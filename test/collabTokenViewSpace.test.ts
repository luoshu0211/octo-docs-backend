import { beforeEach, describe, expect, it, vi } from 'vitest'

// Token issuance proves access and prepares collaboration; it is not proof that
// the user explicitly opened/viewed the document. Recent history is recorded by
// POST /docs/:docId/view after the frontend commits an explicit open.
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: { getByDocId: vi.fn(), getByDocumentName: vi.fn() },
}))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  docMemberRepo: { getRole: vi.fn() },
}))
vi.mock('../src/db/repos/docViewHistoryRepo.js', () => ({
  docViewHistoryRepo: { upsertViewWithPrune: vi.fn() },
}))

import { issueCollabToken } from '../src/auth/issueCollabToken.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import { docViewHistoryRepo } from '../src/db/repos/docViewHistoryRepo.js'
import { setOctoIdentity } from '../src/auth/octoIdentity.js'

const DOC_SPACE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const FOLDER = 'f_default'
const DOC_ID = 'd_share123'
const DOC_KEY = `octo:${DOC_SPACE}:${FOLDER}:${DOC_ID}`

const docMeta = {
  doc_id: DOC_ID,
  document_name: DOC_KEY,
  owner_id: 'u_viewer',
  owner_space_id: DOC_SPACE,
  space_id: DOC_SPACE,
  folder_id: FOLDER,
  doc_type: 'doc',
  status: 1,
  share_scope: 0,
  share_role: 1,
  permission_epoch: 2,
} as never

beforeEach(() => {
  vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(docMeta)
  vi.mocked(docMemberRepo.getRole).mockResolvedValue('reader')
  vi.mocked(docViewHistoryRepo.upsertViewWithPrune).mockReset()
  setOctoIdentity({
    verifyToken: async () => ({ uid: 'u_viewer', currentSpaceId: DOC_SPACE }),
    getUser: async () => null,
    getUsers: async () => [],
    isSpaceMember: async () => true,
  })
})

describe('issueCollabToken — no implicit recent-view write', () => {
  it('issues a token without recording a view', async () => {
    await issueCollabToken('octo_session_viewer', DOC_KEY, DOC_SPACE)
    expect(docViewHistoryRepo.upsertViewWithPrune).not.toHaveBeenCalled()
  })
})
