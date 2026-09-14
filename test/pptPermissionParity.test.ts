import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import type { DocMeta } from '../src/db/repos/docMetaRepo.js'
import type { Role } from '../src/permission/role.js'

let meta: DocMeta
const grants = new Map<string, Role>()
let membership = true
vi.mock('../src/db/repos/docMetaRepo.js', () => ({ docMetaRepo: { getByDocId: async () => meta } }))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({ docMemberRepo: {
  getRole: async (_doc: string, uid: string, space: string) => grants.get(`${uid}:${space}`),
} }))
import { setOctoIdentity } from '../src/auth/octoIdentity.js'
import { requireDocRole } from '../src/api/guard.js'
import { loadPptDocForRead } from '../src/api/ppt/pptDocGuard.js'
import { SHARE_ROLE_READ, SHARE_ROLE_EDIT, SHARE_ROLE_COMMENT } from '../src/permission/shareScope.js'

beforeEach(() => {
  grants.clear(); membership = true
  meta = { doc_id: 'd_1', document_name: 'octo:A:f_default:ppt:d_1', space_id: 'A', folder_id: 'f_default',
    owner_id: 'owner', owner_space_id: 'A', status: 1, doc_type: 'html_ppt', share_scope: 0, share_role: 1 } as DocMeta
  setOctoIdentity({ isSpaceMember: async () => membership } as never)
})

async function compare(uid: string, space: string, expected: Role | 'none') {
  const req = { uid, octoToken: 'session', viewerSpaceId: space, docSpaceScope: { mode: 'human' } } as Request
  let status = 200
  const res = { status: (value: number) => { status = value; return res }, json: vi.fn() } as unknown as Response
  const normal = await requireDocRole(req, res, 'd_1', 'reader')
  if (expected === 'none') {
    expect(normal).toBeNull(); expect(status).toBe(403)
    await expect(loadPptDocForRead(uid, space, 'd_1', { token: 'session' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  } else {
    const ppt = await loadPptDocForRead(uid, space, 'd_1', { token: 'session' })
    expect(normal?.role).toBe(expected); expect(ppt.role).toBe(expected)
    expect(ppt.spaceMember).toBe(space === 'A')
  }
}

describe('PPT uses the Docs / Board / Sheet permission matrix', () => {
  for (const space of ['A', 'B']) {
    it.each(['reader', 'commenter', 'writer', 'admin'] as const)(`exact %s grant in ${space}`, async role => {
      grants.set(`member:${space}`, role)
      await compare('member', space, role)
      await compare('member', space === 'A' ? 'B' : 'A', 'none')
    })
  }
  it('qualifies owner authority by Space', async () => {
    await compare('owner', 'A', 'admin'); await compare('owner', 'B', 'none')
  })
  it.each([[SHARE_ROLE_READ, 'reader'], [SHARE_ROLE_EDIT, 'writer'], [SHARE_ROLE_COMMENT, 'commenter']] as const)('Space sharing %s only applies in home Space', async (shareRole, role) => {
    meta.share_scope = 1; meta.share_role = shareRole
    await compare('member', 'A', role); await compare('member', 'B', 'none')
  })
  it('authenticated link sharing works across Spaces and never lowers a direct grant', async () => {
    meta.share_scope = 2; meta.share_role = 1
    await compare('member', 'B', 'reader')
    grants.set('member:B', 'writer'); await compare('member', 'B', 'writer')
  })
  it('rejects spoofed current Space even for a direct admin', async () => {
    grants.set('member:B', 'admin'); membership = false
    await expect(loadPptDocForRead('member', 'B', 'd_1', { token: 'session' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('does not disclose archive/type to an unauthorized principal', async () => {
    meta.status = 2; meta.doc_type = 'doc'
    await compare('member', 'B', 'none')
    grants.set('member:B', 'reader')
    await expect(loadPptDocForRead('member', 'B', 'd_1', { token: 'session' })).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})
