import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit test for the HARD requirement that reporting an @Bot mention can
// NEVER fail comment creation. The guard and the MySQL pool are mocked, and
// reportBotMentions is replaced with failing doubles (rejecting, and throwing
// synchronously) so we can assert the 201 survives either way — and that no
// unhandled rejection escapes the detached side channel.
vi.mock('../src/api/guard.js', () => ({
  requireDocRole: vi.fn(),
}))
vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(async () => []),
  transaction: vi.fn(),
}))
vi.mock('../src/api/services/docsNotify.js', () => ({
  notifyDocMentioned: vi.fn(async () => 0),
}))
vi.mock('../src/api/services/commentEvents.js', () => ({
  publishCommentMutation: vi.fn(async () => {}),
}))
vi.mock('../src/api/services/botMention.js', () => ({
  reportBotMentions: vi.fn(),
}))
vi.mock('../src/collab/anchorResolve.js', async () => {
  const actual = await vi.importActual<typeof import('../src/collab/anchorResolve.js')>(
    '../src/collab/anchorResolve.js',
  )
  return { ...actual, resolveAnchorFromLiveDoc: vi.fn() }
})

import { createCommentHandler } from '../src/api/routes/comments.js'
import { requireDocRole } from '../src/api/guard.js'
import { reportBotMentions } from '../src/api/services/botMention.js'
import { docCommentRepo } from '../src/db/repos/docCommentRepo.js'

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

function req(body: unknown, over: Record<string, unknown> = {}) {
  return {
    uid: 'u-human',
    spaceId: 's1',
    octoToken: 'tok',
    ownedBots: ['bot-1'],
    params: { docId: 'doc-1' },
    body,
    query: {},
    ...over,
  } as never
}

const guardOk = {
  meta: {
    doc_id: 'doc-1',
    document_name: 'octo:s1:f1:doc-1',
    doc_type: 'doc',
    title: 'Doc',
    space_id: 's1',
    status: 1,
  },
  role: 'writer',
}

/** Collect unhandled rejections for the duration of one assertion. */
async function withUnhandledRejectionWatch(fn: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    seen.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)
  try {
    await fn()
    // Let microtasks + one macrotask turn flush so a detached rejection would surface.
    await new Promise((r) => setTimeout(r, 10))
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
  return seen
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(requireDocRole as ReturnType<typeof vi.fn>).mockResolvedValue(guardOk)
  vi.spyOn(docCommentRepo, 'createReplyIfRoot').mockResolvedValue(101)
  vi.spyOn(docCommentRepo, 'create').mockResolvedValue(202)
})

describe('bot-mention reporting never breaks comment creation', () => {
  it('a REJECTING report still returns 201 for a reply, with no unhandled rejection', async () => {
    ;(reportBotMentions as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('octo-server down'))
    const res = mockRes()
    const unhandled = await withUnhandledRejectionWatch(async () => {
      await createCommentHandler(
        req({ body: 'hi @[user:bot-1:A]', parentId: 5 }),
        res as never,
      )
    })
    expect(res.statusCode).toBe(201)
    expect(res.body).toEqual({ id: 101 })
    expect(unhandled).toEqual([])
  })

  it('a SYNCHRONOUSLY THROWING report still returns 201 for a reply', async () => {
    ;(reportBotMentions as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('sync boom')
    })
    const res = mockRes()
    const unhandled = await withUnhandledRejectionWatch(async () => {
      await createCommentHandler(
        req({ body: 'hi @[user:bot-1:A]', parentId: 5 }),
        res as never,
      )
    })
    expect(res.statusCode).toBe(201)
    expect(res.body).toEqual({ id: 101 })
    expect(unhandled).toEqual([])
  })

  it('a REJECTING report still returns 201 for a ROOT comment', async () => {
    ;(reportBotMentions as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('octo-server down'))
    const res = mockRes()
    const unhandled = await withUnhandledRejectionWatch(async () => {
      await createCommentHandler(
        req({
          body: 'hi @[user:bot-1:A]',
          anchorStart: Buffer.from([1, 2, 3]).toString('base64'),
          anchorEnd: Buffer.from([4, 5, 6]).toString('base64'),
        }),
        res as never,
      )
    })
    expect(res.statusCode).toBe(201)
    expect(res.body).toEqual({ id: 202 })
    expect(unhandled).toEqual([])
  })

  it('passes the committed comment id, the resolved role and ownedBots through', async () => {
    ;(reportBotMentions as ReturnType<typeof vi.fn>).mockResolvedValue({
      accepted: 1,
      skipped: 0,
      failed: 0,
    })
    const res = mockRes()
    await createCommentHandler(req({ body: 'hi @[user:bot-1:A]', parentId: 5 }), res as never)
    expect(res.statusCode).toBe(201)
    expect(reportBotMentions).toHaveBeenCalledTimes(1)
    expect(reportBotMentions).toHaveBeenCalledWith(
      expect.objectContaining({
        docId: 'doc-1',
        commentId: 101, // the id of the row that was actually committed
        parentId: 5,
        spaceId: 's1',
        authorUid: 'u-human',
        authorRole: 'writer', // guard.role, resolved through the shared permission seam
        ownedBots: ['bot-1'],
        // The author's own session token, forwarded so the friend-bot half of the
        // relationship rule can be resolved (GET /v1/robot/my_bots).
        callerToken: 'tok',
        body: 'hi @[user:bot-1:A]',
        isBotCaller: false,
      }),
    )
  })

  it('a ROOT comment reports no parentId (octo-server derives the thread)', async () => {
    ;(reportBotMentions as ReturnType<typeof vi.fn>).mockResolvedValue({
      accepted: 1,
      skipped: 0,
      failed: 0,
    })
    const res = mockRes()
    await createCommentHandler(
      req({
        body: 'hi @[user:bot-1:A]',
        anchorStart: Buffer.from([1, 2, 3]).toString('base64'),
        anchorEnd: Buffer.from([4, 5, 6]).toString('base64'),
      }),
      res as never,
    )
    expect(res.statusCode).toBe(201)
    const arg = (reportBotMentions as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<
      string,
      unknown
    >
    expect(arg.commentId).toBe(202)
    expect(arg.parentId).toBeUndefined()
  })

  it('marks a bot-mount caller so a bot-authored comment is never reported as from_uid', async () => {
    ;(reportBotMentions as ReturnType<typeof vi.fn>).mockResolvedValue({
      accepted: 0,
      skipped: 0,
      failed: 0,
    })
    const res = mockRes()
    await createCommentHandler(
      req({ body: 'hi @[user:bot-1:A]', parentId: 5 }, { botToken: 'bt', ownedBots: undefined }),
      res as never,
    )
    expect(res.statusCode).toBe(201)
    expect(reportBotMentions).toHaveBeenCalledWith(
      expect.objectContaining({ isBotCaller: true, ownedBots: [] }),
    )
  })

  it('does not report when comment creation itself failed (reply to a missing root)', async () => {
    vi.spyOn(docCommentRepo, 'createReplyIfRoot').mockResolvedValue(null)
    const res = mockRes()
    await createCommentHandler(req({ body: 'hi @[user:bot-1:A]', parentId: 5 }), res as never)
    expect(res.statusCode).toBe(404)
    expect(reportBotMentions).not.toHaveBeenCalled()
  })
})
