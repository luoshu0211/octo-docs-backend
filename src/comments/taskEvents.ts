/** Bounded, public tool transcript. Raw runtime objects never cross this contract. */
export const MAX_TASK_EVENTS = 1000
export const MAX_EVENT_CONTENT = 4096
export interface TaskEvent {
  seq: number
  stepId: string
  tool: string
  type: 'tool_use' | 'tool_result' | 'error'
  content: string
  at: number
  truncated: boolean
  redacted: boolean
  failed: boolean
}
export function parseTaskEvents(value: unknown): TaskEvent[] | null {
  if (!Array.isArray(value) || value.length > 10) return null
  let last = 0
  for (const v of value) {
    if (!v || typeof v !== 'object' || Array.isArray(v) ||
      Object.keys(v).some(k => !['seq', 'stepId', 'tool', 'type', 'content', 'at', 'truncated', 'redacted', 'failed'].includes(k)) ||
      !Number.isSafeInteger(v.seq) || v.seq <= last || v.seq > MAX_TASK_EVENTS ||
      typeof v.stepId !== 'string' || !/^[a-zA-Z0-9_.:/-]{1,128}$/.test(v.stepId) ||
      typeof v.tool !== 'string' || !/^[a-zA-Z0-9_.:/-]{1,120}$/.test(v.tool) ||
      !['tool_use', 'tool_result', 'error'].includes(v.type) ||
      typeof v.content !== 'string' || v.content.length > MAX_EVENT_CONTENT ||
      !Number.isSafeInteger(v.at) || v.at < 0 || v.at > 8_640_000_000_000_000 ||
      typeof v.truncated !== 'boolean' || typeof v.redacted !== 'boolean' || typeof v.failed !== 'boolean') return null
    last = v.seq
  }
  return value as TaskEvent[]
}
