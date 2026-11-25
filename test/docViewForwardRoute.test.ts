import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * OCTO-456 §4.5 — POST /api/v1/docs/:docId/view forwards a SUCCESSFUL view to
 * drive. The forwarder itself is mocked here; this pins the hand-off (only when
 * docs actually recorded a view, with the doc's HOME Space and the persisted
 * timestamp) and that the HTTP response never waits on it.
 */
vi.mock('../src/api/guard.js', () => ({ requireDocRole: vi.fn() }))
vi.mock('../src/api/services/recordRecentView.js', () => ({
  recordVerifiedRecentView: vi.fn(),
}))
const { scheduleMock } = vi.hoisted(() => ({ scheduleMock: vi.fn() }))
vi.mock('../src/drive/viewEventForwarder.js', () => ({
  scheduleDriveViewForward: scheduleMock,
}))

import { recordDocViewHandler } from '../src/api/routes/docs.js'
import { requireDocRole } from '../src/api/guard.js'
import { recordVerifiedRecentView } from '../src/api/services/recordRecentView.js'

interface MockRes {
  statusCode: number
  body: unknown
  status(code: number): MockRes
  json(body: unknown): MockRes
}
function response(): MockRes {
  return {
    statusCode: 0,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}
function request(overrides: Record<string, unknown> = {}) {
  return {
    uid: 'u_1',
    spaceId: 'viewer_space',
    principalSpaceId: 'p_space',
    octoToken: 'tok',
    docSpaceScope: { mode: 'human' as const },
    viewerSpaceId: 'viewer_space',
    verifiedViewerSpaceId: 'viewer_space',
    params: { docId: 'd_1' },
    query: {},
    ...overrides,
  }
}
const guard = {
  role: 'reader',
  meta: { doc_id: 'd_1', space_id: 'doc_home_space', status: 1 },
}

beforeEach(() => {
  vi.mocked(requireDocRole).mockReset()
  vi.mocked(recordVerifiedRecentView).mockReset()
  scheduleMock.mockReset()
  vi.mocked(requireDocRole).mockResolvedValue(guard as never)
})

describe('POST /docs/:docId/view — drive forward', () => {
  it('forwards the ACTUALLY WRITTEN Space (not the identity principal Space) plus doc home Space and viewedAt', async () => {
    const viewedAt = new Date('2026-11-23T09:12:33.456Z')
    vi.mocked(recordVerifiedRecentView).mockResolvedValue({ viewedAt, spaceId: 'viewer_space' })
    const res = response()
    await recordDocViewHandler(request() as never, res as never)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ ok: true, viewedAt: viewedAt.toISOString() })
    expect(scheduleMock).toHaveBeenCalledTimes(1)
    expect(scheduleMock).toHaveBeenCalledWith({
      uid: 'u_1',
      principalSpaceId: 'viewer_space',
      docId: 'd_1',
      spaceId: 'doc_home_space',
      viewedAt,
    })
  })

  it('S1 identity + S2 viewer: forwards S2 (the recent-view row Space), never S1', async () => {
    // The human's identity/principal Space defaults to S1 while X-Space-Id=S2 is
    // the verified viewer. docs writes the recent-view row under S2, so Drive
    // must receive S2 too — otherwise S2 is missing and S1 gets a phantom entry.
    const viewedAt = new Date('2026-11-23T09:12:33.456Z')
    vi.mocked(recordVerifiedRecentView).mockResolvedValue({ viewedAt, spaceId: 's2' })
    const res = response()
    await recordDocViewHandler(
      request({ principalSpaceId: 's1', viewerSpaceId: 's2', verifiedViewerSpaceId: 's2' }) as never,
      res as never,
    )
    expect(scheduleMock).toHaveBeenCalledWith(expect.objectContaining({ principalSpaceId: 's2' }))
    expect(scheduleMock.mock.calls[0]![0].principalSpaceId).not.toBe('s1')
    expect(vi.mocked(recordVerifiedRecentView).mock.calls[0]![0]).toMatchObject({
      viewerSpaceId: 's2',
      verifiedViewerSpaceId: 's2',
    })
  })

  it('does NOT forward when the recent-view write was skipped (recorded:false)', async () => {
    vi.mocked(recordVerifiedRecentView).mockResolvedValue(null)
    const res = response()
    await recordDocViewHandler(request() as never, res as never)
    expect(res.body).toEqual({ ok: true, recorded: false })
    expect(scheduleMock).not.toHaveBeenCalled()
  })

  it('does NOT forward when the reader guard blocks', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(null)
    await recordDocViewHandler(request() as never, response() as never)
    expect(scheduleMock).not.toHaveBeenCalled()
  })
})
