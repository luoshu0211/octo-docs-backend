import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit test for the collab-token issuance seam (#64, design §5.1/§5.3).
// Repos are mocked; identity (incl. isSpaceMember) is injected via setOctoIdentity.
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: { getByDocId: vi.fn(), getByDocumentName: vi.fn() },
}))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  docMemberRepo: { getRole: vi.fn() },
}))
vi.mock('../src/permission/epoch.js', () => ({ currentEpoch: vi.fn(async () => 3) }))
vi.mock('../src/permission/recheck.js', () => ({ recheckCurrentRoleCached: vi.fn() }))

import { issueCollabToken, issueCollabTokenByDocId } from '../src/auth/issueCollabToken.js'
import { verifyCollabToken, signCollabToken } from '../src/auth/collabToken.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import { setOctoIdentity } from '../src/auth/octoIdentity.js'
import { authenticate } from '../src/collab/authenticate.js'

const SPACE = 'sp_1'
const FOLDER = 'f_default'
const DOC_ID = 'd_share'
const DOC_KEY = `octo:${SPACE}:${FOLDER}:${DOC_ID}`

const docMeta = (over: Record<string, unknown> = {}) =>
  ({
    doc_id: DOC_ID,
    document_name: DOC_KEY,
    owner_id: 'u_owner',
    owner_space_id: SPACE,
    space_id: SPACE,
    folder_id: FOLDER,
    doc_type: 'doc',
    status: 1,
    permission_epoch: 3,
    share_scope: 0,
    share_role: 1,
    ...over,
  }) as never

let memberCalls: number
/** uid -> fixed identity, with an isSpaceMember that returns the configured value. */
function asUser(uid: string, member: boolean) {
  memberCalls = 0
  setOctoIdentity({
    verifyToken: async (t: string) => (t ? { uid } : null),
    getUser: async () => null,
    getUsers: async () => [],
    isSpaceMember: async () => {
      memberCalls += 1
      return member
    },
  } as never)
}

beforeEach(() => {
  vi.mocked(docMetaRepo.getByDocId).mockReset()
  vi.mocked(docMetaRepo.getByDocumentName).mockReset()
  vi.mocked(docMemberRepo.getRole).mockReset()
})

describe('issueCollabToken — space-scoped share (#64)', () => {
  it('restricted doc: a verified current-Space member without a direct role gets 403', async () => {
    asUser('u_x', true)
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(docMeta())
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(docMeta())
    vi.mocked(docMemberRepo.getRole).mockResolvedValue(null as never)
    const out = await issueCollabToken('tok', DOC_KEY, SPACE)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.status).toBe(403)
    expect(memberCalls).toBe(1)
  })

  it('anyone_in_space/edit: a space member with no doc_member gets a writer token + space_member claim', async () => {
    asUser('u_m', true)
    const m = docMeta({ share_scope: 1, share_role: 2 })
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(m)
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(m)
    vi.mocked(docMemberRepo.getRole).mockResolvedValue(null as never)
    const out = await issueCollabToken('tok', DOC_KEY, SPACE)
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.result.role).toBe('writer')
      const claims = verifyCollabToken(out.result.token)
      expect(claims.role).toBe('writer')
      expect(claims.space_member).toBe(true)
    }
    // Current-Space membership is verified once and reused; share membership
    // is the same Space in this fixture, so no redundant directory lookups.
    expect(memberCalls).toBe(1)
  })

  it('anyone_in_space/read: member gets reader', async () => {
    asUser('u_m', true)
    const m = docMeta({ share_scope: 1, share_role: 1 })
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(m)
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(m)
    vi.mocked(docMemberRepo.getRole).mockResolvedValue(null as never)
    const out = await issueCollabToken('tok', DOC_KEY, SPACE)
    expect(out.ok && out.result.role).toBe('reader')
  })

  it('authenticated/comment issues a commenter token that WS keeps body-read-only', async () => {
    asUser('u_commenter', true)
    const m = docMeta({ share_scope: 2, share_role: 4 })
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(m)
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(m)
    vi.mocked(docMemberRepo.getRole).mockResolvedValue(null as never)
    const out = await issueCollabToken('tok', DOC_KEY, 'sp_external')
    expect(out.ok && out.result.role).toBe('commenter')
    if (out.ok) {
      const connectionConfig = {}
      const auth = await authenticate({ token: out.result.token, documentName: DOC_KEY, connectionConfig })
      expect(auth.role).toBe('commenter')
      expect(connectionConfig).toEqual({ readOnly: true })
    }
  })

  it('A1/A3: non-member (isSpaceMember false — incl. the fail-closed lookup path) => 403, no token', async () => {
    // isSpaceMember is fail-closed at the source (returns false on any lookup
    // error — see isSpaceMember.test.ts), so both a genuine non-member (A1) and
    // an unreachable octo-server (A3) reach issuance as `false`.
    asUser('u_x', false)
    const m = docMeta({ share_scope: 1, share_role: 2 })
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(m)
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(m)
    vi.mocked(docMemberRepo.getRole).mockResolvedValue(null as never)
    const out = await issueCollabToken('tok', DOC_KEY, SPACE)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.status).toBe(403)
  })

  it.each([
    ['legacy', async () => issueCollabToken('tok', DOC_KEY, 'sp_external')],
    ['docId-first', async () => issueCollabTokenByDocId('u_both', DOC_ID, 'tok', 'sp_external')],
  ])('%s does not mint a share-derived token when current Space differs from Home Space', async (_name, issue) => {
    asUser('u_both', true)
    const m = docMeta({ share_scope: 1, share_role: 1 })
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(m)
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(m)
    vi.mocked(docMemberRepo.getRole).mockResolvedValue(null as never)
    const out = await issue()
    expect(out).toEqual({ ok: false, status: 403, error: 'forbidden' })
    expect(memberCalls).toBe(1)
  })

  it('owner on an anyone_in_space doc stays admin after current-Space verification', async () => {
    asUser('u_owner', true)
    const m = docMeta({ share_scope: 1, share_role: 2 })
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(m)
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(m)
    const out = await issueCollabToken('tok', DOC_KEY, SPACE)
    expect(out.ok && out.result.role).toBe('admin')
    if (out.ok) expect(verifyCollabToken(out.result.token).space_member).toBe(true)
  })

  it('O1: a token minted without the space_member claim verifies and reports false', () => {
    // A pre-#64 token carried no space_member — verify must not reject it, and
    // the claim reads as absent (=> false at the use site, fail-closed).
    const legacy = signCollabToken({
      uid: 'u_1',
      documentName: DOC_KEY,
      role: 'reader',
      permission_epoch: 3,
      principal_space_id: SPACE,
    })
    const claims = verifyCollabToken(legacy.token)
    expect(claims.role).toBe('reader')
    expect(claims.space_member).toBeUndefined()
  })

  it.each([
    ['legacy', async () => issueCollabToken('tok', DOC_KEY, 'sp_external')],
    ['docId-first', async () => issueCollabTokenByDocId('u_external', DOC_ID, 'tok', 'sp_external')],
  ])('%s authenticated/edit token passes real authenticate for an external authenticated Human', async (_name, issue) => {
    asUser('u_external', true)
    const m = docMeta({ share_scope: 2, share_role: 2 })
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(m)
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(m)
    vi.mocked(docMemberRepo.getRole).mockResolvedValue(null as never)
    const out = await issue()
    expect(out.ok && out.result.role).toBe('writer')
    if (out.ok) {
      const claims = verifyCollabToken(out.result.token)
      expect(claims.space_member).not.toBe(true)
      expect(claims.home_space_verified).not.toBe(true)
      expect(claims.current_space_verified).toBe(true)
      expect(claims.current_space_id).toBe('sp_external')
      const connectionConfig = {}
      const auth = await authenticate({ token: out.result.token, documentName: DOC_KEY, connectionConfig })
      expect(auth).toMatchObject({ role: 'writer', space_member: false })
      expect(connectionConfig).not.toHaveProperty('readOnly')
    }
  })

  it('legacy issuance rejects missing identity before authenticated scope can derive access', async () => {
    asUser('', true)
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(docMeta({ share_scope: 2, share_role: 1 }))
    expect(await issueCollabToken('', DOC_KEY, 'sp_external')).toEqual({
      ok: false,
      status: 401,
      error: 'login_required',
    })
  })

  it.each([
    ['legacy', async () => issueCollabToken('tok', DOC_KEY, 'sp_external')],
    ['docId-first', async () => issueCollabTokenByDocId('u_direct', DOC_ID, 'tok', 'sp_external')],
  ])('%s direct cross-Space collaborator token passes real authenticate as read-only', async (_name, issue) => {
    asUser('u_direct', true)
    const m = docMeta({ share_scope: 0, share_role: 1 })
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(m)
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(m)
    vi.mocked(docMemberRepo.getRole).mockResolvedValue('reader')
    const out = await issue()
    expect(out.ok && out.result.role).toBe('reader')
    if (out.ok) {
      const claims = verifyCollabToken(out.result.token)
      expect(claims.home_space_verified).not.toBe(true)
      expect(claims.space_member).not.toBe(true)
      expect(claims.current_space_verified).toBe(true)
      expect(claims.current_space_id).toBe('sp_external')
      const connectionConfig = {}
      const auth = await authenticate({ token: out.result.token, documentName: DOC_KEY, connectionConfig })
      expect(auth).toMatchObject({ role: 'reader', space_member: false })
      expect(connectionConfig).toEqual({ readOnly: true })
    }
  })
})
