import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * TES-131 internal doc-role lookup: the drive service asks docs-backend for a
 * caller's DIRECT role on a doc (resolveRole semantics: owner => admin, else the
 * doc_member row, else none) so it can decide a drive-library grant WITHOUT
 * recursing back through the docs derived-access lookup. These pin the auth
 * gate, the direct-role resolution, and the role_rank/doc_status/owner_space_id
 * projection. Mirrors internalHtmlRegistration.test.ts: mock config + repos and
 * call the exported handler directly (no live infra).
 */
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: { driveDerived: { inboundToken: 'drive-tok', outboundToken: 'outbound-only-tok' } },
}))
vi.mock('../src/config/env.js', () => ({ config: mockConfig }))
vi.mock('../src/db/repos/docMetaRepo.js', () => ({ docMetaRepo: { getByDocId: vi.fn() } }))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({ docMemberRepo: { getRole: vi.fn() } }))

import { internalDocRoleHandler } from '../src/api/routes/internalDocRole.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'

interface MockRes {
  statusCode: number
  body: unknown
  status(code: number): MockRes
  json(body: unknown): MockRes
}
function response(): MockRes {
  return {
    statusCode: 0,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}
function request(opts: {
  docId?: string
  uid?: string
  principalSpaceId?: string
  token?: string
} = {}) {
  return {
    params: { docId: opts.docId ?? 'doc1' },
    query: { uid: opts.uid ?? 'u1', principal_space_id: opts.principalSpaceId ?? 's1' },
    header: (name: string) => (name.toLowerCase() === 'x-internal-token' ? opts.token ?? 'drive-tok' : undefined),
  }
}

const meta = { doc_id: 'doc1', owner_id: 'owner-uid', owner_space_id: 's1', status: 1 }

beforeEach(() => {
  vi.clearAllMocks()
  mockConfig.driveDerived.inboundToken = 'drive-tok'
  mockConfig.driveDerived.outboundToken = 'outbound-only-tok'
})

describe('internalDocRoleHandler (TES-131 direct-role lookup)', () => {
  it.each(['', 'wrong-token'])('rejects a missing or invalid internal credential with 401', async (token) => {
    const res = response()
    await internalDocRoleHandler(request({ token }) as never, res as never)
    expect(res.statusCode).toBe(401)
    expect(docMetaRepo.getByDocId).not.toHaveBeenCalled()
  })

  it('fails closed when the configured token is empty (rejects every caller)', async () => {
    mockConfig.driveDerived.inboundToken = ''
    const res = response()
    await internalDocRoleHandler(request({ token: '' }) as never, res as never)
    expect(res.statusCode).toBe(401)
  })

  it('authorizes against inboundToken only, never outboundToken (the two tokens are independent)', async () => {
    // Distinct values per direction: the inbound endpoint must accept the inbound
    // token and reject the outbound one, proving it does not consult outboundToken.
    mockConfig.driveDerived.inboundToken = 'docs-inbound'
    mockConfig.driveDerived.outboundToken = 'drive-outbound'
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(meta as never)

    const ok = response()
    await internalDocRoleHandler(request({ token: 'docs-inbound', uid: 'owner-uid', principalSpaceId: 's1' }) as never, ok as never)
    expect(ok.statusCode).toBe(200)

    const rejected = response()
    await internalDocRoleHandler(request({ token: 'drive-outbound' }) as never, rejected as never)
    expect(rejected.statusCode).toBe(401)
  })

  it('400s on a missing uid or principal_space_id', async () => {
    const res = response()
    await internalDocRoleHandler(request({ uid: '' }) as never, res as never)
    expect(res.statusCode).toBe(400)
  })

  it('404s a missing doc', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(null as never)
    const res = response()
    await internalDocRoleHandler(request() as never, res as never)
    expect(res.statusCode).toBe(404)
  })

  it('404s a soft-deleted (status=0) doc, never leaking a role', async () => {
    // A real row is returned but with status=0: getByDocId does not filter status,
    // so the endpoint must enforce the soft-deleted => 404 contract itself. Before
    // the fix this returned 200 { role, doc_status: 0 }; the mock returning a real
    // status=0 shape (not null) pins that the endpoint-side filter is what 404s it.
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue({ ...meta, status: 0 } as never)
    const res = response()
    await internalDocRoleHandler(request({ uid: 'owner-uid', principalSpaceId: 's1' }) as never, res as never)
    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
    expect(docMemberRepo.getRole).not.toHaveBeenCalled()
  })

  it('owner (uid + owner Space match) => admin with role_rank 40, never consulting doc_member', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(meta as never)
    const res = response()
    await internalDocRoleHandler(request({ uid: 'owner-uid', principalSpaceId: 's1' }) as never, res as never)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ role: 'admin', role_rank: 40, doc_status: 1, owner_space_id: 's1' })
    expect(docMemberRepo.getRole).not.toHaveBeenCalled()
  })

  it('non-owner with a doc_member writer row => writer + its rank', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(meta as never)
    vi.mocked(docMemberRepo.getRole).mockResolvedValue('writer' as never)
    const res = response()
    await internalDocRoleHandler(request({ uid: 'u1', principalSpaceId: 's1' }) as never, res as never)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ role: 'writer', role_rank: 30, doc_status: 1, owner_space_id: 's1' })
    expect(docMemberRepo.getRole).toHaveBeenCalledWith('doc1', 'u1', 's1')
  })

  it('no owner match and no member row => none / rank 0', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(meta as never)
    vi.mocked(docMemberRepo.getRole).mockResolvedValue(null as never)
    const res = response()
    await internalDocRoleHandler(request({ uid: 'stranger', principalSpaceId: 's1' }) as never, res as never)
    expect(res.body).toEqual({ role: 'none', role_rank: 0, doc_status: 1, owner_space_id: 's1' })
  })

  it('owner uid but a DIFFERENT principal Space is not admin (falls through to doc_member)', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(meta as never)
    vi.mocked(docMemberRepo.getRole).mockResolvedValue(null as never)
    const res = response()
    await internalDocRoleHandler(request({ uid: 'owner-uid', principalSpaceId: 's_other' }) as never, res as never)
    expect(res.body).toEqual({ role: 'none', role_rank: 0, doc_status: 1, owner_space_id: 's1' })
    expect(docMemberRepo.getRole).toHaveBeenCalledWith('doc1', 'owner-uid', 's_other')
  })
})
