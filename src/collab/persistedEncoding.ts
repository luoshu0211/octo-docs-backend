/**
 * The single place that decides HOW a Y.Doc is encoded for persistence, and the
 * single place anything is allowed to ask "how many bytes will this cost".
 *
 * WHY THIS FILE EXISTS (review round 2, blocker B3). `persistence.store` moved
 * its size cap onto the v2 encoding (the bytes actually written) while the three
 * REST pre-flight gates — `sizeAfterEdit` (doc body), `measureSheetAfterEdit`
 * (sheet) and `measureBoardAfterEdit` (board) — kept measuring v1. Each of those
 * gates documents itself as byte-exact against the store cap, so the two
 * dimensions silently diverged:
 *
 *   - a document in the band "v1 over cap, v2 under cap" (which includes the
 *     2026-08-21 incident sheet: 18.3 MB v1 vs 6.07 MB v2) persists fine over
 *     collab but 413s on every REST/bot edit, and
 *   - a guard-marked document cannot be shrunk through REST at all, because the
 *     shrink edit is rejected by the v1 gate before any store can succeed —
 *     which makes the documented self-heal ("the mark clears on the next
 *     successful store") unreachable.
 *
 * Fixing that by editing three `Y.encodeStateAsUpdate` call sites would re-open
 * the moment either side changes again. So the encoder choice and the measure
 * live here, together, and everyone imports them:
 *
 *   persistence.store          -> encodeForPersistence (writes these bytes)
 *   sizeAfterEdit              -> persistedByteLength  (measures those bytes)
 *   measureSheetAfterEdit      -> persistedByteLength
 *   measureBoardAfterEdit      -> persistedByteLength
 *
 * TWO-PHASE ROLLOUT (review round 2, blocker B1-critical). v2 writes are behind
 * `YJS_WRITE_V2`, default OFF. The read path (collabDatabase.applyStoredState)
 * dispatches on the row's recorded `encoding` column and is safe to deploy
 * first; only once every instance is running a build that CAN read v2 may the
 * write flag be flipped. Without this, a rolling deploy necessarily hands v2
 * rows to still-running old instances, whose v1 decoder yields an EMPTY document
 * (verified — it does not throw) which the next edit then persists straight over
 * the row: silent, permanent data loss.
 *
 * Deployment order, therefore:
 *   phase 1 — deploy this build fleet-wide with YJS_WRITE_V2 unset (reads v2,
 *             still writes v1: every row stays readable by any older instance)
 *   phase 2 — set YJS_WRITE_V2=true and restart: new writes convert lazily, one
 *             row per successful store
 *   rollback — unset the flag. Rows already written as v2 stay readable by this
 *             build; they are NOT readable by a build older than phase 1, so
 *             phase 1 must be fully rolled out before phase 2 starts.
 */
import * as Y from 'yjs'
import { config } from '../config/env.js'
import type { YjsEncoding } from '../db/repos/yjsDocumentRepo.js'
import { encodeStorageState } from './storageCodec.js'

/** The encoding this process writes. Read side dispatches per row, not on this. */
export function persistedEncoding(): YjsEncoding {
  return config.yjsWriteV2 ? 2 : 1
}

/**
 * Encode the logical Yjs state before the repository's optional storage codec.
 * MAX_DOC_BYTES bounds this decoded representation independently of disk bytes.
 */
export function encodeForPersistence(doc: Y.Doc): { state: Uint8Array; encoding: YjsEncoding } {
  return config.yjsWriteV2
    ? { state: Y.encodeStateAsUpdateV2(doc), encoding: 2 }
    : { state: Y.encodeStateAsUpdate(doc), encoding: 1 }
}

/**
 * Measure the decoded Yjs budget and preflight the independent storage budget.
 */
export function persistedByteLength(doc: Y.Doc): number {
  const { state, encoding } = encodeForPersistence(doc)
  if (state.length <= config.maxDocBytes) encodeStorageState(state, encoding)
  return state.length
}
