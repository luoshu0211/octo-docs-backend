/**
 * Telling clients their local cache is stale after a compaction.
 *
 * WHY THIS EXISTS
 *
 * Compaction rewrites the persisted row as a fresh Y.Doc: every value is
 * reinserted under ONE new clientID and the tombstones are gone. Measured on a
 * production sheet 2026-08-25 that was 10,483,063 bytes of which only 3,206
 * structs were live — it compacted to 659,725 bytes, a 94% saving.
 *
 * And then it came straight back. The browser keeps its own copy in IndexedDB
 * (`y-indexeddb`, wired in CollabSheet before the network provider — "local
 * persistence before network"), so the next time that user opens the document
 * their Y.Doc still carries all 856k tombstones and syncs them up. Captured on a
 * single connection against production:
 *
 *     server sends  659,725 bytes   1 clientID    (the compacted row)
 *     client pushes 10,483,130 bytes            <- its IndexedDB copy
 *     document now  10,556,162 bytes  42 clientIDs
 *
 * Yjs cannot dedupe those: the compacted doc's clientID is new, so the old
 * history reads as a different author's work and both survive. The document is
 * back over the cap and nothing was gained.
 *
 * So compaction is only half a feature without this: the server must tell the
 * client to drop its cache and re-fetch. The client already has the machinery
 * (`offline/cache.ts clearDocCache`, used today on a permission revoke).
 *
 * WHY A TIMESTAMP AND NOT A FLAG
 *
 * A boolean "this was compacted" would make every client clear its cache on
 * every open, forever — a full re-download of a multi-MB document each time.
 * The generation stamp lets a client record what it has already handled and
 * ignore the frame until the NEXT compaction.
 *
 * FAILURE DIRECTION: FAIL OPEN, deliberately
 *
 * Unlike the compaction lock (which fails closed), a read failure here returns
 * null and no frame is sent. Clearing a client's cache destroys anything it has
 * not managed to sync, so a Redis blip must never be able to trigger one. Not
 * clearing costs a missed optimisation; clearing wrongly costs a user's work.
 */
import { getRedis, rkey } from '../db/redis.js'
import { mayInvalidateClientCaches, noteRedisFailureObserved } from './oversizeGuard.js'
import { config } from '../config/env.js'

/** Matched literally by the client — keep in sync with the frontend constant. */
export const STALE_CACHE_FRAME_TYPE = 'doc.cache-stale'

/** The wire shape. `compactedAt` is epoch millis. */
export interface StaleCacheFrame {
  type: typeof STALE_CACHE_FRAME_TYPE
  compactedAt: number
}

/**
 * How long a generation stamp is worth keeping.
 *
 * It only needs to outlive the caches it is meant to invalidate. A client that
 * has not opened the document in 30 days will have been served the compacted
 * row on its previous open anyway; and if the key does expire, the cost is a
 * client that keeps a stale cache — the pre-existing behaviour, not a new fault.
 */
const STAMP_TTL_SECONDS = 30 * 24 * 60 * 60

function stampKey(documentName: string): string {
  return rkey('compacted', documentName)
}

/**
 * How long a mirrored oversize mark survives without being refreshed.
 *
 * Deliberately short relative to the compaction stamp: this key SUPPRESSES
 * notices, so a stale one costs a missed cache clear.
 *
 * This TTL is a FALLBACK, not the primary expiry. The primary keep-alive is the
 * over-cap heartbeat (oversizeGuard `startOverCapHeartbeat`), which re-mirrors
 * the mark well within this window for as long as the replica holds an
 * unresolved over-cap condition — so the mark tracks the CONDITION, not the last
 * store attempt. The earlier design leaned on "a document still over the cap is
 * being rejected continuously, so the mark cannot lapse", but that only holds
 * while a client is actively editing: once the client goes idle the rejected
 * stores stop, Hocuspocus unloads the document, and after this TTL the mark
 * would lapse while the document is still genuinely over cap (MR98-003). The TTL
 * now only bounds how long a mark can outlive the replica that set it — after a
 * hard kill there is no heartbeat, and the mark self-heals within this window.
 */
export const OVER_CAP_TTL_SECONDS = 60 * 60

/**
 * Legacy shape of the shared mark: a bare string any replica's successful store
 * could delete. Still WRITTEN and still READ so a mixed-version deployment does
 * not open a window in which a new replica cannot see an old replica's mark —
 * missing that mark is the data-loss direction, so the rollout must not have a
 * gap. It is only DELETED under the divergence guard in `clearOverCapShared`.
 */
function overCapKey(documentName: string): string {
  return rkey('overcap', documentName)
}

/**
 * The mark, per replica.
 *
 * WHY THIS IS NOT A BOOLEAN ANY MORE. `clearOverCapShared` used to `DEL` one
 * shared key after ANY replica's successful store, but the mark means "some
 * replica is holding an oversized, unpersisted document right now" — and a
 * clean replica's successful store does not prove the divergent replica
 * recovered. That divergence is not hypothetical: measured in production
 * 2026-08-25, one replica was logging 10,556,162 bytes and kicking connections
 * while the other served a clean 659,725. The clean replica dissolved the mark;
 * a client then joining the divergent side would be told its cache was stale and
 * would discard the only copy of its unsaved edits — the exact loss this
 * interlock exists to prevent.
 *
 * So the mark is a HASH of `replicaId -> epoch millis`. A replica may only ever
 * retract its OWN field, and the document is over cap anywhere as long as ANY
 * field is still live.
 *
 * WHY EACH FIELD CARRIES A TIMESTAMP. The key's TTL cannot bound a single
 * replica's field: every other replica's `HSET` refreshes the TTL of the whole
 * key, so a field left behind by a pod that was killed mid-incident (which is
 * precisely how the 2026-08-21 incident ended — 23 restarts) would otherwise
 * suppress notices forever. A field older than `OVER_CAP_TTL_SECONDS` is
 * therefore read as absent, exactly as the old key's expiry behaved.
 */
function overCapReplicasKey(documentName: string): string {
  return rkey('overcap-replicas', documentName)
}

/**
 * Identity of THIS process inside the deployment.
 *
 * `HOSTNAME` is the pod name under Kubernetes, so it is already unique per
 * replica; the pid is appended so two processes sharing a host during local
 * development (or a sidecar) do not silently retract each other's marks — which
 * is the whole failure this field exists to prevent.
 */
const REPLICA_ID = `${config.hostname}:${process.pid}`

/** Test seam: the identity a retraction is allowed to touch. */
export function replicaIdForTest(): string {
  return REPLICA_ID
}

/**
 * Whether `raw` is a field written recently enough to still mean anything.
 *
 * Takes `unknown` rather than `string` because it reads values straight out of
 * an `HGETALL`: anything can be in that hash, and a field this function cannot
 * make sense of must read as absent rather than throw inside the guard.
 */
function isLiveMark(raw: unknown, now: number): boolean {
  if (typeof raw !== 'string') return false
  const at = Number(raw)
  if (!Number.isFinite(at) || at <= 0) return false
  return now - at < OVER_CAP_TTL_SECONDS * 1000
}

/**
 * The DURABLE, replica-independent record that a document is in an over-cap
 * condition whose REJECTED state has not been shown to be persisted.
 *
 * WHY THIS EXISTS ALONGSIDE THE PER-REPLICA MARK. `overCapReplicasKey` and its
 * heartbeat answer "is some replica RIGHT NOW holding an oversized copy". That
 * is bounded by replica lifetime: a field older than `OVER_CAP_TTL_SECONDS`
 * reads as absent, and after a pod is SIGKILLed (23 of them in the 2026-08-21
 * incident) the heartbeat stops and every field lapses within the hour — while
 * the rejected edits still sit in the client's IndexedDB. Replica lifecycle is
 * not a safe boundary for a data-loss interlock (MR98-003 residual).
 *
 * And a successful store on ONE replica does not prove the REJECTED client's
 * state was recovered: A crosses the cap (its edit lives only in A's cache), A
 * disconnects, the doc unloads, B opens it from the persisted row that never
 * held A's edit and small-stores successfully — that store retracts B's replica
 * field, but it accounts for NOTHING about A (MR98-004).
 *
 * So this marker is bound to the REJECTED STATE ITSELF, not to a replica:
 *   - it lives at document scope with a TTL as long as the compaction stamp it
 *     guards against (a stamp is the only thing that can trigger a cache wipe,
 *     so the marker must outlive it — `markCompacted` refreshes this key so it
 *     can never lapse first),
 *   - it survives replica death with NO heartbeat, and
 *   - a successful store clears it ONLY with strong evidence — the persisted
 *     state vector must DOMINATE the rejected one, i.e. carry every rejected
 *     client at a clock at least as high. Absent that evidence it is kept
 *     (fail closed); the only other way out is an explicit reconcile.
 *
 * The value is the rejected state vector as JSON `{ clientId: clock }`, merged
 * per-client-max across rejections so two divergent clients (or replicas) each
 * leave their own floor and neither can be cleared by a store that lacks it.
 */
function unrestoredOverCapKey(documentName: string): string {
  return rkey('overcap-unrestored', documentName)
}

/** A Yjs state vector flattened to plain JSON: clientId (as string) -> clock. */
export type StateVectorMap = Record<string, number>

/**
 * Parse a stored state-vector JSON, tolerating anything (it reads a value other
 * replicas wrote). A field that is not a positive finite clock is dropped rather
 * than throwing inside the interlock.
 */
function parseStateVector(raw: string | null): StateVectorMap {
  if (raw === null) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const out: StateVectorMap = {}
    for (const [client, clock] of Object.entries(parsed as Record<string, unknown>)) {
      const n = Number(clock)
      if (Number.isFinite(n) && n > 0) out[client] = n
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Drop any entry of a state-vector map that is not a positive finite clock —
 * the ONE notion of a valid SV shared with the retry queue in `oversizeGuard`,
 * so the queue's dominance checks read exactly what `recordUnrestoredOverCap`
 * and the Lua write. Routed through `parseStateVector` so there is a single
 * validator, not two that can drift.
 */
export function sanitizeStateVector(sv: StateVectorMap): StateVectorMap {
  return parseStateVector(JSON.stringify(sv))
}

/**
 * Atomic record: read -> per-client-max merge -> write-with-EX, in ONE Redis
 * round-trip so two replicas rejecting concurrently cannot lose each other's
 * floor.
 *
 * WHY LUA AND NOT GET-MERGE-SET. Two replicas can hold divergent copies of the
 * same document (measured in production 2026-08-25) and hit the size gate on
 * their own cadence. A read-modify-write split across two calls lets R2 read the
 * value R1 read, merge only its own client, and SET last — eating R1's floor.
 * That partial marker can then be cleared by a store that never carried R1's
 * bytes, wiping the only copy of R1's rejected client. EVAL runs the whole
 * read-merge-write as one indivisible step, so both floors always survive.
 *
 * KEYS[1] = marker key. ARGV[1] = rejected state vector as JSON. ARGV[2] = TTL
 * seconds. Returns the field count written (0 when the merge is empty and
 * nothing is written — the same no-phantom-marker rule the JS enforced).
 * Invalid entries (non-finite / non-positive clocks) are dropped exactly as
 * `parseStateVector` drops them, so the Lua and JS notions of the marker agree.
 */
const RECORD_UNRESTORED_LUA = `
-- RECORD_UNRESTORED: atomic read -> per-client-max merge -> write-with-EX
local raw = redis.call('get', KEYS[1])
local merged = {}
if raw then
  local ok, parsed = pcall(cjson.decode, raw)
  if ok and type(parsed) == 'table' then
    for k, v in pairs(parsed) do
      local n = tonumber(v)
      if n and n > 0 then merged[k] = n end
    end
  end
end
local ok2, rej = pcall(cjson.decode, ARGV[1])
if ok2 and type(rej) == 'table' then
  for k, v in pairs(rej) do
    local n = tonumber(v)
    if n and n > 0 and n > (merged[k] or 0) then merged[k] = n end
  end
end
local count = 0
for _ in pairs(merged) do count = count + 1 end
if count == 0 then return 0 end
redis.call('set', KEYS[1], cjson.encode(merged), 'EX', tonumber(ARGV[2]))
return count
`

/**
 * Atomic resolve: read -> dominance check -> conditional DEL, in ONE Redis
 * round-trip so a clean replica's resolve cannot wholesale-delete a marker a
 * concurrent rejection just extended.
 *
 * WHY LUA AND NOT GET-CHECK-DEL. A clean replica's store reads the marker as
 * {A}, decides A is dominated, and DELs — but between its read and its DEL a
 * concurrent rejection extended the marker to {A,B}. The split DEL removes the
 * whole {A,B}, dropping B's floor on a stale read. EVAL reads and deletes as one
 * step, so the delete only ever fires against the exact value it judged.
 *
 * KEYS[1] = marker key. ARGV[1] = persisted state vector as JSON. Returns:
 *   0 = no live marker (nothing to clear),
 *   1 = cleared (persisted dominated the recorded rejection),
 *   2 = kept (marker present but persisted did NOT dominate it).
 * The caller can log/observe which branch fired.
 */
const RESOLVE_UNRESTORED_LUA = `
-- RESOLVE_UNRESTORED: atomic read -> dominance check -> conditional DEL
local raw = redis.call('get', KEYS[1])
if not raw then return 0 end
local ok, required = pcall(cjson.decode, raw)
if not ok or type(required) ~= 'table' then return 0 end
local have = {}
local ok2, parsed = pcall(cjson.decode, ARGV[1])
if ok2 and type(parsed) == 'table' then
  for k, v in pairs(parsed) do
    local n = tonumber(v)
    if n and n > 0 then have[k] = n end
  end
end
local count = 0
for k, v in pairs(required) do
  local c = tonumber(v)
  if c and c > 0 then
    count = count + 1
    if (have[k] or 0) < c then return 2 end
  end
end
if count == 0 then return 0 end
redis.call('del', KEYS[1])
return 1
`

/**
 * The two Lua sources, re-exported for the conformance suite ONLY
 * (test/unrestoredEvalConformance.test.ts). The in-memory Redis doubles the
 * suite uses cannot run Lua, so test/helpers/unrestoredEval.ts re-implements
 * both scripts in JS -- a second implementation of production logic. The
 * conformance suite runs the SAME source exported here against a real Redis
 * EVAL and against that double, and asserts they agree; importing rather than
 * copy-pasting is what makes a Lua edit that diverges from the double fail.
 * Nothing in src/ reads these.
 */
export const RECORD_UNRESTORED_LUA_FOR_TEST = RECORD_UNRESTORED_LUA
export const RESOLVE_UNRESTORED_LUA_FOR_TEST = RESOLVE_UNRESTORED_LUA

/** Outcome of an atomic resolve, surfaced so a caller can log what actually happened. */
export type UnrestoredResolution = 'cleared' | 'kept' | 'absent'

/**
 * Whether `documentName` carries an unresolved, unrestored over-cap condition.
 * Replica-independent and needs no heartbeat: it is a plain durable key read.
 */
export async function hasUnrestoredOverCap(documentName: string): Promise<boolean> {
  const raw = await getRedis().get(unrestoredOverCapKey(documentName))
  return Object.keys(parseStateVector(raw)).length > 0
}

/**
 * Record that a store was rejected for size, remembering the REJECTED state
 * vector so a later store can be judged against it. Merges per-client-max into
 * any existing marker and (re)arms the TTL, through the atomic RECORD script.
 *
 * Returns whether the rejected state is now DURABLY recorded: `true` when the
 * marker was written (or the rejection was empty and there is nothing to
 * protect), `false` when Redis refused the write.
 *
 * WHY THE CALLER MUST ACT ON `false` (MR98-006). The earlier version swallowed a
 * Redis failure here and claimed "a blip only shortens the window before the
 * marker's own TTL — the safe direction". That is FALSE for this path: on a
 * failure there is NO marker at all, hence no window to shorten, and nothing can
 * rebuild the rejected state vector — the over-cap frame typically locks the
 * client session, so the first rejection is often the LAST store and there is no
 * natural retry. Once a rejection returns, that state vector must live
 * SOMEWHERE. So this reports the outcome and the retry chain in `oversizeGuard`
 * keeps the vector and re-runs this — through this same atomic script — until it
 * returns `true`: the in-memory queue as the fast path, and the DB-backed durable
 * store as the bottom that survives replica death during the outage window. The
 * invariant: every rejection is durably recorded (Redis marker or DB-backed retry
 * record) or in flight to become so.
 *
 * An empty `rejected` writes nothing: a real over-cap document always carries
 * structs, and creating an empty marker would suppress notices for a document
 * that has no rejected state to protect.
 */
export async function recordUnrestoredOverCap(
  documentName: string,
  rejected: StateVectorMap,
): Promise<boolean> {
  // Drop invalid clocks BEFORE the script so an empty rejection is a no-op
  // round-trip and the script only ever sees clean input (the Lua re-validates
  // regardless, but this keeps the two sides reading the same map).
  const clean = parseStateVector(JSON.stringify(rejected))
  if (Object.keys(clean).length === 0) return true
  try {
    await getRedis().eval(
      RECORD_UNRESTORED_LUA,
      1,
      unrestoredOverCapKey(documentName),
      JSON.stringify(clean),
      String(STAMP_TTL_SECONDS),
    )
    return true
  } catch {
    // Redis refused the write: the rejected state is NOT durable. Report it so
    // the caller can queue a retry — swallowing it here is exactly MR98-006.
    return false
  }
}

/**
 * Clear the unrestored marker ONLY when `persisted` proves the rejected state
 * was accounted for: its state vector must dominate the recorded one. A store
 * that does not (B's unrelated small store; a store on a replica that never saw
 * the rejecting client) leaves the marker standing — suppression is the safe
 * direction. The read/dominance-check/delete run as one atomic EVAL so a
 * concurrent rejection extending the marker cannot be wholesale-deleted on a
 * stale read. Returns the outcome (`cleared` / `kept` / `absent`) for
 * logging/observation. Never throws — a Redis error reads as `kept`.
 */
export async function resolveUnrestoredOverCap(
  documentName: string,
  persisted: StateVectorMap,
): Promise<UnrestoredResolution> {
  try {
    const outcome = await getRedis().eval(
      RESOLVE_UNRESTORED_LUA,
      1,
      unrestoredOverCapKey(documentName),
      JSON.stringify(parseStateVector(JSON.stringify(persisted))),
    )
    if (outcome === 1) return 'cleared'
    if (outcome === 2) return 'kept'
    return 'absent'
  } catch {
    // Leave the marker: a missed clear costs a suppressed notice, never a cache.
    // Report it as kept so a caller never reads a Redis blip as "cleared".
    return 'kept'
  }
}

/**
 * Explicitly reconcile the affected client's generation, dropping the marker
 * without state-vector evidence. The escape hatch for the case the reviewer
 * calls out: an operator (or a reconciliation flow) has confirmed the rejected
 * work is safe — e.g. copied out by hand, or the cap was raised and re-verified.
 * Never throws.
 */
export async function reconcileUnrestoredOverCap(documentName: string): Promise<void> {
  try {
    await getRedis().del(unrestoredOverCapKey(documentName))
  } catch {
    // Best effort; the TTL bounds how long a stale marker can suppress notices.
  }
}

/**
 * Record that `documentName` was compacted at `at` (epoch millis).
 *
 * Never throws. Compaction has ALREADY committed by the time this runs; failing
 * the caller here would turn a successful compaction into a reported failure and
 * (via autoCompact's catch) hide a rewrite that really happened.
 */
export async function markCompacted(documentName: string, at: number): Promise<void> {
  try {
    const redis = getRedis()
    // Renew the unrestored over-cap marker BEFORE publishing the stamp, and treat
    // the pair as all-or-nothing: no renewal, no new stamp.
    //
    // A compaction re-stamps to `now`. If we published the fresh 30-day stamp
    // FIRST and only then extended the marker, a Redis blip between the two
    // commands would leave a fresh destructive stamp visible while the marker
    // still carried its OLD, shorter deadline. The marker would then expire —
    // possibly weeks before the stamp — `isOverCapAnywhere` would lose its
    // durable signal, and a cache holding rejected edits could be wiped: the
    // exact wipe-the-only-copy window this marker exists to close.
    //
    // Doing EXPIRE first closes that window. EXPIRE on an absent marker is a
    // no-op (returns 0, never errors), so a healthy document renews nothing and
    // still gets its stamp normally. But we do NOT swallow an EXPIRE failure and
    // press on: if the renewal itself fails, the `await` throws and we jump to
    // the catch WITHOUT writing the stamp. The guard must be armed for the stamp
    // it protects, or the stamp must not exist.
    await redis.expire(unrestoredOverCapKey(documentName), STAMP_TTL_SECONDS)
    await redis.set(stampKey(documentName), String(at), 'EX', STAMP_TTL_SECONDS)
  } catch {
    // Best effort: the compaction stands, clients just will not be told yet.
    // Because the stamp is published LAST — only after the marker renewal
    // succeeded — a failure here can never leave a fresh stamp outliving its
    // protection.
  }
}

/**
 * The generation stamp for `documentName`, or null when there is none / it
 * cannot be read.
 *
 * Never throws — see FAIL OPEN above.
 */
export async function compactedAt(documentName: string): Promise<number | null> {
  try {
    const raw = await getRedis().get(stampKey(documentName))
    if (raw === null) return null
    const n = Number(raw)
    // A corrupt value must not be interpreted as "compacted at the epoch",
    // which would make every client clear its cache once.
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/** Serialise the frame. Kept here so sender and tests agree on one shape. */
export function staleCacheFramePayload(at: number): string {
  const frame: StaleCacheFrame = { type: STALE_CACHE_FRAME_TYPE, compactedAt: at }
  return JSON.stringify(frame)
}

/**
 * Cross-replica half of the interlock.
 *
 * WHY THE PROCESS-LOCAL FLAG IS NOT ENOUGH. `oversizeGuard`'s mark lives in a
 * per-process Map, written only by the replica whose own store attempt was
 * rejected. Production runs two replicas and they were observed holding
 * different views of the SAME document on 2026-08-25 — one replica logging
 * 10,556,162 bytes and kicking connections while the other served a clean
 * 659,725. A client landing on the clean replica would be told `isOverCap =
 * false` for a document that in truth cannot be persisted, and would wipe the
 * IndexedDB copy holding the edits that never made it to the database. That is
 * the precise data loss the interlock exists to prevent, so it cannot rest on a
 * flag that only one replica ever sets.
 *
 * `markOversized` mirrors the mark to Redis (shared by every replica) and a
 * successful store clears it, so this reads the deployment-wide answer.
 *
 * FAILURE DIRECTION: this one FAILS CLOSED, opposite to `compactedAt` above.
 * The two are not inconsistent — both directions resolve to "do not send the
 * frame". Unable to read the stamp: skip an optimisation. Unable to read the
 * oversize mark: we do not know whether the client's cache is the only copy of
 * its work, and must not gamble on it.
 */
export async function isOverCapAnywhere(documentName: string): Promise<boolean> {
  try {
    const redis = getRedis()
    // Durable, replica-independent marker FIRST: it is the one signal that
    // survives replica death with no heartbeat and is bound to the rejected
    // state rather than to any replica's lifetime. While it stands the document
    // is over cap deployment-wide, full stop (MR98-003 residual / MR98-004).
    if (Object.keys(parseStateVector(await redis.get(unrestoredOverCapKey(documentName)))).length > 0)
      return true
    // Legacy bare key next: during a rolling deploy an OLD replica marks only
    // this one, and failing to see it is the direction that costs a user's work.
    if ((await redis.get(overCapKey(documentName))) !== null) return true
    const fields: Record<string, string> = await redis.hgetall(overCapReplicasKey(documentName))
    const now = Date.now()
    return Object.keys(fields).some((field) => isLiveMark(fields[field], now))
  } catch {
    // OBSERVATION POINT (MR98-012). Failing closed protects THIS read, but the
    // same outage may be letting a sibling replica write a durable row this
    // process will not see until its next heartbeat reconcile. Re-arm the cache
    // invalidation gate: after recovery this replica must not hand out a
    // `compactedAt` on the strength of a Redis that simply has not been told yet.
    noteRedisFailureObserved()
    return true
  }
}

/**
 * Mirror an oversize mark so every replica can see it. Never throws: the
 * caller's size rejection is the important signal.
 *
 * Writes BOTH shapes: the per-replica field this version reads, and the legacy
 * bare key so an old replica still running the previous build keeps working.
 */
export async function markOverCapShared(documentName: string): Promise<void> {
  try {
    const redis = getRedis()
    const hkey = overCapReplicasKey(documentName)
    await redis.hset(hkey, REPLICA_ID, String(Date.now()))
    // Refreshed on every rejected store AND by the over-cap heartbeat while this
    // replica holds an unresolved condition, so the key cannot lapse while the
    // document is genuinely over cap — even across an idle client and an unload.
    await redis.expire(hkey, OVER_CAP_TTL_SECONDS)
    // The legacy key's VALUE carries this replica's identity rather than a bare
    // '1'. Old replicas only ever test it for existence, so this is invisible to
    // them, and it is what lets the retraction below tell "a mark I set" from "a
    // mark an old replica set and is still enforcing".
    await redis.set(overCapKey(documentName), REPLICA_ID, 'EX', OVER_CAP_TTL_SECONDS)
  } catch {
    // Best effort for the MARK. A replica that cannot record it still enforces it
    // locally, and readers fail closed.
    //
    // OBSERVATION POINT (MR98-012). But a failed mirror is also direct evidence
    // that Redis is not accepting over-cap state right now — the precise
    // condition under which un-mirrored rows accumulate cluster-wide. Re-arm the
    // cache invalidation gate until a full reconcile proves this view complete.
    noteRedisFailureObserved()
  }
}

/**
 * Retract THIS replica's mark once its own store has succeeded. Never throws.
 *
 * THE DIVERGENCE GUARD. This used to `DEL` a single shared key, which let a
 * clean replica erase a mark that a divergent replica had set and was still
 * enforcing — see `overCapReplicasKey` for the measured production case. A
 * replica may now retract only its OWN field; the legacy bare key is deleted
 * ONLY when no other replica's field remains live, because that key is the
 * boolean the old code shared and deleting it early would recreate the exact
 * defect. The read side fails closed, so a retraction that fails leaves the mark
 * standing — a missed notice, not a lost cache.
 */
export async function clearOverCapShared(documentName: string): Promise<void> {
  try {
    const redis = getRedis()
    const hkey = overCapReplicasKey(documentName)
    await redis.hdel(hkey, REPLICA_ID)
    const remaining: Record<string, string> = await redis.hgetall(hkey)
    const now = Date.now()
    const stillOversized = Object.keys(remaining).some((field) => isLiveMark(remaining[field], now))
    if (stillOversized) {
      // Another replica is still holding an oversized copy. Leave BOTH the
      // legacy key and its field alone: suppression is the safe direction.
      return
    }
    // Nobody is oversized any more. Reap expired fields so the hash does not
    // accumulate identities of pods that were killed mid-incident.
    const expired = Object.keys(remaining).filter((field) => !isLiveMark(remaining[field], now))
    if (expired.length > 0) await redis.hdel(hkey, ...expired)
    // The legacy key is only ours to delete if WE wrote it. A value that is not
    // this replica's id belongs to an old-build replica that is still enforcing
    // the cap, and deleting it would be precisely the cross-replica retraction
    // this guard exists to stop. Its TTL bounds how long it can outlive that
    // replica, and until then suppression is the safe direction.
    const legacy = await redis.get(overCapKey(documentName))
    if (legacy === REPLICA_ID) await redis.del(overCapKey(documentName))
  } catch {
    // Best effort: the key's TTL bounds how long a stale mark can suppress
    // notices, and suppression is the safe direction.
  }
}

/**
 * Tell ONE arriving connection that its cached copy predates a compaction.
 * Returns whether a frame was sent (for tests / logging).
 *
 * `isOverCap` is the safety interlock and the reason this is a function rather
 * than two lines in the hook. A document that is over the cap cannot persist
 * what the client is holding, so asking that client to drop its cache would
 * destroy the edits it has been unable to save — the exact content the
 * over-size-cap banner is telling the user to copy out by hand. Compaction
 * notices therefore wait until the document can be written again: a successful
 * store clears the oversize mark, and the next connection gets the notice.
 */
export async function noticeStaleCacheOnJoin(
  documentName: string,
  isOverCap: boolean,
  send: (payload: string) => void,
): Promise<boolean> {
  // Same startup interlock as the token path (MR98-010) — the two channels must
  // not disagree about whether this process is in a position to judge over-cap.
  if (!mayInvalidateClientCaches()) return false
  if (isOverCap) return false
  if (await isOverCapAnywhere(documentName)) return false
  const at = await compactedAt(documentName)
  if (at === null) return false
  send(staleCacheFramePayload(at))
  return true
}
