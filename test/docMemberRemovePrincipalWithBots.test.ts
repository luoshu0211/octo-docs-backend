import { beforeEach, describe, expect, it, vi } from 'vitest'

const tx = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('../src/db/pool.js', () => ({
  getPool: vi.fn(), query: vi.fn(),
  transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
}))

import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'

beforeEach(() => tx.query.mockReset())

describe('docMemberRepo.removePrincipalWithBots', () => {
  it('deletes only present authorized principals and increments epoch exactly once', async () => {
    tx.query
      .mockResolvedValueOnce([{ uid: 'human' }, { uid: 'bot-a' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ permission_epoch: 12 }])

    await expect(docMemberRepo.removePrincipalWithBots({
      docId: 'd1', principalSpaceId: 'sp1', uid: 'human', botUids: ['bot-a', 'bot-missing'],
    })).resolves.toEqual({ changed: true, removedUids: ['human', 'bot-a'], newEpoch: 12 })

    expect(tx.query.mock.calls[1]![0]).toContain('DELETE FROM doc_member_notification')
    expect(tx.query.mock.calls[1]![1]).toEqual(['d1', 'sp1', 'human', 'bot-a', 'bot-missing'])
    expect(tx.query.mock.calls[0]![1]).toEqual(['d1', 'sp1', 'human', 'bot-a', 'bot-missing'])
    expect(tx.query.mock.calls[2]![1]).toEqual(['d1', 'sp1', 'human', 'bot-a'])
    expect(tx.query.mock.calls.filter(([sql]) =>
      String(sql).includes('permission_epoch = permission_epoch + 1'))).toHaveLength(1)
  })

  it('is a no-op without epoch mutation when none of the authorized rows exist', async () => {
    tx.query.mockResolvedValueOnce([])

    await expect(docMemberRepo.removePrincipalWithBots({
      docId: 'd1', principalSpaceId: 'sp1', uid: 'human', botUids: ['bot-a'],
    })).resolves.toEqual({ changed: false, removedUids: [] })

    expect(tx.query).toHaveBeenCalledTimes(2)
  })
})
