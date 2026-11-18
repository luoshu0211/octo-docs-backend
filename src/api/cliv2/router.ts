import { Router, type Request, type Response, type NextFunction, type RequestHandler } from 'express'
import { rateLimit } from 'express-rate-limit'
import { withVerifiedCliSpace } from '../../permission/cliSpace.js'
import { docsBusinessHandlers, errorForStatus } from './adapter.js'
import { PptApiError } from '../ppt/errors.js'
import { docsOperations } from './operations.js'
import { config } from '../../config/env.js'
import { isDocType } from '../../db/docType.js'
import { docMetaRepo, type DocMeta } from '../../db/repos/docMetaRepo.js'
import { resolveRole } from '../../permission/resolveRole.js'
import { resolveEffectiveRole } from '../../permission/resolveEffectiveRole.js'
import { shareRoleName, shareScopeName, DISCOVERABILITY_SPACE } from '../../permission/shareScope.js'
import { buildDocShareUrl } from '../../util/docShareLink.js'
import { createRateLimiter, type RateLimiterOptions } from '../middleware/rateLimit.js'
import { CliError, createAuthResolver, hasAction, type CliPrincipal } from './auth.js'

const readDocuments = 'docs.documents:read'

type Handler = (req: Request, res: Response, principal: CliPrincipal) => Promise<void>

export function createCliV2Router(rateOptions: RateLimiterOptions = {}): Router | null {
  const resolve = createAuthResolver(process.env.OCTO_AUTH_SERVER_URL, process.env.OCTO_AUTH_SERVICE_SECRET)
  if (!resolve) return null
  const router = Router({ caseSensitive: true, strict: true })
  const limited = new CliError('RATE_LIMITED').envelope
  router.use(createRateLimiter({ ...rateOptions, message: limited }))
  const byUser = rateLimit({
    windowMs: rateOptions.windowMs ?? config.rateLimit.windowMs,
    limit: rateOptions.max ?? config.rateLimit.max,
    keyGenerator: (_req, res) => 'cli:' + (res.locals.cliPrincipal as CliPrincipal).userId,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: limited,
  })

  const register = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, action: string, ...handle: RequestHandler[]) => {
    router.route(path)[method]((req, res, next) => {
      if (req.method !== method.toUpperCase()) { next('route'); return }
      const headers = req.headersDistinct.authorization
      const token = headers?.length === 1 ? /^Bearer[ \t]+([^,\s]+)$/i.exec(headers[0] ?? '')?.[1] : undefined
      if (!token) { next(new CliError('AUTH_REQUIRED')); return }
      resolve(token).then(({ principal, permissions }) => {
        res.locals.cliPrincipal = principal
        return byUser(req, res, (error?: unknown) => {
          if (error) { next(error); return }
          if (!hasAction(permissions, action)) { next(new CliError('FORBIDDEN')); return }
          res.locals.cliCanReadContent = hasAction(permissions, 'docs.content:read')
          res.locals.cliCanReadAttachments = hasAction(permissions, 'docs.attachments:read')
          req.uid = principal.userId
          req.spaceId = principal.spaceId
          req.principalSpaceId = principal.spaceId
          req.apiKeySpaceId = principal.spaceId
          req.docSpaceScope = { mode: 'cli', spaceId: principal.spaceId }
          withVerifiedCliSpace({ uid: principal.userId, spaceId: principal.spaceId }, next)
        })
      }).catch(next)
    }, ...handle)
  }

  const pilot = (handle: Handler): RequestHandler => (req, res, next) => {
    void handle(req, res, res.locals.cliPrincipal as CliPrincipal).catch(next)
  }
  register('get', '/docs', readDocuments, pilot(listDocs))
  register('get', '/docs/:doc_id', readDocuments, pilot(getDoc))
  const handlers = docsBusinessHandlers()
  for (const operation of docsOperations) {
    const [method, path, action] = operation
    register(method, path, action, ...handlers(operation))
  }
  router.use((_req, _res, next) => next(new CliError('NOT_FOUND')))
  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) { next(error); return }
    const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined
    const failure = error instanceof CliError ? error :
      error instanceof PptApiError ? errorForStatus(error.httpStatus, { error: error.code.toLowerCase() }) :
      status === 413 ? new CliError('PAYLOAD_TOO_LARGE') :
      status === 415 ? new CliError('UNSUPPORTED_MEDIA_TYPE') :
      status === 400 || error instanceof URIError ? new CliError('VALIDATION_ERROR') : new CliError('INTERNAL_ERROR')
    res.status(failure.status).json(failure.envelope)
  })
  return router
}

async function docRole(meta: DocMeta, principal: CliPrincipal) {
  // The legacy guard permits certain cross-Space grants. Reject them before
  // consulting the ACL here, including if this user belongs to both Spaces.
  if (meta.space_id !== principal.spaceId || meta.status === 0) return 'none'
  const direct = await resolveRole(principal.userId, meta.doc_id, principal.spaceId)
  return resolveEffectiveRole(principal.userId, direct, meta, {
    principalSpaceId: principal.spaceId,
    verifiedSpaceId: principal.spaceId,
  })
}

function projectDoc(meta: DocMeta, role: string) {
  return {
    doc_id: meta.doc_id,
    doc_type: meta.doc_type,
    title: meta.title,
    owner_id: meta.owner_id,
    ...(meta.status === 1 ? { created_by: meta.created_by, updated_by: meta.updated_by } : {}),
    ...(meta.octo_doc_slug ? { octo_doc_slug: meta.octo_doc_slug } : {}),
    role,
    updated_at: meta.updated_at,
  }
}

async function getDoc(req: Request, res: Response, principal: CliPrincipal) {
  const docId = req.params.doc_id
  if (!docId) throw new CliError('VALIDATION_ERROR')
  const meta = await docMetaRepo.getByDocId(docId)
  if (!meta || meta.space_id !== principal.spaceId || meta.status === 0) throw new CliError('NOT_FOUND')
  const role = await docRole(meta, principal)
  if (role === 'none') throw new CliError('FORBIDDEN')
  if (meta.status === 2) throw new CliError('CONFLICT')
  res.json({ data: {
    ...projectDoc(meta, role),
    document_name: meta.document_name,
    space_id: meta.space_id,
    folder_id: meta.folder_id,
    created_at: meta.created_at,
    share_url: buildDocShareUrl(config.webOrigin, meta.doc_id, meta.space_id),
    share_scope: shareScopeName(meta.share_scope),
    share_role: shareRoleName(meta.share_role),
    is_space_searchable: meta.discoverability_scope === DISCOVERABILITY_SPACE,
    permission_epoch: meta.permission_epoch,
  } })
}

function pageNumber(raw: unknown, fallback: number, max: number) {
  if (raw === undefined) return fallback
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw) || Number(raw) > max) {
    throw new CliError('VALIDATION_ERROR')
  }
  return Number(raw)
}

async function listDocs(req: Request, res: Response, principal: CliPrincipal) {
  const { folder_id: folderId, q, owner, sort, type } = req.query
  if ((folderId !== undefined && typeof folderId !== 'string') ||
      (q !== undefined && typeof q !== 'string') ||
      (owner !== undefined && owner !== 'me') ||
      (sort !== undefined && sort !== 'updatedAt:asc' && sort !== 'updatedAt:desc')) {
    throw new CliError('VALIDATION_ERROR')
  }
  const types = type === undefined ? [] : Array.isArray(type) ? type : [type]
  if (!types.every(isDocType)) throw new CliError('VALIDATION_ERROR')
  const page = pageNumber(req.query.page, 1, 2147483647)
  const pageSize = pageNumber(req.query.page_size, 20, 100)
  const { total, items } = await docMetaRepo.listForUser({
    uid: principal.userId,
    spaceId: principal.spaceId,
    principalSpaceId: principal.spaceId,
    isSpaceMember: true,
    folderId,
    q,
    owner,
    page,
    pageSize,
    sort: sort ?? 'updatedAt:desc',
    types: [...new Set(types)],
  })
  const projected = await Promise.all(items.map(async (meta) => {
    const role = await docRole(meta, principal)
    return role === 'none' ? [] : [projectDoc(meta, role)]
  }))
  res.json({ data: projected.flat(), pagination: { total, page, page_size: pageSize } })
}
