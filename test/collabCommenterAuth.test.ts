import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/auth/collabToken.js', () => ({ verifyCollabToken: vi.fn() }))
vi.mock('../src/permission/epoch.js', () => ({ currentEpoch: vi.fn(async () => 7) }))
vi.mock('../src/permission/recheck.js', () => ({ recheckCurrentRoleCached: vi.fn() }))

import { verifyCollabToken } from '../src/auth/collabToken.js'
import { authenticate } from '../src/collab/authenticate.js'

describe('commenter collab authentication', () => {
  beforeEach(() => {
    vi.mocked(verifyCollabToken).mockReturnValue({
      uid: 'u_commenter',
      documentName: 'octo:s1:f1:d1',
      role: 'commenter',
      permission_epoch: 7,
      space_member: true,
      home_space_verified: true,
      current_space_verified: true,
      current_space_id: 's1',
    })
  })

  it('accepts the role for reads but marks body writes read-only', async () => {
    const connectionConfig: { readOnly?: boolean } = {}
    const context = await authenticate({ token: 'token', documentName: 'octo:s1:f1:d1', connectionConfig })
    expect(context.role).toBe('commenter')
    expect(connectionConfig.readOnly).toBe(true)
  })
})
