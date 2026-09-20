/**
 * C-style response envelope + fixed error enum, scoped to `/api/v1/ppt/**`.
 *
 * B's legacy surface (`/api/v1/docs/**`) returns BARE JSON — success bodies are
 * raw objects and the central error handler emits a flat `{ error: '<string>' }`
 * (see api/app.ts). PPT deliberately does NOT reuse that shape: per the gate3
 * design (§3.2 / §4) the PPT API mirrors the C service's envelope:
 *
 *   success : { "data": <payload> }
 *   list    : { "data": [...], "pagination": { nextCursor, hasMore } }
 *   failure : { "error": { code, message, details?, hint? } }
 *
 * The error enum is ported verbatim from C's `errorEnum`
 * (octo-docs-html internal/transport/httpx/envelope.go:71-92) with ONE addition:
 * `UNSUPPORTED_DOCUMENT_TYPE` (422), which C does not define — it is PPT-specific
 * for wrong-kind calls (a non-`html_ppt` doc hitting a PPT endpoint, or a PPT doc
 * hitting a Yjs-only endpoint).
 *
 * List pagination is a DELIBERATE divergence from C: C uses offset pagination
 * ({total,page,page_size}); PPT uses cursor pagination ({nextCursor,hasMore}) per
 * the PRD. This module therefore only exposes the cursor shape.
 *
 * This adapter is intentionally isolated to the PPT router so legacy `/docs`
 * responses stay byte-for-byte unchanged; nothing here touches the global
 * bare-JSON error handler.
 */
import { Router, json, type Request, type Response, type NextFunction } from 'express'
import { config } from '../../config/env.js'
import { createPptDraftRouter } from './draft.js'
import { createPptLiveRouter } from './live.js'
import { createPptExportRouter } from './export.js'
import { createPptSourceRouter } from './source.js'
import { createPptCollabTokenRouter } from './collabToken.js'

import { PptApiError, PPT_ERROR_STATUS, type PptErrorCode, type PptErrorBody, type PptErrorOptions, type PptCursorPagination } from './errors.js'
export * from './errors.js'

/** Write a success envelope: `{ data }` at `status` (default 200). */
export function sendPptData<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ data })
}

/** Write a list envelope: `{ data: items, pagination }` at `status` (default 200). */
export function sendPptList<T>(res: Response, items: T[], pagination: PptCursorPagination, status = 200): void {
  res.status(status).json({ data: items, pagination })
}

/** Write a failure envelope: `{ error: { code, message, details?, hint? } }`. */
export function sendPptError(res: Response, code: PptErrorCode, message: string, opts: PptErrorOptions = {}): void {
  const error: PptErrorBody = { code, message }
  if (opts.details !== undefined) error.details = opts.details
  if (opts.hint !== undefined) error.hint = opts.hint
  res.status(PPT_ERROR_STATUS[code]).json({ error })
}

/**
 * Router-scoped error handler for `/api/v1/ppt/**`. Renders every failure as the
 * C-style envelope so a thrown error never leaks the global bare-JSON
 * `{ error: 'internal_error' }` shape into the PPT contract.
 *
 * Mapping:
 *  - PptApiError                     -> its own code + status
 *  - express.json `entity.parse.failed` -> 400 VALIDATION_ERROR
 *  - express.json `entity.too.large`    -> 413 PAYLOAD_TOO_LARGE
 *  - express.json `charset.unsupported` / `encoding.unsupported` -> 415 UNSUPPORTED_MEDIA_TYPE
 *  - anything else                   -> 500 INTERNAL_ERROR (logged, message not leaked)
 */
export function pptErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err)
    return
  }
  if (err instanceof PptApiError) {
    sendPptError(res, err.code, err.message, { details: err.details, hint: err.hint })
    return
  }
  const type = (err as { type?: unknown } | null)?.type
  if (type === 'entity.parse.failed') {
    sendPptError(res, 'VALIDATION_ERROR', 'malformed JSON body')
    return
  }
  if (type === 'entity.too.large') {
    const { limit, length } = err as { limit?: number; length?: number }
    sendPptError(res, 'PAYLOAD_TOO_LARGE', 'request body too large', {
      details: { dimension: 'request', ...(typeof limit === 'number' ? { limit } : {}), ...(typeof length === 'number' ? { requestBytes: length } : {}) },
    })
    return
  }
  if (type === 'charset.unsupported' || type === 'encoding.unsupported') {
    // express.json rejects an unsupported charset/encoding before parsing — that
    // is a media-type problem, not an internal error. Map it to the enum's 415.
    sendPptError(res, 'UNSUPPORTED_MEDIA_TYPE', 'unsupported content encoding')
    return
  }
  // eslint-disable-next-line no-console
  console.error('PPT API error:', err)
  sendPptError(res, 'INTERNAL_ERROR', 'internal error')
}

/**
 * Build the `/api/v1/ppt` router (R1 contract spine).
 *
 * R1 wires the envelope machinery only: the concrete endpoints (create, register,
 * source, draft, versions, collab-token, comments) land in R2+ and will be added
 * to THIS router BEFORE the terminal handlers below, behind their own auth guards.
 * Until then every PPT path resolves to an enveloped `NOT_FOUND` (not the global
 * bare-JSON 404), so the C-style contract is already observable and the legacy
 * `/api/v1/docs/**` surface stays untouched.
 */
export function createPptRouter(): Router {
  const router = Router()

  // Body parsing is scoped to THIS router (the global express.json in
  // api/app.ts deliberately skips `/api/v1/ppt/**`). Parsing here means a
  // malformed-JSON body raises `entity.parse.failed` INSIDE the router, so the
  // router-scoped pptErrorHandler below renders it as the C-style
  // VALIDATION_ERROR envelope instead of the global bare-JSON `invalid_body`.
  const smallBody = json({ limit: '1mb' })
  const fullDeckBody = json({ limit: config.ppt.write.maxRequestBytes })
  router.use((req, res, next) => {
    const fullDeck = (req.method === 'PATCH' && /^\/docs\/[^/]+\/live\/?$/i.test(req.path)) ||
      (req.method === 'PUT' && /^\/docs\/[^/]+\/draft\/?$/i.test(req.path))
    return (fullDeck ? fullDeckBody : smallBody)(req, res, next)
  })

  // R2+ endpoint routers mount here (before the terminal 404). Body is already
  // parsed by the router-scoped `json()` above, so these handlers read req.body
  // directly and a malformed body is enveloped by pptErrorHandler.
  // R2-B1: human create — POST /api/v1/ppt/docs.
  router.use(createPptDraftRouter())
  router.use(createPptLiveRouter())
  router.use(createPptExportRouter())
  // R3-B1: source/bootstrap — GET /api/v1/ppt/docs/:docId/source.
  router.use(createPptSourceRouter())
  // R4-B1: collab-token/ticket — POST /api/v1/ppt/docs/collab-token. Mounted ONLY
  // when the relay is enabled (default ON): issuing a relay ticket for an
  // endpoint that is not attached would be a dead credential. With the relay
  // disabled the path resolves to the
  // enveloped NOT_FOUND below, same as any other unmounted PPT route.
  if (config.ppt.relay.enabled) {
    router.use(createPptCollabTokenRouter())
  }

  // Terminal 404: any PPT path without a matching route returns the enveloped
  // NOT_FOUND rather than falling through to the app's bare-JSON handler.
  router.use((_req: Request, res: Response) => {
    sendPptError(res, 'NOT_FOUND', 'resource not found')
  })

  // Router-scoped error envelope (must be registered last).
  router.use(pptErrorHandler)

  return router
}
