import { beforeEach, describe, expect, it, vi } from 'vitest'

const tx = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('../src/db/pool.js', () => ({
  getPool: vi.fn(), query: vi.fn(),
  transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
}))

import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'

beforeEach(() => tx.query.mockReset())

describe('docMemberRepo.removePrincipalExact', () => {
  it('deletes exactly one Space-qualified principal and increments epoch exactly once', async () => {
    tx.query
      .mockResolvedValueOnce([{ uid: 'human' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ permission_epoch: 12 }])

    await expect(docMemberRepo.removePrincipalExact({
      docId: 'd1', principalSpaceId: 'sp1', uid: 'human',
    })).resolves.toEqual({ changed: true, removedUids: ['human'], newEpoch: 12 })

    const calls = tx.query.mock.calls
    expect(calls).toHaveLength(5)
    expect(calls[1]![0]).toContain('DELETE FROM doc_member_notification')
    expect(calls[1]![1]).toEqual(['d1', 'human', 'sp1'])
    expect(calls[0]![0]).toContain('FOR UPDATE')
    expect(calls[0]![1]).toEqual(['d1', 'human', 'sp1'])
    expect(calls[2]![0]).toContain('DELETE FROM doc_member')
    expect(calls[2]![1]).toEqual(['d1', 'human', 'sp1'])
    expect(calls.filter(([sql]) => String(sql).includes('permission_epoch = permission_epoch + 1'))).toHaveLength(1)
  })

  it('is idempotent and does not delete or bump epoch when the exact row is absent', async () => {
    tx.query.mockResolvedValueOnce([])
    await expect(docMemberRepo.removePrincipalExact({
      docId: 'd1', principalSpaceId: 'sp1', uid: 'missing',
    })).resolves.toEqual({ changed: false, removedUids: [] })
    expect(tx.query).toHaveBeenCalledTimes(2)
  })
})
