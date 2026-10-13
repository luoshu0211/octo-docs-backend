import { readFile } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closePool, getPool } from '../src/db/pool.js'
import { docCommentTaskRepo as repo } from '../src/db/repos/docCommentTaskRepo.js'
import type { TaskProgress } from '../src/comments/taskProgress.js'

// Opt in only for an isolated database, never the shared local/production database.
describe.skipIf(process.env.COMMENT_TASK_INTEGRATION !== '1')('comment task MySQL persistence', () => {
  const prefix = `test-${Date.now()}`
  const key = `${prefix}:comment:bot`
  const p = (sequence: number, state: TaskProgress['state'] = 'running'): TaskProgress => ({
    attemptId: 'a', sequence, state, phase: state === 'running' ? 'tool' : 'ended', steps: [{ id: 'call-1', tool: 'exec', state: 'finished', startedAt: 1, finishedAt: 2, durationMs: 1 }], omittedSteps: 0, replyDelivered: state === 'finished',
  })
  beforeAll(async () => {
    if (process.env.MYSQL_DATABASE !== 'comment_progress_test') throw new Error('isolated test database required')
    const sql = await readFile(new URL('../migrations/upgrades/2026-10-08-add-doc-comment-task.sql', import.meta.url), 'utf8')
    await getPool().query(sql)
    await getPool().query(sql) // upgrade is safe to reapply
    const eventsSql = await readFile(new URL('../migrations/upgrades/2026-10-08-add-doc-comment-task-event.sql', import.meta.url), 'utf8')
    await getPool().query(eventsSql); await getPool().query(eventsSql)
  })
  afterAll(async () => { await getPool().execute('DELETE e FROM doc_comment_task_event e JOIN doc_comment_task t ON t.task_key = e.task_key WHERE t.doc_id = ?', [prefix]); await getPool().execute('DELETE FROM doc_comment_task WHERE doc_id = ?', [prefix]); await closePool() })
  it('persists preparation, receipt, tool steps and completion across fresh reads', async () => {
    await repo.prepare({ key, docId: prefix, kind: 'doc', commentId: 'c', botUid: 'bot' })
    await repo.prepare({ key, docId: prefix, kind: 'doc', commentId: 'c', botUid: 'bot' })
    expect((await repo.get(key))?.progress).toBeNull()
    await repo.delivery(key, true); await repo.delivery(key, false)
    expect((await repo.get(key))?.delivery).toBe('accepted')
    expect(Math.abs(Date.now() - (await repo.get(key))!.updatedAt.getTime())).toBeLessThan(5000)
    expect(await repo.receive(key, prefix, 'foreign-bot', p(1))).toBe('missing')
    expect(await repo.receive(key, 'foreign-doc', 'bot', p(1))).toBe('missing')
    await Promise.all([repo.receive(key, prefix, 'bot', p(5)), repo.receive(key, prefix, 'bot', p(3)), repo.receive(key, prefix, 'bot', p(4))])
    expect((await repo.get(key))?.progress?.sequence).toBe(5)
    expect(await repo.receive(key, prefix, 'bot', p(6, 'finished'))).toBe('accept')
    const completed = await repo.find(prefix, 'doc', 'c', 'bot')
    expect(completed?.progress).toEqual(p(6, 'finished'))
    expect(await repo.receive(key, prefix, 'bot', p(7))).toBe('conflict')
    expect(await repo.receive(key, prefix, 'bot', p(6, 'finished'))).toBe('duplicate')
    expect((await repo.get(key))?.updatedAt).toEqual(completed?.updatedAt)
  })
  it('persists ordered immutable events through duplicate terminal uploads and cursor readback', async () => {
    const eventKey = key + ':events'
    await repo.prepare({ key: eventKey, docId: prefix, kind: 'doc', commentId: 'events', botUid: 'bot' })
    const ev = (seq: number) => ({ seq, stepId: 'call-1', tool: 'exec', type: 'tool_result' as const, content: 'line ' + seq, at: seq, truncated: false, redacted: false, failed: false })
    const running = { ...p(1), eventCount: 21 }
    expect(await repo.receive(eventKey, prefix, 'bot', running, [ev(2)])).toBe('conflict')
    const batch = Array.from({ length: 10 }, (_, i) => ev(i + 1))
    expect(await repo.receive(eventKey, prefix, 'bot', running, batch)).toBe('accept')
    expect(await repo.receive(eventKey, prefix, 'bot', running, batch)).toBe('duplicate')
    expect(await repo.receive(eventKey, prefix, 'bot', running, [{ ...ev(1), content: 'overwritten' }])).toBe('conflict')
    expect(await repo.receive(eventKey, prefix, 'bot', { ...running, attemptId: 'foreign', sequence: 2 }, [ev(1)])).toBe('conflict')
    expect((await repo.get(eventKey))?.progress).toEqual(running)
    expect(await repo.receive(eventKey, prefix, 'bot', { ...running, attemptId: 'foreign' }, [ev(11)])).toBe('conflict')
    expect(await repo.receive(eventKey, prefix, 'bot', running, Array.from({ length: 10 }, (_, i) => ev(i + 11)))).toBe('duplicate')
    const ended = { ...p(2, 'finished'), eventCount: 21 }
    expect(await repo.receive(eventKey, prefix, 'bot', ended)).toBe('accept')
    expect(await repo.receive(eventKey, prefix, 'bot', ended, [ev(21)])).toBe('duplicate')
    expect(await repo.receive(eventKey, prefix, 'bot', { ...ended, eventCount: 22 }, [ev(22)])).toBe('conflict')
    const stored = (await repo.get(eventKey))!
    expect(stored.progress).toEqual(ended)
    expect(await repo.events(stored.taskKey, 'a', 0, 10)).toEqual(batch)
    expect(await repo.events(stored.taskKey, 'a', 20)).toEqual([ev(21)])
    expect(await repo.events(stored.taskKey, 'foreign', 0)).toEqual([])
  })

})
