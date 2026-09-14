import { randomUUID } from 'node:crypto'
import { getRedis, rkey } from '../db/redis.js'
import { pptRoomEvents } from './roomCoordinator.js'
import type { ServerFrame } from './relay/frames.js'

const origin = randomUUID()
export const pptRoomChannel = (): string => rkey('ppt-room-events')

/** Reuse the service's Redis subscriber. Durable edits are recovered from MySQL,
 * never trusted to an ephemeral pub/sub delivery or its arrival order. */
export function receivePptRoomEvent(raw: string): void {
  if (Buffer.byteLength(raw, 'utf8') > 70_000) return
  try {
    const event = JSON.parse(raw)
    if (event.origin === origin || typeof event.docId !== 'string' || !event.docId || event.docId.length > 128) return
    if (event.type === 'changed') pptRoomEvents.emit('refresh', event.docId)
    else if (event.type === 'presence' && event.frame?.ctl === 'presence' &&
      typeof event.frame.uid === 'string' && event.frame.uid.length <= 128 &&
      (event.frame.name === undefined || (typeof event.frame.name === 'string' && event.frame.name.length <= 256))) {
      pptRoomEvents.emit('remote-presence', event.docId, event.frame)
    }
  } catch { /* Ignore malformed internal events. */ }
}

/** Runtime wiring only: importing a service in a unit test must not open Redis. */
export function startPptRoomPublishing(): () => void {
  const publish = (type: string, docId: string, frame?: ServerFrame): void => {
    void getRedis().publish(pptRoomChannel(), JSON.stringify({ origin, type, docId, frame }))
      .catch(() => { /* Active rooms also reconcile from MySQL after a missed event. */ })
  }
  const changed = (docId: string): void => publish('changed', docId)
  const presence = (docId: string, frame: ServerFrame): void => publish('presence', docId, frame)
  pptRoomEvents.on('changed', changed)
  pptRoomEvents.on('compacted', changed)
  pptRoomEvents.on('presence', presence)
  return () => {
    pptRoomEvents.off('changed', changed)
    pptRoomEvents.off('compacted', changed)
    pptRoomEvents.off('presence', presence)
  }
}
