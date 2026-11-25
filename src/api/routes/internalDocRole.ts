/**
 * Internal doc-role lookup (TES-131): the drive service asks docs-backend for a
 * caller's DIRECT role on a document so it can decide whether to derive a
 * drive-library grant. It is deliberately the DIRECT role (resolveRole: owner =>
 * admin, else the doc_member row, else none) — NOT the effective role — so the
 * drive derivation never recurses back through the docs derived-access lookup.
 *
 *   GET /internal/docs/:docId/role?uid=<>&principal_space_id=<>
 *   X-Internal-Token: <DOCS_INTERNAL_TOKEN>
 *   -> 200 { role, role_rank, doc_status, owner_space_id }
 *
 * `role_rank` is the comparison ordinal from roleRank() (admin=40 … none=0), so
 * the drive side can compare privilege without re-encoding the stored/rank
 * decoupling. `doc_status` is doc_meta.status (1=active 0=deleted 2=archived) and
 * `owner_space_id` the doc's home Space. A missing/soft-deleted doc is 404.
 * X-Internal-Token auth mirrors internalHtmlRegistration (timing-safe sha256);
 * an empty configured token rejects every caller (fail-closed).
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  type Router as ExpressRouter,
} from 'express'
import { config } from '../../config/env.js'
import { docMetaRepo } from '../../db/repos/docMetaRepo.js'
import { docMemberRepo } from '../../db/repos/docMemberRepo.js'
import { roleRank, type ResolvedRole } from '../../permission/role.js'

/**
 * Route-scoped limiter (OCTO-456 F2): each router mounts the limiter on its OWN
 * route chain. A router-level limiter would run for every request that reaches
 * the router — Express falls through to the next router when no route matches —
 * so two routers mounted at the same prefix would each burn budget on every
 * request and exhaust each other.
 */
export function createInternalDocRoleRouter(limiter: RequestHandler): ExpressRouter {
  const router = Router()
  router.get('/:docId/role', limiter, asyncHandler(internalDocRoleHandler))
  return router
}

function credentialMatches(actual: string): boolean {
  const expected = config.driveDerived.inboundToken
  if (expected === '' || actual === '') return false
  const digest = (value: string) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(actual), digest(expected))
}

export function authorizeInternalDocRequest(req: Request, res: Response): boolean {
  if (credentialMatches(req.header('x-internal-token') ?? '')) return true
  res.status(401).json({ error: 'unauthorized' })
  return false
}

/** Middleware form: reject before any body parsing happens on the route. */
export function requireInternalDocToken(req: Request, res: Response, next: NextFunction): void {
  if (authorizeInternalDocRequest(req, res)) next()
}

export async function internalDocRoleHandler(req: Request, res: Response): Promise<void> {
  if (!authorizeInternalDocRequest(req, res)) return
  const docId = req.params.docId ?? ''
  const uid = typeof req.query.uid === 'string' ? req.query.uid : ''
  const principalSpaceId = typeof req.query.principal_space_id === 'string' ? req.query.principal_space_id : ''
  if (!docId || !uid || !principalSpaceId) {
    res.status(400).json({ error: 'invalid_request' })
    return
  }

  const meta = await docMetaRepo.getByDocId(docId)
  // Soft-deleted (status=0) is 404, same as a missing row: getByDocId does NOT
  // filter status, so the endpoint enforces the "missing/soft-deleted => 404"
  // contract here (a status=0 row must not leak a role to the drive derivation).
  if (!meta || meta.status === 0) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  // Mirrors resolveRole exactly: owner (uid + owner Space match) => admin,
  // else the single doc_member row, else none. Space-qualified throughout.
  // Keyed on meta.doc_id (the canonical value), not the raw path param.
  const role: ResolvedRole =
    uid === meta.owner_id && principalSpaceId === meta.owner_space_id
      ? 'admin'
      : (await docMemberRepo.getRole(meta.doc_id, uid, principalSpaceId)) ?? 'none'

  res.status(200).json({
    role,
    role_rank: roleRank(role),
    doc_status: meta.status,
    owner_space_id: meta.owner_space_id,
  })
}

function asyncHandler(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next)
  }
}
