/**
 * Inline-comment endpoints (feature #3 — doc_comment).
 *   GET    /api/v1/docs/{docId}/comments        (reader)  list thread roots + replies
 *   POST   /api/v1/docs/{docId}/comments        (commenter) create root or reply
 *   PATCH  /api/v1/docs/{docId}/comments/{id}    body edit -> author+writer; resolve -> writer
 *   DELETE /api/v1/docs/{docId}/comments/{id}    soft -> author; hard -> admin
 *
 * Comments live entirely out-of-band from the Y.Doc. Anchors are opaque encoded
 * Yjs RelativePosition bytes: base64 on the wire, decoded to a Buffer for the
 * BLOB columns and served back as base64. The server never parses them.
 *
 * A root comment's anchors normally come from a browser's live selection. A bot
 * has no live selection, so it may instead supply `anchorText` (+ optional
 * `blockPath` / `occurrence` to disambiguate) and the server resolves it against
 * the live document into the same anchor bytes (feature #70; see anchorResolve).
 * The legacy explicit `anchorStart` / `anchorEnd` path is kept unchanged and
 * always takes precedence, so the existing front-end selection flow is not
 * affected.
 *
 * Readers are read-only. Creating/replying and deleting one's own comment need
 * commenter; body edits and resolve/reopen need writer; hard delete needs admin.
 */
import { Router, type Router as ExpressRouter, type Request, type Response } from 'express'
import { requireDocRole } from '../guard.js'
import { roleAtLeast } from '../../permission/role.js'
import { docCommentRepo, type DocComment } from '../../db/repos/docCommentRepo.js'
import {
  resolveAnchorFromLiveDoc,
  AmbiguousAnchorError,
  AnchorTextNotFoundError,
} from '../../collab/anchorResolve.js'
import { notifyDocMentioned } from '../services/docsNotify.js'
import type { BlockPath } from '../../collab/docBodyEdit.js'
import { isDocType, HTML_PPT_DOC_TYPE } from '../../db/docType.js'
import { validateExplicitCommentAnchors } from '../services/commentAnchors.js'
import { publishCommentMutation } from '../services/commentEvents.js'

export const commentsRouter: ExpressRouter = Router()

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

/**
 * The only doc_type whose live body is a ProseMirror fragment `anchorText` can be
 * resolved against. A sheet/board/whiteboard stores a different Y.Doc shape
 * (COLLAB_FIELD is not a PM fragment), so feeding it to `initProseMirrorDoc`
 * inside the resolver throws. Mirrors docContent.ts's `BODY_EDITABLE_DOC_TYPE`
 * gate — kept local and self-contained so it holds regardless of merge order.
 */
const ANCHOR_RESOLVABLE_DOC_TYPE = 'doc'

/**
 * Reject `anchorText` resolution against a non-rich-text doc_type with a
 * 409 unsupported_doc_type (same contract as docContent.ts). Returns false when
 * blocked so the caller stops before opening/parsing the live document.
 */
function requireAnchorResolvableDocType(res: Response, docType: string): boolean {
  if (docType !== ANCHOR_RESOLVABLE_DOC_TYPE) {
    res.status(409).json({ error: 'unsupported_doc_type' })
    return false
  }
  return true
}

/** Parse a positive integer id from a path/body value, or null when malformed. */
function parseId(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : null
  }
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const n = Number(raw)
    return Number.isSafeInteger(n) && n > 0 ? n : null
  }
  return null
}

/** Sentinel: a supplied disambiguation value is present but not well-formed. */
const INVALID_DISAMBIGUATION = Symbol('invalid_disambiguation')

/**
 * Parse an optional `blockPath` disambiguation value into a child-index path.
 *   - `undefined` / `null`      => absent
 *   - number[] of non-neg ints  => that path
 *   - "0,2,1" comma-separated    => parsed path (CLI passes a string flag)
 *   - anything else             => INVALID_DISAMBIGUATION
 * An empty path is rejected (it addresses the doc root, not a text block).
 */
function parseBlockPath(raw: unknown): BlockPath | undefined | typeof INVALID_DISAMBIGUATION {
  if (raw === undefined || raw === null) return undefined
  let parts: unknown[]
  if (Array.isArray(raw)) {
    parts = raw
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed === '') return INVALID_DISAMBIGUATION
    parts = trimmed.split(',').map((s) => s.trim())
  } else {
    return INVALID_DISAMBIGUATION
  }
  if (parts.length === 0) return INVALID_DISAMBIGUATION
  const path: number[] = []
  for (const part of parts) {
    const n =
      typeof part === 'number'
        ? part
        : typeof part === 'string' && /^\d+$/.test(part)
          ? Number(part)
          : NaN
    if (!Number.isInteger(n) || n < 0) return INVALID_DISAMBIGUATION
    path.push(n)
  }
  return path
}

/**
 * Parse an optional 1-based `occurrence` selector.
 *   - `undefined` / `null` => absent
 *   - positive integer     => that occurrence
 *   - anything else        => INVALID_DISAMBIGUATION
 */
function parseOccurrence(raw: unknown): number | undefined | typeof INVALID_DISAMBIGUATION {
  if (raw === undefined || raw === null) return undefined
  const n =
    typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN
  if (!Number.isSafeInteger(n) || n < 1) return INVALID_DISAMBIGUATION
  return n
}

/** Serialize a stored comment for the wire (anchors -> base64). */
function serialize(c: DocComment) {
  return {
    id: c.id,
    docId: c.docId,
    parentId: c.parentId,
    authorUid: c.authorUid,
    body: c.body,
    anchorStart: c.anchorStart ? c.anchorStart.toString('base64') : null,
    anchorEnd: c.anchorEnd ? c.anchorEnd.toString('base64') : null,
    anchorText: c.anchorText,
    resolved: c.resolved,
    resolvedBy: c.resolvedBy,
    resolvedAt: c.resolvedAt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }
}

commentsRouter.get('/:docId/comments/markers', listCommentMarkersHandler)
commentsRouter.get('/:docId/comments/:id/thread', getCommentThreadHandler)
commentsRouter.get('/:docId/comments', listCommentsHandler)

/** Fetch one grouped root by marker id without walking paginated thread pages. */
export async function getCommentThreadHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(req, res, req.params.docId!, 'reader')
  if (!guard) return
  const id = parseId(req.params.id)
  if (id === null) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  const root = await docCommentRepo.getById(id)
  if (!root || root.docId !== guard.meta.doc_id || root.parentId !== null || root.deleted) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  const replies = await docCommentRepo.listReplies(id)
  res.status(200).json({ ...serialize(root), replies: replies.map(serialize) })
}

/** Paginated lightweight marker feed; every page contains unresolved roots only. */
export async function listCommentMarkersHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(req, res, req.params.docId!, 'reader')
  if (!guard) return
  if (guard.meta.doc_type !== 'board') {
    res.status(409).json({ error: 'unsupported_doc_type' })
    return
  }
  const rawCursor = req.query.cursor
  const cursor = rawCursor === undefined ? null : parseId(rawCursor)
  if (rawCursor !== undefined && cursor === null) {
    res.status(400).json({ error: 'invalid_cursor' })
    return
  }
  const limitRaw = Number(req.query.limit ?? DEFAULT_LIMIT)
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : DEFAULT_LIMIT))
  const roots = await docCommentRepo.listUnresolvedMarkers(guard.meta.doc_id, cursor, limit)
  const items = roots.map((root) => ({
    id: root.id,
    anchorStart: root.anchorStart.toString('base64'),
    anchorEnd: root.anchorEnd.toString('base64'),
    anchorText: root.anchorText,
    resolved: root.resolved,
    updatedAt: root.updatedAt,
  }))
  const nextCursor = roots.length === limit ? roots[roots.length - 1]!.id : null
  res.status(200).json({ items, nextCursor })
}

export async function listCommentsHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(req, res, req.params.docId!, 'reader')
  if (!guard) return

  const includeResolved = req.query.includeResolved === '1'
  const cursor = parseId(req.query.cursor)
  const limitRaw = Number(req.query.limit ?? DEFAULT_LIMIT)
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : DEFAULT_LIMIT))

  const roots = await docCommentRepo.listRoots(guard.meta.doc_id, { includeResolved, cursor, limit })
  // Batch all replies for this page of roots in ONE query, then group by
  // parent in memory — avoids an N+1 (one listReplies per root, up to ~101).
  const replies = await docCommentRepo.listRepliesForRoots(roots.map((r) => r.id))
  const byParent = new Map<number, DocComment[]>()
  for (const reply of replies) {
    const group = byParent.get(reply.parentId!)
    if (group) group.push(reply)
    else byParent.set(reply.parentId!, [reply])
  }
  const items = roots.map((root) => ({
    ...serialize(root),
    replies: (byParent.get(root.id) ?? []).map(serialize),
  }))
  const nextCursor = roots.length === limit ? roots[roots.length - 1]!.id : null

  res.status(200).json({ items, nextCursor })
}

commentsRouter.post('/:docId/comments', createCommentHandler)

export async function createCommentHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(req, res, req.params.docId!, 'commenter')
  if (!guard) return

  const { body, anchorStart, anchorEnd, anchorText, parentId } = req.body ?? {}

  if (typeof body !== 'string' || body.trim() === '') {
    res.status(400).json({ error: 'body required' })
    return
  }

  const docId = guard.meta.doc_id
  const documentName = guard.meta.document_name

  if (parentId !== undefined && parentId !== null) {
    // ── Reply: must point at an existing root in THIS doc; no anchors. ──
    const pid = parseId(parentId)
    if (pid === null) {
      res.status(400).json({ error: 'invalid parentId' })
      return
    }
    // Validate and insert under one row lock so a concurrent root delete cannot create an orphan.
    const id = await docCommentRepo.createReplyIfRoot({
      docId,
      documentName,
      parentId: pid,
      authorUid: req.uid!,
      body,
    })
    // Hide cross-doc, deleted, and nested parent references behind 404.
    if (id === null) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    // Best-effort: notify mentions and invalidate live comment views.
    void notifyDocMentioned({ docId, spaceId: guard.meta.space_id, title: guard.meta.title, authorUid: req.uid!, body })
    void publishCommentMutation(documentName, docId, id, 'created')
    res.status(201).json({ id })
    return
  }

  // ── Root: anchors are required. Two ways to supply them: ──
  //   (a) legacy — explicit base64 anchorStart/anchorEnd from a live selection;
  //   (b) bot — anchorText (+ optional blockPath/occurrence), resolved here.
  // Legacy explicit anchors always win, so the existing front-end flow (which
  // sends both anchors AND an anchorText snapshot) is untouched.
  const hasStart = anchorStart !== undefined && anchorStart !== null
  const hasEnd = anchorEnd !== undefined && anchorEnd !== null

  let start: Buffer
  let end: Buffer
  if (hasStart && hasEnd) {
    // (a) Explicit anchors. Board anchors are canonical versioned JSON; all
    // other document types retain their existing opaque formats and reject the
    // board namespace.
    if (!isDocType(guard.meta.doc_type)) {
      res.status(409).json({ error: 'unsupported_doc_type' })
      return
    }
    // html_ppt (Bento slide-deck) is NOT served by this legacy comment surface —
    // deck comments get their own /api/v1/ppt endpoints in R2. Adding html_ppt to
    // DOC_TYPES widened the isDocType() gate above (it used to reject an html_ppt
    // row as unsupported); reject it explicitly so a deck cannot store opaque
    // anchors here and end up with two comment surfaces.
    if (guard.meta.doc_type === HTML_PPT_DOC_TYPE) {
      res.status(409).json({ error: 'unsupported_doc_type' })
      return
    }
    const validated = validateExplicitCommentAnchors(guard.meta.doc_type, anchorStart, anchorEnd)
    if (!validated.ok) {
      res.status(400).json({ error: validated.error })
      return
    }
    start = validated.start
    end = validated.end
  } else if (!hasStart && !hasEnd && typeof anchorText === 'string' && anchorText.trim() !== '') {
    // (b) Bot path: resolve anchorText against the live document.
    // Gate the doc_type BEFORE touching the live doc: a non-'doc' target stores a
    // non-ProseMirror Y.Doc, so the resolver's initProseMirrorDoc would throw.
    if (!requireAnchorResolvableDocType(res, guard.meta.doc_type)) return
    const blockPath = parseBlockPath((req.body as Record<string, unknown>).blockPath)
    const occurrence = parseOccurrence((req.body as Record<string, unknown>).occurrence)
    if (blockPath === INVALID_DISAMBIGUATION) {
      res.status(400).json({ error: 'invalid_block_path' })
      return
    }
    if (occurrence === INVALID_DISAMBIGUATION) {
      res.status(400).json({ error: 'invalid_occurrence' })
      return
    }
    try {
      const resolved = await resolveAnchorFromLiveDoc(documentName, { anchorText, blockPath, occurrence })
      start = resolved.anchorStart
      end = resolved.anchorEnd
    } catch (err) {
      // Fail-loud ambiguity/miss contract (design item 3) -> 422.
      if (err instanceof AmbiguousAnchorError) {
        res.status(422).json({ error: 'ambiguous_anchor', matches: err.matches })
        return
      }
      if (err instanceof AnchorTextNotFoundError) {
        res.status(422).json({ error: 'anchor_text_not_found' })
        return
      }
      // Any other failure (bad fragment, live-doc read error, …) is unexpected.
      // This is a bare async Express handler, so a re-thrown rejection would
      // escape as an unhandled rejection — never reaching app.ts's central error
      // middleware — and the client request would hang until timeout. Convert it
      // to a 500 internal_error here, matching docContent.ts's try/catch.
      res.status(500).json({ error: 'internal_error' })
      return
    }
  } else {
    // Neither a full legacy anchor pair nor a usable anchorText.
    res.status(400).json({ error: 'anchorStart and anchorEnd required for a root comment' })
    return
  }
  const id = await docCommentRepo.create({
    docId,
    documentName,
    parentId: null,
    authorUid: req.uid!,
    body,
    anchorStart: start,
    anchorEnd: end,
    anchorText: typeof anchorText === 'string' ? anchorText.slice(0, 512) : '',
  })
  // Best-effort: notify mentions and invalidate live comment views.
  void notifyDocMentioned({ docId, spaceId: guard.meta.space_id, title: guard.meta.title, authorUid: req.uid!, body })
  void publishCommentMutation(documentName, docId, id, 'created')
  res.status(201).json({ id })
}

/** Max anchors accepted in one re-anchor batch. One structural edit affects at most a screenful of
 *  comments in practice; the cap keeps a malformed client from asking for an unbounded transaction. */
const MAX_REANCHOR_BATCH = 200

// The `\\:` escapes the colon so Express treats it as a literal character rather than the start of a
// route param. Measured against the Express version in use:
//   POST /docs/abc/comments:reanchor    -> 200
//   POST /docs/abc/comments%3Areanchor  -> 404   (only the literal colon matches)
//   POST /docs/abc/comments/reanchor    -> 404
// So CLIENTS MUST SEND A LITERAL COLON. Wrapping the path in encodeURIComponent — an easy "cleanup" for
// someone hardening URL building — turns every call into a silent 404 with no server-side trace. Unit
// tests cannot catch this: they invoke the handler directly and never touch the router.
commentsRouter.post('/:docId/comments\\:reanchor', reanchorCommentsHandler)

/**
 * POST /:docId/comments:reanchor — rewrite the anchors of existing thread roots in one transaction.
 *
 * Exists because a structural sheet edit (insert/remove/move a row or column) shifts the cells that
 * comments point at. Without this the client can compute the new coordinates perfectly and still have
 * nowhere to put them: PATCH accepts only `body` and `resolved`, and anchors were previously writable
 * only at create time.
 *
 * ── PERMISSION: author OR writer ───────────────────────────────────────────────────────────────
 * Not author-only, and not writer-only:
 *   - Author-only breaks the ordinary case. Creating a comment needs only `commenter`, which sits
 *     BETWEEN reader and writer (see roleRank in permission/role.ts — storage 1/2/3/4 is not the
 *     ranking), so an author may hold no writer role at all, and a comment whose author has left
 *     could never be re-anchored by anyone.
 *   - Writer-only is what the operation actually is for everybody else: re-anchoring repairs an INDEX,
 *     it does not touch the author's words. `resolved` is already writer-gated for the same reason,
 *     while `body` — the author's actual speech — stays author-only.
 * A writer can already delete the very row a comment points at, so allowing them to fix the resulting
 * anchor adds no capability they did not have.
 *
 * ── anchor_text IS NEVER TOUCHED ───────────────────────────────────────────────────────────────
 * The request body has no field for it and this handler never writes it. The stored snapshot is the
 * evidence trail: if an anchor is ever rewritten to the wrong cell, the frozen original text stops
 * agreeing with whatever now occupies the new coordinate, and the mistake becomes visible. Letting a
 * re-anchor refresh it would delete precisely that signal.
 *
 * ── NO doc_type GATE ──────────────────────────────────────────────────────────────────────────
 * Deliberately does NOT call requireAnchorResolvableDocType. That guard exists for the anchorText
 * resolution path, which must parse a ProseMirror document and therefore only works on `doc`. Here the
 * client supplies finished anchor bytes and the server never interprets them, so the guard would add
 * nothing — and applying it would 409 every sheet, i.e. exactly the case this endpoint is for.
 */
export async function reanchorCommentsHandler(req: Request, res: Response): Promise<void> {
  const docId = req.params.docId!
  // Commenter floor, matching every other mutation in this module (create :230, patch, delete) and the
  // contract at the top of this file: "Readers are read-only." An earlier version of this handler used
  // `reader` here, justified by a claim that creating a comment needs only reader — that claim was
  // false (create requires `commenter`), and it made this the one write path in the module a read-only
  // member could reach. Correcting the floor costs nothing: creating a comment already requires
  // `commenter`, so an author is necessarily at least a commenter and the author-OR-writer split below
  // still lets an author repair their own anchor without any writer role.
  const guard = await requireDocRole(req, res, docId, 'commenter')
  if (!guard) return

  // Same guard the create path uses, and for the same two reasons: it narrows doc_type for the
  // validator below, and it refuses a doc whose type this build does not know about rather than
  // guessing how to treat its anchors. Note this is NOT the 'doc'-only gate used by the anchorText
  // resolution path — every known type including `sheet` passes here, which is what this endpoint
  // needs (a 'doc'-only gate would 409 exactly the case it exists for).
  if (!isDocType(guard.meta.doc_type)) {
    res.status(409).json({ error: 'unsupported_doc_type' })
    return
  }

  const raw = (req.body as { anchors?: unknown })?.anchors
  if (!Array.isArray(raw) || raw.length === 0) {
    res.status(400).json({ error: 'anchors required' })
    return
  }
  if (raw.length > MAX_REANCHOR_BATCH) {
    res.status(400).json({ error: 'too_many_anchors' })
    return
  }

  // Decode and validate EVERY entry before writing anything: a partially applied batch is a state no
  // client can reason about, so a single bad entry rejects the whole request.
  const decoded: Array<{ id: number; anchorStart: Buffer; anchorEnd: Buffer }> = []
  const seen = new Set<number>()
  for (const entry of raw) {
    // `Array.isArray` above says nothing about the ELEMENTS: `{"anchors":[null]}` would dereference
    // null below and throw out of this handler, and an async throw in Express 4 never reaches the
    // error middleware — the socket is left open and the client hangs. Reject the element shape here,
    // before any field access, so a malformed body is a 400 like every other bad input.
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      res.status(400).json({ error: 'invalid_id' })
      return
    }
    const e = entry as { id?: unknown; anchorStart?: unknown; anchorEnd?: unknown }
    const id = typeof e.id === 'number' && Number.isSafeInteger(e.id) && e.id > 0 ? e.id : null
    if (id === null) {
      res.status(400).json({ error: 'invalid_id' })
      return
    }
    // A repeated id in one batch has no defined outcome (last write wins by accident) — refuse it
    // rather than silently pick one.
    if (seen.has(id)) {
      res.status(400).json({ error: 'duplicate_id' })
      return
    }
    seen.add(id)
    // Same validator the create path uses, so one code path owns "what is a well-formed anchor".
    // It is doc_type aware, but only for BOARD anchors: a board doc requires a board-shaped anchor and
    // a non-board doc rejects one. Sheet anchors (`sheetId!row:col`, plus the orphan and file-level
    // forms) are not JSON, so parseBoardAnchor returns null for them and they pass untouched —
    // verified by probe against the real validator for all three forms.
    const validated = validateExplicitCommentAnchors(guard.meta.doc_type, e.anchorStart, e.anchorEnd)
    // Absent and malformed both land here: unlike create there is no "no anchor" case, since supplying
    // one is the entire point of the call.
    if (!validated.ok) {
      res.status(400).json({ error: validated.error })
      return
    }
    decoded.push({ id, anchorStart: validated.start, anchorEnd: validated.end })
  }

  // Authorise per comment, still before any write. A writer passes for every comment in the doc; a
  // non-writer passes only for the ones they authored.
  const isWriter = roleAtLeast(guard.role, 'writer')
  for (const { id } of decoded) {
    const comment = await docCommentRepo.getById(id)
    // Cross-doc / missing / deleted => 404, and do not leak which of the three it was.
    if (!comment || comment.docId !== docId || comment.deleted) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    // Replies carry no anchor by schema invariant; asking to re-anchor one is a client bug.
    if (comment.parentId !== null) {
      res.status(400).json({ error: 'only a thread root has an anchor' })
      return
    }
    if (!isWriter && comment.authorUid !== req.uid) {
      res.status(403).json({ error: 'forbidden' })
      return
    }
  }

  // Wrap the write. This handler is `async` and Express 4 does not route a rejected promise to the
  // central error handler at app.ts:213 — the rejection escapes to process-level `unhandledRejection`,
  // which index.ts:36-38 deliberately logs and keeps serving. Nothing ever writes to `res`, so the
  // client does not get a 500: it waits for its own timeout on a request that will never answer.
  // `createCommentHandler:100` already maps unexpected failures to 500 internal_error for exactly this
  // reason; the same treatment belongs here. (patch/delete in this module share the gap — same class of
  // bug, pre-existing, not touched by this PR.)
  try {
    await docCommentRepo.updateAnchors(docId, decoded)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[octo-docs] reanchor failed:', err)
    res.status(500).json({ error: 'internal_error' })
    return
  }
  // Every other mutation handler in this file publishes here so the collab server can push
  // `comment.changed` to the OTHER connected clients. Skipping it would defeat the endpoint on the
  // exact path it exists for: user A's structural edit commits the new coordinates, while user B —
  // same sheet open elsewhere — keeps rendering pins at the pre-edit cells with no event to tell it
  // otherwise. That silent two-client disagreement is worse than the bug this endpoint fixes, because
  // one of the two screens is now wrong with no visible cause. One publish per affected thread root,
  // matching PATCH's granularity so existing subscribers need no change.
  for (const { id } of decoded) {
    void publishCommentMutation(guard.meta.document_name, docId, id, 'updated')
  }
  res.status(200).json({ updated: decoded.length })
}

commentsRouter.patch('/:docId/comments/:id', patchCommentHandler)

export async function patchCommentHandler(req: Request, res: Response): Promise<void> {
  const docId = req.params.docId!
  // Mutation floor: readers may list comments but cannot change them.
  // This runs FIRST so it 404s on missing/deleted docs, 409s on archived ones,
  // and 403s a caller whose role is 'none' (e.g. revoked author) — before the
  // author check below ever gets a chance to allow a write.
  const guard = await requireDocRole(req, res, docId, 'commenter')
  if (!guard) return

  const id = parseId(req.params.id)
  if (id === null) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  const comment = await docCommentRepo.getById(id)
  // Cross-doc / missing / deleted => 404 (do not leak existence).
  if (!comment || comment.docId !== guard.meta.doc_id || comment.deleted) {
    res.status(404).json({ error: 'not_found' })
    return
  }

  const { body, resolved } = req.body ?? {}

  // Resolve / reopen a thread root — requires writer (elevated above the floor).
  if (resolved !== undefined) {
    if (!roleAtLeast(guard.role, 'writer')) {
      res.status(403).json({ error: 'forbidden' })
      return
    }
    if (comment.parentId !== null) {
      res.status(400).json({ error: 'only a thread root can be resolved' })
      return
    }
    if (typeof resolved !== 'boolean') {
      res.status(400).json({ error: 'resolved must be a boolean' })
      return
    }
    await docCommentRepo.setResolved(id, resolved, req.uid!)
    // Resolve/reopen changes both thread and marker visibility; clients refresh.
    void publishCommentMutation(guard.meta.document_name, guard.meta.doc_id, id, 'updated')
    res.status(200).json({ id })
    return
  }

  // Body edit remains a writer operation; writers may edit only their own comments.
  if (body !== undefined) {
    if (comment.authorUid !== req.uid || !roleAtLeast(guard.role, 'writer')) {
      res.status(403).json({ error: 'forbidden' })
      return
    }
    if (typeof body !== 'string' || body.trim() === '') {
      res.status(400).json({ error: 'body required' })
      return
    }
    await docCommentRepo.updateBody(id, body)
    void publishCommentMutation(guard.meta.document_name, guard.meta.doc_id, id, 'updated')
    res.status(200).json({ id })
    return
  }

  res.status(400).json({ error: 'nothing to update' })
}

commentsRouter.delete('/:docId/comments/:id', deleteCommentHandler)

export async function deleteCommentHandler(req: Request, res: Response): Promise<void> {
  const docId = req.params.docId!
  // Commenter floor (see patchCommentHandler): blocks readers/revoked authors and
  // enforces doc-status 404/409 semantics before the author check below.
  const guard = await requireDocRole(req, res, docId, 'commenter')
  if (!guard) return

  const id = parseId(req.params.id)
  if (id === null) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  const comment = await docCommentRepo.getById(id)
  if (!comment || comment.docId !== guard.meta.doc_id || comment.deleted) {
    res.status(404).json({ error: 'not_found' })
    return
  }

  const hard = req.query.hard === '1'

  if (hard) {
    // Hard delete is a moderator action — needs admin (admin/owner).
    if (!roleAtLeast(guard.role, 'admin')) {
      res.status(403).json({ error: 'forbidden' })
      return
    }
    // doc_id from the guard is authoritative; scopes the destructive cascade.
    await docCommentRepo.hardDelete(id, guard.meta.doc_id)
    void publishCommentMutation(guard.meta.document_name, guard.meta.doc_id, id, 'deleted')
    res.status(200).json({ id })
    return
  }

  // Soft delete — only the author can remove their own comment.
  if (comment.authorUid !== req.uid) {
    res.status(403).json({ error: 'forbidden' })
    return
  }
  await docCommentRepo.softDelete(id)
  void publishCommentMutation(guard.meta.document_name, guard.meta.doc_id, id, 'deleted')
  res.status(200).json({ id })
}
