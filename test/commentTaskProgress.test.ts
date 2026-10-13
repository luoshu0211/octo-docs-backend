import { describe, expect, it } from 'vitest'
import { acceptTaskProgress, parseTaskProgress, type TaskProgress } from '../src/comments/taskProgress.js'

const snapshot = (overrides: Partial<TaskProgress> = {}): TaskProgress => ({
  attemptId: 'attempt-1', sequence: 1, state: 'waiting', phase: 'received',
  steps: [], omittedSteps: 0, replyDelivered: false, ...overrides,
})

describe('comment process contract', () => {
  it('accepts bounded public tool metadata, including failed calls', () => {
    const value = snapshot({ state: 'running', phase: 'tool', steps: [{
      id: 'call-1', tool: 'exec', state: 'failed', startedAt: 100, finishedAt: 120, durationMs: 20, exitCode: 1,
    }] })
    expect(parseTaskProgress(value)).toEqual(value)
  })
  it.each(['params', 'result', 'error', 'reasoning', 'command'])('rejects raw %s on snapshots and calls', field => {
    expect(parseTaskProgress({ ...snapshot(), [field]: 'private data' })).toBeNull()
    expect(parseTaskProgress(snapshot({ steps: [{ id: 'a', tool: 'exec', state: 'running', startedAt: 1, [field]: 'private data' } as never] }))).toBeNull()
  })
  it('rejects malformed dates, duplicate IDs and oversized call lists', () => {
    const step = { id: 'a', tool: 'exec', state: 'running' as const, startedAt: 1 }
    for (const steps of [[{ ...step, startedAt: Number.MAX_SAFE_INTEGER }], [step, step], Array.from({ length: 101 }, (_, i) => ({ ...step, id: String(i) }))]) {
      expect(parseTaskProgress(snapshot({ steps }))).toBeNull()
    }
  })
  it('rejects contradictory state and phase facts', () => {
    expect(parseTaskProgress(snapshot({ state: 'running' }))).toBeNull()
    expect(parseTaskProgress(snapshot({ state: 'finished', phase: 'model' }))).toBeNull()
  })
  it('keeps monotonic sequence, task attempt and terminal boundaries', () => {
    const running = snapshot({ sequence: 3, state: 'running', phase: 'model' })
    expect(acceptTaskProgress(running, snapshot({ sequence: 2 }))).toBe('duplicate')
    // Only the attempt differs from an otherwise valid forward transition.
    expect(acceptTaskProgress(running, { ...running, sequence: 4 })).toBe('accept')
    expect(acceptTaskProgress(running, { ...running, attemptId: 'other', sequence: 4 })).toBe('conflict')
    expect(acceptTaskProgress(running, snapshot({ sequence: 4 }))).toBe('conflict')
    expect(acceptTaskProgress(running, snapshot({ sequence: 4, state: 'finished', phase: 'ended' }))).toBe('accept')
    for (const state of ['finished', 'failed', 'unknown'] as const) {
      expect(acceptTaskProgress(snapshot({ state, phase: 'ended' }), running)).toBe('conflict')
    }
  })
})
