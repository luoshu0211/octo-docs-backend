import { beforeEach, expect, it, vi } from 'vitest'
vi.mock('../src/db/repos/docMetaRepo.js', () => ({ docMetaRepo: { getByDocId: vi.fn(), getByOctoDocSlug: vi.fn() } }))
vi.mock('../src/db/repos/docCommentTaskRepo.js', () => ({ docCommentTaskRepo: { prepare: vi.fn(), delivery: vi.fn() } }))
vi.mock('../src/api/services/commentEvents.js', () => ({ publishCommentMutation: vi.fn() }))
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { docCommentTaskRepo } from '../src/db/repos/docCommentTaskRepo.js'
import { trackCommentTask } from '../src/api/services/commentTaskTracking.js'
const p = { docId: 'source', commentId: 'opaque', spaceId: 'space' } as never
beforeEach(() => {
  vi.resetAllMocks()
  const meta = { doc_id: 'canonical', status: 1, document_name: 'octo:s:f:canonical' } as never
  vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(meta)
  vi.mocked(docMetaRepo.getByOctoDocSlug).mockResolvedValue(meta)
})
it('prepares the task under the canonical document, preserving opaque comment IDs', async () => {
  await trackCommentTask({ ...p as object, docKind: 'html' } as never, 'bot')
  expect(docMetaRepo.getByOctoDocSlug).toHaveBeenCalledWith('source', 'space')
  expect(docCommentTaskRepo.prepare).toHaveBeenCalledWith(expect.objectContaining({ docId: 'canonical', kind: 'html', commentId: 'opaque', botUid: 'bot' }))
})
it('records transport acceptance and rejection without pretending they are execution', async () => {
  await trackCommentTask(p, 'bot', { kind: 'accepted', replay: false })
  await trackCommentTask(p, 'bot', { kind: 'permanent', reason: 'disabled' })
  expect(vi.mocked(docCommentTaskRepo.delivery).mock.calls.map(c => c[1])).toEqual([true, false])
  expect(docCommentTaskRepo.prepare).not.toHaveBeenCalled()
})
it('does not create tracking for a document that vanished after permission checks', async () => {
  vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(null)
  await expect(trackCommentTask(p, 'bot')).rejects.toThrow('comment_task_document_unavailable')
  expect(docCommentTaskRepo.prepare).not.toHaveBeenCalled()
})
