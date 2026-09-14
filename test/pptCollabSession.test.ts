import { beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ query: vi.fn(), snapshot: vi.fn() }))
vi.mock('../src/db/pool.js', () => ({ transaction: async (fn: (tx: unknown) => unknown) => fn({ query: mock.query }) }))
vi.mock('../src/db/repos/pptLiveSnapshotRepo.js', () => ({ pptLiveSnapshotRepo: { upsertAdvanceTx: mock.snapshot } }))
import { preparePptCollab } from '../src/ppt/collabSession.js'
beforeEach(() => { mock.query.mockReset(); mock.snapshot.mockReset() })
describe('one-way draft to collaboration handoff', () => {
  it('seeds the first snapshot under the metadata lock with the canonical title and renderable legacy text', async () => {
    mock.query.mockResolvedValueOnce([{ status: 1, permission_epoch: 2, title: 'Current title' }])
      .mockResolvedValueOnce([]).mockResolvedValueOnce([{ draft_doc: JSON.stringify({ title: 'Blank', docId: 'original',
        slides: [{ id: 's1', elements: [{ id: 'e1', type: 'text', text: '<legacy>' }] }] }) }])
    await preparePptCollab('d_1', 2)
    expect(mock.query.mock.calls[0][0]).toContain('FOR UPDATE')
    expect(mock.snapshot).toHaveBeenCalledWith(expect.anything(), 'd_1', 0,
      expect.objectContaining({ title: 'Current title', docId: 'original', slides: [expect.objectContaining({
        elements: [expect.objectContaining({ id: 'e1', html: '<p>&lt;legacy&gt;</p>', x: 100 })],
      })] }), expect.objectContaining({ v: 2 }))
  })
  it('never replaces a live snapshot when the editor reconnects', async () => {
    mock.query.mockResolvedValueOnce([{ status: 1, permission_epoch: 2 }]).mockResolvedValueOnce([{ doc_id: 'd_1' }])
    await preparePptCollab('d_1', 2)
    expect(mock.query).toHaveBeenCalledTimes(2)
    expect(mock.snapshot).not.toHaveBeenCalled()
  })
  it.each([{ status: 1, permission_epoch: 3 }, { status: 0, permission_epoch: 2 }])('refuses a changed permission epoch or deleted document', async meta => {
    mock.query.mockResolvedValueOnce([meta])
    await expect(preparePptCollab('d_1', 2)).rejects.toThrow('permissions changed')
    expect(mock.snapshot).not.toHaveBeenCalled()
  })
})
