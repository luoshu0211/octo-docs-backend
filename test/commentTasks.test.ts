import { beforeEach, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import express from 'express'
vi.mock('../src/api/guard.js', () => ({ requireDocRole: vi.fn() }))
vi.mock('../src/db/repos/docCommentTaskRepo.js', () => ({ docCommentTaskRepo: { get: vi.fn(), find: vi.fn(), events: vi.fn(), receive: vi.fn() } }))
vi.mock('../src/api/services/commentEvents.js', () => ({ publishCommentMutation: vi.fn() }))
import { requireDocRole } from '../src/api/guard.js'
import { docCommentTaskRepo } from '../src/db/repos/docCommentTaskRepo.js'
import { commentTasksRouter, getCommentTaskHandler, getCommentTaskEventsHandler, receiveCommentTaskHandler } from '../src/api/routes/commentTasks.js'
import { publishCommentMutation } from '../src/api/services/commentEvents.js'

const progress = { attemptId: 'a', sequence: 1, state: 'waiting', phase: 'received', steps: [], omittedSteps: 0, replyDelivered: false }
const req = (extra = {}) => ({ uid: 'bot-a', botToken: 'test-only', docSpaceScope: { mode: 'bot', spaceId: 's' }, params: { docId: 'd' }, query: { commentId: 'c', botUid: 'bot-a' }, body: { idempotencyKey: 'key', progress }, ...extra }) as unknown as Request
function res() { return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response }
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(requireDocRole).mockResolvedValue({ meta: { doc_id: 'd', octo_doc_slug: 'html-slug', document_name: 'octo:s:f:d' }, role: 'reader' } as never)
  vi.mocked(docCommentTaskRepo.get).mockResolvedValue({ docId: 'd', botUid: 'bot-a', kind: 'doc' } as never)
  vi.mocked(docCommentTaskRepo.receive).mockResolvedValue('accept')
})
it('allows only a verified Bot to report its own prepared task', async () => {
  for (const extra of [{ uid: 'human', docSpaceScope: { mode: 'human' } }, { botToken: undefined }, { uid: 'bot-b' }]) {
    const response = res()
    await receiveCommentTaskHandler(req(extra), response)
    expect(response.status).toHaveBeenCalledWith(extra.uid === 'bot-b' ? 404 : 403)
  }
  expect(docCommentTaskRepo.receive).not.toHaveBeenCalled()
})
it('checks canonical document access and the exact source path for HTML', async () => {
  vi.mocked(docCommentTaskRepo.get).mockResolvedValue({ docId: 'd', botUid: 'bot-a', kind: 'html' } as never)
  const wrong = res()
  await receiveCommentTaskHandler(req(), wrong)
  expect(wrong.status).toHaveBeenCalledWith(404)
  const correct = res()
  await receiveCommentTaskHandler(req({ params: { docId: 'html-slug' } }), correct)
  expect(requireDocRole).toHaveBeenLastCalledWith(expect.anything(), correct, 'd', 'reader')
  expect(docCommentTaskRepo.receive).toHaveBeenCalledTimes(1)
  expect(correct.json).toHaveBeenCalledWith({ accepted: true })
})
it('does not store or read process details after a failed document guard', async () => {
  vi.mocked(requireDocRole).mockResolvedValue(null)
  await receiveCommentTaskHandler(req(), res())
  await getCommentTaskHandler(req(), res())
  expect(docCommentTaskRepo.receive).not.toHaveBeenCalled()
  expect(docCommentTaskRepo.find).not.toHaveBeenCalled()
})
it('rejects caller supplied identities and raw payload extensions', async () => {
  const response = res()
  await receiveCommentTaskHandler(req({ body: { idempotencyKey: 'key', progress, botUid: 'bot-a' } }), response)
  expect(response.status).toHaveBeenCalledWith(400)
  expect(docCommentTaskRepo.get).not.toHaveBeenCalled()
})
it('accepts duplicate receipts without another broadcast and rejects another attempt', async () => {
  vi.mocked(docCommentTaskRepo.receive).mockResolvedValueOnce('duplicate').mockResolvedValueOnce('conflict')
  const duplicate = res(), conflict = res()
  await receiveCommentTaskHandler(req(), duplicate)
  await receiveCommentTaskHandler(req(), conflict)
  expect(duplicate.json).toHaveBeenCalledWith({ accepted: true })
  expect(conflict.status).toHaveBeenCalledWith(409)
  expect(publishCommentMutation).not.toHaveBeenCalled()
})
it('reads by canonical document, kind, opaque comment ID and Bot identity', async () => {
  await getCommentTaskHandler(req({ query: { kind: 'html', commentId: 'opaque-comment', botUid: 'bot-a' } }), res())
  expect(docCommentTaskRepo.find).toHaveBeenCalledWith('d', 'html', 'opaque-comment', 'bot-a')
})

it('gates event reads by the requested document before looking up task details', async () => {
  vi.mocked(requireDocRole).mockResolvedValue(null)
  await getCommentTaskEventsHandler(req(), res())
  expect(docCommentTaskRepo.find).not.toHaveBeenCalled()
  expect(docCommentTaskRepo.events).not.toHaveBeenCalled()
})
it('reads events only for the server-resolved task and attempt, with an explicit completion boundary', async () => {
  vi.mocked(docCommentTaskRepo.find).mockResolvedValue({ taskKey: 'resolved-key', progress: { attemptId: 'resolved-attempt', eventCount: 1, phase: 'ended' } } as never)
  vi.mocked(docCommentTaskRepo.events).mockResolvedValue([{ seq: 1 }] as never)
  const response = res()
  await getCommentTaskEventsHandler(req(), response)
  expect(docCommentTaskRepo.events).toHaveBeenCalledWith('resolved-key', 'resolved-attempt', 0)
  expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ complete: true, expectedCount: 1, cursor: 1 }))
})
it('rejects invalid event cursors and unknown event fields before writing', async () => {
  const response = res()
  await getCommentTaskEventsHandler(req({ query: { commentId: 'c', botUid: 'bot-a', since: '-1' } }), response)
  expect(response.status).toHaveBeenCalledWith(400)
  await receiveCommentTaskHandler(req({ body: { idempotencyKey: 'key', progress, events: [{ seq: 1, secret: 'private' }] } }), response)
  expect(docCommentTaskRepo.receive).not.toHaveBeenCalled()
})

it('wires event HTTP reads through document access and Bot writes through ownership', async () => {
  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    Object.assign(request, { uid: 'bot-b', botToken: 'test-only', docSpaceScope: { mode: 'bot', spaceId: 's' } }); next()
  })
  app.use('/docs', commentTasksRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    vi.mocked(requireDocRole).mockImplementation(async (_req, response) => { response.status(403).json({ error: 'forbidden' }); return null })
    const denied = await fetch(`${origin}/docs/foreign/comment-task/events?commentId=c&botUid=bot-a`)
    expect(denied.status).toBe(403)
    expect(docCommentTaskRepo.find).not.toHaveBeenCalled()
    expect(docCommentTaskRepo.events).not.toHaveBeenCalled()
    vi.mocked(requireDocRole).mockResolvedValue({ meta: { doc_id: 'canonical' }, role: 'reader' } as never)
    vi.mocked(docCommentTaskRepo.find).mockResolvedValue({ taskKey: 'owned-key', progress: { attemptId: 'owned-attempt', eventCount: 1, phase: 'ended' } } as never)
    vi.mocked(docCommentTaskRepo.events).mockResolvedValue([{ seq: 1 }] as never)
    const allowed = await fetch(`${origin}/docs/alias/comment-task/events?commentId=c&botUid=bot-a&attemptId=foreign&taskKey=foreign`)
    expect(allowed.status).toBe(200)
    expect(await allowed.json()).toMatchObject({ cursor: 1, complete: true })
    expect(docCommentTaskRepo.find).toHaveBeenCalledWith('canonical', 'doc', 'c', 'bot-a')
    expect(docCommentTaskRepo.events).toHaveBeenCalledWith('owned-key', 'owned-attempt', 0)
    vi.mocked(requireDocRole).mockResolvedValue({ meta: { doc_id: 'd' }, role: 'reader' } as never)
    const foreignWrite = await fetch(`${origin}/docs/d/comment-task`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idempotencyKey: 'key', progress, events: [] }) })
    expect(foreignWrite.status).toBe(404)
    expect(docCommentTaskRepo.receive).not.toHaveBeenCalled()
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})
