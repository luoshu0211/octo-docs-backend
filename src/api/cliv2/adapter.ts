import { json, type Request, type RequestHandler, type Response, type Router } from 'express'
import type { ILayer, IRoute } from 'express-serve-static-core'
import { config } from '../../config/env.js'
import { createBotPptRouter } from '../ppt/live.js'
import { createPptExportRouter } from '../ppt/export.js'
import { attachmentsRouter } from '../routes/attachments.js'
import { boardExportRouter, exportBoardHandler } from '../routes/boardExport.js'
import { commentsRouter } from '../routes/comments.js'
import { docContentRouter } from '../routes/docContent.js'
import { docSceneRouter } from '../routes/docScene.js'
import { docSheetRouter } from '../routes/docSheet.js'
import { createDocHandler, docsRouter, searchDocsHandler } from '../routes/docs.js'
import { exportRouter } from '../routes/export.js'
import { importRouter } from '../routes/import.js'
import { membersRouter } from '../routes/members.js'
import { versionsRouter } from '../routes/versions.js'
import { forwardCliGrant, removeCliMember, setCliMember } from './access.js'
import { CliError } from './auth.js'
import { exportExcalidraw, prepareBoardComment } from './board.js'
import type { DocsOperation } from './operations.js'

type AsyncHandler = (req: Request, res: Response) => Promise<unknown>
type JsonRecord = Record<string, unknown>

const customHandlers: Record<string, AsyncHandler> = {
  create: createDocHandler,
  search: searchDocsHandler,
  membersSet: setCliMember,
  membersRemove: removeCliMember,
  forwardGrant: forwardCliGrant,
  delete: async () => { throw new CliError('FORBIDDEN', { reason: 'cli_delete_disabled' }) },
}

// Select the concrete business callback from each pinned Express router by its
// exact method + path. Express Router exposes route layers separately from
// mount middleware. Only the declared callbacks run under the CLI guard.
function registeredHandlers(routers: Record<string, Router>, operation: DocsOperation): RequestHandler[] {
  const [method, , , id, family, oldPath] = operation
  const custom = customHandlers[family]
  if (custom) return [custom]
  const registered = (routers[family]?.stack as (ILayer & { route?: IRoute })[] | undefined) ?? []
  const layers = registered.flatMap(layer => layer.route?.path === oldPath ? layer.route.stack : [])
    .filter(layer => layer.method === method)
  // Imports use their route's existing raw parser and size limit. The PPT
  // live PATCH uses the CLI JSON parser with the same limit as its own.
  const expected = family === 'import' || id === 'docs.ppt.edit' ? 2 : 1
  if (layers.length !== expected) throw new Error('No unique business handler for ' + id)
  return layers.map(layer => layer.handle)
}

function plainObject(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
}

// Nested editor payloads, signed headers and keyed cell maps have their own
// wire formats. Only the surrounding API DTO uses the CLI field convention.
const opaque = new Set([
  'doc', 'deck', 'scene', 'elements', 'files', 'app_state', 'ops', 'headers', 'element_id_map', 'file_id_map',
  'cells', 'dims', 'drawings', 'hyperlinks', 'merges', 'sheets', 'freeze', 'filters', 'data_validations', 'conditional_formats',
  'sheet_cells', 'sheet_dims', 'sheet_hyperlinks', 'sheet_merges', 'sheet_list', 'sheet_freeze',
  'sheet_filters', 'sheet_data_validations', 'sheet_conditional_formats',
])

function snake(key: string): string {
  return key.replace('HyperLinks', 'Hyperlinks').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

function mapKeys(body: unknown, decode: boolean, id: string): unknown {
  if (Array.isArray(body)) return body.map(value => mapKeys(value, decode, id))
  if (!plainObject(body)) return body
  const entries = Object.entries(body).map(([key, value]) => {
    let mapped = decode ? key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()) : snake(key)
    if (decode && key === 'user_id') mapped = 'uid'
    if (!decode && key === 'uid') mapped = 'user_id'
    if (!decode && key === 'removedUids') mapped = 'removed_user_ids'
    if (!decode && id.startsWith('docs.comments.')) {
      if (key === 'id') mapped = 'comment_id'
      if (key === 'authorUid') mapped = 'author_id'
    }
    const publicKey = decode ? key : mapped
    return [mapped, opaque.has(publicKey) ? value : mapKeys(value, decode, id)] as const
  })
  if (decode && new Set(entries.map(([key]) => key)).size !== entries.length) throw new CliError('VALIDATION_ERROR')
  return Object.fromEntries(entries)
}

export function errorForStatus(status: number, body: JsonRecord) {
  const details: JsonRecord | undefined = typeof body.error === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(body.error)
    ? { reason: body.error }
    : undefined
  if (status === 413 && details?.reason === 'sheet_too_large') {
    for (const key of ['baseVersion', 'repairDataValidationKey', 'hint']) {
      if (typeof body[key] === 'string') details[snake(key)] = body[key]
    }
    for (const key of ['payloadBytes', 'limit']) {
      if (typeof body[key] === 'number' && Number.isFinite(body[key])) details[snake(key)] = body[key]
    }
  }
  if (status === 409 && details?.reason === 'ambiguous_sheet_name' && Array.isArray(body.candidates)) {
    details.candidates = body.candidates.flatMap(candidate => {
      if (!plainObject(candidate) || typeof candidate.sheetId !== 'string' || typeof candidate.name !== 'string') return []
      return [{ sheet_id: candidate.sheetId, name: candidate.name }]
    })
  }
  switch (status) {
    case 401: return new CliError('AUTH_REQUIRED')
    case 403: return new CliError('FORBIDDEN', details)
    case 404: case 410: return new CliError('NOT_FOUND')
    case 409: case 412: return new CliError('CONFLICT', details)
    case 413: return new CliError('PAYLOAD_TOO_LARGE', details)
    case 415: return new CliError('UNSUPPORTED_MEDIA_TYPE', details)
    case 429: return new CliError('RATE_LIMITED')
    case 502: case 503: case 504: return new CliError('UPSTREAM_UNAVAILABLE', details)
    default: return new CliError(status < 500 ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR', status < 500 ? details : undefined)
  }
}

function responseAdapter(res: Response, id: string) {
  const jsonResponse = res.json.bind(res)
  res.json = ((value: unknown) => {
    const body = plainObject(value) ? value : {}
    if (res.statusCode >= 400) {
      if (plainObject(body.error) && typeof body.error.code === 'string') return jsonResponse(value)
      const error = errorForStatus(res.statusCode, body)
      return jsonResponse.call(res.status(error.status), error.envelope)
    }
    let data: unknown = value
    let pagination: JsonRecord | undefined
    if (Object.hasOwn(body, 'data')) {
      data = body.data
      if (plainObject(body.pagination)) pagination = body.pagination
    } else if (id === 'docs.search' || id === 'docs.comments.list' || id === 'docs.comments.replies' ||
      id === 'docs.versions.list' || id === 'docs.sheet.get') {
      const { nextCursor, hasMore, ...payload } = body
      data = id === 'docs.versions.list' || id === 'docs.sheet.get' ? payload : body.items
      const next = nextCursor == null || nextCursor === '' ? undefined : String(nextCursor)
      pagination = { has_more: typeof hasMore === 'boolean' ? hasMore : next !== undefined, ...(next === undefined ? {} : { next_cursor: next }) }
    }
    const mapped = mapKeys(data, false, id)
    return jsonResponse({ data: mapped, ...(pagination === undefined ? {} : { pagination }) })
  }) as Response['json']
}

const importMedia = new Map([
  ['docs.import.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['docs.import.markdown', 'text/markdown'],
  ['docs.import.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['docs.import.excalidraw', 'application/json'],
])

export function docsBusinessHandlers() {
  const routers = {
    docs: docsRouter, content: docContentRouter, sheet: docSheetRouter, scene: docSceneRouter,
    boardExport: boardExportRouter, ppt: createBotPptRouter(), pptExport: createPptExportRouter(true),
    members: membersRouter, comments: commentsRouter, versions: versionsRouter, attachments: attachmentsRouter,
    import: importRouter, export: exportRouter,
  }
  return (operation: DocsOperation): RequestHandler[] => {
    const [, , , id, , , params = {}, query = {}] = operation
    const handlers = registeredHandlers(routers, operation)
    const callback = handlers.at(-1)!
    const medium = importMedia.get(id)
    const validateMedia: RequestHandler = (req, _res, next) => {
      if (medium && req.is(medium) === false) { next(new CliError('UNSUPPORTED_MEDIA_TYPE')); return }
      next()
    }
    const parse = medium ? handlers[0]! : json({ limit: id === 'docs.sheet.edit' ? config.sheetWrite.maxRequestBytes :
      id === 'docs.ppt.edit' ? config.ppt.write.maxRequestBytes : '1mb' })
    return [validateMedia, parse, (req, res, next) => {
      const dispatch = async () => {
        req.params = Object.fromEntries(Object.entries(params).map(([key, name]) => [key, req.params[name] ?? '']))
        const initialQuery = req.query
        req.query = Object.fromEntries(Object.entries(query).flatMap(([name, key]) =>
          initialQuery[name] === undefined ? [] : [[key, initialQuery[name]]]))
        const body = mapKeys(req.body, true, id)
        req.body = body
        if (id === 'docs.search') {
          const { cursor, page_size } = initialQuery
          if ((cursor !== undefined && typeof cursor !== 'string') ||
            (page_size !== undefined && (typeof page_size !== 'string' || !/^[1-9]\d*$/.test(page_size)))) {
            throw new CliError('VALIDATION_ERROR')
          }
          req.body = { ...(plainObject(body) ? body : {}), cursor, pageSize: page_size }
        }
        responseAdapter(res, id)
        if (id === 'docs.share.set') {
          if (!plainObject(body) || !['restricted', 'anyone_in_space'].includes(String(body.shareScope)) ||
              Object.hasOwn(body, 'spaceSearchable')) throw new CliError('VALIDATION_ERROR')
        }
        if (id === 'docs.comments.add' && plainObject(body) && !await prepareBoardComment(req, res, body)) return
        if (id === 'docs.scene.export' && req.query.format === 'excalidraw') {
          await exportExcalidraw(req, res)
          return
        }
        if (medium) req.headers['x-octo-import-apply'] = 'true'
        if (id === 'docs.file.export' && (req.query.format === 'png' || req.query.format === 'svg')) {
          await exportBoardHandler(req, res)
          return
        }
        await callback(req, res, next)
      }
      void dispatch().catch(next)
    }]
  }
}
