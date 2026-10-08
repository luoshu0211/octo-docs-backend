/**
 * Automatic history compaction, triggered when a document unloads.
 *
 * WHY IT HAS TO EXIST
 *
 * A CRDT only grows. Yjs cannot collect a tombstone while its parent lives, so
 * a long-lived sheet accumulates deletions forever. Persisting as v2 shrinks the
 * bytes but does not change the trend: a document edited hard enough still
 * reaches the cap. Without this, "keep using it" eventually reproduces the
 * 2026-08-21 incident on a slower clock.
 *
 * HOW MUCH v2 ACTUALLY SAVES (measured, because the threshold depends on it)
 *
 * The v2 saving is NOT a constant — it is a function of how much of the document
 * is tombstone rather than live content, because v2's run-length encoding is what
 * collapses tombstone runs. Measured on synthetic documents of known shape:
 *
 *     live-only, no churn      live 40000 / tomb      0   ->  v2/v1 = 0.905
 *     every cell rewritten x20 live  2000 / tomb  38000   ->  v2/v1 = 0.131
 *     6 clients interleaved    live  1500 / tomb 106500   ->  v2/v1 = 0.154
 *
 * And on six real local documents, all of them live-content-dominated:
 * v2/v1 = 0.978 .. 1.000 (i.e. no saving at all).
 *
 * So "v2 halves it" holds only for the history-dominated documents — which are
 * exactly the ones this module targets. A routine sheet is barely affected,
 * which is why a ratio-of-cap threshold has to be set low (see below).
 *
 * WHY UNLOAD IS THE SAFE TRIGGER
 *
 * Compaction rebuilds the document from its current values, which mints fresh
 * client ids. That is only sound while nobody holds the old state — and "the
 * document just unloaded" is exactly that: Hocuspocus unloads after the last
 * connection closes, and the next client loads the compacted state fresh. No
 * scan, no timer, no operator judgement about who might still have a tab open.
 *
 * WHAT IF A STALE CLIENT COMES BACK
 *
 * Measured against the real incident document: a client reconnecting with the
 * pre-compaction state merges both histories, giving
 *
 *     9.06 MB original -> 3.46 MB compacted -> 6.96 MB after the stale merge
 *
 * with ZERO content differences across all 103,680 cells. The bad case costs
 * part of the saving, never correctness, and still lands below where it started;
 * the next unload compacts again. (An earlier reading of this as "11.46 MB,
 * worse than before" measured the merge in the v1 encoding — under v2 the saving
 * survives. That correction is what makes automation defensible.)
 */
import { storageByteLimit } from './storageCodec.js'
import {
  compactDocument,
  ClusterStateUnknownError,
  CompactionLockedError,
  CompactionNotWorthItError,
  DocumentLoadedError,
} from './compaction.js'

/**
 * Compact once a document passes this fraction of the cap.
 *
 * The figure is a fraction of the PERSISTED (v2) size. Because the v2 saving is
 * shape-dependent (see above), the same document reads as a very different number
 * of bytes depending on how much of it is history. The sheet that caused the
 * incident sat at 9.06 MB v1 / 4.85 MB v2: a 0.5 ratio (5 MB of v2) would not
 * have touched it, which is the opposite of the point.
 *
 * 0.25 puts the trigger at 2.5 MB of v2 — comfortably below that document, and
 * still far enough above a routine sheet that the rewrite is worth a transaction.
 */
const COMPACT_ABOVE_RATIO = 0.25

/** Outcome of an unload-triggered attempt, for logging and tests. */
export type AutoCompactOutcome =
  | {
      ran: false
      reason:
        | 'below-threshold'
        | 'reloaded'
        | 'held-elsewhere'
        | 'cluster-unknown'
        | 'not-compactable'
        | 'no-saving'
        | 'failed'
    }
  | { ran: true; beforeBytes: number; afterBytes: number }

export interface AutoCompactDeps {
  /** Persisted size of the document, or null when there is no row. */
  storedBytes(documentName: string): Promise<number | null>
  compact: typeof compactDocument
  log(message: string): void
}

/**
 * Consider compacting `documentName` now that it has unloaded.
 *
 * Never throws. This runs on a teardown path, and a failed optimisation must not
 * take the unload down with it — but every early exit is reported rather than
 * swallowed, so a document that silently never compacts is visible in the logs.
 */
export async function maybeCompactOnUnload(
  documentName: string,
  deps: AutoCompactDeps,
): Promise<AutoCompactOutcome> {
  try {
    const bytes = await deps.storedBytes(documentName)
    if (bytes === null || bytes < storageByteLimit() * COMPACT_ABOVE_RATIO) {
      return { ran: false, reason: 'below-threshold' }
    }

    // The "is it worth it" decision is NOT made here. It used to be, and that
    // was the bug: compactDocument had already committed the rewrite and the
    // backup row by the time this code ran, so the check only changed a log
    // line. It now lives inside compactDocument's transaction and arrives here
    // as CompactionNotWorthItError, with nothing written.
    const result = await deps.compact(documentName)
    const saved = result.beforeBytes - result.afterBytes

    deps.log(
      `compacted ${documentName}: ${result.beforeBytes} -> ${result.afterBytes} bytes ` +
        `(-${Math.round((saved / result.beforeBytes) * 100)}%), backup version ${result.backupVersionId}`,
    )
    return { ran: true, beforeBytes: result.beforeBytes, afterBytes: result.afterBytes }
  } catch (err) {
    // A client reconnected between the unload and the compaction — precisely the
    // race compactDocument refuses. Routine, not an error: the document is in
    // use again and the next unload will try afresh.
    if (err instanceof DocumentLoadedError) return { ran: false, reason: 'reloaded' }

    // The rebuild ran but freed too little to be worth a rewrite, and refused
    // inside the transaction, so nothing was written. Logged rather than silent:
    // a big document that never gets smaller is worth seeing.
    if (err instanceof CompactionNotWorthItError) {
      deps.log(message(err))
      return { ran: false, reason: 'no-saving' }
    }

    // Another replica got there first. Routine under multi-replica: the work
    // still happens, just not here.
    if (err instanceof CompactionLockedError) return { ran: false, reason: 'held-elsewhere' }

    // Redis could not say who holds the document, so the fleet-wide guard is
    // blind and compaction refused. Logged rather than silent: unlike the cases
    // above this is infrastructure being down, and a document that never
    // compacts because Redis has been unreachable for a week should be visible.
    if (err instanceof ClusterStateUnknownError) {
      deps.log(message(err))
      return { ran: false, reason: 'cluster-unknown' }
    }

    // A rich-text body cannot be rebuilt from map values. That is a permanent
    // property of the document, not something to retry loudly on every unload.
    const text = message(err)
    if (text.includes('cannot reproduce')) return { ran: false, reason: 'not-compactable' }

    deps.log(`compaction of ${documentName} failed, leaving it untouched: ${text}`)
    return { ran: false, reason: 'failed' }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
