import { DbPptRelayStore } from './relay/dbStore.js'
import { isRetryableStorageError } from './relay/store.js'
import { SyncState } from './sync/slidesSync.js'
import { opsOfFrame } from './relay/snapshotter.js'
import type { BentoDoc } from './bentoDoc.js'

/** Same bounded, prune-safe snapshot + tail replay as live collaboration. */
export async function readCurrentPpt(docId: string): Promise<{ deck: BentoDoc; revision: number } | null> {
  const store = new DbPptRelayStore()
  for (let attempt = 0; ; attempt++) {
    const replay = await store.openReplay(docId, 0, { pageRows: 128, pageBytes: 256 * 1024 })
    try {
      const snapshot = replay.snapshot
      if (!snapshot) return null
      if (!snapshot.state) throw new Error('PPT live snapshot has no synchronization state')
      const deck = structuredClone(snapshot.doc) as BentoDoc
      const sync = SyncState.fromJSON('@read', snapshot.state)
      for (;;) {
        const page = await replay.nextPage()
        if (!page.length) break
        for (const item of page) {
          if (item.seq > snapshot.coveredSeq) sync.apply(deck, opsOfFrame(item.frame))
        }
      }
      return { deck, revision: replay.highWater }
    } catch (error) {
      if (attempt >= 2 || !isRetryableStorageError(error)) throw error
    } finally { await replay.close() }
  }
}
