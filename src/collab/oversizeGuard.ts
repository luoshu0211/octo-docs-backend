/**
 * Oversize write guard (incident 2026-08-21).
 *
 * PROBLEM. `persistence.store` rejects a document whose encoded state exceeds
 * `config.maxDocBytes`, but that check runs AFTER Hocuspocus has already encoded
 * the whole Y.Doc, and the throw is swallowed by the extension-database hook
 * ("Document stays in memory to avoid data loss"). The document therefore keeps
 * accepting writes it can never persist: it grew 9.06 MB -> 17.47 MB in ~20
 * minutes, each store attempt re-encoding 17 MB on the single JS thread until
 * the liveness probe timed out and the pod was killed. On restart the clients
 * reconnected, re-inflated the doc, and the cycle repeated (23 restarts).
 *
 * FIX. Once a store is rejected for size we remember it here, and
 * `beforeHandleMessage` refuses further collaborative writes to that document
 * (flipping the connection read-only so the client stops retrying). The mark is
 * cleared as soon as a store succeeds, so a document that shrinks below the cap
 * — e.g. after the owner deletes rows — recovers on its own with no operator
 * action.
 *
 * The lookup MUST stay O(1): it is on the hot path of every inbound Yjs update.
 * We deliberately do NOT re-encode the document to measure it here; the size is
 * only ever recorded from a store attempt that had already paid for the encode.
 */

import {
  markOverCapShared,
  recordUnrestoredOverCap,
  sanitizeStateVector,
  type StateVectorMap,
} from './compactionNotice.js'

/** What we remember about a document that failed its size check. */
export interface OversizeMark {
  /** Encoded byte size of the update that was rejected. */
  readonly bytes: number
  /** The cap that was exceeded (`config.maxDocBytes` at rejection time). */
  readonly limit: number
  /** Epoch millis of the most recent rejection, for logging/observability. */
  readonly since: number
}

const oversized = new Map<string, OversizeMark>()

/**
 * Documents this replica has an UNRESOLVED over-cap condition for: a store was
 * rejected for exceeding the cap and NO store has since succeeded.
 *
 * WHY THIS IS SEPARATE FROM `oversized`. `oversized` is the read-only WRITE
 * guard, and it is deliberately dropped on unload (see `clearOversized` and the
 * afterUnloadDocument comment in server.ts) so a reload re-derives it and no
 * slot leaks. But unloading resolves NOTHING about the cap: the oversized
 * content lives in the client's IndexedDB, not in the in-memory doc that just
 * unloaded, and it re-inflates and is rejected again the next time that client
 * connects. So the over-cap CONDITION outlives the loaded document, and this set
 * tracks it across unloads. It is cleared only by `clearOverCapResolved`, which
 * persistence.store calls on the one event that proves the document fits — a
 * successful store.
 *
 * Its sole job is to feed `refreshSharedOverCapMarks`. The shared Redis mark
 * (compactionNotice) has only a fallback TTL, and a client that goes idle
 * (lunch, overnight) stops producing the rejected stores that used to be the
 * only thing refreshing it. Without a refresh the mark lapses while the document
 * is still genuinely over cap, and the next token/join then stamps the
 * cache-stale signal and wipes the only copy of the user's unsaved work
 * (MR98-003). Refreshing from this set — independent of document activity —
 * closes that hole.
 */
const unresolvedOverCap = new Set<string>()

/**
 * Rejected state vectors whose DURABLE record (`recordUnrestoredOverCap`) has
 * NOT yet landed in Redis, keyed by document. The FAST PATH of the MR98-006 fix.
 *
 * THE HOLE THIS STARTED TO CLOSE. The durable, replica-independent marker is the
 * one signal that survives replica death with no heartbeat. It is written by
 * `recordUnrestoredOverCap`, which used to swallow a Redis failure — so a blip
 * at the exact moment of a rejection created NO marker, and nothing could
 * rebuild it: the over-cap frame typically locks the client session, so the
 * first rejection is often the last store and there is no natural retry. The
 * per-replica heartbeat only resurrects the 1h replica field; once the pod is
 * SIGKILLed (23 of them in the 2026-08-21 incident) that field lapses and
 * `isOverCapAnywhere` finds no signal — the token is stamped and the browser
 * deletes its only copy (the MR98-003 data-loss path, reopened on the write
 * failure).
 *
 * So a failed record does not vanish: its state vector is held here (merged
 * per-client-max, exactly as the durable marker merges) and re-run through the
 * SAME atomic RECORD script by the 10-minute over-cap heartbeat and by graceful
 * shutdown, until it lands. On success the entry leaves the queue; a store whose
 * persisted state DOMINATES a pending vector clears it too (so a genuine
 * recovery does not leave a phantom to be resurrected).
 *
 * BUT THIS MAP IS PROCESS MEMORY, AND THAT IS ONLY HALF THE FIX. The proven
 * failure shape of this system is the replica dying (SIGKILL/OOM) DURING the
 * outage window — before Redis recovers. This queue evaporates with the process,
 * so on its own it fixes the "alive retry" blip, not the death. The durable
 * bottom is the DATABASE: `durableStore` (below) persists the rejected vector at
 * rejection time, OUTSIDE replica memory, so a fresh replica can reconcile it
 * into the Redis marker after the pod is gone. This map stays as the fast path
 * (it lands the record on the same tick when Redis is merely blipping), but it is
 * no longer the last line of defence.
 *
 * THE INVARIANT: every rejection is durably recorded (Redis marker or DB-backed
 * retry record) or in flight to become so.
 */
const pendingUnrestored = new Map<string, StateVectorMap>()

/**
 * The durable, replica-independent bottom of the over-cap retry chain (MR98-006).
 *
 * Injected rather than imported so this module stays free of a hard database
 * dependency (it is on the hot path and is unit-tested in isolation), mirroring
 * `announce` above. The production implementation is `overcapUnrestoredRepo`,
 * wired once at startup (index.ts). Left null in tests that do not exercise the
 * durable layer, in which case the in-memory queue and the local write guard
 * still hold — the rejection already enforces locally, so a null store never
 * reads as "resolved".
 *
 * WHY A STORE AND NOT DIRECT REPO CALLS. The port is the seam that lets the
 * regression suite inject a store that SURVIVES simulated process loss (the DB
 * double is not cleared by `resetOversizedForTest`), which is exactly the
 * replica-death case the in-memory queue could not cover.
 */
export interface UnrestoredDurableStore {
  /** Merge a rejected state vector into the durable record (per-client-max). Rejects on DB failure. */
  put(documentName: string, sv: StateVectorMap): Promise<void>
  /** Every pending durable record, for reconciliation into the Redis marker. */
  list(): Promise<Array<{ documentName: string; stateVector: StateVectorMap }>>
  /** Remove ONLY what was just recorded to Redis (a concurrent rejection's delta stays). */
  removeRecorded(documentName: string, recorded: StateVectorMap): Promise<void>
  /** Remove the record when a persisted state vector dominates it; else keep (fail closed). */
  removeIfDominated(documentName: string, persisted: StateVectorMap): Promise<void>
}

let durableStore: UnrestoredDurableStore | null = null

/** Wire the durable retry store once, at startup. Null disables the durable layer. */
export function setUnrestoredDurableStore(store: UnrestoredDurableStore | null): void {
  durableStore = store
}

/**
 * Has THIS process completed one full reconcile of the durable store into Redis?
 *
 * WHY CACHE INVALIDATION HANGS OFF THIS (MR98-010). The two interlocks that guard
 * cache deletion — `getOversized` (this replica's memory) and `isOverCapAnywhere`
 * (Redis) — cannot see a rejection that is sitting ONLY in `overcap_unrestored`.
 * That is exactly the state a replica death leaves behind, and replica death is
 * not hypothetical: the 2026-08-21 incident had 23 exitCode-137 restarts. Until
 * those rows are mirrored into Redis, a HEALTHY Redis with no marker reads as
 * "this document is fine" — and the arriving client is handed a `compactedAt`
 * that tells it to delete the only copy of the very edits the dead replica
 * refused to store.
 *
 * So the startup reconcile is not an optimisation to retry whenever: until it has
 * succeeded ONCE, this process cannot answer "is this document over cap" and must
 * not license any cache deletion.
 */
let durableReconcileSettled = false

/**
 * Whether this process may issue cache-invalidation signals — the collab-token
 * `compactedAt` and the `doc.cache-stale` frame.
 *
 * With NO durable store wired there is nothing that could be un-mirrored, so the
 * answer is true; otherwise a deployment that never enables the durable layer
 * would lose compaction-notice entirely.
 *
 * WHY THIS IS NOT JUST `durableReconcileSettled` (MR98-011). The startup flag is
 * ONE-SHOT: once a pass succeeds it stays true for the life of the process, and
 * nothing re-arms it. But un-mirrored rows are not a startup-only condition —
 * they are created at any time, by the ordinary rejection path:
 *
 *   markOversized -> rememberUnrestored -> persistDurableUnrestored   (DB row written)
 *   markOverCapShared                                                  (Redis marker FAILS, outage)
 *
 * During the outage `isOverCapAnywhere` fails closed on Redis errors, so siblings
 * are covered. The hole opens the INSTANT Redis RECOVERS: the marker is still
 * un-drained (the drain is heartbeat-only), so a sibling that reconciled at
 * startup passes the one-shot gate, reads a healthy marker-less Redis, and hands
 * out a `compactedAt` for a document whose only copy of the refused edits is in
 * a browser cache. Same consequence class as MR98-010, recurring forever.
 *
 * So the question the gate must answer is not "did startup go well" but "is
 * there, RIGHT NOW, a durable row that Redis has not been told about". That is
 * `durablePendingCount()` below — the count of rows this process knows are
 * written-but-unmirrored, maintained at both ends of their lifetime.
 */
export function mayInvalidateClientCaches(): boolean {
  return (
    durableStore === null ||
    (durableReconcileSettled && durablePendingCount() === 0 && !redisFailureObserved)
  )
}

/**
 * Has this process OBSERVED a Redis failure since its last full reconcile?
 *
 * WHY THIS EXISTS ON TOP OF `durablePending` (MR98-012). `durablePending` is
 * process-local: it fences rows THIS replica wrote, plus rows Redis refuses
 * during this process's own reconcile. It cannot see a row a SIBLING replica
 * wrote moments ago. That leaves the reviewed path open:
 *
 *   replica A: rejection -> DB row written -> markOverCapShared FAILS (outage)
 *   replica B: already running, settled, zero pending — untouched by the outage
 *   Redis recovers -> B reads a healthy, marker-less Redis -> B hands out
 *   `compactedAt` / `doc.cache-stale` for a document whose only copy of the
 *   refused edits lives in a browser cache.
 *
 * B is covered DURING the outage by `isOverCapAnywhere` failing closed. The hole
 * is the window between recovery and B's next heartbeat reconcile (up to 10
 * minutes), and the reason B walks into it is that B believes its own view is
 * complete while a sibling's row exists that B has never read.
 *
 * The observation that closes the COMMON case (a global Redis outage, where
 * every replica sees the failure) needs no cluster state: B saw the same Redis
 * failures A saw — its own `isOverCapAnywhere` catch, its own `markOverCapShared`
 * write failures. A replica that has seen Redis fail can no longer claim its view
 * of the durable rows is complete, so it re-arms the gate and withholds cache
 * invalidation until it has re-read the store end-to-end and mirrored everything.
 *
 * SCOPE, STATED PLAINLY. This closes the common case (shared outage). An
 * ASYMMETRIC partition — A cannot reach Redis, B can, throughout — leaves B
 * with nothing to observe, and B stays exposed until its next heartbeat
 * reconcile. Closing that fully needs a cluster-visible generation counter, which
 * is NOT claimed here.
 */
let redisFailureObserved = false

/**
 * Report a Redis failure seen anywhere in the over-cap path.
 *
 * Called from `compactionNotice`'s two observation points (the `isOverCapAnywhere`
 * catch and a failed `markOverCapShared` write). Deliberately cheap and
 * synchronous: it is called from inside catch blocks that must never throw.
 */
export function noteRedisFailureObserved(): void {
  redisFailureObserved = true
}

/** Test seam: has a Redis failure been observed since the last full reconcile? */
export function redisFailureObservedForTest(): boolean {
  return redisFailureObserved
}

/**
 * Documents with a durable row written by THIS process that is not yet known to
 * be mirrored into Redis.
 *
 * WHY A SET AND NOT A DB COUNT. The decision sits on the token hot path; a query
 * per token issue is not affordable, and a query that fails would have to fail
 * closed and take the feature down on any DB blip. This is a process-local
 * ledger of what this replica itself put in the un-mirrored state.
 *
 * SCOPE, STATED PLAINLY: this closes the window for the replica that WROTE the
 * row and for any replica that has not yet completed a reconcile. A row written
 * by a DIFFERENT already-running replica is still invisible here until this
 * process's next heartbeat reconcile — narrowing that further needs a
 * cluster-visible generation counter, which is a bigger change than this fix and
 * is NOT claimed here. What this does remove is the permanent, self-inflicted
 * blindness of a gate that could never re-close.
 */
const durablePending = new Set<string>()

function durablePendingCount(): number {
  return durablePending.size
}

/** Test seam: how many durable rows this process considers un-mirrored. */
export function durablePendingCountForTest(): number {
  return durablePendingCount()
}

/** Test seam: put the process back in its pre-reconcile state. */
export function resetDurableReconcileForTest(): void {
  durableReconcileSettled = false
  durablePending.clear()
  redisFailureObserved = false
}

/**
 * Hard bound on the retry queue, so a sustained Redis outage across many
 * distinct over-cap documents cannot grow it without limit. In steady state the
 * queue is near-empty (entries leave the instant their record lands), so this is
 * a memory backstop, not an operating size.
 *
 * FAIL-CLOSED ON OVERFLOW. When the queue is full an existing entry is NEVER
 * evicted to admit a new document: each one is an over-cap condition not yet
 * proven durable, and dropping it is precisely the data-loss direction MR98-006
 * is about (oldest-wins is not acceptable here). Entries only ever leave on a
 * durable record or a dominating resolve. If a genuinely new document cannot be
 * queued, `rememberUnrestored` logs loudly and the document keeps its
 * replica-local enforcement (the write guard and the per-replica heartbeat) —
 * it loses only the cross-death durable retry, and that loss is made visible.
 */
let maxPendingUnrestored = 10_000

/**
 * Stateless frame announcing that a document is over the persistence cap.
 *
 * WHY A STATELESS FRAME AND NOT A CLOSE CODE. The obvious design — throw an
 * error carrying WS 1009 from `beforeHandleMessage` and let the client read
 * `event.code` — cannot work, and this was proven on the running stack rather
 * than argued: Hocuspocus's `Connection.close()` does NOT close the socket. It
 * removes the connection from the document and sends an in-band application
 * CLOSE message carrying `reason` only, because one socket multiplexes several
 * documents and closing it would take the others down. So `code` never reaches
 * the browser: the same connection was observed being "closed" three times and
 * receiving messages in between. @hocuspocus/provider's `shouldConnect = false`
 * branch keys off `event.code`, so it never fires either.
 *
 * The stateless channel is the mechanism the client already listens on for
 * out-of-band document state (see statelessRole.ts / `provider.on('stateless')`),
 * it survives the multiplexing because it is addressed per document, and it can
 * be sent the moment the FIRST store is rejected — before any further write
 * arrives. A reason-string sniff could only fire on the NEXT write attempt, and
 * by then the connection semantics are already broken.
 */
export const OVERSIZE_FRAME_TYPE = 'doc.over-size-cap'

/** The wire shape broadcast to clients. `type` is matched literally. */
export interface OversizeFrame {
  type: typeof OVERSIZE_FRAME_TYPE
  bytes: number
  limit: number
}

/** Serialise the frame. Kept here so both sender and tests agree on one shape. */
export function oversizeFramePayload(mark: OversizeMark): string {
  const frame: OversizeFrame = {
    type: OVERSIZE_FRAME_TYPE,
    bytes: mark.bytes,
    limit: mark.limit,
  }
  return JSON.stringify(frame)
}

/**
 * How the guard reaches connected clients.
 *
 * Injected rather than imported because `server.ts` already imports this module
 * (and `persistence.ts`): importing it back would close a cycle. Left null in
 * tests that do not care, so nothing is announced.
 */
type Announce = (documentName: string, payload: string) => void
let announce: Announce | null = null

/** Wire the notifier once, at server construction. */
export function setOversizeAnnouncer(fn: Announce | null): void {
  announce = fn
}

/**
 * Tell ONE arriving connection that the document it just opened is already over
 * the cap, if it is. Returns whether a notice was sent (for tests / logging).
 *
 * `markOversized`'s broadcast only reaches whoever was connected at rejection
 * time. Without this, a client that opens the document afterwards gets a normal,
 * editable surface whose every edit is silently unpersistable — exactly the
 * state in which the incident document kept accumulating writes nobody could
 * save. Extracted from the `connected` hook so it is testable without standing
 * up a real Hocuspocus server.
 */
export function noticeOversizeOnJoin(
  documentName: string,
  send: (payload: string) => void,
): boolean {
  const mark = oversized.get(documentName)
  if (!mark) return false
  send(oversizeFramePayload(mark))
  return true
}

/**
 * Record that `documentName` could not be persisted because it exceeds `limit`,
 * and TELL the clients editing it.
 *
 * Called from `persistence.store` on the size-cap branch, i.e. only after an
 * encode that already happened — the mark itself adds no work.
 *
 * `rejectedStateVector`, when supplied, is the flattened state vector of the
 * document that was just rejected. It is mirrored to the DURABLE unrestored
 * over-cap marker so a later store can only clear the interlock by proving it
 * carries that exact state (see `recordUnrestoredOverCap`). Callers that have no
 * document to hand (unit tests exercising the write guard alone) omit it, in
 * which case only the replica-scoped mark and the local guard are set.
 *
 * The announcement fires on every rejected store, not only the first. That is
 * deliberate: a client that connected after the first rejection has to learn
 * about it too, and the frame is a few dozen bytes against a store attempt that
 * just encoded megabytes. Announcement failure must never mask the size error
 * the caller is about to throw, so it is swallowed here.
 */
export function markOversized(
  documentName: string,
  bytes: number,
  limit: number,
  rejectedStateVector?: StateVectorMap,
): void {
  const mark: OversizeMark = { bytes, limit, since: Date.now() }
  oversized.set(documentName, mark)
  // Also record the durable over-cap CONDITION. Unlike the map above (dropped on
  // unload), this persists until a store succeeds, so the heartbeat keeps the
  // shared mark alive across an idle client and an unload. See `unresolvedOverCap`.
  unresolvedOverCap.add(documentName)
  // Mirror to Redis so the OTHER replicas know too. Only this replica's store
  // was rejected, but the document is over the cap everywhere — and a replica
  // that does not know that will happily tell an arriving client to wipe the
  // IndexedDB copy holding its unsaved work. See compactionNotice
  // `isOverCapAnywhere`. Fire-and-forget and never-throwing: enforcement on
  // THIS replica is already done above and must not depend on Redis.
  void markOverCapShared(documentName)
  // Bind the durable, replica-independent interlock to the state that was
  // actually rejected. This is what outlives replica death and refuses to be
  // dissolved by an unrelated store (MR98-003 residual / MR98-004). Routed
  // through BOTH layers of the retry chain (MR98-006): the DATABASE (written at
  // rejection time so the rejected vector survives a pod that dies before Redis
  // recovers) and the in-memory queue + Redis fast path. A Redis blip at the
  // moment of rejection can no longer silently drop the record.
  if (rejectedStateVector) rememberUnrestored(documentName, rejectedStateVector)
  try {
    announce?.(documentName, oversizeFramePayload(mark))
  } catch {
    // Best-effort: the caller's size rejection is the important signal.
  }
}

/**
 * Merge a rejected state vector into the retry queue and attempt its durable
 * record straight away, through BOTH layers of MR98-006:
 *   - the DATABASE (`durableStore`), written at rejection time so the rejected
 *     vector outlives this replica even if the pod dies before Redis recovers;
 *   - the in-memory queue + Redis fast path, which lands the record on the same
 *     tick when Redis is merely blipping.
 * Never throws — enforcement on this replica is already done by the caller.
 */
function rememberUnrestored(documentName: string, rejected: StateVectorMap): void {
  const clean = sanitizeStateVector(rejected)
  if (Object.keys(clean).length === 0) return
  // Durable bottom FIRST-CLASS: write the rejected vector to the database at
  // rejection time, not only at drain time. This is what survives replica death
  // during the outage window. Fire-and-forget (the caller is about to throw its
  // size error) but loud and fail-closed on failure — see `persistDurableUnrestored`.
  void persistDurableUnrestored(documentName, clean)
  const existing = pendingUnrestored.get(documentName)
  if (existing) {
    // Per-client-max merge, identical to the durable marker's own merge, so a
    // lower clock from a re-rejection can never lower a floor already queued.
    for (const [client, clock] of Object.entries(clean)) {
      if (clock > (existing[client] ?? 0)) existing[client] = clock
    }
  } else if (pendingUnrestored.size >= maxPendingUnrestored) {
    // Fail closed: do NOT evict a tracked entry to make room (see
    // `maxPendingUnrestored`). The document still enforces locally AND has its
    // durable DB record queued above; surface the lost in-memory fast path rather
    // than dropping someone's protection silently.
    // eslint-disable-next-line no-console
    console.error(
      `[octo-docs] unrestored-over-cap retry queue full (${maxPendingUnrestored}); ` +
        `in-memory retry for ${documentName} refused — local enforcement + durable DB record still hold`,
    )
    return
  } else {
    pendingUnrestored.set(documentName, clean)
  }
  void drainUnrestoredRetry(documentName)
}

/**
 * Persist a rejected state vector to the durable store at rejection time. Loud
 * and FAIL CLOSED: a DB failure here is logged, never swallowed, and never
 * downgrades protection — local enforcement (write guard + per-replica field),
 * the in-memory queue, and the next reconcile all still hold, so the absence of
 * a durable row can never read as "resolved". Never throws (the caller is on the
 * rejection path and is about to throw its own size error).
 */
async function persistDurableUnrestored(documentName: string, sv: StateVectorMap): Promise<void> {
  const store = durableStore
  if (!store) return
  // Fence BEFORE the write, not after. Between here and the await this replica
  // may issue a token; the row is already destined for the DB and the Redis
  // marker is a separate fire-and-forget that may never land. Fencing first
  // means the worst case is withholding an optimisation, and fencing last means
  // the worst case is licensing a delete (MR98-011).
  durablePending.add(documentName)
  try {
    await store.put(documentName, sv)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[octo-docs] durable unrestored-over-cap record for ${documentName} FAILED to persist ` +
        `(local enforcement + in-memory retry still hold; cross-death durability lost until it lands): ` +
        String(err),
    )
    // Deliberately NOT clearing the fence here. A rejected `put` can still have
    // reached the database (a timeout on the response, a commit whose ack was
    // lost), so "the write failed" does not prove "there is no row". The fence
    // is cleared only by evidence that the marker is IN Redis — the reconcile
    // and drain paths below. Cost of being wrong: one withheld notice.
  }
}

/**
 * Attempt the durable record for one queued document through the SAME atomic
 * RECORD script the direct path uses. On success remove ONLY what was recorded:
 * a concurrent rejection may have raised a client's floor during the await, and
 * that delta is not yet durable, so it must stay queued. Never throws.
 */
async function drainUnrestoredRetry(documentName: string): Promise<void> {
  const sv = pendingUnrestored.get(documentName)
  if (!sv) return
  const captured: StateVectorMap = { ...sv }
  const durable = await recordUnrestoredOverCap(documentName, captured)
  if (!durable) return // Redis still refusing: leave it queued for the next drain.
  // The marker is now IN Redis, so `isOverCapAnywhere` can see this document on
  // every replica — the reason the fence existed is gone. Clearing it here (and
  // in the reconcile below) is what lets the gate RE-OPEN after an outage,
  // instead of the process going quiet forever the first time Redis blips.
  durablePending.delete(documentName)
  const current = pendingUnrestored.get(documentName)
  if (!current) return
  let remaining: StateVectorMap | null = null
  for (const [client, clock] of Object.entries(current)) {
    if (clock > (captured[client] ?? 0)) {
      remaining ??= {}
      remaining[client] = clock
    }
  }
  if (remaining) pendingUnrestored.set(documentName, remaining)
  else pendingUnrestored.delete(documentName)
}

/**
 * Drain every queued durable record. Called on each over-cap heartbeat tick
 * (piggybacking the Redis round-trip that already refreshes the replica fields)
 * and once more on graceful shutdown, so a rejection that raced a Redis blip
 * gets a durable record the moment Redis is reachable again. Never throws.
 */
export async function flushUnrestoredRetries(): Promise<void> {
  // Snapshot the keys: a drain mutates the map, and a fresh rejection may add
  // entries mid-flush (those are picked up on the next tick).
  for (const documentName of Array.from(pendingUnrestored.keys())) {
    await drainUnrestoredRetry(documentName)
  }
}

/**
 * Reconcile the DURABLE store into the Redis marker (MR98-006). This is the half
 * the in-memory queue cannot do: a FRESH replica has an empty queue but the
 * database may still hold records a pod left behind when it died during the
 * outage window. Read every durable record, run it through the SAME atomic
 * RECORD script the direct path uses, and remove it from the store ONLY once
 * that record lands — a Redis failure leaves the row for the next pass (fail
 * closed). `removeRecorded` deletes only the part that was recorded, so a
 * rejection that raised a floor mid-reconcile keeps its undurable delta.
 *
 * Runs on startup (a replace-the-dead-pod recovery) and on every over-cap
 * heartbeat tick. Never throws: a store read failure is logged and the next tick
 * retries; recording is idempotent, so re-running against a marker that already
 * exists is a harmless no-op merge.
 */
export async function reconcileDurableUnrestored(): Promise<boolean> {
  const store = durableStore
  if (!store) return true
  let records: Array<{ documentName: string; stateVector: StateVectorMap }>
  try {
    records = await store.list()
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[octo-docs] durable unrestored-over-cap reconcile could not read the store: ${String(err)}`)
    // REPORTED, not swallowed (MR98-010). The caller awaits this precisely to know
    // whether the durable rows are mirrored yet; returning void made that await
    // meaningless and left `mayInvalidateClientCaches` free to license deletions
    // against a Redis that simply has not been told about them.
    return false
  }
  // A pass only counts when EVERY row reached Redis. A row that Redis refused is
  // still invisible to `isOverCapAnywhere`, which is the same hole by another
  // door — so a partial pass must not settle the gate.
  let allMirrored = true
  for (const { documentName, stateVector } of records) {
    const durable = await recordUnrestoredOverCap(documentName, stateVector)
    if (!durable) {
      allMirrored = false
      // Redis refused this row: it is un-mirrored by direct evidence, whoever
      // wrote it. Fence it here too — this is how a row written by a SIBLING
      // replica during an outage becomes visible to this process's gate.
      durablePending.add(documentName)
      continue // Redis still refusing: leave the DB record for the next pass.
    }
    durablePending.delete(documentName)
    try {
      await store.removeRecorded(documentName, stateVector)
    } catch (err) {
      // The Redis marker now carries this vector, so a lingering row only causes a
      // harmless idempotent re-record next tick. Log and move on — this one does
      // NOT un-settle the gate: the protection (the Redis marker) is in place.
      // eslint-disable-next-line no-console
      console.error(
        `[octo-docs] durable unrestored-over-cap reconcile recorded ${documentName} to Redis ` +
          `but could not trim the durable row (harmless; will re-record next tick): ${String(err)}`,
      )
    }
  }
  if (allMirrored) {
    durableReconcileSettled = true
    // A pass that read the store end-to-end AND mirrored every row is exactly the
    // evidence the observed-failure re-arm was waiting for: this process's view is
    // complete again (MR98-012). Cleared only here — not on the read-failure path
    // above, and not on a partial pass, because neither proves the sibling rows
    // this replica has never seen are now mirrored.
    redisFailureObserved = false
  }
  return allMirrored
}

/**
 * Clear a queued durable record when a store PROVES the rejected state is safe:
 * its persisted state vector must DOMINATE the pending one, the same evidence
 * `resolveUnrestoredOverCap` requires of the durable marker. Without this a
 * record that failed to land while Redis was down would be resurrected by the
 * heartbeat AFTER a dominating store already recovered the state — a phantom
 * marker. An undominated store leaves the entry queued (fail closed).
 */
export function resolvePendingUnrestored(documentName: string, persisted: StateVectorMap): void {
  const sv = pendingUnrestored.get(documentName)
  if (!sv) return
  const have = sanitizeStateVector(persisted)
  for (const [client, clock] of Object.entries(sv)) {
    if ((have[client] ?? 0) < clock) return // an undominated floor: keep protecting.
  }
  pendingUnrestored.delete(documentName)
}

/**
 * Clear the DURABLE record when a store proves the rejected state is safe: the
 * same dominance evidence `resolvePendingUnrestored` and `resolveUnrestoredOverCap`
 * require (MR98-006). Without this a record that failed to reach Redis would be
 * resurrected by the reconcile AFTER a dominating store already recovered the
 * state — a phantom durable marker. An undominated store leaves the row standing
 * (fail closed). Never throws: fire-and-forget from `persistence.store`'s success
 * path, and a DB error leaves the row for the reconcile, which keeps protecting.
 */
export async function resolveDurableUnrestored(
  documentName: string,
  persisted: StateVectorMap,
): Promise<void> {
  const store = durableStore
  if (!store) return
  try {
    await store.removeIfDominated(documentName, persisted)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[octo-docs] durable unrestored-over-cap resolve for ${documentName} failed ` +
        `(row kept; the interlock stays armed, which is the safe direction): ${String(err)}`,
    )
  }
}

/**
 * Forget the WRITE-GUARD mark for a document, on the two events that make it
 * stale:
 *   - a store SUCCEEDED (it now fits, so writes must be allowed again), and
 *   - the document was unloaded (a later load re-derives the mark from its own
 *     first store attempt, and leaving the entry would leak for every document
 *     that ever tripped the cap).
 *
 * This touches ONLY the read-only write guard (`oversized`), never the durable
 * over-cap condition (`unresolvedOverCap`). Unloading proves nothing about size,
 * so the shared mark must stay alive across it — that is `clearOverCapResolved`'s
 * job, and only on a successful store.
 */
export function clearOversized(documentName: string): void {
  oversized.delete(documentName)
}

/**
 * End this replica's UNRESOLVED over-cap condition for `documentName`, on the
 * ONE event that proves the document now fits: a successful store.
 *
 * Called from persistence.store's success path, next to `clearOversized` (the
 * write guard) and `clearOverCapShared` (the Redis mark). Kept SEPARATE from
 * `clearOversized` precisely because that one also runs on unload — and unload
 * must NOT stop the heartbeat, because the cap is still unresolved then (the
 * oversized copy is in the client's cache, waiting to re-inflate). Only a store
 * that succeeded is proof, so only this path clears the durable condition.
 */
export function clearOverCapResolved(documentName: string): void {
  unresolvedOverCap.delete(documentName)
}

/**
 * Re-mirror every unresolved over-cap mark to Redis, refreshing its TTL.
 *
 * THE INVARIANT THIS KEEPS. The shared mark is what makes an arriving client's
 * cache-stale decision fail safe across replicas. It carries only a fallback
 * TTL, and before this it was refreshed ONLY by a fresh rejected store — which
 * stops the moment the editing client goes idle and Hocuspocus unloads the
 * document. This runs on a timer independent of document activity, so while THIS
 * replica holds an unresolved over-cap condition the mark cannot lapse, no
 * matter how long the client stays away. Each call re-stamps the field to `now`,
 * refreshing both the key TTL and the per-field staleness `isOverCapAnywhere`
 * reads.
 *
 * Never throws: `markOverCapShared` swallows its own Redis errors, and a missed
 * refresh only shortens the window before the fallback TTL — the safe direction.
 */
export function refreshSharedOverCapMarks(): void {
  for (const documentName of unresolvedOverCap) void markOverCapShared(documentName)
  // Piggyback the durable-record retry on the same tick that already touches
  // Redis for the replica fields (MR98-006): drain any rejected state vector
  // whose durable record has not yet landed. Fire-and-forget; the drain never
  // throws, and an entry that still cannot be written stays queued for next tick.
  void flushUnrestoredRetries()
  // AND reconcile the durable DATABASE store into Redis — the half the in-memory
  // queue cannot cover after a replica died with an undurable record still in it.
  // This is what keeps protection alive across replica death during the outage
  // window: the record persisted to the DB at rejection time is now rebuilt into
  // the Redis marker. Fire-and-forget; never throws.
  void reconcileDurableUnrestored()
}

/**
 * How often the heartbeat re-mirrors unresolved over-cap marks.
 *
 * Must stay comfortably below compactionNotice's `OVER_CAP_TTL_SECONDS` (1h) so
 * a refresh always lands before the mark it is keeping alive can expire, even if
 * the event loop is briefly busy. Ten minutes gives roughly six refreshes of
 * headroom inside every TTL window.
 */
const OVER_CAP_REFRESH_INTERVAL_MS = 10 * 60_000

/**
 * Start the over-cap refresh heartbeat. Returns a function that stops it.
 *
 * Mirrors `startNodeHeartbeat` (compactionCluster.ts): the timer is unref'd so
 * it never holds the process open during shutdown, and it is wired in index.ts
 * next to the node heartbeat. An empty `unresolvedOverCap` makes each tick a
 * no-op, so this is cheap to run unconditionally.
 */
export function startOverCapHeartbeat(): () => void {
  const timer = setInterval(refreshSharedOverCapMarks, OVER_CAP_REFRESH_INTERVAL_MS)
  timer.unref()
  return () => clearInterval(timer)
}

/** The mark for `documentName`, or null when it is within the cap. O(1). */
export function getOversized(documentName: string): OversizeMark | null {
  return oversized.get(documentName) ?? null
}

/** Number of currently-marked documents. Exposed for tests/metrics only. */
export function oversizedCount(): number {
  return oversized.size
}

/** Documents whose durable over-cap record is still queued. Tests/metrics only. */
export function pendingUnrestoredCount(): number {
  return pendingUnrestored.size
}

/** Test-only reset so suites do not leak marks into each other. */
export function resetOversizedForTest(): void {
  oversized.clear()
  unresolvedOverCap.clear()
  pendingUnrestored.clear()
  maxPendingUnrestored = 10_000
}

/** Test seam: shrink the retry-queue bound so overflow behaviour is testable. */
export function setMaxPendingUnrestoredForTest(max: number): void {
  maxPendingUnrestored = max
}

/** The part of a Hocuspocus connection this guard is allowed to touch. */
export interface OversizeEnforceable {
  readOnly: boolean
}

/**
 * Enforce the cap on one inbound message. Returns true when `documentName` is
 * over the cap, having flipped the connection read-only.
 *
 * THIS FUNCTION MUST NEVER THROW, and the caller must never throw on its
 * `true` branch. That is the whole reason it exists as a named function rather
 * than three lines inlined in the hook.
 *
 * Flipping `readOnly` is sufficient enforcement: Hocuspocus short-circuits both
 * write paths on a read-only connection (`messageYjsSyncStep2` and
 * `messageYjsUpdate`), so no byte can be applied and the in-memory document
 * cannot inflate further.
 *
 * Throwing, by contrast, closes the connection — and `beforeHandleMessage` runs
 * on EVERY inbound message, including `messageYjsSyncStep1`, which is the client
 * asking for the document and the only path that sends content back. Measured in
 * production on 2026-08-25 against a capped sheet: the client connected,
 * authenticated, received the over-size-cap frame, sent SyncStep1, and was closed
 * before a single byte of content reached it. 348 closes / 353 reloads in 16 h on
 * one document — the reconnect storm this module exists to stop, recreated by its
 * own guard, with a near-cap decode on the main thread every time round.
 *
 * The user is told by the stateless frame (see `OVERSIZE_FRAME_TYPE`), not by
 * losing their connection.
 */
export function applyOversizeDecision(
  documentName: string,
  connection: OversizeEnforceable,
): boolean {
  const mark = oversized.get(documentName)
  if (!mark) return false
  connection.readOnly = true
  return true
}

/**
 * Rejection carrier for a write to an oversized document.
 *
 * This deliberately does NOT try to carry a WebSocket close code. An earlier
 * version set `code = 1009` (MessageTooBig) on the theory that Hocuspocus reads
 * `.code`/`.reason` off a thrown hook error and closes the socket with them, and
 * that @hocuspocus/provider honours 1009 by setting `shouldConnect = false`.
 * Both halves are true in the source and the combination still does not work:
 * `Connection.close()` sends an in-band application CLOSE message carrying
 * `reason` ONLY — the socket stays open (one socket multiplexes several
 * documents), so no CloseEvent and no `code` ever reaches the browser. Measured:
 * the server "closed" one connection nine times, the client saw zero close
 * frames and kept sending.
 *
 * Telling the user is therefore the stateless frame's job (see
 * `OVERSIZE_FRAME_TYPE`), which is pushed the moment the FIRST store is
 * rejected. This error's remaining job is narrow and purely server-side: refuse
 * the write so the in-memory document cannot keep inflating.
 */
export class DocumentTooLargeError extends Error {
  readonly reason: string

  constructor(documentName: string, bytes: number, limit: number) {
    const reason = `Document Too Large: ${bytes} > ${limit} bytes`
    super(`${reason} (${documentName})`)
    this.name = 'DocumentTooLargeError'
    this.reason = reason
  }
}
