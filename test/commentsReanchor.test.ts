import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit test, mirroring comments.test.ts: mock the auth guard and the MySQL pool so the real
// docCommentRepo and route handler run without live infra.
vi.mock('../src/api/guard.js', () => ({
  requireDocRole: vi.fn(),
}))
vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(async () => []),
  transaction: vi.fn(),
}))
// The route's import graph reaches src/db/kafka.ts, which requires `kafkajs`. That package is declared
// in package.json but absent from the shared node_modules this worktree links to, so loading it fails
// before any test runs — the existing comments.test.ts fails the same way in this environment. Stubbing
// it keeps the failure from masking real results; nothing here exercises the queue.
vi.mock('../src/db/kafka.js', () => ({
  getKafkaProducer: vi.fn(),
  publish: vi.fn(async () => undefined),
}))
// The handler must notify other connected clients; mocked so the assertions below can see the calls
// without a live Redis.
vi.mock('../src/api/services/commentEvents.js', () => ({
  publishCommentMutation: vi.fn(async () => undefined),
}))

import { reanchorCommentsHandler } from '../src/api/routes/comments.js'
import { requireDocRole } from '../src/api/guard.js'
import { docCommentRepo } from '../src/db/repos/docCommentRepo.js'
import { transaction } from '../src/db/pool.js'
import { publishCommentMutation } from '../src/api/services/commentEvents.js'

interface MockRes {
  statusCode: number
  body: unknown
  status(c: number): MockRes
  json(b: unknown): MockRes
}

function mockRes(): MockRes {
  return {
    statusCode: 0,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c
      return this
    },
    json(b: unknown) {
      this.body = b
      return this
    },
  }
}

function req(opts: { uid?: string; body?: unknown; docId?: string }) {
  return {
    uid: opts.uid ?? 'u_author',
    spaceId: 's1',
    params: { docId: opts.docId ?? 'd_1' },
    body: opts.body,
    query: {},
  } as never
}

const guardFor = (role: string, docType = 'sheet') =>
  ({ meta: { doc_id: 'd_1', document_name: 'octo:s:f:d_1', doc_type: docType }, role }) as never

/** base64 of a live sheet cell anchor — the shape the client actually sends. */
const cellAnchor = (raw = 'default!4:2') => Buffer.from(raw).toString('base64')

/** A stored thread root owned by `u_author`. */
const rootBy = (authorUid: string, id = 7) =>
  ({
    id,
    docId: 'd_1',
    parentId: null,
    authorUid,
    deleted: false,
    anchorText: 'C5',
  }) as never

function anchorsBody(ids: number[], raw?: string) {
  return { anchors: ids.map((id) => ({ id, anchorStart: cellAnchor(raw), anchorEnd: cellAnchor(raw) })) }
}

beforeEach(() => {
  // restoreAllMocks, not clearAllMocks: `clear` only wipes call records and leaves spy IMPLEMENTATIONS
  // in place, so a stubbed docCommentRepo.updateAnchors from an earlier test would still be stubbed in
  // the repo-level test below — which would then assert against the stub instead of the real code and
  // pass for the wrong reason.
  vi.restoreAllMocks()
  vi.mocked(transaction).mockImplementation((async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ query: vi.fn(async () => []) })) as never)
})

describe('reanchor — permission is author OR writer', () => {
  // The floor itself. requireDocRole is mocked in every other case here, so no other test in this file
  // can see which floor the handler asks for — changing it would leave all of them green. This case
  // asserts the argument, so lowering the floor back to 'reader' fails here and only here. It matters:
  // the module contract (comments.ts:20) is "Readers are read-only", and reanchor writes to the DB, so
  // a 'reader' floor would make this the one write path a read-only member could reach.
  it('demands at least `commenter`, like every other mutation in this module', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guardFor('commenter'))
    vi.spyOn(docCommentRepo, 'getById').mockResolvedValue(rootBy('u_author'))
    vi.spyOn(docCommentRepo, 'updateAnchors').mockResolvedValue(undefined)
    await reanchorCommentsHandler(req({ uid: 'u_author', body: anchorsBody([7]) }), mockRes() as never)
    expect(vi.mocked(requireDocRole).mock.calls[0]![3]).toBe('commenter')
  })

  // Failure containment. This handler is async, and Express 4 does not funnel a rejected promise into
  // the central error handler (app.ts:213) — it escapes to `unhandledRejection`, which index.ts:36-38
  // logs while keeping the process alive. With no try/catch, `res` is never written and the caller hangs
  // until its own timeout instead of seeing a 500. Asserting the STATUS (not just "it didn't throw") is
  // the part that matters: an unwrapped handler makes this case reject, and a handler that swallows the
  // error without responding leaves statusCode unset.
  it('answers 500 instead of hanging when the batch write fails', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guardFor('writer'))
    vi.spyOn(docCommentRepo, 'getById').mockResolvedValue(rootBy('u_author'))
    vi.spyOn(docCommentRepo, 'updateAnchors').mockRejectedValue(new Error('ER_LOCK_DEADLOCK'))
    const res = mockRes()
    await expect(
      reanchorCommentsHandler(req({ uid: 'u_writer', body: anchorsBody([7]) }), res as never),
    ).resolves.toBeUndefined()
    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({ error: 'internal_error' })
  })

  // Not writer-only: creating a comment requires `commenter`, a tier that sits BETWEEN reader and
  // writer (roleRank in permission/role.ts; the stored 1/2/3/4 is not the ranking), so an author may
  // hold no writer role at all. Writer-only would mean the author of a comment cannot repair their own
  // anchor, and a comment whose author has left could never be repaired by anyone.
  it('the author can re-anchor their own comment without a writer role', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guardFor('commenter'))
    vi.spyOn(docCommentRepo, 'getById').mockResolvedValue(rootBy('u_author'))
    const spy = vi.spyOn(docCommentRepo, 'updateAnchors').mockResolvedValue(undefined)
    const res = mockRes()
    await reanchorCommentsHandler(req({ uid: 'u_author', body: anchorsBody([7]) }), res as never)
    expect(res.statusCode).toBe(200)
    expect(spy).toHaveBeenCalledOnce()
  })

  // Not author-only: re-anchoring repairs an INDEX, not the author's words. A writer can already delete
  // the very row the comment points at, so letting them fix the resulting anchor adds no capability.
  it('a writer can re-anchor someone ELSE\'s comment', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guardFor('writer'))
    vi.spyOn(docCommentRepo, 'getById').mockResolvedValue(rootBy('u_somebody_else'))
    const spy = vi.spyOn(docCommentRepo, 'updateAnchors').mockResolvedValue(undefined)
    const res = mockRes()
    await reanchorCommentsHandler(req({ uid: 'u_me', body: anchorsBody([7]) }), res as never)
    expect(res.statusCode).toBe(200)
    expect(spy).toHaveBeenCalledOnce()
  })

  it('a non-writer cannot re-anchor a comment they did not write', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guardFor('reader'))
    vi.spyOn(docCommentRepo, 'getById').mockResolvedValue(rootBy('u_somebody_else'))
    const spy = vi.spyOn(docCommentRepo, 'updateAnchors').mockResolvedValue(undefined)
    const res = mockRes()
    await reanchorCommentsHandler(req({ uid: 'u_me', body: anchorsBody([7]) }), res as never)
    expect(res.statusCode).toBe(403)
    expect(spy).not.toHaveBeenCalled()
  })

  // Authorisation runs over the WHOLE batch before any write: a mixed batch must not half-apply.
  it('rejects the entire batch when one entry is unauthorised', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guardFor('reader'))
    vi.spyOn(docCommentRepo, 'getById').mockImplementation((async (id: number) =>
      rootBy(id === 7 ? 'u_me' : 'u_other', id)) as never)
    const spy = vi.spyOn(docCommentRepo, 'updateAnchors').mockResolvedValue(undefined)
    const res = mockRes()
    await reanchorCommentsHandler(req({ uid: 'u_me', body: anchorsBody([7, 8]) }), res as never)
    expect(res.statusCode).toBe(403)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('reanchor — anchor_text is never written', () => {
  // The stored snapshot is the evidence trail: if an anchor is ever rewritten to the wrong cell, the
  // frozen original text stops agreeing with whatever now occupies the new coordinate, which makes the
  // mistake visible. A re-anchor that refreshed it would erase exactly that signal.
  it('passes only id + the two anchors to the repo', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guardFor('writer'))
    vi.spyOn(docCommentRepo, 'getById').mockResolvedValue(rootBy('u_author'))
    const spy = vi.spyOn(docCommentRepo, 'updateAnchors').mockResolvedValue(undefined)
    const res = mockRes()
    await reanchorCommentsHandler(req({ body: anchorsBody([7]) }), res as never)
    expect(res.statusCode).toBe(200)
    const [, anchors] = spy.mock.calls[0]!
    expect(Object.keys(anchors[0]!).sort()).toEqual(['anchorEnd', 'anchorStart', 'id'])
  })

  it('ignores an anchorText the client sends anyway', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guardFor('writer'))
    vi.spyOn(docCommentRepo, 'getById').mockResolvedValue(rootBy('u_author'))
    const spy = vi.spyOn(docCommentRepo, 'updateAnchors').mockResolvedValue(undefined)
    const res = mockRes()
    await reanchorCommentsHandler(
      req({
        body: { anchors: [{ id: 7, anchorStart: cellAnchor(), anchorEnd: cellAnchor(), anchorText: 'HACK' }] },
      }),
      res as never,
    )
    expect(res.statusCode).toBe(200)
    const [, anchors] = spy.mock.calls[0]!
    expect(anchors[0]).not.toHaveProperty('anchorText')
  })
})

describe('reanchor — sheet anchors are not blocked by the board gate', () => {
  // The shared validator is doc_type aware, but only for BOARD anchors. Sheet anchors are not JSON, so
  // they pass untouched. A 'doc'-only gate here (like the anchorText resolution path uses) would 409
  // every sheet — i.e. exactly the case this endpoint exists for.
  it.each([
    ['live cell', 'default!4:2'],
    ['orphaned cell', 'default!4:2!x'],
    ['file level', '__file__!*'],
  ])('%s is accepted for a sheet', async (_label, raw) => {
    vi.mocked(requireDocRole).mockResolvedValue(guardFor('writer', 'sheet'))
    vi.spyOn(docCommentRepo, 'getById').mockResolvedValue(rootBy('u_author'))
    vi.spyOn(docCommentRepo, 'updateAnchors').mockResolvedValue(undefined)
    const res = mockRes()
    await reanchorCommentsHandler(req({ body: anchorsBody([7], raw) }), res as never)
    expect(res.statusCode).toBe(200)
  })

  it('409s a doc_type this build does not know', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guardFor('writer', 'something_new'))
    const res = mockRes()
    await reanchorCommentsHandler(req({ body: anchorsBody([7]) }), res as never)
    expect(res.statusCode).toBe(409)
  })
})

describe('reanchor — input validation rejects the whole batch', () => {
  beforeEach(() => {
    vi.mocked(requireDocRole).mockResolvedValue(guardFor('writer'))
    vi.spyOn(docCommentRepo, 'getById').mockResolvedValue(rootBy('u_author'))
  })

  it.each([
    ['no anchors field', {}],
    ['empty list', { anchors: [] }],
    ['not a list', { anchors: 'nope' }],
  ])('400s on %s', async (_label, body) => {
    const res = mockRes()
    await reanchorCommentsHandler(req({ body }), res as never)
    expect(res.statusCode).toBe(400)
  })

  it.each([
    ['a non-numeric id', { anchors: [{ id: 'x', anchorStart: cellAnchor(), anchorEnd: cellAnchor() }] }],
    ['a zero id', { anchors: [{ id: 0, anchorStart: cellAnchor(), anchorEnd: cellAnchor() }] }],
    ['a missing anchor', { anchors: [{ id: 7, anchorStart: cellAnchor() }] }],
    ['non-base64', { anchors: [{ id: 7, anchorStart: 'not base64!!', anchorEnd: 'not base64!!' }] }],
  ])('400s on %s', async (_label, body) => {
    const spy = vi.spyOn(docCommentRepo, 'updateAnchors').mockResolvedValue(undefined)
    const res = mockRes()
    await reanchorCommentsHandler(req({ body }), res as never)
    expect(res.statusCode).toBe(400)
    expect(spy).not.toHaveBeenCalled()
  })

  // A repeated id has no defined outcome (last write wins by accident) — refuse rather than pick one.
  it('400s on a duplicate id in one batch', async () => {
    const res = mockRes()
    await reanchorCommentsHandler(req({ body: anchorsBody([7, 7]) }), res as never)
    expect(res.statusCode).toBe(400)
    expect(res.body).toMatchObject({ error: 'duplicate_id' })
  })

  it('400s past the batch cap', async () => {
    const res = mockRes()
    await reanchorCommentsHandler(
      req({ body: anchorsBody(Array.from({ length: 201 }, (_, i) => i + 1)) }),
      res as never,
    )
    expect(res.statusCode).toBe(400)
    expect(res.body).toMatchObject({ error: 'too_many_anchors' })
  })

  // `Array.isArray` on the container says nothing about the ELEMENTS. Before the element-shape check,
  // `[null]` / `[undefined]` dereferenced null and threw out of the handler — and an async throw in
  // Express 4 never reaches the error middleware, so the client got NO response and the socket hung.
  // Asserting the 400 alone is not enough: a handler that throws would fail with the TypeError rather
  // than a wrong status, so each case also pins that the write never happened.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a scalar', 7],
    ['a string', 'x'],
    ['a nested array', [1, 2]],
  ])('400s on %s array element instead of throwing out of the handler', async (_label, element) => {
    const spy = vi.spyOn(docCommentRepo, 'updateAnchors').mockResolvedValue(undefined)
    const res = mockRes()
    await expect(
      reanchorCommentsHandler(req({ body: { anchors: [element] } }), res as never),
    ).resolves.toBeUndefined()
    expect(res.statusCode).toBe(400)
    expect(res.body).toMatchObject({ error: 'invalid_id' })
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('reanchor — target must be a live thread root in this doc', () => {
  beforeEach(() => {
    vi.mocked(requireDocRole).mockResolvedValue(guardFor('writer'))
  })

  it.each([
    ['a missing comment', null],
    ['another doc\'s comment', { ...(rootBy('u_author') as object), docId: 'd_other' }],
    ['a deleted comment', { ...(rootBy('u_author') as object), deleted: true }],
  ])('404s on %s (without leaking which)', async (_label, stored) => {
    vi.spyOn(docCommentRepo, 'getById').mockResolvedValue(stored as never)
    const spy = vi.spyOn(docCommentRepo, 'updateAnchors').mockResolvedValue(undefined)
    const res = mockRes()
    await reanchorCommentsHandler(req({ body: anchorsBody([7]) }), res as never)
    expect(res.statusCode).toBe(404)
    expect(spy).not.toHaveBeenCalled()
  })

  // Replies carry no anchor by schema invariant (chk_doc_comment_anchor), so the UPDATE would match
  // nothing anyway; refusing up front says why instead of silently doing nothing.
  it('400s when the target is a reply', async () => {
    vi.spyOn(docCommentRepo, 'getById').mockResolvedValue({
      ...(rootBy('u_author') as object),
      parentId: 3,
    } as never)
    const spy = vi.spyOn(docCommentRepo, 'updateAnchors').mockResolvedValue(undefined)
    const res = mockRes()
    await reanchorCommentsHandler(req({ body: anchorsBody([7]) }), res as never)
    expect(res.statusCode).toBe(400)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('reanchor — repo layer', () => {
  /** Capture the SQL + params every UPDATE ran with, inside a real transaction call. */
  async function captureWrites(docId: string, ids: number[]) {
    const queries: Array<{ sql: string; params: unknown[] }> = []
    vi.mocked(transaction).mockImplementation((async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        query: vi.fn(async (sql: string, params: unknown[]) => {
          queries.push({ sql, params })
          return []
        }),
      })) as never)
    await docCommentRepo.updateAnchors(
      docId,
      ids.map((id) => ({ id, anchorStart: Buffer.from(`s${id}`), anchorEnd: Buffer.from(`e${id}`) })),
    )
    return queries
  }

  // Each guarantee below gets its OWN test on purpose. An earlier version asserted all three in one
  // case, so mutating away either safety property failed the same single test — meaning a future edit
  // to that one test for an unrelated reason would silently drop TWO guarantees at once.
  it('runs every UPDATE inside a single transaction', async () => {
    const queries = await captureWrites('d_1', [7, 8])
    expect(vi.mocked(transaction)).toHaveBeenCalledOnce()
    expect(queries).toHaveLength(2)
  })

  // Deadlock guard. Row locks are held to commit, so two overlapping batches arriving in opposite
  // caller order form a lock cycle. The repo must therefore impose its own order rather than trust the
  // array it was handed. Passing DESCENDING ids and asserting the emitted statements come out ASCENDING
  // is what distinguishes "sorted" from "happened to already be sorted" — feed it [7,8] and a repo with
  // no sort at all passes.
  it('locks rows in ascending id order regardless of the order the caller passed', async () => {
    const queries = await captureWrites('d_1', [9, 3, 11, 5])
    // params are [anchorStart, anchorEnd, id, docId] — index 2 is the id.
    expect(queries.map((q) => q.params[2])).toEqual([3, 5, 9, 11])
  })

  // The stored snapshot is the evidence trail for a mis-anchored comment (frozen text vs whatever now
  // occupies the new coordinate). An UPDATE that refreshed it would erase that signal, so the column
  // must not appear in the statement at all.
  it('never writes anchor_text', async () => {
    const queries = await captureWrites('d_1', [7])
    for (const q of queries) expect(q.sql).not.toContain('anchor_text')
  })

  // Defence in depth: the route already bounded the doc, but a cross-document write must not be
  // reachable through a single bad param.
  it('scopes every UPDATE by doc_id', async () => {
    const queries = await captureWrites('d_1', [7, 8])
    for (const q of queries) {
      expect(q.sql).toContain('doc_id = ?')
      expect(q.params).toContain('d_1')
    }
  })

  // Replies carry no anchor by schema invariant (chk_doc_comment_anchor); matching them would attempt a
  // write the database would reject anyway.
  it('excludes replies and soft-deleted rows', async () => {
    const queries = await captureWrites('d_1', [7])
    for (const q of queries) {
      expect(q.sql).toContain('parent_id IS NULL')
      expect(q.sql).toContain('deleted = 0')
    }
  })

  it('does not open a transaction for an empty list', async () => {
    await docCommentRepo.updateAnchors('d_1', [])
    expect(vi.mocked(transaction)).not.toHaveBeenCalled()
  })
})

// Live-view invalidation. Every other mutation handler in comments.ts publishes to the comment-events
// channel so the collab server can push `comment.changed` to the OTHER connected clients; this handler
// used to be the only one that skipped it, which broke the endpoint on the exact path it exists for —
// user A commits new coordinates while user B, same sheet open, keeps rendering pins at the pre-edit
// cells with nothing to tell it otherwise. The two screens disagree with no visible cause, which is a
// worse failure than the misplaced anchor this endpoint repairs. Asserted here rather than left to
// review, because nothing else in the suite would notice the publish disappearing again.
describe('reanchor — notifies the other clients', () => {
  it('publishes one update per re-anchored thread root', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guardFor('writer'))
    vi.spyOn(docCommentRepo, 'getById').mockImplementation((async (id: number) =>
      ({ ...rootBy('u_other'), id })) as never)
    vi.spyOn(docCommentRepo, 'updateAnchors').mockResolvedValue(undefined)
    const res = mockRes()
    await reanchorCommentsHandler(req({ uid: 'u_writer', body: anchorsBody([7, 8, 9]) }), res as never)
    expect(res.statusCode).toBe(200)
    expect(vi.mocked(publishCommentMutation)).toHaveBeenCalledTimes(3)
    for (const id of [7, 8, 9]) {
      expect(vi.mocked(publishCommentMutation)).toHaveBeenCalledWith(
        'octo:s:f:d_1',
        'd_1',
        id,
        'updated',
      )
    }
  })

  // A rejected batch must not announce a change that never happened: a client told to refresh would
  // re-read the same pre-edit anchors and could reasonably conclude the server had accepted the move.
  it('publishes nothing when the batch is rejected', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guardFor('reader'))
    vi.spyOn(docCommentRepo, 'getById').mockResolvedValue(rootBy('u_other'))
    const spy = vi.spyOn(docCommentRepo, 'updateAnchors').mockResolvedValue(undefined)
    const res = mockRes()
    await reanchorCommentsHandler(req({ uid: 'u_me', body: anchorsBody([7]) }), res as never)
    expect(res.statusCode).toBe(403)
    expect(spy).not.toHaveBeenCalled()
    expect(vi.mocked(publishCommentMutation)).not.toHaveBeenCalled()
  })
})
