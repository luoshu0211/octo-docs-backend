import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit test for POST /api/v1/docs/{docId}/duplicate (§4.4 复制).
// Mocks the permission guard, the meta/yjs repos, the tx helper and the index
// queue, then exercises the exported handler directly (no live infra).
vi.mock('../src/api/guard.js', () => ({ requireDocRole: vi.fn() }))
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: { createTx: vi.fn(), getByDocId: vi.fn() },
  DocOwnershipError: class DocOwnershipError extends Error {},
}))
vi.mock('../src/db/repos/yjsDocumentRepo.js', () => ({
  yjsDocumentRepo: { fetchState: vi.fn(), upsertStateTx: vi.fn() },
}))
vi.mock('../src/db/pool.js', () => ({
  transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ query: vi.fn() })),
  query: vi.fn(),
  getPool: vi.fn(),
}))
vi.mock('../src/util/ids.js', () => ({ newDocId: () => 'd_new' }))
vi.mock('../src/search/docIndexQueue.js', () => ({
  isSearchIndexedDoc: () => false,
  enqueueDocIndex: vi.fn(),
}))

import { duplicateDocHandler } from '../src/api/routes/docs.js'
import { requireDocRole } from '../src/api/guard.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { yjsDocumentRepo } from '../src/db/repos/yjsDocumentRepo.js'

interface MockRes {
  statusCode: number
  body: unknown
  status(c: number): MockRes
  json(b: unknown): MockRes
}
function mockRes(): MockRes {
  return {
    statusCode: 0,
    body: undefined as unknown,
    status(c: number) { this.statusCode = c; return this },
    json(b: unknown) { this.body = b; return this },
  }
}

function sourceMeta(over: Record<string, unknown> = {}) {
  return {
    doc_id: 'd_src',
    document_name: 'octo:s1:f_default:d_src',
    title: '需求文档',
    owner_id: 'u_owner',
    space_id: 's1',
    folder_id: 'f_default',
    doc_type: 'doc',
    status: 1,
    ...over,
  }
}

function req(extra: Record<string, unknown> = {}) {
  return {
    uid: 'u_reader',
    spaceId: 's1',
    params: { docId: 'd_src' },
    query: {},
    body: {},
    docSpaceScope: { mode: 'human' as const },
    ...extra,
  } as never
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(docMetaRepo.getByDocId).mockResolvedValue({ created_at: '2026-11-26T10:00:00.000Z' } as never)
  vi.mocked(yjsDocumentRepo.fetchState).mockResolvedValue({ state: new Uint8Array([1, 2, 3]), encoding: 1 } as never)
})

describe('POST /api/v1/docs/:docId/duplicate', () => {
  it('creates an independent doc owned by the caller and copies the Yjs body', async () => {
    vi.mocked(requireDocRole).mockResolvedValue({ meta: sourceMeta(), role: 'reader' } as never)
    const res = mockRes()

    await duplicateDocHandler(req(), res as never)

    expect(res.statusCode).toBe(201)
    const body = res.body as Record<string, unknown>
    expect(body.docId).toBe('d_new')
    expect(body.title).toBe('需求文档-副本')
    expect(body.ownerId).toBe('u_reader')
    expect(body.spaceId).toBe('s1')
    expect(body.docType).toBe('doc')
    expect(String(body.documentName)).toContain('d_new')

    const createArg = vi.mocked(docMetaRepo.createTx).mock.calls[0]![1] as Record<string, unknown>
    expect(createArg).toMatchObject({
      docId: 'd_new',
      title: '需求文档-副本',
      ownerId: 'u_reader',
      spaceId: 's1',
      docType: 'doc',
      createdBy: 'u_reader',
    })
    expect(createArg.documentName).not.toBe('octo:s1:f_default:d_src')

    const upsert = vi.mocked(yjsDocumentRepo.upsertStateTx).mock.calls[0]!
    expect(upsert[1]).toBe(createArg.documentName)
    expect(Buffer.from(upsert[2] as Buffer).equals(Buffer.from([1, 2, 3]))).toBe(true)
    expect(upsert[3]).toBe(1)
  })

  it('honours a caller-supplied title', async () => {
    vi.mocked(requireDocRole).mockResolvedValue({ meta: sourceMeta(), role: 'writer' } as never)
    const res = mockRes()

    await duplicateDocHandler(req({ body: { title: '  方案 v2  ' } }), res as never)

    expect(res.statusCode).toBe(201)
    expect((res.body as Record<string, unknown>).title).toBe('方案 v2')
  })

  it('starts empty when the source body was never persisted', async () => {
    vi.mocked(requireDocRole).mockResolvedValue({ meta: sourceMeta(), role: 'reader' } as never)
    vi.mocked(yjsDocumentRepo.fetchState).mockResolvedValue(null)
    const res = mockRes()

    await duplicateDocHandler(req(), res as never)

    expect(res.statusCode).toBe(201)
    expect(docMetaRepo.createTx).toHaveBeenCalledTimes(1)
    expect(yjsDocumentRepo.upsertStateTx).not.toHaveBeenCalled()
  })

  it('does nothing when the caller cannot read the source', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(null as never)
    const res = mockRes()

    await duplicateDocHandler(req(), res as never)

    expect(docMetaRepo.createTx).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(0)
  })

  it('rejects html / html_ppt bodies that live in sibling services', async () => {
    for (const docType of ['html', 'html_ppt']) {
      vi.mocked(requireDocRole).mockResolvedValue({ meta: sourceMeta({ doc_type: docType }), role: 'reader' } as never)
      const res = mockRes()
      await duplicateDocHandler(req(), res as never)
      expect(res.statusCode).toBe(422)
      expect(res.body).toEqual({ error: 'unsupported_document_type' })
    }
    expect(docMetaRepo.createTx).not.toHaveBeenCalled()
  })

  it('rejects a cross-space duplicate target', async () => {
    vi.mocked(requireDocRole).mockResolvedValue({ meta: sourceMeta(), role: 'reader' } as never)
    const res = mockRes()

    await duplicateDocHandler(req({ body: { spaceId: 's2' } }), res as never)

    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'space_mismatch' })
  })

  it('rejects an over-long title', async () => {
    vi.mocked(requireDocRole).mockResolvedValue({ meta: sourceMeta(), role: 'reader' } as never)
    const res = mockRes()

    await duplicateDocHandler(req({ body: { title: 'x'.repeat(513) } }), res as never)

    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'title too long' })
  })
})
