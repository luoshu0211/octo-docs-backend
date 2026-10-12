import type { TaskEvent } from '../../comments/taskEvents.js'
import { createHash } from 'node:crypto'
import { query, transaction } from '../pool.js'
import { acceptTaskProgress, type TaskProgress } from '../../comments/taskProgress.js'

export interface CommentTask {
  taskKey: string
  docId: string
  kind: 'doc' | 'html' | 'ppt'
  commentId: string
  botUid: string
  delivery: 'pending' | 'accepted' | 'failed'
  progress: TaskProgress | null
  updatedAt: Date
}
interface Row {
  task_key: string; doc_id: string; doc_kind: CommentTask['kind']; comment_id: string; bot_uid: string
  delivery: CommentTask['delivery']; progress: string | TaskProgress | null; updated_at_ms: string | number
}
const map = (r: Row): CommentTask => ({
  taskKey: r.task_key, docId: r.doc_id, kind: r.doc_kind, commentId: r.comment_id,
  botUid: r.bot_uid, delivery: r.delivery,
  progress: typeof r.progress === 'string' ? JSON.parse(r.progress) as TaskProgress : r.progress,
  // Convert on MySQL, whose session time zone produced CURRENT_TIMESTAMP.
  // mysql2 otherwise interprets DATETIME in the Node process time zone.
  updatedAt: new Date(Number(r.updated_at_ms)),
})
export const commentTaskKey = (key: string): string => createHash('sha256').update(key).digest('hex')
export const docCommentTaskRepo = {
  async prepare(p: { key: string; docId: string; kind: CommentTask['kind']; commentId: string; botUid: string }): Promise<void> {
    await query(
      'INSERT INTO doc_comment_task (task_key, doc_id, doc_kind, comment_id, bot_uid) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE task_key = task_key',
      [commentTaskKey(p.key), p.docId, p.kind, p.commentId, p.botUid],
    )
  },
  async delivery(key: string, accepted: boolean): Promise<void> {
    // A failed retry cannot overwrite a previously accepted delivery.
    await query("UPDATE doc_comment_task SET delivery = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE task_key = ? AND delivery <> 'accepted'",
      [accepted ? 'accepted' : 'failed', commentTaskKey(key)])
  },
  async get(key: string): Promise<CommentTask | null> {
    const rows = await query<Row>('SELECT *, UNIX_TIMESTAMP(updated_at) * 1000 AS updated_at_ms FROM doc_comment_task WHERE task_key = ?', [commentTaskKey(key)])
    return rows[0] ? map(rows[0]) : null
  },
  async find(docId: string, kind: CommentTask['kind'], commentId: string, botUid: string): Promise<CommentTask | null> {
    const rows = await query<Row>('SELECT *, UNIX_TIMESTAMP(updated_at) * 1000 AS updated_at_ms FROM doc_comment_task WHERE doc_id = ? AND doc_kind = ? AND comment_id = ? AND bot_uid = ?',
      [docId, kind, commentId, botUid])
    return rows[0] ? map(rows[0]) : null
  },
  async events(taskKey: string, attemptId: string, since: number, limit = 100): Promise<TaskEvent[]> {
    // mysql2 encodes numeric execute parameters as doubles; MySQL rejects them in LIMIT.
    const pageSize = Number.isSafeInteger(limit) ? Math.max(1, Math.min(100, limit)) : 100
    const rows = await query<{ event: string | TaskEvent }>(
      `SELECT event FROM doc_comment_task_event WHERE task_key = ? AND attempt_id = ? AND seq > ? ORDER BY seq LIMIT ${pageSize}`,
      [taskKey, attemptId, since],
    )
    return rows.map(row => typeof row.event === 'string' ? JSON.parse(row.event) as TaskEvent : row.event)
  },
  async receive(key: string, docId: string, botUid: string, next: TaskProgress, events: TaskEvent[] = []): Promise<'accept' | 'duplicate' | 'conflict' | 'missing'> {
    return transaction(async tx => {
      const hash = commentTaskKey(key)
      const rows = await tx.query<Row>('SELECT *, UNIX_TIMESTAMP(updated_at) * 1000 AS updated_at_ms FROM doc_comment_task WHERE task_key = ? AND doc_id = ? AND bot_uid = ? FOR UPDATE', [hash, docId, botUid])
      if (!rows[0]) return 'missing'
      const previous = map(rows[0]).progress
      const result = acceptTaskProgress(previous, next)
      if (result === 'conflict') return result
      // Immutable, contiguous events may finish uploading with a duplicate terminal snapshot.
      if (events.length) {
        if (next.eventCount === undefined || events.some(e => e.seq > next.eventCount!)) return 'conflict'
        // A duplicate can backfill only the boundary already persisted with its
        // snapshot; changing the replay's count cannot extend a completed run.
        const eventLimit = result === 'duplicate' ? previous?.eventCount : next.eventCount
        if (eventLimit === undefined || events.some(e => e.seq > eventLimit)) return 'conflict'
        const existing = await tx.query<{ seq: number; event: string | TaskEvent }>(
          'SELECT seq, event FROM doc_comment_task_event WHERE task_key = ? AND attempt_id = ? ORDER BY seq', [hash, next.attemptId])
        const bySeq = new Map(existing.map(row => [row.seq, typeof row.event === 'string' ? JSON.parse(row.event) as TaskEvent : row.event]))
        let last = existing.at(-1)?.seq ?? 0
        const fresh: TaskEvent[] = []
        for (const event of events) {
          const old = bySeq.get(event.seq)
          if (old) {
            if (Object.keys(event).some(k => old[k as keyof TaskEvent] !== event[k as keyof TaskEvent])) return 'conflict'
          } else {
            if (event.seq !== ++last) return 'conflict'
            fresh.push(event)
          }
        }
        for (const event of fresh) await tx.query(
          'INSERT INTO doc_comment_task_event (task_key, attempt_id, seq, event) VALUES (?, ?, ?, ?)',
          [hash, next.attemptId, event.seq, JSON.stringify(event)])
      }
      if (result !== 'accept') return result
      await tx.query('UPDATE doc_comment_task SET progress = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE task_key = ?',
        [JSON.stringify(next), hash])
      return result
    })
  },
}
