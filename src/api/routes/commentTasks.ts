import { Router, type Request, type Response } from 'express'
import { requireDocRole } from '../guard.js'
import { documentAsync, documentErrorHandler } from '../services/documentRoute.js'
import { docCommentTaskRepo } from '../../db/repos/docCommentTaskRepo.js'
import { parseTaskEvents } from '../../comments/taskEvents.js'
import { parseTaskProgress } from '../../comments/taskProgress.js'
import { publishCommentMutation } from '../services/commentEvents.js'

export const commentTasksRouter: Router = Router()
commentTasksRouter.get('/:docId/comment-task/events', documentAsync(getCommentTaskEventsHandler))
commentTasksRouter.get('/:docId/comment-task', documentAsync(getCommentTaskHandler))
commentTasksRouter.post('/:docId/comment-task', documentAsync(receiveCommentTaskHandler))
commentTasksRouter.use(documentErrorHandler)

export async function getCommentTaskHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(req, res, req.params.docId!, 'reader')
  if (!guard) return
  const { commentId, botUid, kind = 'doc' } = req.query
  if (typeof commentId !== 'string' || !commentId || commentId.length > 128 ||
      typeof botUid !== 'string' || !botUid || botUid.length > 128 ||
      (kind !== 'doc' && kind !== 'html' && kind !== 'ppt')) {
    res.status(400).json({ error: 'bad_request' }); return
  }
  const task = await docCommentTaskRepo.find(guard.meta.doc_id, kind, commentId, botUid)
  res.json({ task })
}

export async function receiveCommentTaskHandler(req: Request, res: Response): Promise<void> {
  // Human clients can read process evidence, never author it.
  if (req.docSpaceScope?.mode !== 'bot' || !req.botToken || !req.uid) {
    res.status(403).json({ error: 'forbidden' }); return
  }
  const body = req.body as Record<string, unknown> | null
  const key = body?.idempotencyKey
  const progress = parseTaskProgress(body?.progress)
  const events = body?.events === undefined ? [] : parseTaskEvents(body.events)
  if (typeof key !== 'string' || key.length > 1024 || !key || !progress || !events ||
      Object.keys(body!).some(k => k !== 'idempotencyKey' && k !== 'progress' && k !== 'events')) {
    res.status(400).json({ error: 'bad_request' }); return
  }
  const task = await docCommentTaskRepo.get(key)
  if (!task || task.botUid !== req.uid) { res.status(404).json({ error: 'not_found' }); return }
  const guard = await requireDocRole(req, res, task.docId, 'reader')
  if (!guard) return
  const sourceId = task.kind === 'html' ? guard.meta.octo_doc_slug : guard.meta.doc_id
  if (sourceId !== req.params.docId) { res.status(404).json({ error: 'not_found' }); return }
  const outcome = await docCommentTaskRepo.receive(key, task.docId, req.uid, progress, events)
  if (outcome === 'missing') { res.status(404).json({ error: 'not_found' }); return }
  if (outcome === 'conflict') { res.status(409).json({ error: 'stale_task_attempt' }); return }
  if (outcome === 'accept' && progress.phase === 'ended') await publishCommentMutation(guard.meta.document_name, task.docId, undefined, 'updated')
  res.json({ accepted: true })
}

export async function getCommentTaskEventsHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(req, res, req.params.docId!, 'reader')
  if (!guard) return
  const { commentId, botUid, kind = 'doc', since = '0' } = req.query
  if (typeof commentId !== 'string' || !commentId || commentId.length > 128 ||
      typeof botUid !== 'string' || !botUid || botUid.length > 128 ||
      (kind !== 'doc' && kind !== 'html' && kind !== 'ppt') ||
      typeof since !== 'string' || !/^\d{1,4}$/.test(since) || Number(since) > 1000) {
    res.status(400).json({ error: 'bad_request' }); return
  }
  const task = await docCommentTaskRepo.find(guard.meta.doc_id, kind, commentId, botUid)
  const progress = task?.progress
  const available = progress?.eventCount !== undefined
  const events = available && task ? await docCommentTaskRepo.events(task.taskKey, progress!.attemptId, Number(since)) : []
  const cursor = events.at(-1)?.seq ?? Number(since)
  const terminal = progress?.phase === 'ended' || task?.delivery === 'failed'
  res.json({ events, cursor, available, attemptId: progress?.attemptId ?? null,
    expectedCount: progress?.eventCount ?? 0, truncated: progress?.detailsTruncated ?? false,
    terminal, complete: terminal && cursor >= (progress?.eventCount ?? 0) })
}
