import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * OCTO-456 deleted grey rows on the plain PATCH /api/v1/docs/:docId rename.
 *
 * The rename route opts into `inactiveAsDocArchived`: a deleted (status=0) or
 * archived (status=2) doc answers 409 {error:'doc_archived'} — the code drive's
 * rename proxy maps verbatim. A deleted doc is disclosed ONLY to a principal
 * that can still observe it (owner, any doc_member row, a doc_legacy_visible
 * row); share_scope alone must stay 404 so a deleted doc never becomes an
 * existence oracle. The doc_meta repo and resolveRole are mocked; the human
 * Space check is satisfied by the verified header.
 */
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: {
    getByDocId: vi.fn(),
    getLegacyVisibleDocIds: vi.fn(),
  },
}))
vi.mock('../src/permission/resolveRole.js', () => ({
  resolveRole: vi.fn(),
}))

import { requireDocRole } from '../src/api/guard.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { resolveRole } from '../src/permission/resolveRole.js'

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

function request(uid = 'u_caller', principalSpaceId = 's1') {
  return {
    uid,
    octoToken: 'session-token',
    principalSpaceId,
    viewerSpaceId: principalSpaceId,
    verifiedViewerSpaceId: principalSpaceId,
    docSpaceScope: { mode: 'human' as const },
  }
}

const meta = {
  doc_id: 'd_1',
  document_name: 'octo:s1:f_default:d_1',
  title: 'Grey Doc',
  owner_id: 'u_owner',
  owner_space_id: 's1',
  space_id: 's1',
  folder_id: 'f_default',
  doc_type: 'doc',
  octo_doc_slug: null,
  html_idempotency_key_hash: null,
  status: 0,
  deleted_at: new Date('2026-11-01T00:00:00.000Z'),
  permission_epoch: 2,
  share_scope: 0,
  share_role: 1,
  discoverability_scope: 0,
  created_at: new Date(0),
  updated_at: new Date(0),
  created_by: 'u_owner',
  updated_by: 'u_owner',
}

const options = { inactiveAsDocArchived: true }

beforeEach(() => {
  vi.mocked(docMetaRepo.getByDocId).mockReset()
  vi.mocked(docMetaRepo.getLegacyVisibleDocIds).mockReset()
  vi.mocked(docMetaRepo.getLegacyVisibleDocIds).mockResolvedValue(new Set())
  vi.mocked(resolveRole).mockReset()
  vi.mocked(resolveRole).mockResolvedValue('none')
})

async function resolve(uid = 'u_caller', opts = options, principalSpaceId = 's1') {
  const res = response()
  const guard = await requireDocRole(request(uid, principalSpaceId) as never, res as never, 'd_1', 'reader', opts)
  return { guard, res }
}

describe('requireDocRole — deleted grey row rename semantics', () => {
  it('deleted doc owned by the caller => 409 doc_archived', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(meta as never)
    const { guard, res } = await resolve('u_owner')
    expect(guard).toBeNull()
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ error: 'doc_archived' })
  })

  it('deleted doc owned by the same uid from ANOTHER principal Space => 404 (P1-2)', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(meta as never)
    const { res } = await resolve('u_owner', options, 's_other')
    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
    // The uid-only match must not short-circuit the legacy provenance lookup.
    expect(docMetaRepo.getLegacyVisibleDocIds).toHaveBeenCalledWith(['d_1'], 'u_owner', 's_other')
  })

  it('deleted doc with any surviving doc_member grant => 409 doc_archived', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(meta as never)
    vi.mocked(resolveRole).mockResolvedValue('reader')
    const { res } = await resolve('u_member')
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ error: 'doc_archived' })
    expect(docMetaRepo.getLegacyVisibleDocIds).not.toHaveBeenCalled()
  })

  it('deleted doc with a legacy 补录 row only => 409 doc_archived', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(meta as never)
    vi.mocked(docMetaRepo.getLegacyVisibleDocIds).mockResolvedValue(new Set(['d_1']))
    const { res } = await resolve('u_legacy')
    expect(res.statusCode).toBe(409)
  })

  it('deleted doc with NO surviving grant => 404 (never an existence oracle)', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(meta as never)
    const { res } = await resolve('u_stranger')
    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
  })

  it('deleted doc + share_scope=anyone_in_space only => still 404', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue({
      ...meta,
      share_scope: 1,
      share_role: 1,
    } as never)
    const { res } = await resolve('u_stranger')
    expect(res.statusCode).toBe(404)
  })

  it('without the option the historical 404 for deleted stays byte-identical', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(meta as never)
    const { res } = await resolve('u_owner', {})
    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
  })

  it('archived doc (status=2) => 409 doc_archived with the option, generic conflict without', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue({ ...meta, status: 2 } as never)
    vi.mocked(resolveRole).mockResolvedValue('admin')
    const archived = await resolve('u_caller')
    expect(archived.res.statusCode).toBe(409)
    expect(archived.res.body).toEqual({ error: 'doc_archived' })

    const legacy = await resolve('u_caller', {})
    expect(legacy.res.statusCode).toBe(409)
    expect(legacy.res.body).toEqual({ error: 'conflict' })
  })

  it('missing doc => 404 and there is nothing to disclose', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(null)
    const { res } = await resolve('u_owner')
    expect(res.statusCode).toBe(404)
  })
})
