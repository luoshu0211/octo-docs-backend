import { describe, it, expect, afterEach, vi } from 'vitest'

/**
 * TES-132 — the drive derived-access client. Asks the drive service, per
 * (doc, uid, principal space), whether the caller reaches a drive library that
 * contains the doc; the wire answer `{"role":"reader"}` maps to a `reader` grant,
 * `{"role":"none"}` (and everything else) to `none`. FAIL-CLOSED on every failure
 * path (disabled, unconfigured, degenerate input, timeout, non-200, malformed /
 * unknown-role body, network error). A short-TTL cache +
 * singleflight bound drive QPS; only a CONFIRMED answer is cached so a transient
 * outage retries rather than pinning `none` for the whole TTL.
 */
import { HttpDriveDerivedAccess } from '../src/drive/derivedAccessClient.js'

const BASE = 'http://drive.test'

/** A confirmed derived-access response carrying the given wire role. */
function roleResponse(role: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ role }) } as unknown as Response
}

function makeClient(overrides = {}) {
  return new HttpDriveDerivedAccess({ enabled: true, baseUrl: BASE, token: 'tok', timeoutMs: 500, ttlMs: 15_000, ...overrides })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('HttpDriveDerivedAccess.derivedRole (TES-132)', () => {
  it('POSTs {doc_id, uid, principal_space_id} with the internal token and maps role:reader => reader', async () => {
    const fetchMock = vi.fn(async () => roleResponse('reader'))
    vi.stubGlobal('fetch', fetchMock)

    expect(await makeClient().derivedRole('doc1', 'u1', 's1')).toBe('reader')
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe('http://drive.test/internal/v1/docs/derived-access')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['X-Internal-Token']).toBe('tok')
    expect(JSON.parse(init.body as string)).toEqual({ doc_id: 'doc1', uid: 'u1', principal_space_id: 's1' })
    // Hardening: never follow a redirect (a 3xx would forward X-Internal-Token).
    expect(init.redirect).toBe('error')
  })

  it('role:none => none', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => roleResponse('none')))
    expect(await makeClient().derivedRole('doc1', 'u1', 's1')).toBe('none')
  })

  it('disabled => none, no IO', async () => {
    const fetchMock = vi.fn(async () => roleResponse('reader'))
    vi.stubGlobal('fetch', fetchMock)
    expect(await makeClient({ enabled: false }).derivedRole('doc1', 'u1', 's1')).toBe('none')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('unconfigured base URL => none, no IO', async () => {
    const fetchMock = vi.fn(async () => roleResponse('reader'))
    vi.stubGlobal('fetch', fetchMock)
    expect(await makeClient({ baseUrl: '' }).derivedRole('doc1', 'u1', 's1')).toBe('none')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('degenerate inputs (empty doc/uid/space) => none, no IO', async () => {
    const fetchMock = vi.fn(async () => roleResponse('reader'))
    vi.stubGlobal('fetch', fetchMock)
    const c = makeClient()
    expect(await c.derivedRole('', 'u1', 's1')).toBe('none')
    expect(await c.derivedRole('doc1', '', 's1')).toBe('none')
    expect(await c.derivedRole('doc1', 'u1', '')).toBe('none')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('omits the token header when no token is configured', async () => {
    const fetchMock = vi.fn(async () => roleResponse('reader'))
    vi.stubGlobal('fetch', fetchMock)
    await makeClient({ token: '' }).derivedRole('doc1', 'u1', 's1')
    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>)['X-Internal-Token']).toBeUndefined()
  })

  it('fail-closed: non-200 => none', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response))
    expect(await makeClient().derivedRole('doc1', 'u1', 's1')).toBe('none')
  })

  it('fail-closed: unknown role => none', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => roleResponse('writer')))
    expect(await makeClient().derivedRole('doc1', 'u1', 's1')).toBe('none')
  })

  it('fail-closed: empty role => none', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => roleResponse('')))
    expect(await makeClient().derivedRole('doc1', 'u1', 's1')).toBe('none')
  })

  it('fail-closed: legacy {access:true} shape => none (contract-drift guard)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ access: true }) }) as unknown as Response))
    expect(await makeClient().derivedRole('doc1', 'u1', 's1')).toBe('none')
  })

  it('fail-closed: network throw => none', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }))
    expect(await makeClient().derivedRole('doc1', 'u1', 's1')).toBe('none')
  })

  it('caches a confirmed answer per key (one fetch for repeated calls); a distinct key re-fetches', async () => {
    const fetchMock = vi.fn(async () => roleResponse('reader'))
    vi.stubGlobal('fetch', fetchMock)
    const c = makeClient()

    expect(await c.derivedRole('doc1', 'u1', 's1')).toBe('reader')
    expect(await c.derivedRole('doc1', 'u1', 's1')).toBe('reader')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await c.derivedRole('doc2', 'u1', 's1')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does NOT cache a fail-closed error: the next call retries', async () => {
    let attempt = 0
    const fetchMock = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) throw new Error('boom')
      return roleResponse('reader')
    })
    vi.stubGlobal('fetch', fetchMock)
    const c = makeClient()

    expect(await c.derivedRole('doc1', 'u1', 's1')).toBe('none') // fail-closed, uncached
    expect(await c.derivedRole('doc1', 'u1', 's1')).toBe('reader') // retried, confirmed
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('a confirmed answer expires after the TTL and re-fetches', async () => {
    vi.useFakeTimers()
    let role = 'reader'
    const fetchMock = vi.fn(async () => roleResponse(role))
    vi.stubGlobal('fetch', fetchMock)
    const c = makeClient({ ttlMs: 15_000, nowMs: () => Date.now() })

    expect(await c.derivedRole('doc1', 'u1', 's1')).toBe('reader')
    role = 'none'
    vi.advanceTimersByTime(14_000)
    expect(await c.derivedRole('doc1', 'u1', 's1')).toBe('reader') // within TTL, cached
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2_000)
    expect(await c.derivedRole('doc1', 'u1', 's1')).toBe('none') // TTL elapsed, re-fetched
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('singleflight coalesces concurrent calls for the same key into one fetch', async () => {
    let resolve: (r: Response) => void = () => {}
    const fetchMock = vi.fn(() => new Promise<Response>((r) => {
      resolve = r
    }))
    vi.stubGlobal('fetch', fetchMock)
    const c = makeClient()

    const a = c.derivedRole('doc1', 'u1', 's1')
    const b = c.derivedRole('doc1', 'u1', 's1')
    resolve(roleResponse('reader'))
    expect(await a).toBe('reader')
    expect(await b).toBe('reader')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
