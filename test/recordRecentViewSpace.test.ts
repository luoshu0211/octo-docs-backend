import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * OCTO-456 §4.5 — `recordVerifiedRecentView` must report the Space it ACTUALLY
 * wrote, because the Drive 最近访问 mirror keys on it. A human's identity
 * principal Space (S1) and the verified viewer Space (X-Space-Id: S2) can
 * differ; the OLD forward used principalSpaceId and therefore wrote S2 in docs
 * but S1 in Drive (S2 missing, S1 phantom).
 */
vi.mock('../src/config/env.js', () => ({
  config: { docView: { retainCount: 200, retainDays: 90 } },
}))
const { upsertMock } = vi.hoisted(() => ({ upsertMock: vi.fn() }))
vi.mock('../src/db/repos/docViewHistoryRepo.js', () => ({
  docViewHistoryRepo: { upsertViewWithPrune: upsertMock },
}))
const { isSpaceMemberMock } = vi.hoisted(() => ({ isSpaceMemberMock: vi.fn() }))
vi.mock('../src/auth/octoIdentity.js', () => ({
  getOctoIdentity: () => ({ isSpaceMember: isSpaceMemberMock }),
}))

import { recordVerifiedRecentView } from '../src/api/services/recordRecentView.js'

const viewedAt = new Date('2026-11-23T09:12:33.456Z')

beforeEach(() => {
  upsertMock.mockReset()
  upsertMock.mockResolvedValue(viewedAt)
  isSpaceMemberMock.mockReset()
  isSpaceMemberMock.mockResolvedValue(true)
})

describe('recordVerifiedRecentView — returned Space authority', () => {
  it('human signed in as S1 but viewing in S2 writes S2 and returns spaceId S2', async () => {
    const out = await recordVerifiedRecentView({
      scope: { mode: 'human' },
      uid: 'u_1',
      docId: 'd_1',
      viewerSpaceId: 's2',
      verifiedViewerSpaceId: 's2',
      token: 'tok',
    })
    expect(out).toEqual({ viewedAt, spaceId: 's2' })
    expect(upsertMock).toHaveBeenCalledTimes(1)
    expect(upsertMock).toHaveBeenCalledWith(expect.objectContaining({ uid: 'u_1', docId: 'd_1', spaceId: 's2' }))
    // No fallback to the identity Space: the only row written is S2.
    expect(upsertMock.mock.calls.some(([args]) => args.spaceId === 's1')).toBe(false)
  })

  it('human with an unverified viewer Space skips the write (no home/identity fallback)', async () => {
    isSpaceMemberMock.mockResolvedValue(false)
    const out = await recordVerifiedRecentView({
      scope: { mode: 'human' },
      uid: 'u_1',
      docId: 'd_1',
      viewerSpaceId: 's2',
      token: 'tok',
    })
    expect(out).toBeNull()
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it('human without an X-Space-Id skips the write', async () => {
    const out = await recordVerifiedRecentView({
      scope: { mode: 'human' },
      uid: 'u_1',
      docId: 'd_1',
      token: 'tok',
    })
    expect(out).toBeNull()
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it('bot writes and reports its server-resolved Space', async () => {
    const out = await recordVerifiedRecentView({
      scope: { mode: 'bot', spaceId: 's_bot' },
      uid: 'bot_1',
      docId: 'd_1',
      viewerSpaceId: 'ignored',
    })
    expect(out).toEqual({ viewedAt, spaceId: 's_bot' })
    expect(upsertMock).toHaveBeenCalledWith(expect.objectContaining({ uid: 'bot_1', spaceId: 's_bot' }))
    expect(isSpaceMemberMock).not.toHaveBeenCalled()
  })

  it('a write failure is swallowed (best effort) and reports no Space', async () => {
    upsertMock.mockRejectedValue(new Error('mysql down'))
    const out = await recordVerifiedRecentView({
      scope: { mode: 'human' },
      uid: 'u_1',
      docId: 'd_1',
      viewerSpaceId: 's2',
      verifiedViewerSpaceId: 's2',
      token: 'tok',
    })
    expect(out).toBeNull()
  })
})
