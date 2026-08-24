import { beforeEach, describe, expect, it, vi } from 'vitest'

const tx = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('../src/db/pool.js', () => ({
  getPool: vi.fn(), query: vi.fn(),
  transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
}))

import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'

beforeEach(() => tx.query.mockReset())

describe('docMemberRepo.removePrincipalWithBots', () => {
  it('deletes the Human and same-Space Bots and increments epoch exactly once', async () => {
    tx.query
      .mockResolvedValueOnce([{ uid: 'human' }, { uid: 'bot-a' }, { uid: 'bot-b' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ permission_epoch: 12 }])

    await expect(docMemberRepo.removePrincipalWithBots({
      docId: 'd1', principalSpaceId: 'sp1', uid: 'human', botUids: ['bot-a', 'bot-b'],
    })).resolves.toEqual({ changed: true, removedUids: ['human', 'bot-a', 'bot-b'], newEpoch: 12 })

    const calls = tx.query.mock.calls
    expect(calls).toHaveLength(4)
    expect(calls[0]![0]).toContain('FOR UPDATE')
    expect(calls[0]![1]).toEqual(['d1', 'sp1', 'human', 'bot-a', 'bot-b'])
    expect(calls[1]![0]).toContain('DELETE FROM doc_member')
    expect(calls[1]![1]).toEqual(['d1', 'sp1', 'human', 'bot-a', 'bot-b'])
    expect(calls.filter(([sql]) => String(sql).includes('permission_epoch = permission_epoch + 1'))).toHaveLength(1)
  })
})
