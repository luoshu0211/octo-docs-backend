/**
 * Service-to-service compensation for the §4.4 copy primitive.
 *
 *   POST /internal/docs/:docId/discard-copy   body { owner_uid }
 *
 * WHY THIS EXISTS
 * Drive mints a copy, then writes its own `drive_file` row. If that row cannot
 * be written, the document has no entry anywhere: it is invisible to every
 * client but still occupies doc_meta + body + attachments. Drive used to clean
 * this up with the CALLER's credential, which docs only accepts for humans —
 * so every bot copy that failed on drive's side leaked a document.
 *
 * CONTRACT (owned by octo-drive: internal/docsapi/duplicate.go DiscardCopy)
 *   · X-Internal-Token, like the sibling /internal/docs routes.
 *   · Only a document that is still plausibly an unlinked copy may be
 *     discarded: same owner, still active, created within the orphan window, and
 *     with NO members besides the owner, NO versions and NO comments. Anything
 *     else answers 409 not_a_copy_orphan — this endpoint can never be used to
 *     delete a normal document.
 *   · Discard is a SOFT delete (status=0 + deleted_at), so the existing trash
 *     retention/purge pipeline remains the only thing that physically removes
 *     rows. html content is purged remote-side; a failure there is reported as
 *     `html_cleanup: "failed"` but does not fail the request (the doc_meta row
 *     is already out of every listing, and trash purge retries it).
 */
import {
  Router,
  json as jsonBodyParser,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  type Router as ExpressRouter,
} from 'express'
import { docMetaRepo } from '../../db/repos/docMetaRepo.js'
import { requireInternalDocToken } from './internalDocRole.js'
import { purgeHtmlDocument } from '../services/htmlPurge.js'
import { verifyDiscardToken } from '../services/discardToken.js'
import { HTML_DOC_TYPE } from '../../db/docType.js'

/** Copies created by a request are compensated within minutes, not days. */
export const COPY_ORPHAN_WINDOW_MS = 24 * 60 * 60 * 1000

export function createInternalDocsCopyCompensationRouter(limiter: RequestHandler): ExpressRouter {
  const router = Router()
  const body = jsonBodyParser({ limit: 8 * 1024 })
  // Order: limiter -> internal token -> JSON body -> handler. The global parser
  // skips /internal/docs, so an unauthenticated caller never spends body CPU.
  router.post('/:docId/discard-copy', limiter, requireInternalDocToken, body, asyncHandler(discardCopyHandler))
  return router
}

async function discardCopyHandler(req: Request, res: Response): Promise<void> {
  const docId = String(req.params.docId ?? '').trim()
  const body = (req.body ?? {}) as Record<string, unknown>
  const ownerUID = typeof body.owner_uid === 'string' ? body.owner_uid.trim() : ''
  const token = typeof body.discard_token === 'string' ? body.discard_token.trim() : ''
  if (docId === '' || ownerUID === '' || token === '') {
    res.status(400).json({ error: 'invalid_request' })
    return
  }

  // The token is the proof that THIS docId came out of a copy request by THIS
  // owner. Without it, a stray/guessed id could be aimed at a live document.
  const proof = verifyDiscardToken(token)
  if (!proof || proof.docId !== docId || proof.ownerUid !== ownerUID) {
    res.status(409).json({ error: 'not_a_copy_orphan' })
    return
  }
  if (Date.now() - proof.issuedAtMs > COPY_ORPHAN_WINDOW_MS) {
    res.status(409).json({ error: 'not_a_copy_orphan' })
    return
  }

  const meta = await docMetaRepo.getByDocId(docId)
  if (!meta) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  // One conditional UPDATE owns BOTH the eligibility check and the write: a copy
  // that gained a member/version/comment since the request started simply does
  // not match, so "checked" and "deleted" can never disagree. A read-then-delete
  // pair left a window where the document became real in between and was still
  // deleted (and its html body purged).
  const discarded = await docMetaRepo.discardUnlinkedCopy({
    docId,
    ownerUid: ownerUID,
    notBefore: new Date(Date.now() - COPY_ORPHAN_WINDOW_MS),
  })
  if (!discarded) {
    res.status(409).json({ error: 'not_a_copy_orphan' })
    return
  }

  let htmlCleanup: 'done' | 'failed' | 'skipped' = 'skipped'
  if (meta.doc_type === HTML_DOC_TYPE && meta.octo_doc_slug) {
    const purge = await purgeHtmlDocument(meta.octo_doc_slug, docId, meta.space_id)
    htmlCleanup = purge.ok ? 'done' : 'failed'
    if (!purge.ok) {
      // eslint-disable-next-line no-console
      console.warn('[octo-docs] discard-copy: html purge failed', { docId, reason: purge.reason })
    }
  }

  res.status(200).json({ discarded: true, html_cleanup: htmlCleanup })
}

function asyncHandler(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next)
  }
}
