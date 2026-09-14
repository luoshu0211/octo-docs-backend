import { describe, it, expect, afterEach, vi } from 'vitest'

/**
 * TES-131/TES-132 — the THIRD permission source in resolveEffectiveRole:
 * effectiveRole = max(directRole, share-derived, drive-derived-reader). Drive
 * only ever grants `reader`, so it can only raise a base below `reader`, and it
 * is fail-closed (a throw is treated as `none`, never lowering the base). These
 * pin the acceptance cases: a direct writer never touches the drive (short
 * circuit), a restricted doc with no direct/share access is raised to reader by
 * drive, a drive throw degrades to none, and an anyone_in_space share whose
 * principal Space does not match neither grants via the share nor via drive.
 */
import { resolveEffectiveRole } from '../src/permission/resolveEffectiveRole.js'
import { setDriveDerivedAccess, type DriveDerivedAccess } from '../src/drive/derivedAccessClient.js'
import { setOctoIdentity } from '../src/auth/octoIdentity.js'
import type { ResolvedRole } from '../src/permission/role.js'
import {
  SHARE_SCOPE_RESTRICTED,
  SHARE_SCOPE_ANYONE,
  SHARE_ROLE_EDIT,
} from '../src/permission/shareScope.js'

const restricted = { doc_id: 'doc1', space_id: 's1', share_scope: SHARE_SCOPE_RESTRICTED, share_role: SHARE_ROLE_EDIT }

/** A drive client stub that answers a fixed role and counts its calls. */
function stubDrive(role: ResolvedRole | (() => never)): { calls: number } {
  const state = { calls: 0 }
  const impl: DriveDerivedAccess = {
    async derivedRole() {
      state.calls += 1
      if (typeof role === 'function') role()
      return role
    },
  }
  setDriveDerivedAccess(impl)
  return state
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolveEffectiveRole drive-derived source (TES-131)', () => {
  it('direct=writer short-circuits: no drive call, returns writer', async () => {
    const drive = stubDrive('reader')
    const role = await resolveEffectiveRole('u1', 'writer', restricted, { principalSpaceId: 's1' })
    expect(role).toBe('writer')
    expect(drive.calls).toBe(0)
  })

  it('direct=none + share=none + drive=reader => reader', async () => {
    const drive = stubDrive('reader')
    const role = await resolveEffectiveRole('u1', 'none', restricted, { principalSpaceId: 's1' })
    expect(role).toBe('reader')
    expect(drive.calls).toBe(1)
  })

  it('drive throws => fail-closed to none (never lowers, never propagates)', async () => {
    stubDrive(() => {
      throw new Error('drive unreachable')
    })
    const role = await resolveEffectiveRole('u1', 'none', restricted, { principalSpaceId: 's1' })
    expect(role).toBe('none')
  })

  it('drive never lowers an existing reader base: direct=reader with drive=none stays reader, no call', async () => {
    const drive = stubDrive('none')
    const role = await resolveEffectiveRole('u1', 'reader', restricted, { principalSpaceId: 's1' })
    expect(role).toBe('reader')
    expect(drive.calls).toBe(0)
  })

  it('anyone_in_space share with a principal-Space mismatch grants nothing (share=none, drive=none) => none', async () => {
    // isSpaceMember must never be consulted: the Space mismatch short-circuits the
    // share path before any membership lookup. A throwing identity proves it.
    setOctoIdentity({
      isSpaceMember: async () => {
        throw new Error('should not be called')
      },
    } as never)
    stubDrive('none')
    const anyoneEdit = { doc_id: 'doc1', space_id: 's1', share_scope: SHARE_SCOPE_ANYONE, share_role: SHARE_ROLE_EDIT }
    const role = await resolveEffectiveRole('u1', 'none', anyoneEdit, { principalSpaceId: 's_other' })
    expect(role).toBe('none')
  })

  it('drive is skipped when the meta carries no doc_id (narrow write-service meta)', async () => {
    const drive = stubDrive('reader')
    const role = await resolveEffectiveRole(
      'u1',
      'none',
      { space_id: 's1', share_scope: SHARE_SCOPE_RESTRICTED, share_role: SHARE_ROLE_EDIT },
      { principalSpaceId: 's1' },
    )
    expect(role).toBe('none')
    expect(drive.calls).toBe(0)
  })

  it('drive is skipped when the caller has no principal Space (anonymous)', async () => {
    const drive = stubDrive('reader')
    const role = await resolveEffectiveRole('u1', 'none', restricted, {})
    expect(role).toBe('none')
    expect(drive.calls).toBe(0)
  })
})
