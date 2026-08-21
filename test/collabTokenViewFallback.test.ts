import { beforeEach, describe, expect, it, vi } from 'vitest'

// Regression: collab-token issuance may happen during restoration/reconnect and
// therefore must never create recent-history rows on its own.
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: { getByDocId: vi.fn(), getByDocumentName: vi.fn() },
}))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  docMemberRepo: { getRole: vi.fn() },
}))
vi.mock('../src/db/repos/docViewHistoryRepo.js', () => ({
  docViewHistoryRepo: { upsertViewWithPrune: vi.fn() },
}))

import { issueCollabTokenByDocId } from '../src/auth/issueCollabToken.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import { docViewHistoryRepo } from '../src/db/repos/docViewHistoryRepo.js'
import { setOctoIdentity } from '../src/auth/octoIdentity.js'

const SPACE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const DOC_ID = 'd_share123'
const DOC_KEY = `octo:${SPACE}:f_default:${DOC_ID}`
const meta = {
  doc_id: DOC_ID,
  document_name: DOC_KEY,
  owner_id: 'owner_z',
  owner_space_id: SPACE,
  space_id: SPACE,
  folder_id: 'f_default',
  doc_type: 'doc',
  status: 1,
  share_scope: 0,
  share_role: 1,
  permission_epoch: 2,
} as never

beforeEach(() => {
  vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(meta)
  vi.mocked(docMemberRepo.getRole).mockResolvedValue('reader')
  vi.mocked(docViewHistoryRepo.upsertViewWithPrune).mockReset()
  setOctoIdentity({
    verifyToken: async () => ({ uid: 'u_viewer' }),
    getUser: async () => null,
    getUsers: async () => [],
    isSpaceMember: async () => true,
  })
})

describe('issueCollabTokenByDocId — no recent-view fallback', () => {
  it('does not record a view during token issuance', async () => {
    const out = await issueCollabTokenByDocId('u_viewer', DOC_ID, 'session', SPACE)
    expect(out.ok).toBe(true)
    expect(docViewHistoryRepo.upsertViewWithPrune).not.toHaveBeenCalled()
  })
})
