import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * OCTO-456 P1 回收站仓储：不连 MySQL，mock pool 的 query/transaction，
 * 断言 SQL 谓词（owner/admin + status=0 + 保留期游标）与事务内的删除覆盖面。
 */
const { mockQuery, mockTransaction, mockBumpEpochTx } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockTransaction: vi.fn(),
  mockBumpEpochTx: vi.fn(),
}))
vi.mock('../src/db/pool.js', () => ({ query: mockQuery, transaction: mockTransaction }))
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: { bumpEpochTx: mockBumpEpochTx },
  escapeLikeSubstring: (raw: string) => raw.replace(/[\\%_]/g, (ch) => `\\${ch}`),
}))

import {
  decodeTrashCursor,
  docTrashRepo,
  encodeTrashCursor,
  MAX_TRASH_BATCH,
} from '../src/db/repos/docTrashRepo.js'

function row(overrides: Record<string, unknown> = {}) {
  return {
    doc_id: 'd1',
    title: 'Doc',
    doc_type: 'doc',
    owner_id: 'u1',
    deleted_at: new Date('2026-11-20T00:00:00.000Z'),
    ...overrides,
  }
}

function txWith(handlers: Array<(sql: string, params: unknown[]) => unknown>) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const tx = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params })
      for (const handler of handlers) {
        const out = handler(sql, params)
        if (out !== undefined) return out
      }
      return []
    }),
    execute: vi.fn(async () => ({ affectedRows: 0 })),
  }
  return { tx, calls }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('docTrashRepo.listTrash', () => {
  it('selects owner-or-admin status=0 rows ordered by deleted_at DESC, doc_id DESC', async () => {
    mockQuery.mockResolvedValueOnce([row()])
    const page = await docTrashRepo.listTrash({ uid: 'u1', principalSpaceId: 's1' })
    expect(page.items).toHaveLength(1)
    expect(page.nextCursor).toBeNull()
    const [sql, params] = mockQuery.mock.calls[0]!
    expect(sql).toContain('FROM doc_meta m')
    expect(sql).toContain('LEFT JOIN doc_member dm')
    expect(sql).toContain('m.status = 0')
    expect(sql).toContain('(m.owner_id = ? AND m.owner_space_id = ?) OR dm.role = 3')
    expect(sql).toContain('ORDER BY m.deleted_at DESC, m.doc_id DESC')
    expect(sql).toContain('LIMIT 21')
    expect(params).toEqual(['u1', 's1', 'u1', 's1'])
  })

  it('escapes LIKE wildcards in q so a user-typed % or _ matches literally', async () => {
    mockQuery.mockResolvedValueOnce([])
    await docTrashRepo.listTrash({ uid: 'u1', principalSpaceId: 's1', q: 'a%b_c' })
    const [sql, params] = mockQuery.mock.calls[0]!
    expect(sql).toContain("m.title LIKE ? ESCAPE '\\\\'")
    expect(params).toContain('%a\\%b\\_c%')
  })

  it('pages the non-NULL deleted_at segment and still reaches the trailing NULL segment', async () => {
    mockQuery.mockResolvedValueOnce([])
    const cursor = encodeTrashCursor(new Date('2026-11-20T00:00:00.000Z'), 'd9')
    await docTrashRepo.listTrash({ uid: 'u1', principalSpaceId: 's1', cursor })
    const [sql, params] = mockQuery.mock.calls[0]!
    expect(sql).toContain('m.deleted_at IS NULL OR m.deleted_at < ? OR (m.deleted_at = ? AND m.doc_id < ?)')
    expect(params.slice(-3)).toEqual([new Date('2026-11-20T00:00:00.000Z'), new Date('2026-11-20T00:00:00.000Z'), 'd9'])
  })

  it('pages within the NULL segment with only doc_id < cursor', async () => {
    mockQuery.mockResolvedValueOnce([])
    await docTrashRepo.listTrash({ uid: 'u1', principalSpaceId: 's1', cursor: encodeTrashCursor(null, 'd9') })
    const [sql, params] = mockQuery.mock.calls[0]!
    expect(sql).toContain('m.deleted_at IS NULL AND m.doc_id < ?')
    expect(params.at(-1)).toBe('d9')
  })

  it('emits next_cursor from the last KEPT row when an extra row is fetched', async () => {
    const rows = Array.from({ length: 21 }, (_, i) => row({ doc_id: `d${20 - i}`, deleted_at: new Date(2026, 10, 20 - i) }))
    mockQuery.mockResolvedValueOnce(rows)
    const page = await docTrashRepo.listTrash({ uid: 'u1', principalSpaceId: 's1' })
    expect(page.items).toHaveLength(20)
    expect(page.nextCursor).not.toBeNull()
    const decoded = decodeTrashCursor(page.nextCursor!)
    expect(decoded?.docId).toBe('d1')
  })

  it('rejects a malformed cursor instead of silently restarting at page one', async () => {
    await expect(
      docTrashRepo.listTrash({ uid: 'u1', principalSpaceId: 's1', cursor: 'not-a-cursor' }),
    ).rejects.toThrow('invalid_cursor')
    expect(mockQuery).not.toHaveBeenCalled()
  })
})

describe('docTrashRepo.restoreDoc', () => {
  it('flips status=1 / deleted_at=NULL and bumps the epoch in the same transaction', async () => {
    const { tx, calls } = txWith([
      (sql) => (sql.startsWith('SELECT status')
        ? [{ status: 0, document_name: 'octo:s1:f1:d1', deleted_at: new Date('2026-11-20T00:00:00.000Z') }]
        : undefined),
      (sql) => (sql.startsWith('SELECT document_name') ? [{ document_name: 'octo:s1:f1:d1', permission_epoch: 8 }] : undefined),
    ])
    mockTransaction.mockImplementationOnce(async (fn: never) => (fn as never as (t: unknown) => unknown)(tx))

    const result = await docTrashRepo.restoreDoc('d1')
    expect(result).toEqual({
      ok: true,
      doc: { documentName: 'octo:s1:f1:d1', permissionEpoch: 8, changed: true },
    })
    expect(calls.some((c) => c.sql.includes('SET status = 1, deleted_at = NULL'))).toBe(true)
    expect(mockBumpEpochTx).toHaveBeenCalledWith(tx, 'd1')
  })

  it('refuses an archived row (cancel-archive is a different path)', async () => {
    const { tx } = txWith([
      (sql) => (sql.startsWith('SELECT status') ? [{ status: 2, document_name: 'x' }] : undefined),
    ])
    mockTransaction.mockImplementationOnce(async (fn: never) => (fn as never as (t: unknown) => unknown)(tx))
    expect(await docTrashRepo.restoreDoc('d1')).toEqual({ ok: false, reason: 'archived' })
    expect(mockBumpEpochTx).not.toHaveBeenCalled()
  })

  it('reports a lost race when another request already restored the row', async () => {
    // The pre-check ran outside the lock, so "already active" under the lock means
    // someone else restored it: this call must not answer a fresh 200.
    const { tx } = txWith([
      (sql) => (sql.startsWith('SELECT status') ? [{ status: 1, document_name: 'octo:s1:f1:d1' }] : undefined),
    ])
    mockTransaction.mockImplementationOnce(async (fn: never) => (fn as never as (t: unknown) => unknown)(tx))
    expect(await docTrashRepo.restoreDoc('d1')).toEqual({ ok: false, reason: 'not_found' })
    expect(mockBumpEpochTx).not.toHaveBeenCalled()
  })

  it('re-checks the retention deadline inside the lock', async () => {
    // Still inside the window when the caller pre-checked, expired by the time the
    // row lock was granted.
    const { tx, calls } = txWith([
      (sql) => (sql.startsWith('SELECT status')
        ? [{ status: 0, document_name: 'octo:s1:f1:d1', deleted_at: new Date('2026-01-01T00:00:00.000Z') }]
        : undefined),
    ])
    mockTransaction.mockImplementationOnce(async (fn: never) => (fn as never as (t: unknown) => unknown)(tx))
    expect(await docTrashRepo.restoreDoc('d1')).toEqual({ ok: false, reason: 'expired' })
    expect(calls.some((c) => c.sql.includes('SET status = 1'))).toBe(false)
    expect(mockBumpEpochTx).not.toHaveBeenCalled()
  })
})

describe('docTrashRepo.purgeDoc', () => {
  function purgeTx(status = 0) {
    return txWith([
      (sql) => (sql.startsWith('SELECT status')
        ? [{ status, document_name: 'octo:s1:f1:d1' }]
        : undefined),
      (sql) => (sql.startsWith('SELECT object_key')
        ? [{ object_key: 'att/1' }, { object_key: 'att/2' }]
        : undefined),
    ])
  }

  it('deletes every doc-scoped child table before doc_meta and returns attachment keys', async () => {
    const { tx, calls } = purgeTx()
    mockTransaction.mockImplementationOnce(async (fn: never) => (fn as never as (t: unknown) => unknown)(tx))

    const result = await docTrashRepo.purgeDoc('d1')
    expect(result).toEqual({
      ok: true,
      doc: { documentName: 'octo:s1:f1:d1', attachObjectKeys: ['att/1', 'att/2'] },
    })
    const deletes = calls.filter((c) => c.sql.startsWith('DELETE FROM')).map((c) => c.sql)
    for (const table of [
      'doc_member_notification', 'doc_member', 'doc_invite', 'doc_access_request',
      'doc_attachment', 'doc_comment', 'doc_version', 'doc_view_history', 'doc_library_event',
      'doc_legacy_visible', 'ppt_doc_state', 'ppt_collab_op', 'ppt_live_snapshot',
      'doc_state_generation', 'yjs_document', 'overcap_unrestored', 'doc_meta',
    ]) {
      expect(deletes.some((sql) => sql.includes(` ${table} `) || sql.includes(` ${table}\n`) || sql.endsWith(` ${table}`))).toBe(true)
    }
    // doc_meta 必须是最后一个删除（子表先走）。
    expect(deletes.at(-1)).toBe('DELETE FROM doc_meta WHERE doc_id = ?')
  })

  it.each([
    [1, 'not_deleted'],
    [2, 'archived'],
  ])('refuses a status=%i row without deleting anything', async (status, reason) => {
    const { tx, calls } = purgeTx(status)
    mockTransaction.mockImplementationOnce(async (fn: never) => (fn as never as (t: unknown) => unknown)(tx))
    expect(await docTrashRepo.purgeDoc('d1')).toEqual({ ok: false, reason })
    expect(calls.some((c) => c.sql.startsWith('DELETE FROM'))).toBe(false)
  })
})

describe('docTrashRepo.listExpiredForCleanup', () => {
  it('only selects status=0 rows WITH a known deleted_at older than the cutoff (NULL never auto-cleaned)', async () => {
    mockQuery.mockResolvedValueOnce([])
    const cutoff = new Date('2026-11-01T00:00:00.000Z')
    await docTrashRepo.listExpiredForCleanup(cutoff, 100)
    const [sql, params] = mockQuery.mock.calls[0]!
    expect(sql).toContain('status = 0')
    expect(sql).toContain('deleted_at IS NOT NULL')
    expect(sql).toContain('deleted_at < ?')
    expect(sql).toContain('LIMIT 100')
    expect(params).toEqual([cutoff])
  })

  it('bounds a non-integer / oversized batch size', async () => {
    mockQuery.mockResolvedValueOnce([])
    await docTrashRepo.listExpiredForCleanup(new Date(), 5000)
    expect(mockQuery.mock.calls[0]![0]).toContain('LIMIT 1000')
  })
})

describe('trash cursor + retention constants', () => {
  it('round-trips a NULL deleted_at cursor', () => {
    expect(decodeTrashCursor(encodeTrashCursor(null, 'd1'))).toEqual({ deletedAt: null, docId: 'd1' })
  })

  it('exposes the PRD batch cap', () => {
    expect(MAX_TRASH_BATCH).toBe(50)
  })
})

describe('docTrashRepo.claimPurge / restoreDoc purge fence', () => {
  it('persists purge_state=1 in the row lock BEFORE any remote work', async () => {
    const { tx, calls } = txWith([
      (sql) => (sql.startsWith('SELECT status')
        ? [{ status: 0, document_name: 'octo:s1:f1:d1', purge_state: 0 }]
        : undefined),
    ])
    mockTransaction.mockImplementationOnce(async (fn: never) => (fn as never as (t: unknown) => unknown)(tx))

    const claim = await docTrashRepo.claimPurge('d1')
    expect(claim.ok).toBe(true)
    expect(claim.ok && claim.resumed).toBe(false)
    // The claim is durable state, written inside the same transaction as the
    // status check — not an in-memory flag the restore path cannot see.
    expect(calls.some((c) => c.sql.includes('SET purge_state = 1'))).toBe(true)
  })

  it('resumes an already-claimed purge instead of failing (retry basis)', async () => {
    const { tx, calls } = txWith([
      (sql) => (sql.startsWith('SELECT status')
        ? [{ status: 0, document_name: 'octo:s1:f1:d1', purge_state: 1 }]
        : undefined),
    ])
    mockTransaction.mockImplementationOnce(async (fn: never) => (fn as never as (t: unknown) => unknown)(tx))

    const claim = await docTrashRepo.claimPurge('d1')
    expect(claim.ok).toBe(true)
    expect(claim.ok && claim.resumed).toBe(true)
    expect(calls.some((c) => c.sql.includes('SET purge_state = 1'))).toBe(false)
  })

  it('refuses to restore a purge-claimed row, even while it is still status=0', async () => {
    const { tx, calls } = txWith([
      (sql) => (sql.startsWith('SELECT status')
        ? [{ status: 0, document_name: 'octo:s1:f1:d1', purge_state: 1 }]
        : undefined),
    ])
    mockTransaction.mockImplementationOnce(async (fn: never) => (fn as never as (t: unknown) => unknown)(tx))

    expect(await docTrashRepo.restoreDoc('d1')).toEqual({ ok: false, reason: 'purging' })
    expect(calls.some((c) => c.sql.includes('SET status = 1'))).toBe(false)
    expect(mockBumpEpochTx).not.toHaveBeenCalled()
  })
})
