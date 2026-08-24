import { describe, expect, it, vi } from 'vitest'
import { docInviteRedemptionRepo } from '../src/db/repos/docInviteRedemptionRepo.js'
import type { Tx } from '../src/db/pool.js'

describe('docInviteRedemptionRepo Space-qualified accounting', () => {
  it('treats the same uid in distinct Spaces as distinct redemptions', async () => {
    const redemptions = new Set<string>()
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      const [inviteToken, uid, principalSpaceId] = params as string[]
      const key = `${inviteToken}:${uid}:${principalSpaceId}`
      if (sql.startsWith('SELECT')) return redemptions.has(key) ? [{ one: 1 }] : []
      if (sql.startsWith('INSERT')) {
        redemptions.add(key)
        return []
      }
      throw new Error(`unexpected query: ${sql}`)
    })
    const tx = { query } as unknown as Tx

    await docInviteRedemptionRepo.insertTx(tx, 'invite-1', 'uid-1', 'space-a')

    await expect(docInviteRedemptionRepo.existsTx(tx, 'invite-1', 'uid-1', 'space-a')).resolves.toBe(true)
    await expect(docInviteRedemptionRepo.existsTx(tx, 'invite-1', 'uid-1', 'space-b')).resolves.toBe(false)

    await docInviteRedemptionRepo.insertTx(tx, 'invite-1', 'uid-1', 'space-b')
    await expect(docInviteRedemptionRepo.existsTx(tx, 'invite-1', 'uid-1', 'space-b')).resolves.toBe(true)

    expect(redemptions).toEqual(new Set([
      'invite-1:uid-1:space-a',
      'invite-1:uid-1:space-b',
    ]))
  })
})
