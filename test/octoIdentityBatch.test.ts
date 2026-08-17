import { describe, it, expect, vi, afterEach } from 'vitest'
import { HttpOctoIdentity, OCTO_SERVER_BATCH_MAX_UIDS } from '../src/auth/octoIdentity.js'
import { config } from '../src/config/env.js'

// Batch identity resolvers (XIN-1850/1853). getUsersBatch (human) and
// getUsersAsBotBatch (bot) each call octo-server's frozen POST batch endpoints
// ONCE for the whole uid set and return a uid-keyed lookup of the GRANTABLE
// users only (present AND enabled). The two failure granularities are asserted:
//   - per-row not-grantable (missing / disabled / malformed) => absent from map
//   - batch-level failure (transport / non-200 / malformed body) => null (the
//     forward-grant handler then fails closed before any write)
//
// octo-server frozen response shape:
//   { users: [{ uid, status, name?, robot? }], missing_uids: [...] }
// status === 1 marks an enabled account; any other status is non-grantable.

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HttpOctoIdentity.getUsersBatch (human)', () => {
  it('resolves many uids in ONE call and returns a uid-keyed grantable lookup', async () => {
    expect(config.octoIdentity.serviceToken).toBe('')
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        users: [
          { uid: 'u1', status: 1, name: 'Alice', robot: 0 },
          { uid: 'u3', status: 1, name: 'Cara', robot: 0 },
        ],
        missing_uids: ['u2'],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const identity = new HttpOctoIdentity('http://octo.test')
    const map = await identity.getUsersBatch(['u1', 'u2', 'u3'], 'caller-tok')

    // ONE HTTP round-trip for the whole shard (not one per uid).
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe('http://octo.test/v1/users/batch')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ uids: ['u1', 'u2', 'u3'] })
    // Auth: caller token forwarded as the `token` header (no service token set).
    expect((init.headers as Record<string, string>).token).toBe('caller-tok')

    // uid-keyed lookup, grantable users present, missing uid absent.
    expect(map).not.toBeNull()
    expect(map!.get('u1')).toEqual({ uid: 'u1', name: 'Alice', avatar: undefined })
    expect(map!.get('u3')).toEqual({ uid: 'u3', name: 'Cara', avatar: undefined })
    expect(map!.has('u2')).toBe(false)
  })

  it('treats non-enabled and malformed rows as NOT grantable (absent from map)', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        users: [
          { uid: 'u_enabled', status: 1, name: 'Ok' },
          { uid: 'u_disabled', status: 0, name: 'Disabled' }, // non-enabled -> dropped
          { uid: 'u_frozen', status: 2, name: 'Frozen' }, // any non-1 status -> dropped
          { status: 1, name: 'NoUid' }, // malformed row (no uid) -> dropped
          null, // malformed row -> dropped
        ],
        missing_uids: [],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const identity = new HttpOctoIdentity('http://octo.test')
    const map = await identity.getUsersBatch(['u_enabled', 'u_disabled', 'u_frozen'], 'tok')

    expect(map).not.toBeNull()
    expect([...map!.keys()]).toEqual(['u_enabled'])
  })

  it('fails CLOSED (null) on a non-200 batch response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'boom' }, 500)))
    const identity = new HttpOctoIdentity('http://octo.test')
    expect(await identity.getUsersBatch(['u1'], 'tok')).toBeNull()
  })

  it('fails CLOSED (null) on a malformed body (users not an array)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ users: 'nope' })))
    const identity = new HttpOctoIdentity('http://octo.test')
    expect(await identity.getUsersBatch(['u1'], 'tok')).toBeNull()
  })

  it('fails CLOSED (null) when the identity source is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }),
    )
    const identity = new HttpOctoIdentity('http://octo.test')
    expect(await identity.getUsersBatch(['u1'], 'tok')).toBeNull()
  })
})

describe('HttpOctoIdentity.getUsersAsBotBatch (bot)', () => {
  it('calls the bot batch route ONCE with the bot bearer token', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ users: [{ uid: 'u1', status: 1, name: 'Alice' }], missing_uids: ['u2'] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const identity = new HttpOctoIdentity('http://octo.test')
    const map = await identity.getUsersAsBotBatch(['u1', 'u2'], 'bot-tok')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe('http://octo.test/v1/bot/users/batch')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer bot-tok')
    expect(JSON.parse(init.body as string)).toEqual({ uids: ['u1', 'u2'] })

    expect(map!.get('u1')).toEqual({ uid: 'u1', name: 'Alice', avatar: undefined })
    expect(map!.has('u2')).toBe(false)
  })

  it('fails CLOSED (null) with no IO when the bot token is empty', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const identity = new HttpOctoIdentity('http://octo.test')
    expect(await identity.getUsersAsBotBatch(['u1'], '')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// Space-prefix original-request-uid alias (XIN-1866). octo-server's bot batch
// route (`/v1/bot/users/batch`, PR #772) strips a leading `s<digits>_` space
// prefix and keys resolved users by the BASE uid. The forward-grant batch
// handler looks up `lookup.get(g.uid)` using the ORIGINAL requested string, so
// without an alias a bot forward-grant for `s1_alice` resolves upstream as
// `alice` yet is reported `user_not_found`. getUsersAsBotBatch must therefore
// expose each successfully-resolved user under the ORIGINAL requested uid, never
// collapsing distinct requested strings that share one base uid.
describe('HttpOctoIdentity.getUsersAsBotBatch — space-prefix original-uid alias (XIN-1866)', () => {
  it('resolves a space-prefixed request under the ORIGINAL requested uid (base returned upstream)', async () => {
    // octo-server strips `s1_` and returns the base uid `alice`.
    const fetchMock = vi.fn(async () =>
      jsonResponse({ users: [{ uid: 'alice', status: 1, name: 'Alice' }], missing_uids: [] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const identity = new HttpOctoIdentity('http://octo.test')
    const map = await identity.getUsersAsBotBatch(['s1_alice'], 'bot-tok')

    // The lookup must be resolvable under the ORIGINAL requested string.
    expect(map).not.toBeNull()
    expect(map!.get('s1_alice')).toEqual({ uid: 'alice', name: 'Alice', avatar: undefined })
  })

  it('does NOT collapse distinct requested uids that strip to the same base', async () => {
    // s1_alice, s2_alice and bare alice all resolve upstream to base `alice`.
    const fetchMock = vi.fn(async () =>
      jsonResponse({ users: [{ uid: 'alice', status: 1, name: 'Alice' }], missing_uids: [] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const identity = new HttpOctoIdentity('http://octo.test')
    const map = await identity.getUsersAsBotBatch(['s1_alice', 's2_alice', 'alice'], 'bot-tok')

    expect(map).not.toBeNull()
    // Each original request string gets its own resolvable key — no collapse.
    expect(map!.get('s1_alice')).toEqual({ uid: 'alice', name: 'Alice', avatar: undefined })
    expect(map!.get('s2_alice')).toEqual({ uid: 'alice', name: 'Alice', avatar: undefined })
    expect(map!.get('alice')).toEqual({ uid: 'alice', name: 'Alice', avatar: undefined })
  })

  it('a genuinely-missing prefixed uid stays absent (user_not_found downstream)', async () => {
    // Upstream resolves s1_alice -> alice but has no row for s3_ghost's base.
    const fetchMock = vi.fn(async () =>
      jsonResponse({ users: [{ uid: 'alice', status: 1, name: 'Alice' }], missing_uids: ['ghost'] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const identity = new HttpOctoIdentity('http://octo.test')
    const map = await identity.getUsersAsBotBatch(['s1_alice', 's3_ghost'], 'bot-tok')

    expect(map).not.toBeNull()
    expect(map!.get('s1_alice')).toEqual({ uid: 'alice', name: 'Alice', avatar: undefined })
    expect(map!.has('s3_ghost')).toBe(false)
  })

  it('a bare (unprefixed) uid keeps resolving under itself', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ users: [{ uid: 'bob', status: 1, name: 'Bob' }], missing_uids: [] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const identity = new HttpOctoIdentity('http://octo.test')
    const map = await identity.getUsersAsBotBatch(['bob'], 'bot-tok')

    expect(map).not.toBeNull()
    expect(map!.get('bob')).toEqual({ uid: 'bob', name: 'Bob', avatar: undefined })
  })
})

// Internal sub-chunking against octo-server's batch cap (XIN-1864, Option A).
// octo-server PR #772 lowered MaxBatchUserUIDs 1000 -> 200: an over-cap batch is
// rejected 400, which under fail-closed semantics would sink the WHOLE forward
// shard for any group > 200. docs-backend therefore splits the uid set into
// sequential sub-chunks of <= OCTO_SERVER_BATCH_MAX_UIDS, issues one octo-server
// request per chunk, and merges the per-chunk maps — failing closed if ANY chunk
// fails. forward-grant/batch's own 1000 request cap and the frontend 1000 shard
// are unchanged, so at most ceil(1000/200)=5 sub-calls per shard.
describe('HttpOctoIdentity batch sub-chunking (<= OCTO_SERVER_BATCH_MAX_UIDS per octo-server call)', () => {
  it('mirrors octo-server MaxBatchUserUIDs (200)', () => {
    expect(OCTO_SERVER_BATCH_MAX_UIDS).toBe(200)
  })

  it('getUsersBatch: 450 uids -> 3 octo-server calls (200/200/50) and merges every grantable user', async () => {
    const uids = Array.from({ length: 450 }, (_, i) => `u${i}`)
    const sentChunks: string[][] = []
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const sent = (JSON.parse(init.body as string) as { uids: string[] }).uids
      sentChunks.push(sent)
      // octo-server echoes each requested uid back as an enabled grantable user.
      return jsonResponse({
        users: sent.map((uid) => ({ uid, status: 1, name: uid })),
        missing_uids: [],
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const identity = new HttpOctoIdentity('http://octo.test')
    const map = await identity.getUsersBatch(uids, 'tok')

    // ceil(450/200) = 3 requests, chunked 200/200/50.
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(sentChunks.map((c) => c.length)).toEqual([200, 200, 50])
    // Sequential, non-overlapping slices covering every uid exactly once, in order.
    expect(sentChunks.flat()).toEqual(uids)
    // Each request went to the human batch route.
    for (const [url] of fetchMock.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(url).toBe('http://octo.test/v1/users/batch')
    }
    // Merged map aggregates all chunks' grantable users.
    expect(map).not.toBeNull()
    expect(map!.size).toBe(450)
    expect(map!.get('u0')).toEqual({ uid: 'u0', name: 'u0', avatar: undefined })
    expect(map!.get('u449')).toEqual({ uid: 'u449', name: 'u449', avatar: undefined })
  })

  it('getUsersBatch: fails CLOSED (null) when ANY sub-chunk returns non-200 (over-cap 400) — no partial map', async () => {
    const uids = Array.from({ length: 450 }, (_, i) => `u${i}`)
    let n = 0
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      n += 1
      const sent = (JSON.parse(init.body as string) as { uids: string[] }).uids
      // The 2nd sub-chunk simulates octo-server rejecting the batch (400).
      if (n === 2) return jsonResponse({ error: 'too many uids' }, 400)
      return jsonResponse({ users: sent.map((uid) => ({ uid, status: 1, name: uid })), missing_uids: [] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const identity = new HttpOctoIdentity('http://octo.test')
    // A single failing chunk => whole resolution null (fail closed, no partial grant).
    expect(await identity.getUsersBatch(uids, 'tok')).toBeNull()
    // Sequential: it stops at the failing chunk, never reaching the 3rd.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('getUsersBatch: fails CLOSED (null) when ANY sub-chunk transport-fails', async () => {
    const uids = Array.from({ length: 250 }, (_, i) => `u${i}`)
    let n = 0
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      n += 1
      if (n === 2) throw new Error('ECONNRESET')
      const sent = (JSON.parse(init.body as string) as { uids: string[] }).uids
      return jsonResponse({ users: sent.map((uid) => ({ uid, status: 1, name: uid })), missing_uids: [] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const identity = new HttpOctoIdentity('http://octo.test')
    expect(await identity.getUsersBatch(uids, 'tok')).toBeNull()
  })

  it('getUsersBatch: fails CLOSED (null) when ANY sub-chunk body is malformed', async () => {
    const uids = Array.from({ length: 250 }, (_, i) => `u${i}`)
    let n = 0
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      n += 1
      // 2nd chunk returns a 200 with a batch-level malformed body (users not an array).
      if (n === 2) return jsonResponse({ users: 'nope' })
      const sent = (JSON.parse(init.body as string) as { uids: string[] }).uids
      return jsonResponse({ users: sent.map((uid) => ({ uid, status: 1, name: uid })), missing_uids: [] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const identity = new HttpOctoIdentity('http://octo.test')
    expect(await identity.getUsersBatch(uids, 'tok')).toBeNull()
  })

  it('getUsersAsBotBatch: 450 uids -> 3 bot batch calls (200/200/50) and merges', async () => {
    const uids = Array.from({ length: 450 }, (_, i) => `b${i}`)
    const sentChunks: string[][] = []
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const sent = (JSON.parse(init.body as string) as { uids: string[] }).uids
      sentChunks.push(sent)
      return jsonResponse({ users: sent.map((uid) => ({ uid, status: 1, name: uid })), missing_uids: [] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const identity = new HttpOctoIdentity('http://octo.test')
    const map = await identity.getUsersAsBotBatch(uids, 'bot-tok')

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(sentChunks.map((c) => c.length)).toEqual([200, 200, 50])
    expect(sentChunks.flat()).toEqual(uids)
    for (const [url, init] of fetchMock.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(url).toBe('http://octo.test/v1/bot/users/batch')
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer bot-tok')
    }
    expect(map).not.toBeNull()
    expect(map!.size).toBe(450)
  })

  it('getUsersAsBotBatch: fails CLOSED (null) when ANY sub-chunk returns non-200', async () => {
    const uids = Array.from({ length: 250 }, (_, i) => `b${i}`)
    let n = 0
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      n += 1
      if (n === 2) return jsonResponse({ error: 'over cap' }, 400)
      const sent = (JSON.parse(init.body as string) as { uids: string[] }).uids
      return jsonResponse({ users: sent.map((uid) => ({ uid, status: 1, name: uid })), missing_uids: [] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const identity = new HttpOctoIdentity('http://octo.test')
    expect(await identity.getUsersAsBotBatch(uids, 'bot-tok')).toBeNull()
  })
})
