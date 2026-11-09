import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  meta: {
    doc_id: 'd_drive_only',
    document_name: 'octo:s1:f_default:d_drive_only',
    owner_id: 'someone_else',
    owner_space_id: 's1',
    space_id: 's1',
    folder_id: 'f_default',
    status: 1,
    doc_type: 'doc',
    permission_epoch: 7,
    share_scope: 0,
    share_role: 1,
  },
  epoch: 7,
  directRole: 'none' as 'none' | 'writer',
  claims: {
    ver: 2 as const,
    uid: 'drive_reader',
    docId: 'd_drive_only',
    documentName: 'octo:s1:f_default:d_drive_only',
    homeSpaceId: 's1',
    role: 'reader' as 'reader' | 'writer',
    permission_epoch: 7,
    principal_space_id: 's1',
    current_space_verified: true,
    current_space_id: 's1',
  },
}))

// The token and current epoch are controlled facts; the permission resolver,
// document/ACL lookup and Drive-derived role merge remain the real auth path.
vi.mock('../src/auth/collabToken.js', () => ({ verifyCollabToken: vi.fn(() => fixture.claims) }))
vi.mock('../src/permission/epoch.js', () => ({ currentEpoch: vi.fn(async () => fixture.epoch) }))
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: {
    getByDocumentName: vi.fn(async (name: string) => name === fixture.meta.document_name ? fixture.meta : null),
    getByDocId: vi.fn(async (id: string) => id === fixture.meta.doc_id ? fixture.meta : null),
  },
}))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  docMemberRepo: { getRole: vi.fn(async () => fixture.directRole === 'none' ? undefined : fixture.directRole) },
}))

import { authenticate } from '../src/collab/authenticate.js'
import { setDriveDerivedAccess, type DriveDerivedAccess, type DerivedRole } from '../src/drive/derivedAccessClient.js'
import { recheckCurrentRole } from '../src/permission/resolveRole.js'

function driveProvider(role: DerivedRole | (() => never), expiresInMs = 15_000): DriveDerivedAccess {
  return {
    async derivedAccess(docId, uid, principalSpaceId) {
      const resolved = typeof role === 'function' ? role() : role
      return { docId, uid, principalSpaceId, role: resolved, sourceRevision: 'sha256:test',
        validForMs: expiresInMs, expiresAt: performance.now() + expiresInMs }
    },
    async versions(bindings) {
      return bindings.map(binding => ({ ...binding, sourceRevision: 'sha256:test',
        validForMs: expiresInMs, expiresAt: performance.now() + expiresInMs }))
    },
  }
}

beforeEach(() => {
  fixture.epoch = fixture.claims.permission_epoch
  fixture.claims.role = 'reader'
  fixture.directRole = 'none'
})

describe('same-epoch Docs reader token after Drive revocation', () => {
  it('rejects the old reader token when Drive now reports no source access', async () => {
    setDriveDerivedAccess(driveProvider('none'))

    await expect(authenticate({
      token: 'previously-issued-reader-token',
      documentName: fixture.claims.documentName,
      connectionConfig: {},
    })).rejects.toMatchObject({ code: 4403, reason: 'Forbidden' })
  })
  it('rejects a Drive-derived reader when the source proof expires during authentication', async () => {
    setDriveDerivedAccess(driveProvider('reader', -1))

    await expect(authenticate({
      token: 'previously-issued-reader-token',
      documentName: fixture.claims.documentName,
      connectionConfig: {},
    })).rejects.toMatchObject({ code: 4401, reason: 'Unauthorized' })
  })

  it('keeps an independent direct writer authorized during a Drive outage', async () => {
    setDriveDerivedAccess(driveProvider(() => { throw new Error('Drive unavailable') }))
    fixture.claims.role = 'writer'
    fixture.directRole = 'writer'

    const role = await recheckCurrentRole(fixture.claims.documentName, fixture.claims.uid, 's1')
    expect(role).toBe('writer')
  })
})
