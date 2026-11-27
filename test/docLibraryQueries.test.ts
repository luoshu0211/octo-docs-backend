import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * OCTO-456 repo-layer contracts (offline; the MySQL pool is mocked).
 *
 * These pin the SQL an operator/reviewer must be able to read back:
 *   - shared excludes the caller's OWN docs and the im_card/im_link legacy
 *     sources, and merges doc_member + doc_legacy_visible on their PKs;
 *   - readable covers owner / direct / authenticated / same-Space share;
 *   - both page by (updated_at, doc_id) DESC with pageSize+1 over-fetch;
 *   - manageable's new `q` is a title LIKE ANDed with the existing predicates,
 *     with LIKE metacharacters escaped.
 */
vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(async () => []),
  transaction: vi.fn(),
}))

import { docMetaRepo, escapeLikeSubstring, MAX_LIBRARY_PAGE_SIZE } from '../src/db/repos/docMetaRepo.js'
import { TRASH_RETENTION_DAYS } from '../src/permission/docRetention.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import { query } from '../src/db/pool.js'

const mockQuery = vi.mocked(query)

function lastSql(): string {
  return mockQuery.mock.calls[mockQuery.mock.calls.length - 1]![0] as string
}
function lastParams(): unknown[] {
  return (mockQuery.mock.calls[mockQuery.mock.calls.length - 1]![1] ?? []) as unknown[]
}

beforeEach(() => {
  mockQuery.mockReset()
  mockQuery.mockResolvedValue([] as never)
})

describe('docMetaRepo.listSharedWithUser', () => {
  it('merges doc_member + doc_legacy_visible, excludes own docs and im sources, over-fetches by 1', async () => {
    await docMetaRepo.listSharedWithUser({ uid: 'u1', principalSpaceId: 's1', pageSize: 200 })
    const sql = lastSql()
    expect(sql).toContain('LEFT JOIN doc_member dm')
    expect(sql).toContain('LEFT JOIN doc_legacy_visible dl')
    expect(sql).toContain('NOT (m.owner_id = ? AND m.owner_space_id = ?)')
    expect(sql).toContain("dl.source NOT IN ('im_card', 'im_link')")
    // 2026-11-27 product rule: 与我共享 also accepts "查看记录 + 当前分享范围".
    // The caller's view row in the CURRENT principal Space joins in, and the
    // candidate gate requires a share scope that still allows access:
    // authenticated (2) org-wide, or anyone_in_space (1) only when the document
    // home Space matches the view record's Space.
    expect(sql).toContain('LEFT JOIN doc_view_history v')
    expect(sql).toContain('v.uid = ? AND v.space_id = ?')
    expect(sql).toContain('CASE WHEN v.doc_id IS NULL THEN 0 ELSE 1 END AS has_view')
    expect(sql).toContain('m.share_scope AS share_scope')
    expect(sql).toContain('m.share_scope = 2')
    expect(sql).toContain('m.share_scope = 1 AND m.space_id = v.space_id')
    expect(sql).toContain('m.status = 1')
    // v3.1 §3.3: a deleted doc still inside its 30-day retention window stays a
    // candidate so Drive can render it as a grey row to observers. Historical
    // status=0 rows have deleted_at NULL (the migration deliberately does not
    // backfill), and internalDocsLibrary reports those as expired:false, so the
    // candidate query must keep them too — filtering on IS NOT NULL dropped them
    // before Drive ever saw them.
    expect(sql).toContain('m.status = 0')
    expect(sql).toContain('(m.deleted_at IS NULL')
    // The window comes from the configured retention (never a hard-coded 30):
    // a 60-day deployment must still list a document deleted 40 days ago.
    expect(sql).toContain('m.deleted_at >= NOW(3) - INTERVAL ? DAY')
    expect(sql).toContain('ORDER BY m.updated_at DESC, m.doc_id DESC')
    expect(sql).toContain('LIMIT 201')
    // JOIN dm.uid, dm.principal_space_id; JOIN dl.uid, dl.principal_space;
    // JOIN v.uid, v.space_id; retention window; owner_id + owner_space_id
    // (compound owner exclusion).
    expect(lastParams()).toEqual([
      'u1', 's1', 'u1', 's1', 'u1', 's1', TRASH_RETENTION_DAYS, 'u1', 's1',
    ])
  })

  it('defaults the window to the same configured retention every other projection uses', async () => {
    await docMetaRepo.listSharedWithUser({ uid: 'u1', principalSpaceId: 's1', pageSize: 200 })
    // Not a literal: the configured value, so display / restore / cleanup and this
    // candidate filter can never disagree.
    expect(lastParams()[6]).toBe(TRASH_RETENTION_DAYS)
  })

  it('binds the configured retention window instead of a hard-coded 30 days', async () => {
    await docMetaRepo.listSharedWithUser({
      uid: 'u1', principalSpaceId: 's1', pageSize: 200, retentionDays: 60,
    })
    expect(lastSql()).toContain('m.deleted_at >= NOW(3) - INTERVAL ? DAY')
    expect(lastParams()[6]).toBe(60)
  })

  it('clamps pageSize to the 500 cap', async () => {
    expect(MAX_LIBRARY_PAGE_SIZE).toBe(500)
    await docMetaRepo.listSharedWithUser({ uid: 'u1', principalSpaceId: 's1', pageSize: 5000 })
    expect(lastSql()).toContain('LIMIT 501')
  })

  it('builds a stable (updated_at, doc_id) keyset cursor and a null nextCursor on a short page', async () => {
    mockQuery.mockResolvedValue([
      { doc_id: 'd1', updated_at: new Date('2026-11-21T00:00:00.000Z') },
    ] as never)
    const cursor = Buffer.from(
      JSON.stringify({ u: '2026-11-20T00:00:00.000Z', d: 'd9' }),
    ).toString('base64url')
    const result = await docMetaRepo.listSharedWithUser({
      uid: 'u1', principalSpaceId: 's1', pageSize: 10, cursor,
    })
    expect(lastSql()).toContain('m.updated_at < ? OR (m.updated_at = ? AND m.doc_id < ?)')
    const params = lastParams()
    expect(params.slice(-3)).toEqual([
      new Date('2026-11-20T00:00:00.000Z'),
      new Date('2026-11-20T00:00:00.000Z'),
      'd9',
    ])
    expect(result.nextCursor).toBeNull()
  })

  it('throws invalid_cursor for a malformed cursor', async () => {
    await expect(docMetaRepo.listSharedWithUser({
      uid: 'u1', principalSpaceId: 's1', pageSize: 10, cursor: 'garbage',
    })).rejects.toThrow('invalid_cursor')
  })

  it('emits a nextCursor from the last kept row when an extra row indicates more', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      doc_id: `d${i}`,
      updated_at: new Date(Date.UTC(2026, 10, 21 - i)),
    }))
    mockQuery.mockResolvedValue(rows as never)
    const result = await docMetaRepo.listSharedWithUser({
      uid: 'u1', principalSpaceId: 's1', pageSize: 2,
    })
    expect(result.items).toHaveLength(2)
    expect(result.nextCursor).not.toBeNull()
  })
})

describe('docMetaRepo.listReadableForUser', () => {
  it('covers owner / direct / authenticated / same-Space share, ordered + over-fetched', async () => {
    await docMetaRepo.listReadableForUser({ uid: 'u1', principalSpaceId: 's1', pageSize: 500 })
    const sql = lastSql()
    expect(sql).toContain('(m.owner_id = ? AND m.owner_space_id = ?)')
    expect(sql).toContain('dm.doc_id IS NOT NULL')
    expect(sql).toMatch(/m\.share_scope = 2/)
    expect(sql).toMatch(/m\.share_scope = 1 AND m\.space_id = \?/)
    expect(sql).toContain('ORDER BY m.updated_at DESC, m.doc_id DESC')
    expect(sql).toContain('LIMIT 501')
    // JOIN dm.uid, dm.principal_space_id; owner uid, owner_space; share space.
    expect(lastParams()).toEqual(['u1', 's1', 'u1', 's1', 's1'])
  })
})

describe('docMetaRepo.getByDocIds / docMemberRepo.getRoles (batch projection reads)', () => {
  it('de-duplicates ids, binds them as an IN list, and rejects > 500', async () => {
    mockQuery.mockResolvedValue([] as never)
    await docMetaRepo.getByDocIds(['d1', 'd1', 'd2', ''])
    expect(lastSql()).toMatch(/WHERE doc_id IN \(\?, \?\)/)
    expect(lastParams()).toEqual(['d1', 'd2'])
    await expect(
      docMetaRepo.getByDocIds(Array.from({ length: 501 }, (_, i) => `d${i}`)),
    ).rejects.toThrow('too_many_doc_ids')
  })

  it('getRoles is keyed by the compound principal and drops unknown stored values', async () => {
    mockQuery.mockResolvedValue([
      { doc_id: 'd1', role: 2 },
      { doc_id: 'd2', role: 99 },
    ] as never)
    const roles = await docMemberRepo.getRoles(['d1', 'd2'], 'u1', 's1')
    expect(lastSql()).toContain('uid = ? AND principal_space_id = ?')
    expect(lastParams()).toEqual(['u1', 's1', 'd1', 'd2'])
    expect([...roles.entries()]).toEqual([['d1', 'writer']])
  })
})

describe('listManageable title filter (OCTO-456 q)', () => {
  it('adds a case-insensitive %q% LIKE ANDed with the existing predicates', async () => {
    await docMetaRepo.listManageable({
      uid: 'u1', spaceId: 's1', principalSpaceId: 's1', pageSize: 20, q: 'Quarterly Report',
    })
    const sql = lastSql()
    expect(sql).toContain("m.title LIKE ? ESCAPE")
    // The LIKE still sits next to (AND) the owner/admin + status filters.
    expect(sql).toMatch(/m\.status = 1 AND m\.space_id = \?\s+AND m\.title LIKE \? ESCAPE .* AND \(\(m\.owner_id = \?/s)
    expect(lastParams()).toEqual(['u1', 's1', 's1', '%Quarterly Report%', 'u1', 's1'])
  })

  it('adds NO title clause for a blank / absent q (byte-compatible with the old query)', async () => {
    await docMetaRepo.listManageable({
      uid: 'u1', spaceId: 's1', principalSpaceId: 's1', pageSize: 20,
    })
    expect(lastSql()).not.toContain('m.title LIKE')
    await docMetaRepo.listManageable({
      uid: 'u1', spaceId: 's1', principalSpaceId: 's1', pageSize: 20, q: '   ',
    })
    expect(lastSql()).not.toContain('m.title LIKE')
  })

  it('escapes LIKE metacharacters so they match literally', async () => {
    expect(escapeLikeSubstring('50%_off\\')).toBe('50\\%\\_off\\\\')
    await docMetaRepo.listManageable({
      uid: 'u1', spaceId: 's1', principalSpaceId: 's1', pageSize: 20, q: '50%_off',
    })
    expect(lastParams()).toContain('%50\\%\\_off%')
  })

  it('keeps the keyset cursor semantics unchanged when q is present', async () => {
    await docMetaRepo.listManageable({
      uid: 'u1', spaceId: 's1', principalSpaceId: 's1', pageSize: 20,
      q: 'a', cursor: Buffer.from(JSON.stringify({ u: '2026-11-20T00:00:00.000Z', d: 'd9' })).toString('base64url'),
    })
    expect(lastSql()).toContain('m.updated_at < ? OR (m.updated_at = ? AND m.doc_id < ?)')
    expect(lastParams().slice(-1)).toEqual(['d9'])
  })
})

describe('OCTO-456 legacy backfill migration', () => {
  it('ships doc_legacy_visible in both the incremental upgrade and schema.sql', async () => {
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const root = fileURLToPath(new URL('..', import.meta.url))
    const upgrade = await readFile(
      `${root}migrations/upgrades/2026-11-23-add-doc-legacy-visible.sql`, 'utf8',
    )
    const schema = await readFile(`${root}migrations/schema.sql`, 'utf8')
    // The upgrade must be re-runnable (guarded DDL); schema.sql builds fresh DBs.
    expect(upgrade).toContain('CREATE TABLE IF NOT EXISTS doc_legacy_visible')
    expect(schema).toContain('CREATE TABLE doc_legacy_visible')
    for (const sql of [upgrade, schema]) {
      expect(sql).toMatch(/doc_id\s+VARCHAR\(64\) NOT NULL/)
      expect(sql).toMatch(/uid\s+VARCHAR\(64\) NOT NULL/)
      expect(sql).toMatch(/principal_space\s+VARCHAR\(64\) NOT NULL/)
      expect(sql).toMatch(/source\s+VARCHAR\(16\)/)
      expect(sql).toMatch(/last_seen_at\s+DATETIME\(3\)/)
      expect(sql).toContain('PRIMARY KEY (doc_id, uid, principal_space)')
    }
  })
})
