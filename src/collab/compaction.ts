/**
 * History compaction for a single document (incident 2026-08-21).
 *
 * WHY IT IS NEEDED
 *
 * A CRDT's persisted size is dominated by tombstones, not by content: the sheet
 * that took production down carried 103,727 live entries against 1,262,141
 * deleted ones — 4.70 MB of content inside a 17.47 MB document. Yjs cannot
 * garbage-collect those tombstones while their parent lives, so the only way to
 * shed them is to rebuild the document from its current values.
 *
 * WHY THE "NOT LOADED" PRECONDITION IS THE WHOLE DESIGN
 *
 * Rebuilding mints fresh client ids and clocks, which is safe ONLY while nobody
 * holds the old state. A client carrying the pre-compaction document is treated
 * by Yjs as a concurrent branch, and BOTH histories merge back together.
 * Measured on the real document: 9.06 MB -> 3.46 MB compacted -> 6.96 MB after
 * a stale client syncs, with zero content differences. So the bad case costs
 * part of the saving and never correctness — but only because compaction runs
 * when the document is unloaded. A naive "compact any row over N MB" job would
 * hit that case constantly, since it cannot know what is cached in a browser tab.
 *
 * This module therefore refuses unless the document is absent from the server's
 * map, and `autoCompact.ts` drives it from the unload hook, which is precisely
 * the moment that precondition holds.
 *
 * (An earlier reading of the stale-merge as "11.46 MB, worse than before"
 * measured the merged result in the v1 encoding. Under v2 the saving survives,
 * and that correction is what makes this safe to automate rather than run by
 * hand.)
 *
 * WHERE THE WORK HAPPENS
 *
 * Not here. Decode, rebuild, verification and re-encode are seconds of
 * synchronous CPU and all run on a worker thread; this module holds the
 * transaction, the safety checks and the writes. See compactionWorker.ts.
 *
 * WHAT IT DOES NOT DO
 *
 * Nothing is deleted. The pre-compaction state is written to `doc_version`
 * first, so the operation is reversible through the existing restore path.
 */
import { config } from '../config/env.js'
import { transaction } from '../db/pool.js'
import { runCompactionOffThread } from './compactionRunner.js'
import { otherLiveHolders, withCompactionLock } from './compactionCluster.js'
import { markCompacted } from './compactionNotice.js'
import { persistedEncoding } from './persistedEncoding.js'
import { yjsDocumentRepo } from '../db/repos/yjsDocumentRepo.js'
import { docVersionRepo, KIND_AUTO } from '../db/repos/docVersionRepo.js'
import { parseDocumentName } from '../permission/documentName.js'
import { SCHEMA_VERSION } from '../schema/index.js'
import { WB_SCHEMA_VERSION } from '../whiteboard/schema/index.js'
import { getCollabServer } from './server.js'

export interface CompactionResult {
  documentName: string
  beforeBytes: number
  afterBytes: number
  /** Live entries carried over — the content that survives compaction. */
  entries: number
  /** doc_version row holding the pre-compaction state, for rollback. */
  backupVersionId: number
}

export class DocumentLoadedError extends Error {
  constructor(documentName: string, where = 'the document is loaded') {
    super(
      `refusing to compact ${documentName}: ${where}, so a connected ` +
        'client would merge the pre-compaction history straight back in',
    )
    this.name = 'DocumentLoadedError'
  }
}

/**
 * Redis could not answer whether other replicas hold the document.
 *
 * Deliberately NOT folded into DocumentLoadedError: "somebody has it open" is a
 * routine outcome, while "we cannot tell" means the fleet-wide guard is blind
 * and should be visible in the logs.
 */
export class ClusterStateUnknownError extends Error {
  constructor(documentName: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    super(
      `refusing to compact ${documentName}: cannot determine which replicas hold ` +
        `it (${reason}); treating an unreachable Redis as "nobody has it" would ` +
        'authorise a destructive rewrite',
    )
    this.name = 'ClusterStateUnknownError'
  }
}

/**
 * Report a rewrite as worth doing only if it sheds this fraction of the bytes.
 *
 * Lives here, not in autoCompact.ts, because it has to gate the WRITE. Asked
 * after the transaction commits it is only a log line.
 */
const MIN_SAVING_RATIO = 0.1

/**
 * The rebuild worked but was not worth writing.
 *
 * Thrown from inside the transaction, before anything is written, so the backup
 * row and the row rewrite both roll back. `withCompactionLock` releases the lock
 * in its `finally`, so throwing here does not leak it.
 */
export class CompactionNotWorthItError extends Error {
  constructor(documentName: string, savedBytes: number, baselineBytes: number) {
    super(
      `not compacting ${documentName}: the rebuild would free only ${savedBytes} of ` +
        `${baselineBytes} bytes (as v2); this document is dominated by live content, not history`,
    )
    this.name = 'CompactionNotWorthItError'
  }
}

/**
 * Another replica is compacting this document right now.
 *
 * Not a failure. Compaction fires on every unload, so the loser of the race
 * simply stands down and the work still happens — once.
 */
export class CompactionLockedError extends Error {
  constructor(documentName: string) {
    super(`skipping ${documentName}: another replica holds the compaction lock`)
    this.name = 'CompactionLockedError'
  }
}

/** Throw unless `documentName` is absent from this instance's document map. */
function assertNotLoaded(documentName: string): void {
  if (getCollabServer().hocuspocus.documents.has(documentName)) {
    throw new DocumentLoadedError(documentName)
  }
}

/**
 * Throw unless no OTHER live replica holds `documentName` loaded.
 *
 * Fails closed: a Redis error becomes ClusterStateUnknownError rather than an
 * empty holder list.
 */
async function assertNotHeldElsewhere(documentName: string): Promise<void> {
  let holders: string[]
  try {
    holders = await otherLiveHolders(documentName)
  } catch (err) {
    throw new ClusterStateUnknownError(documentName, err)
  }
  if (holders.length > 0) {
    throw new DocumentLoadedError(documentName, `it is loaded on ${holders.join(', ')}`)
  }
}

export { rebuildFromValues, isFlatMapOnlyDocument, contentDrift } from './docRebuild.js'

/**
 * Compact one document. Throws `DocumentLoadedError` unless it is currently
 * unloaded EVERYWHERE, and refuses documents this rebuild cannot reproduce.
 *
 * The unloaded check is made THREE times, and the repetition is the design:
 *
 *  - up front, locally, to fail fast without touching Redis or the database;
 *  - fleet-wide via Redis, because this instance's document map says nothing
 *    about the other replicas (see compactionCluster.ts);
 *  - once more, locally, after the row lock is held. Between the first checks
 *    and the lock a client can connect and Hocuspocus will load the document
 *    from the pre-compaction row — that client would then hold the old history
 *    and merge it straight back in on its first sync, which is the rebound this
 *    whole design exists to avoid. This last check runs inside the transaction,
 *    so if it trips, the backup row and the compacted state roll back together.
 *
 * The whole attempt is wrapped in a fleet-wide lock, so two replicas cannot
 * rebuild the same document concurrently and race each other's writes. Losing
 * that lock is reported as `heldElsewhere` rather than raised: compaction fires
 * on every unload, so there is always a next chance.
 */
export async function compactDocument(documentName: string): Promise<CompactionResult> {
  assertNotLoaded(documentName)
  await assertNotHeldElsewhere(documentName)

  const target = deriveTarget(documentName)
  if (!target) throw new Error(`cannot derive a snapshot target for ${documentName}`)

  const outcome = await withCompactionLock(documentName, async () => {
    // Re-checked under the lock: the holder list is a moment-in-time read, and
    // acquiring the lock is the first point at which no other replica can be
    // starting the same work.
    assertNotLoaded(documentName)
    await assertNotHeldElsewhere(documentName)

    return transaction(async (tx) => {
      const existing = await yjsDocumentRepo.selectForUpdateTx(tx, documentName)
      if (!existing) throw new Error(`document ${documentName} has no persisted state`)

      // Resolved once, inside the transaction, and used for BOTH the encode and
      // the row's encoding label so the two can never disagree.
      const writeEncoding = persistedEncoding()

      // Re-check under the lock: a connection may have arrived while we waited.
      assertNotLoaded(documentName)

      // EVERY expensive step — decode, the flat-map check, the rebuild, the drift
      // check, the re-encode and the v1 conversion for the backup — happens on a
      // worker thread. Together they are several seconds of SYNCHRONOUS CPU
      // (~4.7 s for the decode alone at incident scale), and running them here
      // would stall every request and every liveness probe for the duration: the
      // exact failure this whole change set exists to prevent. Nothing is left on
      // this thread but the bytes and the writes.
      //
      // Not awaiting the work would NOT have been a fix: declining to wait for a
      // promise does not move synchronous work off the thread.
      const worked = await runCompactionOffThread({
        state: existing.state,
        encoding: existing.encoding,
        // Compaction rewrites the authoritative row, so it is bound by the same
        // two-phase rollout as persistence.store: writing v2 while the fleet is
        // still in phase 1 would hand a v2 row to instances that decode it as v1
        // and get an EMPTY document. Shedding tombstones is what compaction is
        // for, and that works in either encoding.
        writeEncoding,
      })
      if (!worked.ok) throw new Error(`refusing to compact ${documentName}: ${worked.reason}`)

      const after = worked.compacted

      // Re-checked here rather than in the worker because the cap is a property of
      // THIS deploy's config, not of the bytes.
      if (after.length > config.maxDocBytes) {
        throw new Error(
          `refusing to compact ${documentName}: the rebuild still exceeds the cap ` +
            `(${after.length} > ${config.maxDocBytes} bytes)`,
        )
      }

      // Is the rebuild worth writing at all?
      //
      // This has to be decided HERE — before the backup row and before the
      // UPSERT — and by throwing rather than returning, so the transaction rolls
      // back and nothing is written. An earlier version asked the same question
      // in autoCompact.ts AFTER compactDocument had committed: it only changed a
      // log line. Measured on a real document, that cost a full worker rebuild,
      // a rewrite of the row and a 0.92 MB doc_version backup to save 36 bytes —
      // and it would have repeated on every single unload, so the feature meant
      // to stop documents bloating was itself an unbounded writer.
      //
      // Both sides of the comparison are in the encoding being written (see
      // baselineBytes): measured against a stored size in the OTHER encoding, a
      // rebuild that achieved nothing still looks like it halved the document.
      const saved = worked.baselineBytes - after.length
      if (saved < worked.baselineBytes * MIN_SAVING_RATIO) {
        throw new CompactionNotWorthItError(documentName, saved, worked.baselineBytes)
      }

      // Back up BEFORE writing, inside the same transaction: a failure past this
      // point rolls the backup back too, so we never end up with a compacted row
      // and no way home.
      const backupVersionId = await docVersionRepo.createTx(tx, {
        docId: target.docId,
        documentName,
        kind: KIND_AUTO,
        state: Buffer.from(worked.backupV1),
        schemaVersion: target.schemaVersion,
        createdBy: 'system',
      })

      // The label must come from the same decision that produced the bytes — a
      // hardcoded 2 here would mislabel a v1 rebuild, and a mislabelled row
      // decodes to an empty document rather than failing loudly.
      await yjsDocumentRepo.upsertStateTx(tx, documentName, Buffer.from(after), writeEncoding)

      return {
        documentName,
        beforeBytes: existing.state.length,
        afterBytes: after.length,
        entries: worked.entries,
        backupVersionId,
      }
    })
  })

  if (!outcome.ran) throw new CompactionLockedError(documentName)

  // The rewrite is committed. Stamp the generation so the next client to open
  // this document is told its IndexedDB copy predates the compaction and must be
  // dropped — without that, the browser syncs the old history straight back and
  // the saving is undone (see compactionNotice.ts for the production capture).
  //
  // AFTER the transaction, never inside it: a stamp left behind by a rolled-back
  // compaction would make every client clear a cache that is still correct, and
  // a cache clear costs whatever that client had not yet synced.
  //
  // Swallowed HERE as well as inside markCompacted. The rewrite is already
  // committed at this point, so anything thrown on this line would turn a
  // compaction that really happened into a reported failure — and autoCompact
  // logs that as `failed`, hiding a row rewrite that did occur. Belt and braces
  // is right for a best-effort side channel guarding a committed transaction.
  await markCompacted(documentName, Date.now()).catch(() => {})

  return outcome.value
}

/**
 * doc_id + schema line for the backup row, mirroring autoSnapshot's derivation:
 * a whiteboard stamps WB_SCHEMA_VERSION, a doc/sheet stamps SCHEMA_VERSION.
 * Returns null for a key neither branch recognises, so the caller refuses rather
 * than writing a snapshot the restore path cannot interpret.
 */
function deriveTarget(documentName: string): { docId: string; schemaVersion: number } | null {
  try {
    const parsed = parseDocumentName(documentName)
    if (parsed.kind === 'document') return { docId: parsed.doc, schemaVersion: SCHEMA_VERSION }
    if (parsed.kind === 'whiteboard') return { docId: parsed.board, schemaVersion: WB_SCHEMA_VERSION }
    return null
  } catch {
    return null
  }
}
