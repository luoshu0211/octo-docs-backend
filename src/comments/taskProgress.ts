/** Public process metadata only. Never accept tool arguments, output, or model reasoning. */
export const TASK_STATES = ['waiting', 'running', 'finished', 'failed', 'unknown'] as const
export type TaskState = typeof TASK_STATES[number]
export const TASK_ERRORS = ['dispatch_failed', 'delivery_failed', 'permission_denied', 'interrupted'] as const
export interface TaskStep {
  id: string
  tool: string
  state: 'running' | 'finished' | 'failed' | 'unknown'
  startedAt: number
  finishedAt?: number
  durationMs?: number
  exitCode?: number
}
export interface TaskProgress {
  eventCount?: number
  detailsTruncated?: boolean
  attemptId: string
  sequence: number
  state: TaskState
  phase: 'received' | 'model' | 'tool' | 'ended'
  steps: TaskStep[]
  omittedSteps: number
  replyDelivered: boolean
  errorCode?: typeof TASK_ERRORS[number]
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const id = (v: unknown, max = 128): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && /^[a-zA-Z0-9_.:/-]+$/.test(v)
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k))

export function parseTaskProgress(value: unknown): TaskProgress | null {
  if (!record(value) || !keys(value, ['attemptId', 'sequence', 'state', 'phase', 'steps', 'omittedSteps', 'replyDelivered', 'errorCode', 'eventCount', 'detailsTruncated'])) return null
  if ((value.eventCount !== undefined && !integer(value.eventCount, 0, 1000)) ||
      (value.detailsTruncated !== undefined && typeof value.detailsTruncated !== 'boolean')) return null
  if (!id(value.attemptId) || !integer(value.sequence, 1) ||
      !TASK_STATES.includes(value.state as TaskState) ||
      !['received', 'model', 'tool', 'ended'].includes(value.phase as string) ||
      !Array.isArray(value.steps) || value.steps.length > 100 ||
      !integer(value.omittedSteps, 0, 1_000_000) || typeof value.replyDelivered !== 'boolean' ||
      (value.errorCode !== undefined && !TASK_ERRORS.includes(value.errorCode as typeof TASK_ERRORS[number]))) return null
  if (value.state === 'waiting' ? value.phase !== 'received' :
      value.state === 'running' ? !['model', 'tool'].includes(value.phase as string) : value.phase !== 'ended') return null
  const seen = new Set<string>()
  for (const step of value.steps) {
    if (!record(step) || !keys(step, ['id', 'tool', 'state', 'startedAt', 'finishedAt', 'durationMs', 'exitCode']) ||
        !id(step.id) || !id(step.tool, 120) || seen.has(step.id as string) ||
        !['running', 'finished', 'failed', 'unknown'].includes(step.state as string) ||
        !integer(step.startedAt, 0, 8_640_000_000_000_000) ||
        (step.finishedAt !== undefined && (!integer(step.finishedAt, 0, 8_640_000_000_000_000) || step.finishedAt < step.startedAt)) ||
        (step.durationMs !== undefined && !integer(step.durationMs, 0, 7 * 86_400_000)) ||
        (step.exitCode !== undefined && !integer(step.exitCode, -2147483648, 2147483647))) return null
    seen.add(step.id as string)
  }
  return value as unknown as TaskProgress
}

export const isTaskTerminal = (state: TaskState): boolean => state === 'finished' || state === 'failed'

export function acceptTaskProgress(previous: TaskProgress | null, next: TaskProgress): 'accept' | 'duplicate' | 'conflict' {
  if (!previous) return 'accept'
  if (previous.attemptId !== next.attemptId) return 'conflict'
  if (next.sequence <= previous.sequence) return 'duplicate'
  if (previous.eventCount !== undefined && (next.eventCount ?? -1) < previous.eventCount) return 'conflict'
  if (isTaskTerminal(previous.state) || previous.phase === 'ended') return 'conflict'
  if (previous.state === 'running' && next.state === 'waiting') return 'conflict'
  return 'accept'
}
