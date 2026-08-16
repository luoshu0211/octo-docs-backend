import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Offline unit test for POST /:docId/forward-grant/batch (XIN-1850/1853). Drives
// the batch handler off the Express router stack (mirrors forwardGrantRoutes.test.ts).
// The guard, grant core, and identity are mocked; we assert:
//   - atomic request validation (empty / dup / invalid role / over-cap / bad shape
//     -> 400 and ZERO grant writes)
//   - the human path resolves identities via getUsersBatch ONCE per shard, never
//     scalar getUser per uid; the bot path via getUsersAsBotBatch once
//   - missing / disabled uids -> per-item user_not_found, no grantForwardAccess
//   - a partial grant_failed does NOT roll back earlier successes; later items run
//   - a batch-level identity failure (resolver null) fails closed (502), zero writes
//   - the batch route is registered on the SAME shared forwardGrantRouter that
//     app.ts mounts on both the human (/api/v1/docs) and bot (/v1/bot/docs) trees
vi.mock('../src/api/guard.js', () => ({
  requireDocRole: vi.fn(),
}))
vi.mock('../src/api/services/grantForward.js', () => ({
  grantForwardAccess: vi.fn(async () => ({ finalRole: 'reader', changed: true })),
}))

import { forwardGrantRouter } from '../src/api/routes/forwardGrant.js'
import { requireDocRole } from '../src/api/guard.js'
import { grantForwardAccess } from '../src/api/services/grantForward.js'
import {
  HttpOctoIdentity,
  setOctoIdentity,
  type OctoIdentity,
  type OctoUser,
} from '../src/auth/octoIdentity.js'

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

function batchHandler() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const layer of (forwardGrantRouter as unknown as { stack: any[] }).stack) {
    const route = layer.route
    if (route && route.path === '/:docId/forward-grant/batch' && route.methods?.post) {
      return route.stack[route.stack.length - 1].handle as (req: unknown, res: unknown) => Promise<void>
    }
  }
  throw new Error('forward-grant/batch handler not found')
}

// Human request (req.octoToken set, no botToken).
function humanReq(body: Record<string, unknown>) {
  return { uid: 'u_admin', octoToken: 'tok', params: { docId: 'd_1' }, body } as never
}
// Bot request (req.botToken set by verifyBot).
function botReq(body: Record<string, unknown>) {
  return { uid: 'bot_1', botToken: 'bot-tok', params: { docId: 'd_1' }, body } as never
}

// Build a stub identity whose scalar getUser/getUserAsBot are spies we can assert
// are NEVER called on the batch path, and whose batch resolvers return a uid-keyed
// map (or null to simulate a batch-level identity failure).
function stubIdentity(opts: {
  grantable?: string[]
  batchNull?: boolean
}) {
  const map = new Map<string, OctoUser>()
  for (const uid of opts.grantable ?? []) map.set(uid, { uid, name: uid })
  const getUser = vi.fn(async () => null)
  const getUserAsBot = vi.fn(async () => null)
  const getUsersBatch = vi.fn(async () => (opts.batchNull ? null : map))
  const getUsersAsBotBatch = vi.fn(async () => (opts.batchNull ? null : map))
  const identity = {
    verifyToken: vi.fn(async () => null),
    getUser,
    getUserAsBot,
    getUsers: vi.fn(async () => []),
    getUsersBatch,
    getUsersAsBotBatch,
  } as unknown as OctoIdentity
  setOctoIdentity(identity)
  return { getUser, getUserAsBot, getUsersBatch, getUsersAsBotBatch }
}

const okGuard = {
  meta: { doc_id: 'd_1', document_name: 'doc-d_1', owner_id: 'u_admin' },
  role: 'admin',
} as never

beforeEach(() => {
  vi.mocked(requireDocRole).mockReset()
  vi.mocked(grantForwardAccess).mockReset()
  vi.mocked(grantForwardAccess).mockResolvedValue({ finalRole: 'reader', changed: true })
})

describe('POST /:docId/forward-grant/batch — validation (atomic, zero writes)', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(okGuard))

  it('empty grants -> 400', async () => {
    stubIdentity({})
    const res = mockRes()
    await batchHandler()(humanReq({ grants: [] }), res as never)
    expect(res.statusCode).toBe(400)
    expect(vi.mocked(grantForwardAccess)).not.toHaveBeenCalled()
  })

  it('non-array grants -> 400', async () => {
    stubIdentity({})
    const res = mockRes()
    await batchHandler()(humanReq({ grants: 'nope' }), res as never)
    expect(res.statusCode).toBe(400)
    expect(vi.mocked(grantForwardAccess)).not.toHaveBeenCalled()
  })

  it('duplicate uid -> 400', async () => {
    stubIdentity({ grantable: ['u1'] })
    const res = mockRes()
    await batchHandler()(
      humanReq({ grants: [{ uid: 'u1', role: 'reader' }, { uid: 'u1', role: 'writer' }] }),
      res as never,
    )
    expect(res.statusCode).toBe(400)
    expect(vi.mocked(grantForwardAccess)).not.toHaveBeenCalled()
  })

  it('invalid role (admin) -> 400', async () => {
    stubIdentity({ grantable: ['u1'] })
    const res = mockRes()
    await batchHandler()(humanReq({ grants: [{ uid: 'u1', role: 'admin' }] }), res as never)
    expect(res.statusCode).toBe(400)
    expect(vi.mocked(grantForwardAccess)).not.toHaveBeenCalled()
  })

  it('grant missing uid -> 400', async () => {
    stubIdentity({})
    const res = mockRes()
    await batchHandler()(humanReq({ grants: [{ role: 'reader' }] }), res as never)
    expect(res.statusCode).toBe(400)
    expect(vi.mocked(grantForwardAccess)).not.toHaveBeenCalled()
  })

  it('over 1000 unique uids -> 400', async () => {
    stubIdentity({})
    const grants = Array.from({ length: 1001 }, (_, i) => ({ uid: `u${i}`, role: 'reader' }))
    const res = mockRes()
    await batchHandler()(humanReq({ grants }), res as never)
    expect(res.statusCode).toBe(400)
    expect(vi.mocked(grantForwardAccess)).not.toHaveBeenCalled()
  })

  it('blocked guard (non admin) short-circuits before any validation/write', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(null) // already wrote 403
    const spies = stubIdentity({})
    const res = mockRes()
    await batchHandler()(humanReq({ grants: [{ uid: 'u1', role: 'reader' }] }), res as never)
    expect(spies.getUsersBatch).not.toHaveBeenCalled()
    expect(vi.mocked(grantForwardAccess)).not.toHaveBeenCalled()
  })
})

describe('POST /:docId/forward-grant/batch — once-per-shard identity resolution', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(okGuard))

  it('HUMAN path calls getUsersBatch ONCE with all uids, never scalar getUser', async () => {
    const spies = stubIdentity({ grantable: ['u1', 'u2', 'u3'] })
    const res = mockRes()
    await batchHandler()(
      humanReq({
        grants: [
          { uid: 'u1', role: 'reader' },
          { uid: 'u2', role: 'writer' },
          { uid: 'u3', role: 'commenter' },
        ],
      }),
      res as never,
    )
    expect(res.statusCode).toBe(200)
    expect(spies.getUsersBatch).toHaveBeenCalledTimes(1)
    expect(spies.getUsersBatch).toHaveBeenCalledWith(['u1', 'u2', 'u3'], 'tok')
    expect(spies.getUser).not.toHaveBeenCalled()
    expect(spies.getUsersAsBotBatch).not.toHaveBeenCalled()
    expect(vi.mocked(grantForwardAccess)).toHaveBeenCalledTimes(3)
    expect(res.body).toMatchObject({ ok: true, granted: 3, failed: 0 })
  })

  it('BOT path calls getUsersAsBotBatch ONCE with the bot token, never scalar getUserAsBot', async () => {
    const spies = stubIdentity({ grantable: ['u1', 'u2'] })
    const res = mockRes()
    await batchHandler()(
      botReq({ grants: [{ uid: 'u1', role: 'reader' }, { uid: 'u2', role: 'writer' }] }),
      res as never,
    )
    expect(res.statusCode).toBe(200)
    expect(spies.getUsersAsBotBatch).toHaveBeenCalledTimes(1)
    expect(spies.getUsersAsBotBatch).toHaveBeenCalledWith(['u1', 'u2'], 'bot-tok')
    expect(spies.getUserAsBot).not.toHaveBeenCalled()
    expect(spies.getUsersBatch).not.toHaveBeenCalled()
    expect(vi.mocked(grantForwardAccess)).toHaveBeenCalledTimes(2)
  })

  it('batch-level identity failure (resolver null) fails closed: 502, zero writes', async () => {
    const spies = stubIdentity({ batchNull: true })
    const res = mockRes()
    await batchHandler()(humanReq({ grants: [{ uid: 'u1', role: 'reader' }] }), res as never)
    expect(res.statusCode).toBe(502)
    expect(spies.getUsersBatch).toHaveBeenCalledTimes(1)
    expect(vi.mocked(grantForwardAccess)).not.toHaveBeenCalled()
  })
})

describe('POST /:docId/forward-grant/batch — per-item semantics', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(okGuard))

  it('missing/disabled uids -> user_not_found and NO grant call; found uids granted', async () => {
    // Only u1 and u3 are grantable; u2 is missing/disabled (absent from lookup).
    stubIdentity({ grantable: ['u1', 'u3'] })
    const res = mockRes()
    await batchHandler()(
      humanReq({
        grants: [
          { uid: 'u1', role: 'reader' },
          { uid: 'u2', role: 'writer' },
          { uid: 'u3', role: 'commenter' },
        ],
      }),
      res as never,
    )
    expect(res.statusCode).toBe(200)
    // grant only called for the two grantable uids, never for u2.
    expect(vi.mocked(grantForwardAccess)).toHaveBeenCalledTimes(2)
    const calledUids = vi.mocked(grantForwardAccess).mock.calls.map((c) => (c[0] as { uid: string }).uid)
    expect(calledUids).toEqual(['u1', 'u3'])
    expect(res.body).toMatchObject({ ok: false, granted: 2, failed: 1 })
    expect((res.body as { results: unknown[] }).results).toEqual([
      { uid: 'u1', status: 'ok', role: 'reader', changed: true },
      { uid: 'u2', status: 'user_not_found' },
      { uid: 'u3', status: 'ok', role: 'reader', changed: true },
    ])
  })

  it('a partial grant_failed does NOT roll back earlier successes; later items still processed', async () => {
    stubIdentity({ grantable: ['u1', 'u2', 'u3'] })
    // u1 ok, u2 throws (grant_failed), u3 still processed and ok.
    vi.mocked(grantForwardAccess)
      .mockResolvedValueOnce({ finalRole: 'reader', changed: true })
      .mockRejectedValueOnce(new Error('db write failed'))
      .mockResolvedValueOnce({ finalRole: 'writer', changed: false })
    const res = mockRes()
    await batchHandler()(
      humanReq({
        grants: [
          { uid: 'u1', role: 'reader' },
          { uid: 'u2', role: 'writer' },
          { uid: 'u3', role: 'writer' },
        ],
      }),
      res as never,
    )
    expect(res.statusCode).toBe(200)
    expect(vi.mocked(grantForwardAccess)).toHaveBeenCalledTimes(3) // u3 not skipped
    expect(res.body).toMatchObject({ ok: false, granted: 2, failed: 1 })
    expect((res.body as { results: unknown[] }).results).toEqual([
      { uid: 'u1', status: 'ok', role: 'reader', changed: true },
      { uid: 'u2', status: 'grant_failed' },
      { uid: 'u3', status: 'ok', role: 'writer', changed: false },
    ])
  })
})

describe('shared router exposure', () => {
  it('the batch route is registered on the same forwardGrantRouter mounted on both trees', () => {
    // app.ts mounts this single forwardGrantRouter instance on the human tree
    // (api.use(forwardGrantRouter) -> /api/v1/docs) and the bot tree
    // (botApi.use(forwardGrantRouter) -> /v1/bot/docs). Proving the route exists
    // on the router proves it is exposed on BOTH mounts.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const paths = (forwardGrantRouter as unknown as { stack: any[] }).stack
      .map((l) => l.route?.path)
      .filter(Boolean)
    expect(paths).toContain('/:docId/forward-grant') // single route untouched
    expect(paths).toContain('/:docId/forward-grant/batch') // sibling batch route
  })
})

// End-to-end bot space-prefix regression (XIN-1866). Unlike the tests above,
// this drives the REAL HttpOctoIdentity.getUsersAsBotBatch against a stubbed
// octo-server that mirrors PR #772: the bot batch route strips a leading
// `s<digits>_` prefix and returns users keyed by the BASE uid. It proves the
// batch handler now GRANTS a space-prefixed bot forward-grant (was
// user_not_found), echoes the ORIGINAL requested uid per item, and never
// collapses distinct requested strings that share one base uid.
describe('POST /:docId/forward-grant/batch — bot space-prefix path (XIN-1866, real resolver)', () => {
  afterEach(() => vi.unstubAllGlobals())

  // octo-server bot batch: strip a leading s<digits>_ and echo the BASE uid.
  function stubOctoServerBotBatch(enabledBases: Set<string>) {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('http://octo.test/v1/bot/users/batch')
      const sent = (JSON.parse(init.body as string) as { uids: string[] }).uids
      const bases = new Set(sent.map((u) => u.replace(/^s\d+_/, '')))
      const users = [...bases]
        .filter((b) => enabledBases.has(b))
        .map((uid) => ({ uid, status: 1, name: uid }))
      return {
        ok: true,
        status: 200,
        json: async () => ({ users, missing_uids: [] }),
      } as unknown as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(okGuard))

  it('grants a space-prefixed bot forward-grant (regression: was user_not_found)', async () => {
    setOctoIdentity(new HttpOctoIdentity('http://octo.test'))
    stubOctoServerBotBatch(new Set(['alice']))
    const res = mockRes()

    await batchHandler()(botReq({ grants: [{ uid: 's1_alice', role: 'reader' }] }), res as never)

    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({ ok: true, granted: 1, failed: 0 })
    expect((res.body as { results: unknown[] }).results).toEqual([
      { uid: 's1_alice', status: 'ok', role: 'reader', changed: true },
    ])
    // The grant is issued for the ORIGINAL requested uid (mirrors the single route).
    expect(vi.mocked(grantForwardAccess)).toHaveBeenCalledWith(
      expect.objectContaining({ uid: 's1_alice' }),
    )
  })

  it('mixed batch: prefixed + bare + collapse-siblings + genuinely-missing map per item, no collapse', async () => {
    setOctoIdentity(new HttpOctoIdentity('http://octo.test'))
    // alice resolves; ghost does not.
    stubOctoServerBotBatch(new Set(['alice']))
    const res = mockRes()

    await batchHandler()(
      botReq({
        grants: [
          { uid: 's1_alice', role: 'reader' },
          { uid: 's2_alice', role: 'writer' }, // same base as s1_alice — must NOT collapse
          { uid: 'alice', role: 'commenter' }, // bare base — resolves under itself
          { uid: 's3_ghost', role: 'reader' }, // base has no enabled row -> user_not_found
        ],
      }),
      res as never,
    )

    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({ ok: false, granted: 3, failed: 1 })
    expect((res.body as { results: unknown[] }).results).toEqual([
      { uid: 's1_alice', status: 'ok', role: 'reader', changed: true },
      { uid: 's2_alice', status: 'ok', role: 'reader', changed: true },
      { uid: 'alice', status: 'ok', role: 'reader', changed: true },
      { uid: 's3_ghost', status: 'user_not_found' },
    ])
    // Every resolved original uid produced its own grant; the missing one did not.
    const grantedUids = vi
      .mocked(grantForwardAccess)
      .mock.calls.map((c) => (c[0] as { uid: string }).uid)
    expect(grantedUids).toEqual(['s1_alice', 's2_alice', 'alice'])
  })
})
