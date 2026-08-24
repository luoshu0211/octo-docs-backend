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
  current_space_verified: true,
  current_space_id: 's_1',
}

beforeEach(() => {
  vi.mocked(verifyCollabToken).mockReturnValue(claims)
  config.collabToken.allowLegacyWithoutHomeSpaceProof = false
})

describe('v2 WebSocket identity binding (remove-sp §7.3)', () => {
  it.each([
    ['missing proof', { current_space_verified: undefined }],
    ['false proof', { current_space_verified: false }],
    ['missing current Space', { current_space_id: undefined }],
    ['empty current Space', { current_space_id: '' }],
  ])('rejects %s with 4403', async (_name, patch) => {
    vi.mocked(verifyCollabToken).mockReturnValue({ ...claims, ...patch })
    await expect(authenticate({ token: 'legacy', documentName: claims.documentName, connectionConfig: {} }))
      .rejects.toEqual(expect.objectContaining({ code: 4403, reason: 'Forbidden' }))
  })

  it('does not let the legacy compatibility flag bypass missing current-Space proof', async () => {
    config.collabToken.allowLegacyWithoutHomeSpaceProof = true
    vi.mocked(verifyCollabToken).mockReturnValue({ ...claims, current_space_verified: undefined })
    await expect(authenticate({ token: 'legacy', documentName: claims.documentName, connectionConfig: {} }))
      .rejects.toEqual(expect.objectContaining({ code: 4403, reason: 'Forbidden' }))
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
