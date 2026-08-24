/**
 * Compaction worker: every expensive, synchronous step of a rebuild, off the
 * event loop.
 *
 * WHY A WORKER IS POSSIBLE HERE AND NOWHERE ELSE
 *
 * The collab hot path cannot be moved to a worker: a live Y.Doc is an object
 * graph that only exists in the heap that built it, and handing it across a
 * thread boundary would mean encoding it — the very cost we would be trying to
 * escape.
 *
 * Compaction has no such problem. It is bytes in, bytes out: a persisted state
 * goes in, a rebuilt state and a backup blob come out, and nothing in between
 * needs to be shared with the main thread. That makes it the one place in this
 * service where a worker actually buys something.
 *
 * WHY IT IS NOT OPTIONAL
 *
 * Measured on a document at incident scale (4.16 MB as v2): `Y.applyUpdateV2`
 * alone takes ~4.7 s, and it is SYNCHRONOUS. Running that on the main thread
 * stalls every other request and every liveness probe for its whole duration —
 * the exact failure that took the service down. Not awaiting it does not help:
 * `void somePromise` declines to wait for a result, it does not move work off
 * the thread.
 *
 * EVERYTHING costly belongs here, not just the obvious rebuild. The v2->v1
 * conversion for the backup row is a full decode plus a full re-encode; leaving
 * that behind on the main thread would have kept most of the stall while
 * looking like it had been fixed.
 */
import { parentPort, workerData } from 'node:worker_threads'
import * as Y from 'yjs'
import { rebuildFromValues, isFlatMapOnlyDocument, contentDrift } from './docRebuild.js'

/** What the main thread sends: the persisted state and how it was encoded. */
export interface CompactWorkerInput {
  state: Uint8Array
  encoding: 1 | 2
  /**
   * The encoding the rebuilt state must be written in — i.e. what this build
   * persists (`persistedEncoding()`), NOT unconditionally v2.
   *
   * Compaction rewrites the authoritative row, so it is bound by exactly the
   * same two-phase rollout constraint as `persistence.store`: while the fleet is
   * still in phase 1 a v2 row handed to a not-yet-upgraded instance decodes to
   * an EMPTY document. Compaction's saving comes from shedding tombstones, which
   * is independent of the encoding, so phase 1 still gets the benefit — it just
   * writes the rebuild back as v1.
   */
  writeEncoding: 1 | 2
}

/** What comes back: the bytes to write, or the reason nothing must be written. */
export type CompactWorkerOutput =
  | {
      ok: true
      /** The rebuilt state, encoded in the requested `writeEncoding`. */
      compacted: Uint8Array
      /** The pre-compaction state as v1, for the doc_version backup row. */
      backupV1: Uint8Array
      entries: number
      /** Size of the row as it is stored today, in whatever encoding that is. */
      beforeBytes: number
      /**
       * What this document would occupy in `writeEncoding` WITHOUT being rebuilt.
       *
       * This is the only honest baseline for judging a rebuild, because
       * `compacted` is in `writeEncoding` and the stored row may be in the other
       * one. Comparing across encodings credits the rebuild with the encoding
       * change — worth roughly half the bytes on the documents this feature
       * targets — and makes any saving threshold pass no matter how little the
       * rebuild actually achieved.
       */
      baselineBytes: number
    }
  | { ok: false; reason: string }

/**
 * Decode, verify, rebuild, verify again, re-encode.
 *
 * Exported so the logic is unit-testable without spawning a thread; the worker
 * body below is a thin shell around it.
 *
 * Never throws — a failure is returned as a value, so the parent gets the reason
 * rather than an opaque worker error event.
 */
export function compactState(input: CompactWorkerInput): CompactWorkerOutput {
  const beforeBytes = input.state.length
  try {
    const doc = new Y.Doc()
    if (input.encoding === 2) Y.applyUpdateV2(doc, input.state)
    else Y.applyUpdate(doc, input.state)

    if (!isFlatMapOnlyDocument(doc)) {
      return {
        ok: false,
        reason:
          'it contains list/text or nested collaborative types this rebuild cannot reproduce',
      }
    }

    const { rebuilt, entries } = rebuildFromValues(doc)

    const drift = contentDrift(doc, rebuilt)
    if (drift) return { ok: false, reason: `the rebuild changed content (${drift})` }

    // Encoded in the encoding this build persists, not unconditionally v2: see
    // `writeEncoding` above for why compaction cannot get ahead of the rollout.
    const compacted =
      input.writeEncoding === 2
        ? Y.encodeStateAsUpdateV2(rebuilt)
        : Y.encodeStateAsUpdate(rebuilt)

    // The like-for-like baseline: the same content, in the encoding we are about
    // to write, WITHOUT the rebuild. When the row is already in that encoding
    // this is just its length; otherwise it costs one more encode HERE, on the
    // worker, and buys the only comparison that means anything.
    const baselineBytes =
      input.encoding === input.writeEncoding
        ? input.state.length
        : input.writeEncoding === 2
          ? Y.encodeStateAsUpdateV2(doc).length
          : Y.encodeStateAsUpdate(doc).length

    // A rebuild that did not shrink the document at all means this document is
    // dominated by live content, not by history. Compared in ONE encoding on both
    // sides: against `beforeBytes` a row stored in the other encoding would
    // credit the rebuild with the encoding change and pass this check while
    // achieving nothing.
    //
    // This is only the "did it shrink" floor. The 10% WORTH-IT floor lives in
    // compaction.ts (MIN_SAVING_RATIO), ahead of both the backup and the write,
    // which is the right place for it: this function is pure and its caller is
    // what decides whether a saving justifies a transaction. Do not add a second
    // ratio here — two floors in two files drift apart.
    if (compacted.length >= baselineBytes) {
      return {
        ok: false,
        reason:
          `the rebuild is not smaller (${compacted.length} >= ${baselineBytes} bytes ` +
          `as v${input.writeEncoding})`,
      }
    }

    // doc_version blobs are v1 by contract — the restore path decodes them as
    // v1 — so a v2 row is converted here rather than recorded in a format
    // restore cannot read. Done last: there is no point paying for it on a
    // document we have just decided not to compact.
    const backupV1 =
      input.encoding === 2 ? Y.convertUpdateFormatV2ToV1(input.state) : input.state

    return { ok: true, compacted, backupV1, entries, beforeBytes, baselineBytes }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

// Worker entry. Guarded so importing this module from a test (or from the main
// thread, for `compactState`) does not post on a parentPort that is not there.
if (parentPort) {
  const result = compactState(workerData as CompactWorkerInput)
  parentPort.postMessage(
    result,
    // Hand the buffers over rather than copying multiple megabytes back across
    // the boundary. Both are worker-allocated and exactly sized — EXCEPT the
    // v1-encoded input reused as `backupV1`, which is the caller's buffer and is
    // therefore left to be copied.
    result.ok
      ? [result.compacted.buffer as ArrayBuffer].concat(
          result.backupV1 === (workerData as CompactWorkerInput).state
            ? []
            : [result.backupV1.buffer as ArrayBuffer],
        )
      : [],
  )
}
