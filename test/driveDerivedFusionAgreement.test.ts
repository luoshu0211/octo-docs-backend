import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * TES-137 HIGH blocker — drive-derived viewer access must be folded in at EVERY
 * effective-role seam, not just the open-context REST guard. Before this fix the
 * drive source only reached `resolveEffectiveRole`, so the same caller (direct =
 * none / share = none / drive = reader) could get a reader answer on one endpoint
 * and a forbidden answer on another — a WS the collab-token opened would fail its
 * first stale-token recheck. These pin that the four seams AGREE for the same
 * caller (the issuance/recheck single-resolution invariant):
 *   1. open-context / REST guard   -> resolveEffectiveRole
 *   2. collab-token issuance       -> issueCollabToken
 *   3. WS stale-token recheck      -> recheckCurrentRole (recheck.ts wraps this)
 *   4. PPT relay ticket            -> resolveEffectiveRoleWithMembership
 *
 * Offline: repos are mocked, identity is injected, and the drive client is a stub
 * (setDriveDerivedAccess), so no live infra is touched.
 */
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: { getByDocId: vi.fn(), getByDocumentName: vi.fn() },
}))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  docMemberRepo: { getRole: vi.fn() },
}))

import { issueCollabToken } from '../src/auth/issueCollabToken.js'
import { recheckCurrentRole } from '../src/permission/resolveRole.js'
import {
  resolveEffectiveRole,
  resolveEffectiveRoleWithMembership,
} from '../src/permission/resolveEffectiveRole.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import { setOctoIdentity } from '../src/auth/octoIdentity.js'
import {
  setDriveDerivedAccess,
  HttpDriveDerivedAccess,
  type DriveDerivedAccess,
} from '../src/drive/derivedAccessClient.js'
import { SHARE_SCOPE_RESTRICTED, SHARE_ROLE_EDIT } from '../src/permission/shareScope.js'
import type { ResolvedRole } from '../src/permission/role.js'

const SPACE = '6fd5d5cf10b14d6ebe814b63a856766d'
const FOLDER = 'f_default'
const DOC_ID = 'd_derived123'
const DOC_KEY = `octo:${SPACE}:${FOLDER}:${DOC_ID}`
const UID = 'caller_u'

// A restricted doc owned by SOMEONE ELSE: the caller holds no doc_member row and
// no share grant, so the ONLY source that can grant `reader` is drive-derived.
const docMeta = {
  doc_id: DOC_ID,
  document_name: DOC_KEY,
  owner_id: 'someone_else',
  owner_space_id: SPACE,
  space_id: SPACE,
  folder_id: FOLDER,
  doc_type: 'doc',
  status: 1,
  permission_epoch: 3,
  share_scope: SHARE_SCOPE_RESTRICTED,
  share_role: SHARE_ROLE_EDIT,
}

/** A drive stub answering a fixed role (or throwing), counting its calls. */
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

beforeEach(() => {
  vi.mocked(docMetaRepo.getByDocId).mockReset().mockResolvedValue(docMeta as never)
  vi.mocked(docMetaRepo.getByDocumentName).mockReset().mockResolvedValue(docMeta as never)
  vi.mocked(docMemberRepo.getRole).mockReset().mockResolvedValue(undefined as never)
  setOctoIdentity({
    verifyToken: async (t: string) => (t ? { uid: UID } : null),
    getUser: async () => null,
    getUsers: async () => [],
    isSpaceMember: async () => true,
  } as never)
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** The role each seam resolves for the standard direct=none/share=none caller. */
async function rolesAcrossSeams(): Promise<{ open: ResolvedRole; token: ResolvedRole | 'forbidden'; recheck: ResolvedRole }> {
  const open = await resolveEffectiveRole(UID, 'none', docMeta, { principalSpaceId: SPACE })
  const issued = await issueCollabToken('octo_session', DOC_KEY, SPACE)
  const token = issued.ok ? issued.result.role : 'forbidden'
  const recheck = await recheckCurrentRole(DOC_KEY, UID, SPACE, false)
  return { open, token, recheck }
}

describe('drive-derived fusion-point agreement (TES-137)', () => {
  it('drive=reader: open-context, collab-token, and WS recheck ALL grant reader', async () => {
    stubDrive('reader')
    const { open, token, recheck } = await rolesAcrossSeams()
    expect(open).toBe('reader')
    expect(token).toBe('reader')
    expect(recheck).toBe('reader')
  })

  it('drive=none: the same three seams ALL forbid (reader nowhere, 403 on issuance)', async () => {
    stubDrive('none')
    const { open, token, recheck } = await rolesAcrossSeams()
    expect(open).toBe('none')
    expect(token).toBe('forbidden')
    expect(recheck).toBe('none')
  })

  it('PPT relay ticket path agrees with the REST read path for the same caller', async () => {
    stubDrive('reader')
    const rest = await resolveEffectiveRole(UID, 'none', docMeta, { principalSpaceId: SPACE })
    const { role: ticket } = await resolveEffectiveRoleWithMembership(UID, 'none', docMeta, {
      isBot: true,
      principalSpaceId: SPACE,
    })
    expect(rest).toBe('reader')
    expect(ticket).toBe(rest)
  })

  it('fail-closed: a drive throw is treated as none at all four seams (never upgraded, never propagated)', async () => {
    stubDrive(() => {
      throw new Error('drive 500')
    })
    const { role: ticket } = await resolveEffectiveRoleWithMembership(UID, 'none', docMeta, {
      isBot: true,
      principalSpaceId: SPACE,
    })
    const { open, token, recheck } = await rolesAcrossSeams()
    expect(open).toBe('none')
    expect(ticket).toBe('none')
    expect(recheck).toBe('none')
    expect(token).toBe('forbidden')
  })

  it('flag OFF: the new seams are byte-identical to pre-feature (no drive grant, direct role only)', async () => {
    // The REAL client with the feature disabled — the drive lookup is never made
    // and never widens access, so the no-access caller stays forbidden everywhere.
    setDriveDerivedAccess(new HttpDriveDerivedAccess({ enabled: false }))
    const { open, token, recheck } = await rolesAcrossSeams()
    expect(open).toBe('none')
    expect(token).toBe('forbidden')
    expect(recheck).toBe('none')

    // And a direct writer is unchanged (short-circuit: drive never consulted).
    vi.mocked(docMemberRepo.getRole).mockResolvedValue('writer' as never)
    expect(await resolveEffectiveRole(UID, 'writer', docMeta, { principalSpaceId: SPACE })).toBe('writer')
    expect(await recheckCurrentRole(DOC_KEY, UID, SPACE, false)).toBe('writer')
    const issued = await issueCollabToken('octo_session', DOC_KEY, SPACE)
    expect(issued.ok && issued.result.role).toBe('writer')
  })
})
