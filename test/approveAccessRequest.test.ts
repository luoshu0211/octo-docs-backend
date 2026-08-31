import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ status: 1, role: 0, epoch: 0 }))
const tx = vi.hoisted(() => ({
  query: vi.fn(async () => [{ permission_epoch: state.epoch }]),
  execute: vi.fn(),
}))
vi.mock('../src/db/pool.js', () => ({
  transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    const before = { ...state }
    try { return await fn(tx) } catch (error) { Object.assign(state, before); throw error }
  }),
}))
vi.mock('../src/db/repos/docAccessRequestRepo.js', () => ({
  REQUEST_STATUS_APPROVED: 2,
  docAccessRequestRepo: {
    decideTx: vi.fn(async () => {
      if (state.status !== 1) return false
      state.status = 2
      return true
    }),
  },
}))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  docMemberRepo: {
    getRoleTx: vi.fn(async () => state.role === 0 ? undefined : 'reader'),
    upsertGrantMaxTx: vi.fn(async () => { state.role = 1; return true }),
  },
}))
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: { bumpEpochTx: vi.fn(async () => { state.epoch += 1 }) },
}))
vi.mock('../src/permission/epoch.js', () => ({ refreshAndPublish: vi.fn() }))

import { approveAccessRequest } from '../src/api/services/approveAccessRequest.js'
import { docAccessRequestRepo } from '../src/db/repos/docAccessRequestRepo.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import { refreshAndPublish } from '../src/permission/epoch.js'

const params = {
  docId: 'd1', requestId: 'r1', documentName: 'dn1', ownerUid: 'owner', ownerSpaceId: 'sp1',
  uid: 'human', principalSpaceId: 'sp1', roleNum: 1, decidedBy: 'admin',
  decidedBySpaceId: 'sp-admin', decidedAtUnix: 1_784_073_600,
}

beforeEach(() => {
  state.status = 1; state.role = 0; state.epoch = 0
  vi.mocked(docMemberRepo.upsertGrantMaxTx).mockReset().mockImplementation(async () => { state.role = 1; return true })
  vi.mocked(refreshAndPublish).mockReset()
  tx.query.mockClear()
})

describe('approveAccessRequest atomic primary grant', () => {
  it('rolls the approved CAS back when the requester grant fails, then permits retry', async () => {
    vi.mocked(docMemberRepo.upsertGrantMaxTx).mockRejectedValueOnce(new Error('grant failed'))
    await expect(approveAccessRequest(params)).rejects.toThrow('grant failed')
    expect(state).toEqual({ status: 1, role: 0, epoch: 0 })

    vi.mocked(docMemberRepo.upsertGrantMaxTx).mockImplementationOnce(async () => { state.role = 1; return true })
    await expect(approveAccessRequest(params)).resolves.toMatchObject({ transitioned: true, requesterRole: 'reader' })
    expect(state).toEqual({ status: 2, role: 1, epoch: 1 })
    expect(refreshAndPublish).toHaveBeenCalledTimes(1)
  })

  it('allows only one concurrent approval winner', async () => {
    const [first, second] = await Promise.all([approveAccessRequest(params), approveAccessRequest(params)])
    expect([first.transitioned, second.transitioned].sort()).toEqual([false, true])
    expect(docMemberRepo.upsertGrantMaxTx).toHaveBeenCalledTimes(1)
    expect(state.epoch).toBe(1)
  })

  it('persists the authoritative decider Space + decision time atomically in the CAS', async () => {
    await approveAccessRequest(params)
    expect(docAccessRequestRepo.decideTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: 2,
        decidedBy: 'admin',
        decidedBySpaceId: 'sp-admin',
        decidedAtUnix: 1_784_073_600,
      }),
    )
  })
})
