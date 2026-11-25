import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * OCTO-456 §4.5 — docs -> drive view-event forwarder.
 *
 * Pins the wire payload/endpoint/header against internal/docsapi/library.go's
 * documented contract (POST {base}/v1/internal/drive/library/view,
 * X-Internal-Token, {uid, principal_space_id, doc_id, space_id, entry_id:0,
 * viewed_at}), the silent-skip behaviour when the connection is unconfigured,
 * and the bounded retry policy.
 */
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    driveInternalUrl: 'http://drive.internal:8080',
    driveInternalToken: 'drive-token',
  },
}))
vi.mock('../src/config/env.js', () => ({ config: mockConfig }))

import {
  buildDriveViewEventBody,
  forwardViewEvent,
  scheduleDriveViewForward,
  getDriveViewQueueStats,
  __resetViewForwardQueueForTests,
  DRIVE_VIEW_MAX_ATTEMPTS,
  DRIVE_VIEW_PATH,
  DRIVE_VIEW_QUEUE_MAX,
  DRIVE_VIEW_CONCURRENCY,
} from '../src/drive/viewEventForwarder.js'

const viewedAt = new Date('2026-11-23T09:12:33.456Z')
const event = {
  uid: 'u_1',
  principalSpaceId: 's_1',
  docId: 'd_1',
  spaceId: 'space:1',
  viewedAt,
}

function okResponse(status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => new ArrayBuffer(0),
  }
}

let fetchMock: ReturnType<typeof vi.fn>
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  __resetViewForwardQueueForTests()
  mockConfig.driveInternalUrl = 'http://drive.internal:8080'
  mockConfig.driveInternalToken = 'drive-token'
  fetchMock = vi.fn(async () => okResponse())
  vi.stubGlobal('fetch', fetchMock)
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  warnSpy.mockRestore()
})

describe('buildDriveViewEventBody', () => {
  it('emits the exact snake_case contract with entry_id 0 and an ISO viewed_at', () => {
    expect(buildDriveViewEventBody(event)).toEqual({
      uid: 'u_1',
      principal_space_id: 's_1',
      doc_id: 'd_1',
      space_id: 'space:1',
      entry_id: 0,
      viewed_at: '2026-11-23T09:12:33.456Z',
    })
  })
})

describe('forwardViewEvent', () => {
  it('POSTs to the drive internal route with the internal token and JSON body', async () => {
    await expect(forwardViewEvent(event)).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`http://drive.internal:8080${DRIVE_VIEW_PATH}`)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['X-Internal-Token']).toBe('drive-token')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(JSON.parse(String(init.body))).toEqual({
      uid: 'u_1',
      principal_space_id: 's_1',
      doc_id: 'd_1',
      space_id: 'space:1',
      entry_id: 0,
      viewed_at: '2026-11-23T09:12:33.456Z',
    })
  })

  it('normalizes a trailing slash in the configured base URL', async () => {
    mockConfig.driveInternalUrl = 'http://drive.internal:8080///'
    await forwardViewEvent(event)
    expect((fetchMock.mock.calls[0] as [string])[0])
      .toBe(`http://drive.internal:8080${DRIVE_VIEW_PATH}`)
  })

  it('retries a 5xx and succeeds on a later attempt', async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse(503))
      .mockResolvedValueOnce(okResponse(200))
    await expect(forwardViewEvent(event)).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('retries a network rejection', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(okResponse(200))
    await expect(forwardViewEvent(event)).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry a 4xx (deterministic) and warns once', async () => {
    fetchMock.mockResolvedValue(okResponse(401))
    await expect(forwardViewEvent(event)).resolves.toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('aborts a hung attempt at the 3s deadline, bounds retries, and resolves safely (P2-1)', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      })
    }))
    vi.stubGlobal('fetch', fetchMock)

    const pending = forwardViewEvent(event)
    await vi.advanceTimersByTimeAsync(30_000)

    await expect(pending).resolves.toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(DRIVE_VIEW_MAX_ATTEMPTS)
  })

  it('never follows redirects and treats a 3xx as a terminal failure (P2-3)', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(302))

    await expect(forwardViewEvent(event)).resolves.toBe(false)
    // No retry: a redirect is deterministic, and following it could leak the
    // shared X-Internal-Token (fetch does not strip custom headers on redirect).
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.redirect).toBe('manual')
  })

  it('gives up after the bounded attempt count and never throws', async () => {
    fetchMock.mockResolvedValue(okResponse(503))
    await expect(forwardViewEvent(event)).resolves.toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(DRIVE_VIEW_MAX_ATTEMPTS)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('SILENTLY skips when the URL is not configured', async () => {
    mockConfig.driveInternalUrl = ''
    await expect(forwardViewEvent(event)).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('SILENTLY skips when the token is not configured', async () => {
    mockConfig.driveInternalToken = ''
    await expect(forwardViewEvent(event)).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

describe('scheduleDriveViewForward', () => {
  it('is a no-op (no fetch, no log) when unconfigured', () => {
    mockConfig.driveInternalUrl = ''
    scheduleDriveViewForward(event)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('starts the forward without blocking the caller', async () => {
    scheduleDriveViewForward(event)
    // The call is fire-and-forget; give the microtask/fetch a tick to start.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('bounded view-forward queue (P1-2)', () => {
  const view = (docId: string, at = viewedAt) => ({ ...event, docId, viewedAt: at })

  async function drain(resolvers: Array<(response: ReturnType<typeof okResponse>) => void>) {
    for (let round = 0; round < 500; round++) {
      while (resolvers.length > 0) resolvers.shift()!(okResponse())
      await new Promise((resolve) => setTimeout(resolve, 0))
      const stats = getDriveViewQueueStats()
      if (stats.active === 0 && stats.queued === 0) return stats
    }
    throw new Error('view queue did not drain')
  }

  it('caps concurrency, coalesces a queued duplicate with the latest viewedAt, and drains', async () => {
    const resolvers: Array<(response: ReturnType<typeof okResponse>) => void> = []
    fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      resolvers.push((response) => resolve(response as unknown as Response))
    }))
    vi.stubGlobal('fetch', fetchMock)

    for (let i = 0; i < DRIVE_VIEW_CONCURRENCY; i++) scheduleDriveViewForward(view(`d${i}`))
    expect(getDriveViewQueueStats()).toMatchObject({ active: DRIVE_VIEW_CONCURRENCY, queued: 0 })

    const later = new Date('2026-11-23T10:00:00.000Z')
    scheduleDriveViewForward(view('d-queued', viewedAt))
    scheduleDriveViewForward(view('d-queued', later)) // replaces the queued event
    scheduleDriveViewForward(view('d-other'))
    expect(getDriveViewQueueStats()).toMatchObject({ queued: 2, merged: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(DRIVE_VIEW_CONCURRENCY)

    await drain(resolvers)

    expect(fetchMock).toHaveBeenCalledTimes(DRIVE_VIEW_CONCURRENCY + 2)
    const queuedBody = fetchMock.mock.calls
      .map((call) => JSON.parse((call[1] as RequestInit).body as string) as { doc_id: string; viewed_at: string })
      .find((body) => body.doc_id === 'd-queued')!
    expect(queuedBody.viewed_at).toBe(later.toISOString())
  })

  it('a duplicate while the first event is ACTIVE is merged/dropped, never a mutated stale body', async () => {
    const resolvers: Array<(response: ReturnType<typeof okResponse>) => void> = []
    fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      resolvers.push((response) => resolve(response as unknown as Response))
    }))
    vi.stubGlobal('fetch', fetchMock)

    const first = new Date('2026-11-23T09:00:00.000Z')
    const newest = new Date('2026-11-23T09:00:04.000Z')
    scheduleDriveViewForward(view('d-active', first))
    expect(getDriveViewQueueStats()).toMatchObject({ active: 1, queued: 0 })

    // Same key arrives while the first request is in flight (<5s): dropped and
    // counted; the already-started request cannot be retroactively updated.
    scheduleDriveViewForward(view('d-active', newest))
    expect(getDriveViewQueueStats()).toMatchObject({ active: 1, queued: 0, merged: 1 })

    scheduleDriveViewForward(view('d-other'))
    await drain(resolvers)

    const activeBody = fetchMock.mock.calls
      .map((call) => JSON.parse((call[1] as RequestInit).body as string) as { doc_id: string; viewed_at: string })
      .find((body) => body.doc_id === 'd-active')!
    expect(activeBody.viewed_at).toBe(first.toISOString()) // not the lost newest value
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('drops beyond the queue bound (counted + warned) and still drains without leaks', async () => {
    const resolvers: Array<(response: ReturnType<typeof okResponse>) => void> = []
    fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      resolvers.push((response) => resolve(response as unknown as Response))
    }))
    vi.stubGlobal('fetch', fetchMock)

    const total = DRIVE_VIEW_CONCURRENCY + DRIVE_VIEW_QUEUE_MAX + 3
    for (let i = 0; i < total; i++) scheduleDriveViewForward(view(`d${i}`))

    const stats = getDriveViewQueueStats()
    expect(stats.queued).toBe(DRIVE_VIEW_QUEUE_MAX)
    expect(stats.active).toBe(DRIVE_VIEW_CONCURRENCY)
    expect(stats.dropped).toBe(3)
    expect(fetchMock).toHaveBeenCalledTimes(DRIVE_VIEW_CONCURRENCY)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('queue full'),
      expect.any(Object),
    )

    await drain(resolvers)
    expect(getDriveViewQueueStats()).toMatchObject({ queued: 0, active: 0 })
    expect(fetchMock).toHaveBeenCalledTimes(total - 3)
  })
})
