import { describe, it, expect, afterEach, vi } from 'vitest'

vi.mock('../src/config/env.js', () => ({
  config: {
    driveDerived: {
      enabled: true,
      internalBaseUrl: '',
      outboundToken: 'cfg-outbound',
      timeoutMs: 500,
      ttlMs: 15_000,
    },
  },
}))

import { HttpDriveDerivedAccess, type DerivedAccessBinding } from '../src/drive/derivedAccessClient.js'

const BASE = 'http://drive.test'
const binding: DerivedAccessBinding = { docId: 'doc1', uid: 'u1', principalSpaceId: 's1' }
const revision = `sha256:${'0'.repeat(64)}`
const revokedRevision = `sha256:${'1'.repeat(64)}`
const oldRevision = `sha256:${'2'.repeat(64)}`

function accessResponse(role: unknown, sourceRevision: unknown = revision, validForMs: unknown = 15_000): Response {
  return { ok: true, status: 200, json: async () => ({
    role, source_revision: sourceRevision, valid_for_ms: validForMs,
  }) } as unknown as Response
}

function makeClient(overrides = {}) {
  return new HttpDriveDerivedAccess({ enabled: true, baseUrl: BASE, token: 'tok', timeoutMs: 500, ttlMs: 15_000, ...overrides })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('HttpDriveDerivedAccess', () => {
  it('POSTs the complete-access contract with the internal token and preserves its proof', async () => {
    const fetchMock = vi.fn(async () => accessResponse('reader'))
    vi.stubGlobal('fetch', fetchMock)
    let now = 100
    const client = makeClient({ nowMs: () => now })

    expect(await client.derivedAccess('doc1', 'u1', 's1')).toMatchObject({
      ...binding, role: 'reader', sourceRevision: revision, validForMs: 15_000, expiresAt: 15_100,
    })
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe(`${BASE}/internal/v1/docs/derived-access`)
    expect(init.method).toBe('POST')
    const request = fetchMock.mock.calls[0]![1] as RequestInit
    const headers = request.headers as Record<string, string>
    expect(headers['X-Internal-Token']).toBe('tok')
    expect(JSON.parse(request.body as string)).toEqual({ doc_id: 'doc1', uid: 'u1', principal_space_id: 's1' })
    expect(request.redirect).toBe('error')
  })

  it('returns confirmed none with its source proof', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => accessResponse('none')))
    expect(await makeClient().derivedAccess('doc1', 'u1', 's1')).toMatchObject({ role: 'none', sourceRevision: revision })
  })

  it('disabled, unconfigured or degenerate lookups are unconfirmed and perform no IO', async () => {
    const fetchMock = vi.fn(async () => accessResponse('reader'))
    vi.stubGlobal('fetch', fetchMock)
    const client = makeClient()
    expect(await makeClient({ enabled: false }).derivedAccess('doc1', 'u1', 's1')).toBeNull()
    expect(await makeClient({ baseUrl: '' }).derivedAccess('doc1', 'u1', 's1')).toBeNull()
    expect(await client.derivedAccess('', 'u1', 's1')).toBeNull()
    expect(await client.derivedAccess('doc1', '', 's1')).toBeNull()
    expect(await client.derivedAccess('doc1', 'u1', '')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('omits an empty token and defaults to the configured outbound token', async () => {
    const fetchMock = vi.fn(async () => accessResponse('reader'))
    vi.stubGlobal('fetch', fetchMock)
    await makeClient({ token: '' }).derivedAccess('doc1', 'u1', 's1')
    const firstRequest = fetchMock.mock.calls[0]![1] as RequestInit
    expect(firstRequest.headers).toMatchObject({ 'Content-Type': 'application/json' })
    expect((firstRequest.headers as Record<string, string>)['X-Internal-Token']).toBeUndefined()

    await new HttpDriveDerivedAccess({ enabled: true, baseUrl: BASE }).derivedAccess('doc1', 'u1', 's1')
    const secondRequest = fetchMock.mock.calls[1]![1] as RequestInit
    expect((secondRequest.headers as Record<string, string>)['X-Internal-Token']).toBe('cfg-outbound')
  })

  it.each([
    [{ role: 'writer', source_revision: revision, valid_for_ms: 15_000 }],
    [{ role: 'reader', source_revision: '', valid_for_ms: 15_000 }],
    [{ role: 'reader', source_revision: revision }],
    [{ role: 'reader', source_revision: revision, valid_for_ms: 30_001 }],
    [{ access: true }],
  ])('fails to confirm malformed complete-access response %#', async body => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => body }) as unknown as Response))
    expect(await makeClient().derivedAccess('doc1', 'u1', 's1')).toBeNull()
  })
  it('does not grant a proof that expired before the complete-access response arrived', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => accessResponse('reader', revision, 0)))
    const client = makeClient({ nowMs: () => 1_000 })
    expect(await client.derivedAccess('doc1', 'u1', 's1')).toBeNull()
  })

  it('returns unconfirmed for non-200 and network failures, then retries the next lookup', async () => {
    let attempt = 0
    const fetchMock = vi.fn(async () => {
      attempt++
      if (attempt === 1) return { ok: false, status: 500 } as unknown as Response
      if (attempt === 2) throw new Error('ECONNREFUSED')
      return accessResponse('reader')
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = makeClient()
    expect(await client.derivedAccess('doc1', 'u1', 's1')).toBeNull()
    expect(await client.derivedAccess('doc1', 'u1', 's1')).toBeNull()
    expect(await client.derivedAccess('doc1', 'u1', 's1')).toMatchObject({ role: 'reader', sourceRevision: revision })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('caches only until the original proof deadline and re-fetches after expiry', async () => {
    let now = 1_000
    let role = 'reader'
    const fetchMock = vi.fn(async () => accessResponse(role, revision, 5_000))
    vi.stubGlobal('fetch', fetchMock)
    const client = makeClient({ ttlMs: 15_000, nowMs: () => now })
    expect(await client.derivedAccess('doc1', 'u1', 's1')).toMatchObject({ expiresAt: 6_000 })
    role = 'none'
    now += 4_000
    expect(await client.derivedAccess('doc1', 'u1', 's1')).toMatchObject({ role: 'reader', expiresAt: 6_000 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    now += 1_000
    expect(await client.derivedAccess('doc1', 'u1', 's1')).toMatchObject({ role: 'none' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('invalidates a cached proof and prevents an invalidated in-flight result from repopulating it', async () => {
    let resolveOld: (response: Response) => void = () => {}
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveOld = resolve }))
      .mockImplementationOnce(async () => accessResponse('none', revokedRevision))
    vi.stubGlobal('fetch', fetchMock)
    const client = makeClient()
    const oldLookup = client.derivedAccess('doc1', 'u1', 's1')
    client.invalidate('doc1', 'u1', 's1')
    const newLookup = client.derivedAccess('doc1', 'u1', 's1')
    expect(await newLookup).toMatchObject({ role: 'none', sourceRevision: revokedRevision })
    resolveOld(accessResponse('reader', oldRevision))
    await expect(oldLookup).resolves.toBeNull()
    expect(await client.derivedAccess('doc1', 'u1', 's1')).toMatchObject({ role: 'none', sourceRevision: revokedRevision })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('POSTs a deduplicated version batch and preserves request order and bounded proofs', async () => {
    let now = 2_000
    const bindings: DerivedAccessBinding[] = [
      { docId: 'd1', uid: 'u1', principalSpaceId: 's1' },
      { docId: 'd2', uid: 'u2', principalSpaceId: 's2' },
    ]
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ items: [
        { doc_id: 'd1', uid: 'u1', principal_space_id: 's1', source_revision: `sha256:${'3'.repeat(64)}`, valid_for_ms: 5_000 },
        { doc_id: 'd2', uid: 'u2', principal_space_id: 's2', source_revision: `sha256:${'4'.repeat(64)}`, valid_for_ms: 30_000 },
      ] }),
    }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    const result = await makeClient({ nowMs: () => now }).versions(bindings)
    expect(result).toMatchObject([
      { ...bindings[0], sourceRevision: `sha256:${'3'.repeat(64)}`, validForMs: 5_000, expiresAt: 7_000 },
      { ...bindings[1], sourceRevision: `sha256:${'4'.repeat(64)}`, validForMs: 30_000, expiresAt: 17_000 },
    ])
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe(`${BASE}/internal/v1/docs/derived-access/versions`)
    expect(JSON.parse(init.body as string)).toEqual({ items: [
      { doc_id: 'd1', uid: 'u1', principal_space_id: 's1' },
      { doc_id: 'd2', uid: 'u2', principal_space_id: 's2' },
    ] })
    now = 3_000
  })

  it('fails the entire version batch when the response is incomplete or mismatched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ items: [
        { doc_id: 'other', uid: 'u1', principal_space_id: 's1', source_revision: revision, valid_for_ms: 1_000 },
      ] }),
    }) as unknown as Response))
    expect(await makeClient().versions([binding])).toBeNull()
  })

  it('coalesces concurrent complete-access calls for the same binding', async () => {
    let resolve: (response: Response) => void = () => {}
    const fetchMock = vi.fn(() => new Promise<Response>(done => { resolve = done }))
    vi.stubGlobal('fetch', fetchMock)
    const client = makeClient()
    const first = client.derivedAccess('doc1', 'u1', 's1')
    const second = client.derivedAccess('doc1', 'u1', 's1')
    resolve(accessResponse('reader'))
    expect(await first).toMatchObject({ role: 'reader' })
    expect(await second).toMatchObject({ role: 'reader' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
