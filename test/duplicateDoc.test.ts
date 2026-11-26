import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit test for POST /api/v1/docs/{docId}/duplicate (§4.4 复制).
// Mocks the permission guard, the meta/yjs repos, the tx helper and the index
// queue, then exercises the exported handler directly (no live infra).
vi.mock('../src/api/guard.js', () => ({ requireDocRole: vi.fn() }))
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: { createTx: vi.fn(), create: vi.fn(), getByDocId: vi.fn() },
  DocOwnershipError: class DocOwnershipError extends Error {},
}))
vi.mock('../src/api/services/htmlDuplicate.js', () => ({ duplicateHtmlDoc: vi.fn() }))
vi.mock('../src/db/repos/yjsDocumentRepo.js', () => ({
  yjsDocumentRepo: { fetchState: vi.fn(), upsertStateTx: vi.fn() },
}))
vi.mock('../src/collab/liveDocRead.js', () => ({ readLiveDocState: vi.fn() }))
vi.mock('../src/api/services/htmlPurge.js', () => ({ purgeHtmlDocument: vi.fn() }))
// Keep the real emptiness predicate (the copy skips upsert only for a真正 empty
// update) but stub the attachment I/O: the attachment behaviour has its own
// dedicated suite (duplicateAttachments.test.ts).
vi.mock('../src/api/services/duplicateAttachments.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/services/duplicateAttachments.js')>()
  return {
    ...actual,
    copyReferencedAttachments: vi.fn(async ({ state }: { state: Uint8Array }) => ({ state, copied: [] })),
    cleanupCopiedAttachments: vi.fn(async () => undefined),
  }
})
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
import { duplicateHtmlDoc } from '../src/api/services/htmlDuplicate.js'
import { readLiveDocState } from '../src/collab/liveDocRead.js'
import { copyReferencedAttachments, cleanupCopiedAttachments } from '../src/api/services/duplicateAttachments.js'
import { purgeHtmlDocument } from '../src/api/services/htmlPurge.js'

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
  vi.mocked(readLiveDocState).mockResolvedValue(new Uint8Array([1, 2, 3]) as never)
  vi.mocked(purgeHtmlDocument).mockResolvedValue({ ok: true, slug: 'd_new' } as never)
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
    // A never-stored document reads back as the empty Yjs update (lib0: [0,0]).
    vi.mocked(readLiveDocState).mockResolvedValue(new Uint8Array([0, 0]) as never)
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

  it('rejects html_ppt, whose body lives in the Bento service', async () => {
    vi.mocked(requireDocRole).mockResolvedValue({ meta: sourceMeta({ doc_type: 'html_ppt' }), role: 'reader' } as never)
    const res = mockRes()
    await duplicateDocHandler(req(), res as never)
    expect(res.statusCode).toBe(422)
    expect(res.body).toEqual({ error: 'unsupported_document_type' })
    expect(docMetaRepo.createTx).not.toHaveBeenCalled()
    expect(duplicateHtmlDoc).not.toHaveBeenCalled()
  })

  it('copies an html document through the html service and registers the new row', async () => {
    vi.mocked(requireDocRole).mockResolvedValue({
      meta: sourceMeta({ doc_type: 'html', octo_doc_slug: 'slug-src' }), role: 'reader',
    } as never)
    vi.mocked(duplicateHtmlDoc).mockResolvedValue({ ok: true, slug: 'd_new', version: 1, size: 42 })
    const res = mockRes()

    await duplicateDocHandler(req(), res as never)

    expect(res.statusCode).toBe(201)
    const body = res.body as Record<string, unknown>
    expect(body.docId).toBe('d_new')
    expect(body.octoDocSlug).toBe('d_new')
    expect(body.docType).toBe('html')
    const call = vi.mocked(duplicateHtmlDoc).mock.calls[0]![0] as Record<string, unknown>
    expect(call).toMatchObject({
      sourceSlug: 'slug-src', targetSlug: 'd_new', title: '需求文档-副本',
      spaceId: 's1', ownerUid: 'u_reader',
    })
    const createArg = vi.mocked(docMetaRepo.create).mock.calls[0]![0] as Record<string, unknown>
    expect(createArg).toMatchObject({
      docId: 'd_new', ownerId: 'u_reader', docType: 'html', octoDocSlug: 'd_new', createdBy: 'u_reader',
    })
    // The Yjs path must not run for html.
    expect(docMetaRepo.createTx).not.toHaveBeenCalled()
    expect(readLiveDocState).not.toHaveBeenCalled()
  })

  it('surfaces html copy failures instead of writing a dangling row', async () => {
    vi.mocked(requireDocRole).mockResolvedValue({
      meta: sourceMeta({ doc_type: 'html', octo_doc_slug: 'slug-src' }), role: 'reader',
    } as never)

    vi.mocked(duplicateHtmlDoc).mockResolvedValue({ ok: false, reason: 'upstream', status: 500 })
    let res = mockRes()
    await duplicateDocHandler(req(), res as never)
    expect(res.statusCode).toBe(503)
    expect(res.body).toEqual({ error: 'copy_unavailable' })

    vi.mocked(duplicateHtmlDoc).mockResolvedValue({ ok: false, reason: 'not_found', status: 404 })
    res = mockRes()
    await duplicateDocHandler(req(), res as never)
    expect(res.statusCode).toBe(404)

    vi.mocked(duplicateHtmlDoc).mockResolvedValue({ ok: false, reason: 'conflict', status: 409 })
    res = mockRes()
    await duplicateDocHandler(req(), res as never)
    expect(res.statusCode).toBe(409)
    expect(docMetaRepo.create).not.toHaveBeenCalled()
  })

  it('refuses an unregistered html row (no slug to copy)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue({
      meta: sourceMeta({ doc_type: 'html', octo_doc_slug: null }), role: 'reader',
    } as never)
    const res = mockRes()
    await duplicateDocHandler(req(), res as never)
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ error: 'html_document_unregistered' })
    expect(duplicateHtmlDoc).not.toHaveBeenCalled()
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

  it('registers the copy in the CALLER space while keeping the source home space (cross-Space copy)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue({ meta: sourceMeta(), role: 'reader' } as never)
    const res = mockRes()

    // The guard already verified the caller's identity space; the copy must use
    // it for owner_space_id, otherwise (owner_id, owner_space_id) authorization
    // would key the copy to the SOURCE space and the copier could not manage it.
    await duplicateDocHandler(req({ principalSpaceId: 's2' }), res as never)

    expect(res.statusCode).toBe(201)
    const createArg = vi.mocked(docMetaRepo.createTx).mock.calls[0]![1] as Record<string, unknown>
    expect(createArg.spaceId).toBe('s1')
    expect(createArg.ownerSpaceId).toBe('s2')
  })

  it('copies the attachments the body references and maps them onto the new doc', async () => {
    vi.mocked(requireDocRole).mockResolvedValue({ meta: sourceMeta(), role: 'reader' } as never)
    const res = mockRes()

    await duplicateDocHandler(req(), res as never)

    expect(res.statusCode).toBe(201)
    const call = vi.mocked(copyReferencedAttachments).mock.calls[0]![0] as Record<string, unknown>
    expect(call).toMatchObject({ sourceDocId: 'd_src', targetDocId: 'd_new', uid: 'u_reader' })
  })

  it('cleans up copied attachments when the doc_meta registration fails', async () => {
    vi.mocked(requireDocRole).mockResolvedValue({ meta: sourceMeta(), role: 'reader' } as never)
    vi.mocked(copyReferencedAttachments).mockResolvedValue({ state: new Uint8Array([9, 9]), copied: [{ attachId: 'a1' }] } as never)
    vi.mocked(docMetaRepo.createTx).mockRejectedValueOnce(new Error('duplicate key') as never)
    const res = mockRes()

    await expect(duplicateDocHandler(req(), res as never)).rejects.toThrow('duplicate key')
    expect(cleanupCopiedAttachments).toHaveBeenCalledWith(['a1'])
  })

  it('purges the html copy when registering its doc_meta row fails', async () => {
    vi.mocked(requireDocRole).mockResolvedValue({
      meta: sourceMeta({ doc_type: 'html', octo_doc_slug: 'slug-src' }), role: 'reader',
    } as never)
    vi.mocked(duplicateHtmlDoc).mockResolvedValue({ ok: true, slug: 'd_new', version: 1, size: 42 })
    vi.mocked(docMetaRepo.create).mockRejectedValueOnce(new Error('insert failed') as never)
    const res = mockRes()

    await expect(duplicateDocHandler(req(), res as never)).rejects.toThrow('insert failed')
    expect(purgeHtmlDocument).toHaveBeenCalledWith('d_new', 'd_new', 's1')
  })
})
