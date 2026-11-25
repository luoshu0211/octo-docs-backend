import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * OCTO-456 P1 回收站 HTTP 路由（owner/admin 语义、409/403/404 映射、批量逐项）。
 * 直接调用导出的 handler（不启 express），mock 仓储/权限/epoch/purge 服务。
 */
vi.mock('../src/db/repos/docMetaRepo.js', () => ({ docMetaRepo: { getByDocId: vi.fn() } }))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({ docMemberRepo: { getRole: vi.fn() } }))
vi.mock('../src/db/repos/docTrashRepo.js', () => ({
  docTrashRepo: { listTrash: vi.fn(), restoreDoc: vi.fn() },
  MAX_TRASH_BATCH: 50,
  TRASH_PAGE_SIZE_DEFAULT: 20,
  TRASH_PAGE_SIZE_MAX: 100,
}))
vi.mock('../src/api/middleware/docSpaceScope.js', () => ({
  resolveHumanCurrentSpace: vi.fn(async () => ({ verified: true })),
}))
vi.mock('../src/permission/principalSpace.js', () => ({
  resolveRequestPrincipalSpace: vi.fn(async () => 's1'),
}))
vi.mock('../src/permission/epoch.js', () => ({ refreshAndPublish: vi.fn(async () => {}) }))
vi.mock('../src/search/docIndexQueue.js', () => ({
  enqueueDocIndex: vi.fn(async () => true),
  isSearchIndexedDoc: vi.fn(() => true),
}))
vi.mock('../src/trash/purgeDocument.js', () => ({ purgeDocument: vi.fn() }))

import {
  batchPurgeHandler,
  batchRestoreHandler,
  listTrashHandler,
  purgeDocHandler,
  restoreDocHandler,
} from '../src/api/routes/docsTrash.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import { docTrashRepo } from '../src/db/repos/docTrashRepo.js'
import { resolveHumanCurrentSpace } from '../src/api/middleware/docSpaceScope.js'
import { resolveRequestPrincipalSpace } from '../src/permission/principalSpace.js'
import { refreshAndPublish } from '../src/permission/epoch.js'
import { purgeDocument } from '../src/trash/purgeDocument.js'

interface MockRes {
  statusCode: number
  body: unknown
  ended: boolean
  status(code: number): MockRes
  json(body: unknown): MockRes
  end(): MockRes
}
function response(): MockRes {
  return {
    statusCode: 0,
    body: undefined,
    ended: false,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
    end() { this.ended = true; return this },
  }
}
function request(opts: {
  docId?: string
  query?: Record<string, unknown>
  body?: unknown
} = {}) {
  return {
    uid: 'u1',
    viewerSpaceId: 's1',
    docSpaceScope: { mode: 'human' },
    params: { docId: opts.docId ?? 'd1' },
    query: opts.query ?? {},
    body: opts.body,
  }
}

const meta = {
  doc_id: 'd1',
  document_name: 'octo:s1:f1:d1',
  title: 'Doc',
  doc_type: 'doc',
  owner_id: 'u1',
  owner_space_id: 's1',
  space_id: 's1',
  status: 0,
  deleted_at: new Date('2026-11-10T00:00:00.000Z'),
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(resolveHumanCurrentSpace).mockResolvedValue({ verified: true } as never)
  vi.mocked(resolveRequestPrincipalSpace).mockResolvedValue('s1' as never)
  vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(meta as never)
  vi.mocked(docMemberRepo.getRole).mockResolvedValue('admin' as never)
  vi.mocked(docTrashRepo.listTrash).mockResolvedValue({ items: [], nextCursor: null } as never)
  vi.mocked(docTrashRepo.restoreDoc).mockResolvedValue({
    ok: true,
    doc: { documentName: 'octo:s1:f1:d1', permissionEpoch: 5, changed: true },
  } as never)
  vi.mocked(purgeDocument).mockResolvedValue({ ok: true, documentName: 'octo:s1:f1:d1' } as never)
})

describe('GET /api/v1/docs/trash', () => {
  it('maps rows to the camelCase wire shape with retention fields', async () => {
    vi.mocked(docTrashRepo.listTrash).mockResolvedValueOnce({
      items: [
        { doc_id: 'd1', title: 'Doc', doc_type: 'doc', owner_id: 'u1', deleted_at: new Date('2026-11-10T00:00:00.000Z') },
        { doc_id: 'd0', title: 'Old', doc_type: 'sheet', owner_id: 'u1', deleted_at: null },
      ],
      nextCursor: 'cursor-1',
    } as never)
    const res = response()
    await listTrashHandler(request({ query: { page_size: '20', q: 'doc' } }) as never, res as never)

    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({ next_cursor: 'cursor-1' })
    const items = (res.body as { items: Array<Record<string, unknown>> }).items
    expect(items[0]).toEqual({
      docId: 'd1',
      title: 'Doc',
      docType: 'doc',
      owner: { uid: 'u1' },
      role: 'admin',
      deletedAt: '2026-11-10T00:00:00.000Z',
      expireAt: '2026-12-10T00:00:00.000Z',
      retentionDays: 30,
      canRestore: true,
      canPurge: true,
    })
    expect(items[1]).toMatchObject({ docId: 'd0', deletedAt: null, expireAt: null, canRestore: true, canPurge: true })
  })

  it('400s invalid_cursor instead of silently restarting at page one', async () => {
    vi.mocked(docTrashRepo.listTrash).mockRejectedValueOnce(new Error('invalid_cursor'))
    const res = response()
    await listTrashHandler(request({ query: { cursor: 'junk' } }) as never, res as never)
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_cursor' })
  })

  it('requires a verified current Space', async () => {
    vi.mocked(resolveHumanCurrentSpace).mockResolvedValueOnce({ verified: false, status: 400, error: 'space_required' } as never)
    const res = response()
    await listTrashHandler(request() as never, res as never)
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'space_required' })
    expect(docTrashRepo.listTrash).not.toHaveBeenCalled()
  })
})

describe('POST /api/v1/docs/{docId}/restore', () => {
  it('restores, bumps/publishes the epoch, and reports restoredAt', async () => {
    const res = response()
    await restoreDocHandler(request() as never, res as never)
    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({ docId: 'd1', status: 'restored' })
    expect(typeof (res.body as { restoredAt: string }).restoredAt).toBe('string')
    expect(refreshAndPublish).toHaveBeenCalledWith('octo:s1:f1:d1', 5)
  })

  it('404s a missing doc and 403s a non-admin observer (member viewers cannot act)', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValueOnce(null as never)
    const missing = response()
    await restoreDocHandler(request() as never, missing as never)
    expect(missing.statusCode).toBe(404)

    vi.mocked(docMetaRepo.getByDocId).mockResolvedValueOnce({ ...meta, owner_id: 'owner-other' } as never)
    vi.mocked(docMemberRepo.getRole).mockResolvedValueOnce('reader' as never)
    const denied = response()
    await restoreDocHandler(request() as never, denied as never)
    expect(denied.statusCode).toBe(403)
    expect(denied.body).toEqual({ error: 'forbidden' })
    expect(docTrashRepo.restoreDoc).not.toHaveBeenCalled()
  })

  it('409s doc_archived for status=2', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValueOnce({ ...meta, status: 2 } as never)
    const res = response()
    await restoreDocHandler(request() as never, res as never)
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ error: 'doc_archived' })
  })
})

describe('POST /api/v1/docs/{docId}/purge', () => {
  it('requires confirm:true before doing anything irreversible', async () => {
    const res = response()
    await purgeDocHandler(request({ body: {} }) as never, res as never)
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'confirm_required' })
    expect(purgeDocument).not.toHaveBeenCalled()
  })

  it('204s on success', async () => {
    const res = response()
    await purgeDocHandler(request({ body: { confirm: true } }) as never, res as never)
    expect(res.statusCode).toBe(204)
    expect(res.ended).toBe(true)
    expect(purgeDocument).toHaveBeenCalledWith('d1', { mode: 'strict' })
  })

  it('503s html_purge_failed (doc_meta is kept)', async () => {
    vi.mocked(purgeDocument).mockResolvedValueOnce({
      ok: false, status: 503, error: 'html_purge_failed',
    } as never)
    const res = response()
    await purgeDocHandler(request({ body: { confirm: true } }) as never, res as never)
    expect(res.statusCode).toBe(503)
    expect(res.body).toEqual({ error: 'html_purge_failed' })
  })
})

describe('POST /api/v1/docs/trash/{restore,purge} (batch)', () => {
  it('caps doc_ids at 50', async () => {
    const res = response()
    await batchRestoreHandler(
      request({ body: { doc_ids: Array.from({ length: 51 }, (_, i) => `d${i}`) } }) as never,
      res as never,
    )
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'too_many_doc_ids' })
    expect(docTrashRepo.restoreDoc).not.toHaveBeenCalled()
  })

  it('400s on a malformed batch body', async () => {
    const res = response()
    await batchPurgeHandler(request({ body: { doc_ids: 'd1' } }) as never, res as never)
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_request' })
  })

  it('returns one item per requested doc, including per-item failures', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockImplementation(async (docId: string) => {
      if (docId === 'd_missing') return null as never
      if (docId === 'd_archived') return { ...meta, doc_id: 'd_archived', status: 2 } as never
      if (docId === 'd_reader') return { ...meta, doc_id: 'd_reader', owner_id: 'someone-else' } as never
      return meta as never
    })
    vi.mocked(docMemberRepo.getRole).mockImplementation(async (docId: string) => {
      if (docId === 'd_reader') return 'writer' as never
      return 'admin' as never
    })

    const res = response()
    await batchRestoreHandler(
      request({ body: { doc_ids: ['d1', 'd_missing', 'd_archived', 'd_reader', 'd1'] } }) as never,
      res as never,
    )
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      items: [
        { docId: 'd1', status: 'restored', error: null },
        { docId: 'd_missing', status: 'failed', error: 'not_found' },
        { docId: 'd_archived', status: 'failed', error: 'doc_archived' },
        { docId: 'd_reader', status: 'failed', error: 'forbidden' },
      ],
    })
  })

  it('purges each admin doc and reports per-item results', async () => {
    vi.mocked(purgeDocument)
      .mockResolvedValueOnce({ ok: true, documentName: 'octo:s1:f1:d1' } as never)
      .mockResolvedValueOnce({ ok: false, status: 503, error: 'html_purge_failed' } as never)
    const res = response()
    await batchPurgeHandler(request({ body: { doc_ids: ['d1', 'd2'] } }) as never, res as never)
    expect(res.body).toEqual({
      items: [
        { docId: 'd1', status: 'purged', error: null },
        { docId: 'd2', status: 'failed', error: 'html_purge_failed' },
      ],
    })
  })
})

describe('restore state machine shared by single and batch entry points', () => {
  it('410s an expired document instead of restoring it', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValueOnce({
      ...meta,
      deleted_at: new Date('2026-09-01T00:00:00.000Z'),
    } as never)
    const res = response()
    await restoreDocHandler(request() as never, res as never)
    expect(res.statusCode).toBe(410)
    expect(res.body).toEqual({ error: 'trash_expired' })
    expect(docTrashRepo.restoreDoc).not.toHaveBeenCalled()
  })

  it('409s purge_in_progress while a purge holds the claim', async () => {
    vi.mocked(docTrashRepo.restoreDoc).mockResolvedValueOnce({ ok: false, reason: 'purging' } as never)
    const res = response()
    await restoreDocHandler(request() as never, res as never)
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ error: 'purge_in_progress' })
    expect(refreshAndPublish).not.toHaveBeenCalled()
  })

  it('batch restore reports the SAME per-item errors instead of reactivating expired docs', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockImplementation(async (docId: string) => {
      if (docId === 'expired') {
        return { ...meta, doc_id: 'expired', deleted_at: new Date('2026-09-01T00:00:00.000Z') } as never
      }
      if (docId === 'purging') return { ...meta, doc_id: 'purging', status: 0 } as never
      return { ...meta, doc_id: docId } as never
    })
    vi.mocked(docTrashRepo.restoreDoc).mockImplementation(async (docId: string) => {
      if (docId === 'purging') return { ok: false, reason: 'purging' } as never
      return { ok: true, doc: { documentName: `octo:s1:f1:${docId}`, permissionEpoch: 6, changed: true } } as never
    })

    const res = response()
    await batchRestoreHandler(
      request({ body: { doc_ids: ['expired', 'purging', 'ok'] } }) as never,
      res as never,
    )
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      items: [
        { docId: 'expired', status: 'failed', error: 'trash_expired' },
        { docId: 'purging', status: 'failed', error: 'purge_in_progress' },
        { docId: 'ok', status: 'restored', error: null },
      ],
    })
    // The expired row must never be flipped back to active.
    expect(vi.mocked(docTrashRepo.restoreDoc).mock.calls.map(([id]) => id)).not.toContain('expired')
  })
})
