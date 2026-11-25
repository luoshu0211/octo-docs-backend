/**
 * Persistence adapter for @hocuspocus/extension-database (§3.2 / §3.3).
 *
 * Authoritative store is the Y.Doc binary (§3.1). Single-row authoritative
 * merged-state model (§3.3): UPSERT into yjs_document, merge-on-write with a
 * incremental extraction and a background merge, inside SELECT ... FOR UPDATE.
 *
 * store() also writes doc_meta.updated_by from context.user.id (P2-A) in the
 * same transaction.
 */
import * as Y from 'yjs'
import { stateGenerationRepo } from '../db/repos/stateGenerationRepo.js'
import { assertStateGeneration } from './stateGeneration.js'
import { captureDurableSnapshot, recordDurableReceipt, durableReceipt } from './durableReceipt.js'
import { transaction } from '../db/pool.js'
import { yjsDocumentRepo, type StoredYjsState, type YjsEncoding } from '../db/repos/yjsDocumentRepo.js'
import { config } from '../config/env.js'
import { clearOversized, clearOverCapResolved, markOversized, resolvePendingUnrestored, resolveDurableUnrestored } from './oversizeGuard.js'
import { clearOverCapShared, resolveUnrestoredOverCap } from './compactionNotice.js'
import { encodeStorageState, StorageBudgetError } from './storageCodec.js'
import { captureStoreUpdate, recordStoreCheckpoint } from './storeCheckpoint.js'
import { storeWorkerPool } from './storeWorkerPool.js'
import { CapacityLane } from './capacityLane.js'
import { captureDocumentActivitySnapshot, confirmDocumentBodyEdits, snapshotIncludesDocumentEdit } from './documentActivity.js'
import { confirmPersistedDocumentEdits } from '../drive/documentActivity.js'

const storeAdmission = new CapacityLane()

/**
 * An empty Yjs v1 update encodes as two zero bytes (no structs, empty delete
 * set). Y has no exported isEmptyUpdate, so we check the known encoding.
 */
export function isEmptyUpdate(update: Uint8Array): boolean {
  return update.length === 2 && update[0] === 0 && update[1] === 0
}

/**
 * The v2 encoding of an empty update. v2 frames a header before the (empty)
 * struct/delete-set payload, so the v1 two-zero-bytes check does not apply; we
 * derive the constant from Yjs itself rather than hardcoding a byte pattern that
 * a lib0 upgrade could change underneath us.
 */
const EMPTY_UPDATE_V2 = Y.encodeStateAsUpdateV2(new Y.Doc())

/** Whether a v2 update carries no structs and an empty delete set. */
export function isEmptyUpdateV2(update: Uint8Array): boolean {
  if (update.length !== EMPTY_UPDATE_V2.length) return false
  return update.every((b, i) => b === EMPTY_UPDATE_V2[i])
}

export interface StoreContext {
  user?: { id?: string }
}

/**
 * Sentinel uid the read-only openDirectConnection paths pass as `user.id`
 * (readLiveBoard / readLiveSheet / readLiveDocState / readLiveForEdit /
 * resolveAnchorFromLiveDoc). @hocuspocus/server's disconnect() flushes
 * onStoreDocument UNCONDITIONALLY (before the clientsCount gate), so a pure read
 * that opens a direct connection and disconnects would otherwise re-stamp
 * doc_meta.updated_by/updated_at from this sentinel — a read silently rewriting
 * the document's authoritative "last editor". store() therefore skips the
 * doc_meta metadata write for this uid (the Y.Doc row is still upserted, which is
 * idempotent for a read), so ONLY a real editor ever moves updated_by/updated_at.
 */
export const SYSTEM_STORE_UID = 'system'

/**
 * Pure merge-on-write computation (§3.2). Returns the bytes to persist, in the
 * SAME encoding as `liveEncoded` (whatever this build writes — see
 * persistedEncoding.ts), and whether the union fallback path ran (for
 * diagnostics/tests).
 *
 * Direction is critical (P1-D): surplus = diffUpdate(existing, sv(live)).
 * Empty surplus => existing ⊆ live (live is the superset) => persist the live
 * encoding directly. The reverse would misjudge a stale live doc and drop
 * existing's edits.
 *
 * BOTH sides carry their own encoding, and neither may be assumed:
 *   - `existing` because rows convert lazily — a document not written since the
 *     v2 rollout is still v1 on disk, and the two decoders are not
 *     interchangeable (v2 bytes through the v1 decoder yield an EMPTY doc, not
 *     an error), and
 *   - `liveEncoding` because v2 writes are behind a flag during the two-phase
 *     rollout, so the union re-encode must not silently emit v2 while the row is
 *     about to be labelled v1.
 *
 * Unlike the pre-v2 version this takes the LIVE document rather than its encoded
 * bytes: the state vector comes straight off the object, so the normal
 * single-writer path no longer decodes a full copy of the incoming update just
 * to read its state vector (that decode cost ~2.4 s on the 17 MB sheet from the
 * 2026-08-21 incident, on every store attempt).
 */
export function computeFinalState(
  existing: StoredYjsState | null,
  liveDoc: Y.Doc,
  liveEncoded: Uint8Array,
  liveEncoding: YjsEncoding,
  capturedStateVector = Y.encodeStateVector(liveDoc),
): { finalState: Buffer; usedUnion: boolean } {
  if (!existing) {
    return { finalState: Buffer.from(liveEncoded), usedUnion: false }
  }

  const liveStateVector = capturedStateVector
  const surplus =
    existing.encoding === 2
      ? Y.diffUpdateV2(existing.state, liveStateVector)
      : Y.diffUpdate(existing.state, liveStateVector)

  if (existing.encoding === 2 ? isEmptyUpdateV2(surplus) : isEmptyUpdate(surplus)) {
    // existing ⊆ live => union === live; skip the re-encode.
    return { finalState: Buffer.from(liveEncoded), usedUnion: false }
  }

  // Concurrency detected: union-merge fallback so no edit is lost. Each side is
  // applied with ITS OWN decoder, and the result is re-encoded in the encoding
  // this build persists — not unconditionally v2.
  const merged = new Y.Doc()
  try {
    if (liveEncoding === 2) Y.applyUpdateV2(merged, liveEncoded)
    else Y.applyUpdate(merged, liveEncoded)
    if (existing.encoding === 2) Y.applyUpdateV2(merged, existing.state)
    else Y.applyUpdate(merged, existing.state)
    const union = liveEncoding === 2 ? Y.encodeStateAsUpdateV2(merged) : Y.encodeStateAsUpdate(merged)
    return { finalState: Buffer.from(union), usedUnion: true }
  } finally { merged.destroy() }
}

export const persistence = {
  loaded: recordStoreCheckpoint,
  /**
   * fetch(documentName): the persisted state plus the encoder that produced it,
   * or null (§3.2). documentName is the canonical persistence key, not doc_id.
   * The caller MUST decode with the matching decoder — see collabDatabase.ts.
   */
  async fetch(documentName: string): Promise<StoredYjsState | null> {
    return transaction(async tx => {
      const stored = await yjsDocumentRepo.selectForUpdateTx(tx, documentName)
      const generation = await stateGenerationRepo.ensureSheetTx(tx, documentName)
      if (!stored && !generation) return null
      return { ...(stored ?? { state: Y.encodeStateAsUpdateV2(new Y.Doc()), encoding: 2 as const }), generation }
    })
  },

  /**
   * store(documentName, liveDoc, context): persist the full merged state in the
   * encoding this build writes (v1, or v2 once YJS_WRITE_V2 is flipped — see
   * persistedEncoding.ts for the mandatory two-phase rollout). merge-on-write
   * (union) is the correctness fallback; the diffUpdate bypass skips the
   * redundant union re-encode on the normal single-writer path.
   *
   * The default path extracts a delta from the LIVE document; a worker builds
   * and caps the full authoritative snapshot. The synchronous fallback uses
   * the same persisted format. The size cap is
   * therefore measured against what goes to disk, and the three REST pre-flight
   * gates measure the SAME dimension via persistedByteLength — that shared
   * measure is what keeps the "byte-accurate gate" contract true rather than
   * aspirational. Under v2 the sheet from the 2026-08-21 incident encodes to
   * 6,073,851 bytes instead of 18,320,896 as v1, so the same document that could
   * not be saved at all saves normally.
   */
  async store(documentName: string, liveDoc: Y.Doc, context?: StoreContext): Promise<void> {
    // DirectConnection.disconnect awaits this flush but Hocuspocus swallows
    // store-hook errors before unloading. Queue pressure must keep the flush
    // pending; otherwise an accepted REST edit can be acknowledged and lost.
    return storeAdmission.runRetained(() => storeSnapshot(documentName, liveDoc, context))
  },
}

/** Only the admitted save captures buffers and acquires a database row lock. */
async function storeSnapshot(documentName: string, liveDoc: Y.Doc, context?: StoreContext): Promise<void> {
    const background = config.yjsBackgroundStore
    let receipt = captureDurableSnapshot(liveDoc)
    let captured = captureStoreUpdate(documentName, liveDoc, background)
    let activity = captureDocumentActivitySnapshot(liveDoc)
    const { state: incoming, encoding } = captured

    // §9.5 single-document hard size cap: reject oversized writes (a runaway
    // doc would block the event loop in decode/encode under the row lock).
    if (incoming.length > config.maxDocBytes) {
      // Remember the rejection so beforeHandleMessage can refuse further writes
      // instead of letting the document keep growing past a size it can never
      // persist (incident 2026-08-21: 9.06 MB -> 17.47 MB in ~20 min, 23 pod
      // restarts). Without this the throw below is swallowed by the database
      // extension and the client simply retries.
      //
      // Pass the rejected document's state vector so the DURABLE interlock is
      // bound to the state that was actually refused: only a later store that
      // carries this exact state (or an explicit reconcile) may lift it, so an
      // unrelated small store on another connection can no longer dissolve the
      // protection for a client whose edits are still unpersisted (MR98-004).
      markOversized(documentName, incoming.length, config.maxDocBytes, captured.stateMap)
      throw new Error(
        `document ${documentName} exceeds max size ${config.maxDocBytes} bytes (got ${incoming.length})`,
      )
    }

    try {
      if (!background) encodeStorageState(incoming, encoding)
      await transaction(async (tx) => {
        if (background) {
          const existing = await yjsDocumentRepo.selectRawForUpdateTx(tx, documentName)
          assertStateGeneration(liveDoc, await stateGenerationRepo.readTx(tx, documentName))
          const prepare = () => storeWorkerPool.run({
            documentName, existing, update: captured.state, encoding: captured.encoding,
            baseVector: captured.baseVector, targetVector: captured.vector,
            codec: { maxDocBytes: config.maxDocBytes, maxDocStorageBytes: config.maxDocStorageBytes, yjsStorageGzip: config.yjsStorageGzip },
          })
          let result = await prepare()
          if (result.kind === 'needs-full-state') {
            // The durable base was replaced/compacted. Re-capture a FULL update
            // and its matching vector while still holding the same row lock.
            receipt = captureDurableSnapshot(liveDoc)
            captured = captureStoreUpdate(documentName, liveDoc, false)
            activity = captureDocumentActivitySnapshot(liveDoc)
            if (captured.state.length > config.maxDocBytes) {
              throw new StorageBudgetError('decoded', captured.state.length, config.maxDocBytes)
            }
            result = await prepare()
          }
          if (result.kind !== 'stored') throw new Error('Yjs full-state fallback could not prepare a snapshot')
          await yjsDocumentRepo.upsertEncodedStateTx(tx, documentName, result.stored)
        } else {
          // 1. lock + take the latest row (read-modify-write 2nd-layer defense).
          const existing = await yjsDocumentRepo.selectForUpdateTx(tx, documentName)
          assertStateGeneration(liveDoc, await stateGenerationRepo.readTx(tx, documentName))

          // 2. merge-on-write + diffUpdate bypass, in the encoding we are writing.
          const { finalState } = computeFinalState(existing, liveDoc, incoming, encoding, captured.vector)
          encodeStorageState(finalState, encoding)

          // 3. UPSERT single authoritative row, recording the encoding that produced
          //    `finalState` — never a hardcoded 2. A mislabelled row is unreadable
          //    (or worse, silently decodes empty), so the label must come from the
          //    same decision that produced the bytes.
          await yjsDocumentRepo.upsertStateTx(tx, documentName, finalState, encoding)
        }

        // doc_meta.updated_at + updated_by (updated_by from context.user.id, §4.1).
        // A read-only direct connection (SYSTEM_STORE_UID) flushes a store on
        // disconnect but must NEVER be recorded as the last editor: skip the
        // metadata stamp so a GET /scene or a PATCH pre-flight read cannot pollute
        // updated_by/updated_at. Only a real editor's write updates it.
        if (context?.user?.id !== SYSTEM_STORE_UID) {
          await tx.query('UPDATE doc_meta SET updated_at = NOW(3), updated_by = ? WHERE document_name = ?', [
            context?.user?.id ?? null,
            documentName,
          ])
        }
        if (activity) {
          const { edits, snapshot, generation } = activity
          await confirmPersistedDocumentEdits(tx, documentName, edits, proof =>
            snapshotIncludesDocumentEdit(snapshot, generation, proof),
          )
        }
      })
    } catch (error) {
      if (error instanceof StorageBudgetError) {
        markOversized(documentName, error.bytes, error.limit, captured.stateMap)
      }
      throw error
    }

    // Advance only AFTER COMMIT, never after queueing, preparing, or UPSERT.
    recordStoreCheckpoint(documentName, liveDoc, captured.vector)
    if (activity) confirmDocumentBodyEdits(liveDoc, activity.edits)
    recordDurableReceipt(liveDoc, receipt)
    const notification = durableReceipt(liveDoc)
    // A receipt is emitted only after COMMIT, and describes the captured state, never later edits.
    if (notification && 'broadcastStateless' in liveDoc) {
      try {
        (liveDoc as Y.Doc & { broadcastStateless(payload: string): void }).broadcastStateless(notification)
      } catch (error) {
        // Delivery is best-effort. A failed socket must not turn COMMIT into a failed store.
        console.error('[collab-generation] durable receipt delivery failed', error) // eslint-disable-line no-console -- best-effort delivery after COMMIT
      }
    }

    // The document fits again (it may have been marked on an earlier attempt and
    // then shrunk — e.g. the owner deleted rows). Lift the write guard so the
    // recovery needs no operator action.
    clearOversized(documentName)
    // End the durable over-cap condition too, so the heartbeat stops refreshing
    // the shared mark now that a store has PROVEN the document fits. `clearOversized`
    // above only lifts the write guard and also runs on unload, which is exactly
    // why the durable condition needs its own clear on this — the resolving — path.
    clearOverCapResolved(documentName)
    // Clear the cross-replica mark HERE and only here. `clearOversized` is also
    // called on unload (server.ts), but unloading proves nothing about size —
    // dropping the shared mark there would re-open the stale-cache notice for a
    // document that still cannot be persisted, and the next client to connect
    // would be told to wipe the only copy of its unsaved edits. A store that
    // reached this line is the one event that proves the document fits.
    void clearOverCapShared(documentName)
    // Retire the DURABLE unrestored marker only if THIS store actually accounts
    // for the state that was rejected — its state vector must dominate the
    // recorded one. A store that does not (B opening the doc from a persisted
    // row that never held A's over-cap edit, then saving a small change) leaves
    // the marker standing, so the interlock survives until A's bytes genuinely
    // land or the condition is explicitly reconciled (MR98-004). The replica
    // retraction above is not sufficient evidence and never was.
    void resolveUnrestoredOverCap(documentName, captured.stateMap)
    // Same dominance evidence, applied to the IN-MEMORY retry queue (MR98-006):
    // a record that never reached Redis (blip at rejection time) lives only in
    // that queue, so a genuine recovery must clear it there too — otherwise the
    // over-cap heartbeat would resurrect a phantom durable marker after the
    // state was already recovered. Synchronous and local; leaves an undominated
    // entry standing, exactly as `resolveUnrestoredOverCap` leaves the marker.
    resolvePendingUnrestored(documentName, captured.stateMap)
    // And the DURABLE DB record (MR98-006): the record persisted at rejection
    // time outlives replica death, so a dominating recovery must clear it there
    // too, or a later reconcile would rebuild a phantom Redis marker for state
    // that already landed. Fire-and-forget with the SAME dominance evidence; an
    // undominated store leaves the row standing (fail closed).
    void resolveDurableUnrestored(documentName, captured.stateMap)
}
