/**
 * HTML doc first-screen preview (human surface, read-only).
 *
 * Forwarding an HTML doc into a conversation produces a type-18
 * DocumentShareCard, and the card needs an ACL-safe first-screen preview. No
 * existing content surface can serve it: /content accepts only 'doc', /sheet only
 * 'sheet', /scene only 'board' — an html target hits 409 unsupported_doc_type on
 * all three. This is that missing surface, and only that:
 *
 *   GET /:docId/html-preview   reader — heading + first paragraphs, plain text
 *
 * Structurally it is docSheet.ts's GET skeleton: requireDocRole(reader) → a
 * doc_type gate that emits the SAME 409 unsupported_doc_type body → serve.
 * Archived (status=2) is NOT handled here — requireDocRole already returns 409
 * conflict for it, and duplicating that check is how the two drift apart.
 *
 * The body reuses the frontend's EXISTING **render-layer** preview type
 * `DocSharePreview` (`{ type: 'doc', heading?, paragraphs }`, declared in
 * ui/DocumentShareCard/index.tsx), so html needs no new RENDERING component —
 * the Cell can feed this straight into the existing `document-preview-page`.
 *
 * ⚠️ That is NOT the same as "zero new frontend code", and an earlier draft of
 * this comment claimed exactly that. It was wrong. Concretely:
 * Messages/DocumentShareCard/preview.ts routes doc→/content, board→/scene,
 * sheet→/sheet and then PARSES each body — `parseDocPreview` reads
 * `body.doc.content`, a raw ProseMirror block array. This endpoint returns an
 * ALREADY-EXTRACTED result, not a ProseMirror tree, so handing our body to
 * `parseDocPreview` yields `blocks = []` → `undefined`. The frontend therefore
 * still needs a NEW html branch that calls /html-preview and adopts
 * `body.preview` verbatim, bypassing `parseDocPreview` entirely.
 *
 * Returning the extracted shape (instead of markup for the client to parse) is
 * the deliberate design, not an oversight: server-side extraction IS the point —
 * the upstream HTML is attacker-authored and must never reach the client, and
 * making the frontend re-parse it would recreate the very problem this endpoint
 * exists to solve. Frontend wiring is a SEPARATE PR; when it lands, the html
 * branch will not reuse `parseDocPreview`.
 *
 * ── Never 5xx, never leak markup ─────────────────────────────────────────────
 * Everything after the permission gate is best-effort: no slug on the row, an
 * unsafe slug, upstream down/slow/erroring, unparseable HTML — all return
 * 200 with an EMPTY preview, which renders as today's neutral "暂无预览".
 * Rationale in htmlPreviewFetch.ts; the short version is that a preview failure
 * turning the card red is strictly worse than no preview.
 *
 * Only decoded plain text crosses this boundary — the raw upstream HTML is never
 * put in the response.
 *
 * ⚠️ CONSUMERS MUST RENDER `preview.heading` / `preview.paragraphs` AS TEXT,
 * never via innerHTML (or `v-html`/`dangerouslySetInnerHTML`). These fields are
 * plain text, but plain text derived from an attacker-authored document can still
 * CONTAIN `<`, `>` and `&` — `&lt;script&gt;` decodes to literal `<script>`, and
 * prose like `5 < 10` is kept verbatim because a browser renders it verbatim.
 * Piping that into an HTML sink turns text back into markup and re-creates the
 * XSS this endpoint exists to prevent. Server-side extraction is not a substitute
 * for output encoding at the render site.
 */
import { Router, type Router as ExpressRouter, type Request, type Response } from 'express'
import { requireDocRole } from '../guard.js'
import { HTML_DOC_TYPE } from '../../db/docType.js'
import { fetchHtmlSource } from '../services/htmlPreviewFetch.js'
import { extractHtmlExcerpt, type HtmlExcerpt } from '../services/htmlExcerpt.js'

export const docHtmlPreviewRouter: ExpressRouter = Router()

/**
 * Reject a target whose doc_type is not 'html'. Writes a 409 unsupported_doc_type
 * and returns false when blocked — the mirror of docContent's
 * requireBodyEditableDocType, docSheet's requireSheetDocType and docScene's
 * requireBoardDocType. The body is byte-identical to those three on purpose: the
 * frontend already branches on this exact error string.
 *
 * Deliberately excludes 'html_ppt': a Bento slide deck is a first-class sibling
 * kind with its own source path under /api/v1/ppt/**, never a fall-through here.
 */
function requireHtmlDocType(res: Response, docType: string): boolean {
  if (docType !== HTML_DOC_TYPE) {
    res.status(409).json({ error: 'unsupported_doc_type' })
    return false
  }
  return true
}

/** The neutral "no preview" body. Same shape as a populated one, empty content. */
const EMPTY_PREVIEW: HtmlExcerpt = { paragraphs: [] }

// ── GET /:docId/html-preview — first-screen excerpt (reader) ──────────────────
docHtmlPreviewRouter.get('/:docId/html-preview', getDocHtmlPreviewHandler)

export async function getDocHtmlPreviewHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(req, res, req.params.docId!, 'reader')
  if (!guard) return
  if (!requireHtmlDocType(res, guard.meta.doc_type)) return

  // The guard already loaded doc_meta, and DocMetaRow carries octo_doc_slug +
  // doc_type — no second query.
  //
  // ★ The slug can legitimately be NULL: only BOT-registered html rows persist
  // one (see docType.ts docTypeUsesOctoDocSlug); a human-created html row stores
  // NULL. That is a normal document, not an error — it just has no upstream
  // source to read, so it gets the empty preview, never a 500.
  const slug = guard.meta.octo_doc_slug

  // ★ The lookup space MUST be the document's OWN home space — never the
  // observer's `X-Space-Id`.
  //
  // `octo_doc_slug` is unique only WITHIN a space (schema.sql uk_octo_doc_slug is
  // (space_id, octo_doc_slug)), so upstream needs a space to resolve the slug at
  // all. And the human chain here deliberately allows the two to differ:
  // requireDocRole locates by docId alone and guard.ts states outright that
  // `X-Space-Id` never scopes selection or authz — a cross-space direct member /
  // owner / anyone_in_space reader resolves exactly as if `sp` had been correct.
  // Forwarding an html doc into a conversation in ANOTHER space is precisely why
  // this endpoint exists, so "observer space ≠ doc space" is the MAIN case.
  //
  // Passing the observer's space upstream breaks that main case outright:
  // octo-docs-html's crossSpaceScope() treats "doc provenance space ≠ request
  // context space" as a cross-space access attempt and resolveDocID() returns
  // docID="" with registered=true — an explicit DENY that must not fall back. The
  // read lands on 404 and the card is permanently blank for every cross-space
  // reader. Sending the doc's own space is what makes upstream's view of "which
  // document" agree with the one this service just authorized.
  //
  // This header is NOT an authorization input in either direction — authz already
  // happened in requireDocRole, and upstream's own check is defense in depth, not
  // our source of truth (see htmlPreviewFetch.ts). It selects WHICH DOCUMENT's
  // source is read, which is why it must be derived from the doc, not the caller.
  //
  // guard.meta already carries space_id — no second query.
  const docSpaceId = (guard.meta.space_id ?? '').trim()

  let preview: HtmlExcerpt = EMPTY_PREVIEW
  try {
    // fetchHtmlSource validates the slug shape before building the URL and
    // returns null for a NULL/unsafe slug, an unconfigured baseUrl, a timeout, or
    // any non-2xx — no request is even issued in the first two cases.
    const html = await fetchHtmlSource({
      slug,
      callerToken: req.octoToken ?? '',
      ...(docSpaceId ? { docSpaceId } : {}),
    })
    if (html !== null && html !== '') preview = extractHtmlExcerpt(html)
  } catch {
    // Belt and braces: fetchHtmlSource is already non-throwing and
    // extractHtmlExcerpt is pure, but a preview must NEVER become a 5xx.
    preview = EMPTY_PREVIEW
  }

  res.status(200).json({
    docId: guard.meta.doc_id,
    // `type: 'doc'` is the frontend's `DocSharePreview` RENDER-layer discriminant
    // — it describes the PREVIEW's shape, not the document's doc_type. Reusing it
    // means no new card renderer; it does NOT mean no new frontend code (the html
    // branch that calls this endpoint is still to be written — see file header).
    preview: {
      type: 'doc',
      ...(preview.heading ? { heading: preview.heading } : {}),
      paragraphs: preview.paragraphs,
    },
  })
}
