import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * OCTO-456 §4.8 rename permission matrix + the drive rename receipt.
 *
 *   doc / sheet / board / html_ppt  -> admin
 *   html                            -> admin OR the ORIGINAL AUTHOR
 *                                      (doc_meta.owner_id === uid)
 *
 * The old gate was requireDocRole('admin') for every type, which 403'd an html
 * doc's original author when they held only a member role. The guard is mocked
 * here so the matrix is exercised without live infra (mirrors
 * docsRenameReindex.test.ts).
 */
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: { search: { indexEnabled: false } },
}))
vi.mock('../src/config/env.js', () => ({ config: mockConfig }))
vi.mock('../src/api/guard.js', () => ({ requireDocRole: vi.fn() }))
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: {
    rename: vi.fn(async () => undefined),
    resolveDocumentName: vi.fn(async () => null),
  },
  DocOwnershipError: class extends Error {},
}))

import { renameDocHandler } from '../src/api/routes/docs.js'
import { requireDocRole } from '../src/api/guard.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'

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
  uid?: string
  docId?: string
  title?: unknown
} = {}) {
  return {
    uid: opts.uid ?? 'u_caller',
    params: { docId: opts.docId ?? 'd_1' },
    body: { title: opts.title ?? 'New Title' },
    query: {},
    principalSpaceId: 's1',
    docSpaceScope: { mode: 'human' as const },
  }
}
function guard(role: string, meta: Record<string, unknown>) {
  return {
    role,
    meta: {
      doc_id: 'd_1',
      title: 'Before Title',
      doc_type: 'doc',
      owner_id: 'u_owner',
      owner_space_id: 's1',
      space_id: 's1',
      status: 1,
      permission_epoch: 3,
      ...meta,
    },
  }
}

beforeEach(() => {
  vi.mocked(requireDocRole).mockReset()
  vi.mocked(docMetaRepo.rename).mockClear()
})

describe('PATCH /api/v1/docs/:docId — canRenameOriginal matrix', () => {
  it('doc + admin (not the owner) => 200, rename applied, beforeTitle from doc_meta', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guard('admin', {}) as never)
    const res = response()
    await renameDocHandler(request() as never, res as never)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ docId: 'd_1', title: 'New Title', beforeTitle: 'Before Title' })
    expect(docMetaRepo.rename).toHaveBeenCalledWith('d_1', 'New Title', 'u_caller')
    // The gate is READ, not admin: the §4.8 matrix is applied after it.
    expect(vi.mocked(requireDocRole).mock.calls[0]![3]).toBe('reader')
  })

  it('doc + writer => 403 {error:"forbidden"} and no write', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guard('writer', {}) as never)
    const res = response()
    await renameDocHandler(request() as never, res as never)
    expect(res.statusCode).toBe(403)
    expect(res.body).toEqual({ error: 'forbidden' })
    expect(docMetaRepo.rename).not.toHaveBeenCalled()
  })

  it.each(['doc', 'sheet', 'board', 'html_ppt'])(
    '%s + reader/commenter/writer => 403',
    async (docType) => {
      for (const role of ['reader', 'commenter', 'writer']) {
        vi.mocked(requireDocRole).mockResolvedValue(guard(role, { doc_type: docType }) as never)
        const res = response()
        await renameDocHandler(request() as never, res as never)
        expect(res.statusCode).toBe(403)
      }
    },
  )

  it('html + reader who IS the original author IN THE SAME Space => 200 (author branch)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(
      guard('reader', { doc_type: 'html', owner_id: 'u_caller', owner_space_id: 's1' }) as never,
    )
    const res = response()
    await renameDocHandler(request() as never, res as never)
    expect(res.statusCode).toBe(200)
    expect(docMetaRepo.rename).toHaveBeenCalledOnce()
  })

  it('html + author UID from ANOTHER Space => 403 (compound author identity)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(
      guard('reader', { doc_type: 'html', owner_id: 'u_caller', owner_space_id: 's_other' }) as never,
    )
    const res = response()
    await renameDocHandler(request() as never, res as never)
    expect(res.statusCode).toBe(403)
    expect(res.body).toEqual({ error: 'forbidden' })
    expect(docMetaRepo.rename).not.toHaveBeenCalled()
  })

  it('html + reader who is NOT the author => 403', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(
      guard('reader', { doc_type: 'html', owner_id: 'u_author' }) as never,
    )
    const res = response()
    await renameDocHandler(request() as never, res as never)
    expect(res.statusCode).toBe(403)
    expect(res.body).toEqual({ error: 'forbidden' })
  })

  it('html + admin who is NOT the author => 200 (§4.8 role>=admin branch)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(
      guard('admin', { doc_type: 'html', owner_id: 'u_author' }) as never,
    )
    const res = response()
    await renameDocHandler(request() as never, res as never)
    expect(res.statusCode).toBe(200)
  })

  it('empty title => 400 for an authorized caller', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guard('admin', {}) as never)
    const res = response()
    await renameDocHandler(request({ title: '' }) as never, res as never)
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'title required' })
    expect(docMetaRepo.rename).not.toHaveBeenCalled()
  })

  it('title over 512 => 400', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guard('admin', {}) as never)
    const res = response()
    await renameDocHandler(request({ title: 'x'.repeat(513) }) as never, res as never)
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'title too long' })
  })

  it.each([0, 2])('status=%i (deleted/archived) => 409 doc_archived, no rename', async (status) => {
    vi.mocked(requireDocRole).mockResolvedValue(guard('admin', { status }) as never)
    const res = response()
    await renameDocHandler(request() as never, res as never)
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ error: 'doc_archived' })
    expect(docMetaRepo.rename).not.toHaveBeenCalled()
  })

  it('asks the guard for deleted-as-archived disclosure (drive rename proxy contract)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guard('admin', {}) as never)
    await renameDocHandler(request() as never, response() as never)
    expect(vi.mocked(requireDocRole).mock.calls[0]![4]).toEqual({ inactiveAsDocArchived: true })
  })

  it('does not write a response when the read guard already blocked (404/409)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(null)
    const res = response()
    await renameDocHandler(request() as never, res as never)
    expect(res.statusCode).toBe(0)
    expect(docMetaRepo.rename).not.toHaveBeenCalled()
  })
})
