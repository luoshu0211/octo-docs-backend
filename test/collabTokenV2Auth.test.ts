import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/auth/collabToken.js', () => ({ verifyCollabToken: vi.fn() }))
vi.mock('../src/permission/epoch.js', () => ({ currentEpoch: vi.fn(async () => 7) }))
vi.mock('../src/permission/recheck.js', () => ({ recheckCurrentRoleCached: vi.fn() }))

import { verifyCollabToken } from '../src/auth/collabToken.js'
import { authenticate } from '../src/collab/authenticate.js'
import { config } from '../src/config/env.js'

const claims = {
  ver: 2 as const,
  uid: 'u_1',
  docId: 'd_1',
  documentName: 'octo:s_1:f_default:d_1',
  homeSpaceId: 's_1',
  role: 'writer' as const,
  permission_epoch: 7,
  space_member: true,
  home_space_verified: true,
}

beforeEach(() => {
  vi.mocked(verifyCollabToken).mockReturnValue(claims)
  config.collabToken.allowLegacyWithoutHomeSpaceProof = false
})

describe('v2 WebSocket identity binding (remove-sp §7.3)', () => {
  it('rejects a pre-hotfix token without home-Space proof in strict mode', async () => {
    vi.mocked(verifyCollabToken).mockReturnValue({ ...claims, home_space_verified: undefined })
    await expect(authenticate({ token: 'legacy', documentName: claims.documentName, connectionConfig: {} }))
      .rejects.toEqual(expect.objectContaining({ code: 4403, reason: 'Forbidden' }))
  })

  it('accepts a still-unexpired pre-hotfix token only during the explicit rollout window', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    config.collabToken.allowLegacyWithoutHomeSpaceProof = true
    vi.mocked(verifyCollabToken).mockReturnValue({ ...claims, home_space_verified: undefined })
    const ctx = await authenticate({ token: 'sensitive-legacy-jwt', documentName: claims.documentName, connectionConfig: {} })
    expect(ctx).toMatchObject({ kind: 'document', doc: 'd_1', space: 's_1' })
    expect(warn).toHaveBeenCalledWith(
      '[octo-docs] legacy_home_space_token_accepted',
      { credentialKind: 'collab_v2' },
    )
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sensitive-legacy-jwt')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('u_1')
    warn.mockRestore()
  })

  it('accepts a token whose docId, homeSpaceId, room and epoch agree', async () => {
    const ctx = await authenticate({
      token: 'v2',
      documentName: claims.documentName,
      connectionConfig: {},
    })
    expect(ctx).toMatchObject({ kind: 'document', doc: 'd_1', space: 's_1', permission_epoch: 7 })
  })

  it.each([
    ['docId', { docId: 'd_other' }],
    ['homeSpaceId', { homeSpaceId: 's_other' }],
  ])('rejects a mismatched %s with 4403', async (_name, patch) => {
    vi.mocked(verifyCollabToken).mockReturnValue({ ...claims, ...patch })
    await expect(authenticate({ token: 'v2', documentName: claims.documentName, connectionConfig: {} }))
      .rejects.toEqual(expect.objectContaining({ code: 4403, reason: 'Forbidden' }))
  })

  it('accepts a whiteboard token bound to its board id and home Space', async () => {
    const whiteboardClaims = {
      ...claims,
      docId: 'board_1',
      documentName: 'octo:s_1:f_default:wb:board_1',
    }
    vi.mocked(verifyCollabToken).mockReturnValue(whiteboardClaims)

    const ctx = await authenticate({
      token: 'v2-board',
      documentName: whiteboardClaims.documentName,
      connectionConfig: {},
    })

    expect(ctx).toMatchObject({ kind: 'whiteboard', board: 'board_1', space: 's_1', permission_epoch: 7 })
  })

  it.each([
    ['docId', { docId: 'board_other' }],
    ['homeSpaceId', { homeSpaceId: 's_other' }],
  ])('rejects a whiteboard token with mismatched %s', async (_name, patch) => {
    const documentName = 'octo:s_1:f_default:wb:board_1'
    vi.mocked(verifyCollabToken).mockReturnValue({
      ...claims,
      docId: 'board_1',
      documentName,
      ...patch,
    })

    await expect(authenticate({ token: 'v2-board', documentName, connectionConfig: {} }))
      .rejects.toEqual(expect.objectContaining({ code: 4403, reason: 'Forbidden' }))
  })
})
