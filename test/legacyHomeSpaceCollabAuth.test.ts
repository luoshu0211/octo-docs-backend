import { beforeEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'

vi.mock('../src/permission/epoch.js', () => ({ currentEpoch: vi.fn(async () => 7) }))
vi.mock('../src/permission/recheck.js', () => ({ recheckCurrentRoleCached: vi.fn() }))

import { authenticate } from '../src/collab/authenticate.js'
import { config } from '../src/config/env.js'
import { LEGACY_COLLAB_AUD } from '../src/auth/collabToken.js'

const documentName = 'octo:s_1:f_default:d_1'

function legacyV1Token(): string {
  return jwt.sign({
    uid: 'u_legacy',
    documentName,
    role: 'writer',
    permission_epoch: 7,
  }, config.collabToken.secret, {
    algorithm: 'HS256',
    audience: LEGACY_COLLAB_AUD,
    expiresIn: 30,
  })
}

beforeEach(() => {
  config.collabToken.allowLegacyWithoutHomeSpaceProof = false
})

describe('pre-hotfix v1 Hocuspocus credential rollout', () => {
  it('rejects a genuine signed no-ver token in strict mode', async () => {
    await expect(authenticate({ token: legacyV1Token(), documentName, connectionConfig: {} }))
      .rejects.toEqual(expect.objectContaining({ code: 4403, reason: 'Forbidden' }))
  })

  it('accepts the same signed no-ver token only during the rollout window', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    config.collabToken.allowLegacyWithoutHomeSpaceProof = true
    const ctx = await authenticate({ token: legacyV1Token(), documentName, connectionConfig: {} })
    expect(ctx).toMatchObject({ kind: 'document', doc: 'd_1', space: 's_1' })
    expect(warn).toHaveBeenCalledWith(
      '[octo-docs] legacy_home_space_token_accepted',
      { credentialKind: 'collab_v1' },
    )
    expect(JSON.stringify(warn.mock.calls)).not.toContain('u_legacy')
    warn.mockRestore()
  })
})
