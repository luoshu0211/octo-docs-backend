import { EventEmitter } from 'node:events'

/** REST edits and local relay writes share the same commit/delivery order. */
const chains = new Map<string, Promise<unknown>>()
export const pptRoomEvents = new EventEmitter()
pptRoomEvents.setMaxListeners(0)

export async function inPptRoom<T>(docId: string, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(docId) ?? Promise.resolve()
  const run = previous.then(task, task)
  chains.set(docId, run)
  try { return await run } finally {
    if (chains.get(docId) === run) chains.delete(docId)
  }
}
