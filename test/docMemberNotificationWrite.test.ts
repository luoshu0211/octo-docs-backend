import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(async () => []),
  getPool: vi.fn(),
  transaction: vi.fn(),
}))

import { transaction, type Tx } from '../src/db/pool.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'

const params = {
  docId: 'd_1',
  uid: 'u_member',
  principalSpaceId: 's1',
  roleNum: 2,
  grantedBy: 'u_admin',
  notifyRecipient: true,
}

beforeEach(() => vi.resetAllMocks())

describe('direct member notification write', () => {
  it.each(['u_admin', 'bot_admin'])('atomically records a first Human recipient grant by %s', async (grantedBy) => {
    const tx = {
      query: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]),
      execute: vi.fn(),
    } satisfies Tx
    vi.mocked(transaction).mockImplementationOnce(async (fn) => fn(tx))

    await expect(docMemberRepo.upsertDirectWithNotification({ ...params, grantedBy })).resolves.toEqual({ created: true })

    expect(tx.query).toHaveBeenCalledTimes(3)
    expect(tx.query.mock.calls[2]?.[0]).toContain('INSERT INTO doc_member_notification')
    expect(tx.query.mock.calls[2]?.[0]).toContain('read_at = NULL')
    expect(tx.query.mock.calls[2]?.[1]).toEqual(['u_member', 's1', 'd_1', grantedBy, 2])
  })

  it('does not notify for a role edit of an existing exact principal', async () => {
    const tx = {
      query: vi.fn()
        .mockResolvedValueOnce([{ present: 1 }])
        .mockResolvedValueOnce([]),
      execute: vi.fn(),
    } satisfies Tx
    vi.mocked(transaction).mockImplementationOnce(async (fn) => fn(tx))

    await expect(docMemberRepo.upsertDirectWithNotification(params)).resolves.toEqual({ created: false })
    expect(tx.query).toHaveBeenCalledTimes(2)
  })

  it('does not create a notification when the recipient is a Bot', async () => {
    const tx = {
      query: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]),
      execute: vi.fn(),
    } satisfies Tx
    vi.mocked(transaction).mockImplementationOnce(async (fn) => fn(tx))

    await docMemberRepo.upsertDirectWithNotification({ ...params, notifyRecipient: false })
    expect(tx.query).toHaveBeenCalledTimes(2)
  })
})


describe('member notification transaction retries', () => {
  it('retries a rolled-back deadlock and re-reads the winning member before deciding to notify', async () => {
    vi.mocked(transaction).mockRejectedValueOnce(Object.assign(new Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' }))
    const tx = { query: vi.fn().mockResolvedValueOnce([{ present: 1 }]).mockResolvedValueOnce([]), execute: vi.fn() } satisfies Tx
    vi.mocked(transaction).mockImplementationOnce(async fn => fn(tx))
    await expect(docMemberRepo.upsertDirectWithNotification(params)).resolves.toEqual({ created: false })
    expect(transaction).toHaveBeenCalledTimes(2)
    expect(tx.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO doc_member_notification'))).toBe(false)
  })

  it('bounds transient retries and propagates the final failure', async () => {
    const error = Object.assign(new Error('deadlock'), { errno: 1213 })
    vi.mocked(transaction).mockRejectedValue(error)
    await expect(docMemberRepo.upsertDirectWithNotification(params)).rejects.toBe(error)
    expect(transaction).toHaveBeenCalledTimes(6)
  })

  it('does not retry connection or non-lock database failures', async () => {
    const error = Object.assign(new Error('connection lost'), { code: 'PROTOCOL_CONNECTION_LOST' })
    vi.mocked(transaction).mockRejectedValue(error)
    await expect(docMemberRepo.upsertDirectWithNotification(params)).rejects.toBe(error)
    expect(transaction).toHaveBeenCalledTimes(1)
  })
})
