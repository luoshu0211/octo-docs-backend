import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * XIN-1825 P1-3 — the membership-lookup fail-closed swallow is SCOPED to the PPT
 * relay ticket path.
 *
 * `resolveEffectiveRoleWithMembership` (the relay ticket caller) must fail CLOSED
 * to non-member on an identity-service throw — it has to produce a concrete,
 * signable boolean and a live downgrade recheck must match issuance. The legacy
 * `resolveEffectiveRole` (the REST guard + the three transactional write
 * services) must NOT swallow: an unexpected throw PROPAGATES, byte-identical to
 * merge-base, so an identity outage surfaces as a 5xx rather than silently
 * degrading an `anyone_in_space` share writer to 403. This pins that split so a
 * future refactor cannot re-collapse the legacy paths onto the relay's swallow.
 */
import { setOctoIdentity } from '../src/auth/octoIdentity.js'
import {
  resolveEffectiveRole,
  resolveEffectiveRoleWithMembership,
} from '../src/permission/resolveEffectiveRole.js'
import { SHARE_SCOPE_ANYONE, SHARE_SCOPE_AUTHENTICATED, SHARE_ROLE_EDIT } from '../src/permission/shareScope.js'

const anyoneEdit = { space_id: 's1', share_scope: SHARE_SCOPE_ANYONE, share_role: SHARE_ROLE_EDIT }

function withThrowingMembership(): void {
  setOctoIdentity({
    isSpaceMember: async () => {
      throw new Error('identity service unavailable')
    },
  } as never)
}

describe('resolveEffectiveRole fail-closed scope (XIN-1825 P1-3)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('the relay ticket path fails CLOSED and logs only a sanitized event on an isSpaceMember throw', async () => {
    const uid = 'uid-sensitive'
    const spaceId = 'space-sensitive'
    const token = 'token-sensitive'
    const rawError = 'identity service unavailable at https://identity.internal.example'
    setOctoIdentity({
      isSpaceMember: async () => {
        throw new Error(rawError)
      },
    } as never)

    const out = await resolveEffectiveRoleWithMembership(
      uid,
      'none',
      { ...anyoneEdit, space_id: spaceId },
      { principalSpaceId: spaceId, token },
    )
    expect(out).toEqual({ role: 'none', spaceMember: false })
    expect(warnSpy).toHaveBeenCalledWith('[octo-docs] space_membership_verify_error', {
      reason: 'identity_call_threw',
      path: 'ppt_relay',
    })

    const serializedLog = JSON.stringify(warnSpy.mock.calls)
    for (const secret of [uid, spaceId, token, rawError, 'identity.internal.example']) {
      expect(serializedLog).not.toContain(secret)
    }
  })

  it('the legacy write-path resolver PROPAGATES an isSpaceMember throw (no silent 403 degrade)', async () => {
    withThrowingMembership()
    await expect(resolveEffectiveRole('u_m', 'none', anyoneEdit, { principalSpaceId: 's1', token: 't' })).rejects.toThrow(
      /identity service unavailable/,
    )
  })

  it('the legacy resolver never even consults membership when the share grant is not load-bearing', async () => {
    withThrowingMembership()
    // A direct writer already satisfies the share ceiling, so membership (which
    // would throw) is never called — proves the propagation path is lazy, not a
    // regression that adds IO.
    await expect(resolveEffectiveRole('u_w', 'writer', anyoneEdit, { token: 't' })).resolves.toBe('writer')
  })

  it('authenticated derives writer without any irrelevant home-Space membership lookup', async () => {
    withThrowingMembership()
    await expect(resolveEffectiveRoleWithMembership('u_any', 'none', {
      space_id: 's_home',
      share_scope: SHARE_SCOPE_AUTHENTICATED,
      share_role: SHARE_ROLE_EDIT,
    }, { token: 't' })).resolves.toEqual({ role: 'writer', spaceMember: false })
  })
})
