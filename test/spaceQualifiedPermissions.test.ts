import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(),
  getPool: vi.fn(() => ({ execute: vi.fn() })),
  transaction: vi.fn(async (run) => run({ execute: query })),
}))

import { query } from '../src/db/pool.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import { docAccessRequestRepo } from '../src/db/repos/docAccessRequestRepo.js'
import { readFileSync } from 'node:fs'

describe('Space-qualified permission persistence', () => {
  beforeEach(() => vi.mocked(query).mockReset())

  it('does not fall back to UID-only member lookup', async () => {
    vi.mocked(query).mockResolvedValueOnce([])
    await docMemberRepo.getRole('d1', 'same-uid', 'space-b')
    expect(vi.mocked(query).mock.calls[0]?.[0]).toContain('principal_space_id = ?')
    expect(vi.mocked(query).mock.calls[0]?.[1]).toEqual(['d1', 'same-uid', 'space-b'])
  })

  it('updates an existing member by the exact compound principal without INSERT', async () => {
    vi.mocked(query).mockResolvedValueOnce({ affectedRows: 1 } as never)

    await expect(
      docMemberRepo.updateExistingDirect({
        docId: 'd1',
        uid: 'same-uid',
        principalSpaceId: 'space-b',
        roleNum: 2,
        grantedBy: 'admin',
      }),
    ).resolves.toBe(true)

    expect(vi.mocked(query)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(query).mock.calls[0]?.[0]).toMatch(/^UPDATE doc_member/)
    expect(vi.mocked(query).mock.calls[0]?.[0]).toContain(
      'WHERE doc_id = ? AND uid = ? AND principal_space_id = ?',
    )
    expect(vi.mocked(query).mock.calls[0]?.[1]).toEqual([
      2,
      'admin',
      'd1',
      'same-uid',
      'space-b',
    ])
  })

  it('returns false for an absent exact principal and never falls back to INSERT', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce({ affectedRows: 0 } as never)
      .mockResolvedValueOnce([])

    await expect(
      docMemberRepo.updateExistingDirect({
        docId: 'd1',
        uid: 'same-uid',
        principalSpaceId: 'space-missing',
        roleNum: 2,
        grantedBy: 'admin',
      }),
    ).resolves.toBe(false)

    expect(vi.mocked(query).mock.calls).toHaveLength(2)
    expect(vi.mocked(query).mock.calls.every(([sql]) => !String(sql).includes('INSERT'))).toBe(true)
    expect(vi.mocked(query).mock.calls[1]?.[1]).toEqual(['d1', 'same-uid', 'space-missing'])
  })

  it('keeps same UID requests in two Spaces as distinct PK rows', async () => {
    vi.mocked(query).mockResolvedValue([])
    const a = await docAccessRequestRepo.submit({
      docId: 'd1', uid: 'u1', principalSpaceId: 'space-a', requestedRoleNum: 1, reason: '',
    })
    const b = await docAccessRequestRepo.submit({
      docId: 'd1', uid: 'u1', principalSpaceId: 'space-b', requestedRoleNum: 1, reason: '',
    })
    expect(a.requestId).not.toBe(b.requestId)
    expect(vi.mocked(query).mock.calls[0]?.[1]?.slice(0, 3)).toEqual(['d1', 'u1', 'space-a'])
    expect(vi.mocked(query).mock.calls[2]?.[1]?.slice(0, 3)).toEqual(['d1', 'u1', 'space-b'])
  })

  it('migration backfills from doc home Space and upgrades all three PKs', () => {
    const sql = readFileSync('migrations/upgrades/2026-08-13-space-qualified-permissions.sql', 'utf8')
    expect(sql).toContain('SET dm.principal_space_id=m.space_id')
    expect(sql).toContain('PRIMARY KEY(doc_id,uid,principal_space_id)')
    expect(sql).toContain('PRIMARY KEY(invite_token,uid,principal_space_id)')
    expect(sql).toMatch(/SET owner_space_id\s*=\s*space_id/)
  })
})
