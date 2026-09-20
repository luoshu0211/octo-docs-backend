import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ query: vi.fn(), snapshot: vi.fn() }))
vi.mock('../src/db/pool.js', () => ({ transaction: async (fn: (tx: unknown) => unknown) => fn({ query: mock.query }) }))
vi.mock('../src/db/repos/pptLiveSnapshotRepo.js', () => ({ pptLiveSnapshotRepo: { upsertAdvanceTx: mock.snapshot } }))
import { preparePptCollab } from '../src/ppt/collabSession.js'
import { config } from '../src/config/env.js'
const originalLimit = config.ppt.write.maxDocumentBytes
afterEach(() => { config.ppt.write.maxDocumentBytes = originalLimit })
beforeEach(() => { mock.query.mockReset(); mock.snapshot.mockReset() })
describe('one-way draft to collaboration handoff', () => {
  it.each(['escaping', 'layout', 'title'])('rejects post-normalization %s growth before writing a snapshot', async kind => {
    const draft = { title: 'Draft', docId: 'original', slides: [{ id: 's1', elements:
      Array.from({ length: kind === 'layout' ? 20 : 1 }, (_, n) => ({ id: `e${n}`, type: 'text', text: kind === 'escaping' ? '&<>'.repeat(100) : 'x',
        ...(kind === 'title' ? { html: '<p>x</p>' } : {}) })) }] }
    const raw = JSON.stringify(draft)
    config.ppt.write.maxDocumentBytes = Buffer.byteLength(raw) + 1
    expect(Buffer.byteLength(raw)).toBeLessThan(config.ppt.write.maxDocumentBytes)
    mock.query.mockResolvedValueOnce([{ status: 1, permission_epoch: 2, title: kind === 'title' ? 'T'.repeat(512) : draft.title }])
      .mockResolvedValueOnce([]).mockResolvedValueOnce([{ draft_doc: raw }])
    await expect(preparePptCollab('d_1', 2)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE', details: {
      dimension: 'document', documentBytes: expect.any(Number), limit: config.ppt.write.maxDocumentBytes,
    } })
    expect(mock.snapshot).not.toHaveBeenCalled()
    expect(JSON.stringify(draft)).toBe(raw)
  })
  it('accepts an exactly-at-limit normalized deck', async () => {
    const draft = { title: 'Current title', docId: 'original', slides: [{ id: 's1', elements: [{ id: 'e1', type: 'text', text: '<legacy>' }] }] }
    const seed = () => mock.query.mockResolvedValueOnce([{ status: 1, permission_epoch: 2, title: draft.title }])
      .mockResolvedValueOnce([]).mockResolvedValueOnce([{ draft_doc: JSON.stringify(draft) }])
    seed()
    await preparePptCollab('d_1', 2)
    config.ppt.write.maxDocumentBytes = Buffer.byteLength(JSON.stringify(mock.snapshot.mock.calls[0]![3]))
    mock.snapshot.mockClear()
    seed()
    await preparePptCollab('d_1', 2)
    expect(mock.snapshot).toHaveBeenCalledOnce()
  })
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
