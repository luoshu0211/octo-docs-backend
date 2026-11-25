import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * OCTO-456 deletion grey state — the storage half.
 *
 * Pins that (a) a fresh install and the incremental upgrade declare the SAME
 * single nullable doc_meta.deleted_at column, (b) the upgrade is re-runnable and
 * deliberately does NOT backfill historical status=0 rows, and (c) the one
 * revival path (legacy html slug re-registration) clears the timestamp so a
 * revived doc is never reported as deleted.
 */
const root = fileURLToPath(new URL('..', import.meta.url))
const schema = readFileSync(`${root}/migrations/schema.sql`, 'utf8')
const upgrade = readFileSync(
  `${root}/migrations/upgrades/2026-11-24-add-doc-deleted-at.sql`,
  'utf8',
)

const txQueries: Array<{ sql: string; params: unknown[] }> = []

vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(async () => []),
  getPool: vi.fn(),
  transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({
    async query(sql: string, params: unknown[] = []) {
      txQueries.push({ sql, params })
      if (/^\s*SELECT \* FROM doc_meta WHERE doc_id/i.test(sql)) {
        return [{
          doc_id: 'd_html', document_name: 'octo:s1:f_default:html:d_html', title: 'Revived',
          owner_id: 'u_owner', owner_space_id: 's1', space_id: 's1', folder_id: 'f_default',
          doc_type: 'html', octo_doc_slug: 'slug-1', html_idempotency_key_hash: null,
          status: 1, deleted_at: null, permission_epoch: 2, share_scope: 0, share_role: 1,
          discoverability_scope: 0, created_at: new Date(0), updated_at: new Date(0),
          created_by: 'u_owner', updated_by: 'u_owner',
        }]
      }
      return []
    },
    async execute() { return { affectedRows: 0 } },
  })),
}))

import { query } from '../src/db/pool.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'

const legacyHtmlRow = {
  doc_id: 'd_html', document_name: 'octo:s1:f_default:html:d_html', title: 'Old',
  owner_id: 'u_owner', owner_space_id: 's1', space_id: 's1', folder_id: 'f_default',
  doc_type: 'html', octo_doc_slug: 'slug-1', html_idempotency_key_hash: null,
  status: 0, deleted_at: new Date('2026-11-01T00:00:00.000Z'), permission_epoch: 1,
  share_scope: 0, share_role: 1, discoverability_scope: 0,
  created_at: new Date(0), updated_at: new Date(0), created_by: 'u_owner', updated_by: 'u_owner',
}

beforeEach(() => {
  txQueries.length = 0
  vi.mocked(query).mockReset()
})

describe('doc_meta.deleted_at schema contract', () => {
  it('schema.sql declares DATETIME(3) NULL on doc_meta', () => {
    expect(schema).toMatch(/CREATE TABLE doc_meta \([\s\S]*?deleted_at\s+DATETIME\(3\)\s+NULL DEFAULT NULL/)
  })

  it('the upgrade adds the same column behind an information_schema guard (re-runnable)', () => {
    expect(upgrade).toMatch(/information_schema\.columns[\s\S]*column_name\s*=\s*'deleted_at'/)
    expect(upgrade).toMatch(/ALTER TABLE doc_meta\s+ADD COLUMN deleted_at DATETIME\(3\) NULL DEFAULT NULL/)
    expect(upgrade).toContain('DROP PROCEDURE IF EXISTS octo_add_doc_meta_deleted_at')
  })

  it('does NOT backfill historical deleted rows (unknown deletion time stays NULL)', () => {
    expect(upgrade).not.toMatch(/UPDATE\s+doc_meta/i)
    expect(upgrade).not.toMatch(/SET\s+deleted_at/i)
  })
})

describe('revival clears the deletion timestamp', () => {
  it('legacy html slug re-registration sets status=1 AND deleted_at=NULL atomically', async () => {
    vi.mocked(query).mockResolvedValue([legacyHtmlRow] as never)
    await docMetaRepo.upsertHtmlByOctoDocSlug({
      docId: 'd_html',
      documentName: 'octo:s1:f_default:html:d_html',
      title: 'Revived',
      ownerId: 'u_owner',
      spaceId: 's1',
      folderId: 'f_default',
      docType: 'html',
      octoDocSlug: 'slug-1',
      createdBy: 'u_owner',
    })
    const revive = txQueries.find((q) => /UPDATE doc_meta[\s\S]*status = 1/i.test(q.sql))
    expect(revive).toBeDefined()
    expect(revive!.sql).toMatch(/deleted_at = NULL/i)
  })
})
