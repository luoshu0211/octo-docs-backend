import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Offline unit tests for octoIdentity.listCallerBots — the client for
// octo-server's GET /v1/robot/my_bots (the caller's FRIEND-bot list, the second
// half of the "which bots may this caller @" rule).
//
// global.fetch is stubbed, so nothing here touches the network. The wire contract
// under test (verified against octo-server modules/robot/api.go myBots):
//   - auth is the `token` HEADER (AuthMiddleware realm), NOT Authorization: Bearer
//   - `space_id` is an optional query parameter
//   - success is HTTP 200 + a BARE JSON array (no {data:...} envelope), each item
//     keyed uid / name / description / creator_uid / creator_name / bot_commands
//   - EVERY error is HTTP 400 (httperr pins transportStatus to StatusBadRequest)
vi.mock('../src/config/env.js', () => ({
  config: {
    octoIdentity: {
      mode: 'http',
      serverBaseUrl: 'http://octo-server:8080',
      serviceToken: '',
      membershipCacheTtlSeconds: 30,
      callerBotsCacheTtlSeconds: 30,
    },
  },
}))

import { HttpOctoIdentity } from '../src/auth/octoIdentity.js'

/** One my_bots row exactly as octo-server serializes it. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uid: 'bot-friend',
    name: 'Friend Bot',
    description: 'a bot someone else created',
    creator_uid: 'u-other',
    creator_name: 'Other',
    bot_commands: '',
    ...over,
  }
}

function resp(status: number, body?: unknown): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status })
}

/** Serve one canned response per call, repeating the last one. */
function fetchMock(...responses: Array<Response | Error>) {
  let i = 0
  return vi.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)]
    i++
    if (r instanceof Error) throw r
    return (r as Response).clone()
  })
}

/** The URLs and init objects fetch was called with. */
function calls(): Array<[string, RequestInit]> {
  return (fetch as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls
}

let identity: HttpOctoIdentity

beforeEach(() => {
  // A FRESH instance per test: the cache and the single-flight map are instance
  // state, so this keeps every case independent.
  identity = new HttpOctoIdentity()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('listCallerBots — wire contract', () => {
  it('parses a BARE JSON array (no {data} envelope) into uid + creatorUid', async () => {
    vi.stubGlobal('fetch', fetchMock(resp(200, [row(), row({ uid: 'bot-2', creator_uid: 'u-third' })])))
    expect(await identity.listCallerBots('u-me', 's1', 'tok')).toEqual([
      { uid: 'bot-friend', creatorUid: 'u-other' },
      { uid: 'bot-2', creatorUid: 'u-third' },
    ])
  })

  it('authenticates with the `token` HEADER, never Authorization: Bearer', async () => {
    vi.stubGlobal('fetch', fetchMock(resp(200, [])))
    await identity.listCallerBots('u-me', 's1', 'tok-secret')
    const [, init] = calls()[0]!
    const headers = init.headers as Record<string, string>
    expect(headers.token).toBe('tok-secret')
    expect(headers.Authorization).toBeUndefined()
    expect(headers.authorization).toBeUndefined()
  })

  it('sends the space scope as ?space_id= and url-encodes it', async () => {
    vi.stubGlobal('fetch', fetchMock(resp(200, [])))
    await identity.listCallerBots('u-me', 's 1/x', 'tok')
    expect(calls()[0]![0]).toBe('http://octo-server:8080/v1/robot/my_bots?space_id=s%201%2Fx')
  })

  it('omits the query entirely when no space scope is given', async () => {
    vi.stubGlobal('fetch', fetchMock(resp(200, [])))
    await identity.listCallerBots('u-me', '', 'tok')
    expect(calls()[0]![0]).toBe('http://octo-server:8080/v1/robot/my_bots')
  })

  it('surfaces a confirmed EMPTY list as [] (not null): "no friend bots" is an answer', async () => {
    vi.stubGlobal('fetch', fetchMock(resp(200, [])))
    expect(await identity.listCallerBots('u-me', 's1', 'tok')).toEqual([])
  })

  it('defaults a missing/non-string creator_uid to \'\' (octo-server IFNULLs it)', async () => {
    vi.stubGlobal(
      'fetch',
      fetchMock(resp(200, [row({ creator_uid: '' }), row({ uid: 'b2', creator_uid: undefined }), row({ uid: 'b3', creator_uid: 7 })])),
    )
    expect(await identity.listCallerBots('u-me', 's1', 'tok')).toEqual([
      { uid: 'bot-friend', creatorUid: '' },
      { uid: 'b2', creatorUid: '' },
      { uid: 'b3', creatorUid: '' },
    ])
  })

  it('IGNORES malformed elements and keeps the well-formed ones', async () => {
    vi.stubGlobal(
      'fetch',
      fetchMock(resp(200, [null, 'bot-string', 42, {}, { uid: '' }, { uid: 123 }, [], row()])),
    )
    // Dropping a row can only NARROW the candidate set, which is the fail-closed
    // direction; one bad row must not discard the caller's real bots.
    expect(await identity.listCallerBots('u-me', 's1', 'tok')).toEqual([
      { uid: 'bot-friend', creatorUid: 'u-other' },
    ])
  })
})

describe('listCallerBots — fail-closed', () => {
  it('returns null (not []) when the transport fails', async () => {
    vi.stubGlobal('fetch', fetchMock(new Error('ECONNREFUSED')))
    expect(await identity.listCallerBots('u-me', 's1', 'tok')).toBeNull()
  })

  it.each([400, 401, 403, 404, 500, 502])('returns null on HTTP %i', async (status) => {
    // octo-server answers 400 for every error on this route; the others are
    // proxy/infra shapes. All of them mean "could not confirm".
    vi.stubGlobal('fetch', fetchMock(resp(status, { msg: 'nope' })))
    expect(await identity.listCallerBots('u-me', 's1', 'tok')).toBeNull()
  })

  it('returns null when the body is not an array (an envelope is NOT zero bots)', async () => {
    for (const body of [{ data: [row()] }, { list: [] }, 'nope', 7, null] as unknown[]) {
      vi.stubGlobal('fetch', fetchMock(resp(200, body)))
      expect(await new HttpOctoIdentity().listCallerBots('u-me', 's1', 'tok')).toBeNull()
    }
  })

  it('returns null on an unparseable body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>502</html>', { status: 200 })))
    expect(await identity.listCallerBots('u-me', 's1', 'tok')).toBeNull()
  })

  it('short-circuits with NO IO when the uid or the token is missing', async () => {
    vi.stubGlobal('fetch', fetchMock(resp(200, [row()])))
    expect(await identity.listCallerBots('', 's1', 'tok')).toBeNull()
    expect(await identity.listCallerBots('u-me', 's1', '')).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does NOT cache a null: the next call retries and can succeed', async () => {
    vi.stubGlobal('fetch', fetchMock(resp(500), resp(200, [row()])))
    expect(await identity.listCallerBots('u-me', 's1', 'tok')).toBeNull()
    expect(await identity.listCallerBots('u-me', 's1', 'tok')).toEqual([
      { uid: 'bot-friend', creatorUid: 'u-other' },
    ])
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

describe('listCallerBots — cache + single-flight', () => {
  it('serves a repeat call from the cache (one fetch)', async () => {
    vi.stubGlobal('fetch', fetchMock(resp(200, [row()])))
    const first = await identity.listCallerBots('u-me', 's1', 'tok')
    const second = await identity.listCallerBots('u-me', 's1', 'tok')
    expect(second).toEqual(first)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('caches a confirmed EMPTY list too', async () => {
    vi.stubGlobal('fetch', fetchMock(resp(200, [])))
    expect(await identity.listCallerBots('u-me', 's1', 'tok')).toEqual([])
    expect(await identity.listCallerBots('u-me', 's1', 'tok')).toEqual([])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('coalesces CONCURRENT calls for the same caller into one request', async () => {
    vi.stubGlobal('fetch', fetchMock(resp(200, [row()])))
    const [a, b, c] = await Promise.all([
      identity.listCallerBots('u-me', 's1', 'tok'),
      identity.listCallerBots('u-me', 's1', 'tok'),
      identity.listCallerBots('u-me', 's1', 'tok'),
    ])
    expect(a).toEqual([{ uid: 'bot-friend', creatorUid: 'u-other' }])
    expect(b).toEqual(a)
    expect(c).toEqual(a)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  // ── SECURITY: the cache is process-wide, so its key must carry every caller
  // dimension. A leak here would hand one user another user's bot list.
  it('SECURITY: user B never reads user A\'s cached list (different uid => own fetch)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const token = (init.headers as Record<string, string>).token
        return new Response(JSON.stringify(token === 'tok-a' ? [row({ uid: 'bot-a' })] : [row({ uid: 'bot-b' })]), {
          status: 200,
        })
      }),
    )
    expect(await identity.listCallerBots('u-a', 's1', 'tok-a')).toEqual([
      { uid: 'bot-a', creatorUid: 'u-other' },
    ])
    expect(await identity.listCallerBots('u-b', 's1', 'tok-b')).toEqual([
      { uid: 'bot-b', creatorUid: 'u-other' },
    ])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('SECURITY: the same uid with a DIFFERENT token is a different cache entry', async () => {
    // The endpoint answers for the TOKEN HOLDER, so the cached value is a property
    // of the token — a stale/other token must never be served A's answer.
    vi.stubGlobal('fetch', fetchMock(resp(200, [row()])))
    await identity.listCallerBots('u-me', 's1', 'tok-1')
    await identity.listCallerBots('u-me', 's1', 'tok-2')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('scopes the cache per space (the space filter changes the answer)', async () => {
    vi.stubGlobal('fetch', fetchMock(resp(200, [row()])))
    await identity.listCallerBots('u-me', 's1', 'tok')
    await identity.listCallerBots('u-me', 's2', 'tok')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('never puts the raw token in the cache key (only a hash of it)', async () => {
    // Defence in depth on log/heap hygiene: the key is a Map key held in memory,
    // and it must not be the bearer secret itself.
    vi.stubGlobal('fetch', fetchMock(resp(200, [row()])))
    await identity.listCallerBots('u-me', 's1', 'super-secret-token')
    const cache = (identity as unknown as { callerBotsCache: { store: Map<string, unknown> } })
      .callerBotsCache
    const keys = [...cache.store.keys()]
    expect(keys).toHaveLength(1)
    expect(keys[0]).not.toContain('super-secret-token')
    expect(keys[0]).toContain('u-me')
    expect(keys[0]).toContain('s1')
  })
})
