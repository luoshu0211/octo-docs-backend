import { describe, it, expect, vi, beforeEach } from 'vitest'

// Persistence-layer oracle for the #64 migration/default (design §2 / §6 AC1/AC6):
// - docMetaRepo.create MUST NOT set the share columns, so a new doc relies on the
//   DDL defaults (share_scope=0 restricted / share_role=1 read) — no accidental
//   exposure.
// - docMetaRepo.setShareSettings issues the exact UPDATE the share API depends on.
vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(async () => []),
  transaction: vi.fn(),
}))

import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { query, transaction } from '../src/db/pool.js'

const mockQuery = vi.mocked(query)
const mockTransaction = vi.mocked(transaction)

beforeEach(() => {
  mockQuery.mockReset()
  mockQuery.mockResolvedValue([] as never)
  mockTransaction.mockReset()
})

describe('docMetaRepo — share columns default restricted (#64)', () => {
  it('create() never writes share_scope/share_role (new docs default to restricted)', async () => {
    await docMetaRepo.create({
      docId: 'd_new',
      documentName: 'octo:s1:f_default:d_new',
      title: 't',
      ownerId: 'u_1',
      spaceId: 's1',
      principalSpaceId: 's1',
      folderId: 'f_default',
      docType: 'doc',
      createdBy: 'u_1',
    })
    const sql = mockQuery.mock.calls[0]![0] as string
    expect(sql).toMatch(/INSERT INTO doc_meta/)
    expect(sql).not.toMatch(/share_scope/)
    expect(sql).not.toMatch(/share_role/)
  })

  it('setShareSettings updates share_scope/share_role AND bumps the epoch atomically (one tx)', async () => {
    // The share write + epoch bump run in ONE transaction (mirrors softDelete) so
    // a narrowing is never observable at the new scope with a stale epoch.
    const queries: Array<{ sql: string; params: unknown[] }> = []
    mockTransaction.mockImplementation(async (fn: never) => {
      const tx = {
        query: vi.fn(async (sql: string, params: unknown[] = []) => {
          queries.push({ sql, params })
          if (sql.includes('UPDATE doc_meta')) return { affectedRows: 1 }
          if (sql.includes('SELECT share_scope')) return [{
            share_scope: 1,
            share_role: 2,
            discoverability_scope: 0,
            permission_epoch: 8,
          }]
          return []
        }),
      }
      return (fn as unknown as (t: typeof tx) => Promise<unknown>)(tx)
    })

    const result = await docMetaRepo.setShareSettings('d_1', 1, 2, false, 7)
    expect(result).toEqual({
      updated: true,
      settings: {
        shareScope: 1,
        shareRole: 2,
        spaceSearchable: false,
        permissionEpoch: 8,
      },
    })
    const update = queries.find((q) => q.sql.includes('SET share_scope'))!
    expect(update.sql).toMatch(/discoverability_scope = \?,\s+permission_epoch = permission_epoch \+ 1/)
    expect(update.sql).toMatch(/WHERE doc_id = \? AND permission_epoch = \?/)
    expect(update.params).toEqual([1, 2, 0, 'd_1', 7])
    expect(queries.find((q) => q.sql.includes('SELECT share_scope'))?.sql).toMatch(/LIMIT 1 FOR UPDATE/)
    expect(queries.filter((q) => /permission_epoch = permission_epoch \+ 1/.test(q.sql))).toHaveLength(1)
  })

  it('returns the authoritative settings without another update when the expected epoch is stale', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = []
    mockTransaction.mockImplementation(async (fn: never) => {
      const tx = {
        query: vi.fn(async (sql: string, params: unknown[] = []) => {
          queries.push({ sql, params })
          if (sql.includes('UPDATE doc_meta')) return { affectedRows: 0 }
          return [{
            share_scope: 2,
            share_role: 4,
            discoverability_scope: 1,
            permission_epoch: 9,
          }]
        }),
      }
      return (fn as unknown as (t: typeof tx) => Promise<unknown>)(tx)
    })

    await expect(docMetaRepo.setShareSettings('d_1', 1, 2, false, 7)).resolves.toEqual({
      updated: false,
      current: {
        shareScope: 2,
        shareRole: 4,
        spaceSearchable: true,
        permissionEpoch: 9,
      },
    })
    expect(queries).toHaveLength(2)
    expect(queries[1]?.sql).toMatch(/LIMIT 1 FOR UPDATE/)
  })
})
