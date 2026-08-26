import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/db/pool.js', () => ({ query: vi.fn(async () => []) }))

import { query } from '../src/db/pool.js'
import { docAccessNotifyCardRepo } from '../src/db/repos/docAccessNotifyCardRepo.js'

describe('docAccessNotifyCardRepo Space-qualified identity', () => {
  beforeEach(() => vi.mocked(query).mockClear())

  it('retains two cards for the same uid in different delivery Spaces', async () => {
    await docAccessNotifyCardRepo.record('req-1', [
      { recipientUid: 'same', deliverySpaceId: 'space-A', channelId: 'a', channelType: 1, messageId: '1', clientMsgNo: 'a1' },
      { recipientUid: 'same', deliverySpaceId: 'space-B', channelId: 'b', channelType: 1, messageId: '2', clientMsgNo: 'b1' },
    ])
    const [sql, params] = vi.mocked(query).mock.calls[0]!
    expect(String(sql)).toContain('(request_id, recipient_uid, delivery_space_id,')
    expect(params).toEqual([
      'req-1', 'same', 'space-A', 'a', 1, '1', 'a1', 1,
      'req-1', 'same', 'space-B', 'b', 1, '2', 'b1', 1,
    ])
  })

  it('terminalizes only one exact delivery principal', async () => {
    await docAccessNotifyCardRepo.markTerminalized('req-1', 'same', 'space-B')
    expect(vi.mocked(query).mock.calls[0]![0]).toContain('delivery_space_id = ?')
    expect(vi.mocked(query).mock.calls[0]![1]).toEqual(['req-1', 'same', 'space-B'])
  })
})
