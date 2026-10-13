import { expect, it } from 'vitest'
import { parseTaskEvents } from '../src/comments/taskEvents.js'
const event = { seq: 1, stepId: 'call-1', tool: 'exec', type: 'tool_use', content: '{"command":"date"}', at: 1, truncated: false, redacted: false, failed: false }
it('validates bounded event envelopes and rejects malformed or reordered batches', () => {
  expect(parseTaskEvents([event])).toEqual([event])
  for (const batch of [[{ ...event, token: 'secret' }], [{ ...event, content: 'a'.repeat(4097) }], [{ ...event, seq: 1001 }], [{ ...event, at: Number.MAX_SAFE_INTEGER }], [event, event], Array.from({ length: 11 }, (_, i) => ({ ...event, seq: i + 1 }))]) expect(parseTaskEvents(batch)).toBeNull()
})
