import { config } from '../config/env.js'
import { pptDocStateRepo } from '../db/repos/pptDocStateRepo.js'
import { PptApiError } from '../api/ppt/errors.js'
import { inPptRoom, pptRoomEvents } from './roomCoordinator.js'
import { DbPptRelayStore } from './relay/dbStore.js'
import { productionAgedOpDropHandler } from './relay/agedOpDrop.js'
import { PptSnapshotter } from './relay/snapshotter.js'

export class PptRoomCapacityError extends PptApiError {
  constructor() { super('CONFLICT', 'PPT room is full; retry after compaction') }
}
let snapshotter: PptSnapshotter | undefined
const pending = new Set<string>()
const framesSinceSnapshot = new Map<string, number>()

/** Caller holds the room chain, but MUST NOT hold a SQL transaction. */
export async function compactPptRoom(docId: string, force = false): Promise<void> {
  snapshotter ??= new PptSnapshotter(new DbPptRelayStore(), config.ppt.relay.maxBufferedOpLag, productionAgedOpDropHandler)
  await snapshotter.advance(docId, async id => (await pptDocStateRepo.getSource(id))?.draftDoc ?? null,
    { forceUnfreeze: force })
  framesSinceSnapshot.delete(docId)
  pptRoomEvents.emit('compacted', docId)
}

/** A capacity rejection has rolled back every SQL write before compaction.
 * Retrying the entire transaction preserves restore safety versions and receipts. */
export async function withPptCompaction<T extends { frames?: unknown[]; roomBytesAfter?: number }>(docId: string, transaction: () => Promise<T>): Promise<T> {
  let result: T
  try { result = await transaction() } catch (error) {
    if (!(error instanceof PptRoomCapacityError)) throw error
    await compactPptRoom(docId, true)
    result = await transaction()
  }
  const frames = result.frames?.length ?? 0
  if (!frames) return result
  const count = (framesSinceSnapshot.get(docId) ?? 0) + frames
  framesSinceSnapshot.delete(docId)
  framesSinceSnapshot.set(docId, count)
  while (framesSinceSnapshot.size > 4096) framesSinceSnapshot.delete(framesSinceSnapshot.keys().next().value!)
  if (!pending.has(docId) && (count >= 256 || (result.roomBytesAfter ?? 0) >= Math.min(16 * 1024 * 1024, config.ppt.relay.maxRoomFrameBytes / 2))) {
    pending.add(docId)
    // Queue after the current outer room task, never recursively await its lock.
    void inPptRoom(docId, () => compactPptRoom(docId)).catch(error => {
      // eslint-disable-next-line no-console
      console.warn('[ppt] REST compaction failed; will retry', error)
    }).finally(() => pending.delete(docId))
  }
  return result
}
