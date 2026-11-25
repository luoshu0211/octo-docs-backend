import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit test: the real repos run against a mocked MySQL pool. softDelete
// goes through `transaction`; the recheck path reads doc_meta via `query`.
// This anchors the §8.4 invariant that a soft delete severs live collaboration:
//   1. softDelete flips status=0 AND bumps permission_epoch in the SAME tx, and
//   2. the recheck path (beforeHandleMessage -> recheckCurrentRole) returns
//      'none' for the former owner/admin once status===0.
const txQueries: Array<{ sql: string; params: unknown[] }> = []
const queryCalls: Array<{ sql: string; params: unknown[] }> = []
// In-memory stand-in for doc_member_notification so the §3.3 "deletion consumes
// the invite badge" contract is exercised, not just asserted as SQL text.
const notificationRows = new Map<string, number>()

// Deleted doc_meta row as returned post-softDelete (status===0).
const deletedRow = {
  doc_id: 'd_1',
  document_name: 'octo:s:f:d_1',
  title: 'Doc',
  owner_id: 'u_owner',
  space_id: 's',
  folder_id: 'f',
  doc_type: 'doc',
  status: 0,
  permission_epoch: 8,
  created_at: new Date(0),
  updated_at: new Date(0),
  created_by: 'u_owner',
  updated_by: 'u_owner',
}

vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    queryCalls.push({ sql, params })
    // recheckCurrentRole -> docMetaRepo.getByDocumentName
    if (/FROM doc_meta WHERE document_name/i.test(sql)) return [deletedRow]
    return []
  }),
  transaction: vi.fn(async (fn: (tx: unknown) => unknown) => {
    const tx = {
      async query(sql: string, params: unknown[] = []) {
        txQueries.push({ sql, params })
        if (/DELETE FROM doc_member_notification/i.test(sql)) {
          const docId = String(params[0])
          notificationRows.set(docId, 0)
          return []
        }
        // The read-back SELECT after the status flip + epoch bump.
        if (/^\s*SELECT/i.test(sql)) {
          return [{ document_name: deletedRow.document_name, permission_epoch: 8 }]
        }
        return []
      },
    }
    return fn(tx)
  }),
}))

import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { recheckCurrentRole } from '../src/permission/resolveRole.js'

beforeEach(() => {
  txQueries.length = 0
  queryCalls.length = 0
  notificationRows.clear()
})

describe('docMetaRepo.softDelete severs live collaboration (§8.4)', () => {
  it('flips status=0 AND bumps permission_epoch in the same transaction', async () => {
    const out = await docMetaRepo.softDelete('d_1')

    const sql = txQueries.map((q) => q.sql).join('\n')
    // status flip and epoch bump must BOTH happen in the one transaction.
    expect(sql).toMatch(/status\s*=\s*0/i)
    // Fails if someone later removes the epoch bump from softDelete.
    expect(sql).toMatch(/permission_epoch\s*=\s*permission_epoch\s*\+\s*1/i)

    // Returns the doc's name + new epoch so the route can publish the event.
    expect(out).toEqual({ documentName: 'octo:s:f:d_1', permissionEpoch: 8 })
  })

  it('stamps deleted_at with the repo NOW(3) convention, preserving the first deletion', async () => {
    await docMetaRepo.softDelete('d_1')
    const flip = txQueries.find((q) => /UPDATE doc_meta[\s\S]*status = 0/i.test(q.sql))
    expect(flip).toBeDefined()
    expect(flip!.sql).toMatch(/deleted_at\s*=\s*COALESCE\(deleted_at,\s*NOW\(3\)\)/i)
  })

  it('consumes the doc\'s member-added unread reminders in the same transaction (§3.3)', async () => {
    notificationRows.set('d_1', 2)
    await docMetaRepo.softDelete('d_1')
    const deletes = txQueries.filter((q) => /DELETE FROM doc_member_notification/i.test(q.sql))
    expect(deletes).toEqual([{ sql: expect.stringContaining('DELETE FROM doc_member_notification'), params: ['d_1'] }])
    expect(notificationRows.get('d_1')).toBe(0)
  })

  it('is re-entrant: a repeated delete clears zero rows and never double-decrements', async () => {
    notificationRows.set('d_1', 1)
    await docMetaRepo.softDelete('d_1')
    expect(notificationRows.get('d_1')).toBe(0)
    await docMetaRepo.softDelete('d_1')
    // Second pass re-runs the same idempotent statements; the row count is unchanged.
    expect(notificationRows.get('d_1')).toBe(0)
    const deletes = txQueries.filter((q) => /DELETE FROM doc_member_notification/i.test(q.sql))
    expect(deletes).toHaveLength(2)
    expect(deletes.every((q) => q.params[0] === 'd_1')).toBe(true)
  })

  it('recheck returns none for the former owner/admin once status===0', async () => {
    // This is the actual beforeHandleMessage recheck path. Fails if recheck
    // ever stops reading doc_meta.status — the doc would stay writable.
    const role = await recheckCurrentRole('octo:s:f:d_1', 'u_owner')
    expect(role).toBe('none')
  })
})
