/**
 * Multi-replica safety for history compaction.
 *
 * WHY compaction.ts's own check is not enough
 *
 * `compactDocument` refuses while the document is in THIS instance's document
 * map. Under a multi-replica deployment that proves nothing about the other
 * replicas: the same document can be loaded on several nodes at once (they sync
 * through Redis pub/sub), and a node still holding the pre-compaction state will
 * flush it back over the compacted row on its next store, or merge both
 * histories on its next sync. The local check alone makes compaction look
 * guarded while being unguarded.
 *
 * WHY NOT REUSE THE CONNECTION REGISTRY
 *
 * `permission/connectionRegistry.ts` already tracks connections per document
 * across nodes, but it is not usable as a compaction gate, for two reasons
 * measured against production rather than assumed:
 *
 * 1. IT LEAKS. Entries are removed on `onDisconnect`, which never runs when a
 *    pod is SIGKILLed — exactly what happened during the 2026-08-21 incident
 *    (exit code 137). A live read found 649 registered connections spread over
 *    five pod names while only ONE pod existed: 88% of the registry was rubble
 *    from dead pods. Gating on it would refuse compaction forever, and would
 *    refuse it hardest on the documents that were open when a pod died — the
 *    big ones this feature exists for.
 *
 * 2. CONNECTIONS ARE NOT THE SAME AS LOADED. Hocuspocus keeps a document loaded
 *    after the last client leaves (`unloadImmediately: false` plus the store
 *    debounce). During that window the registry is empty while a node still
 *    holds the in-memory state, which is precisely the state that would undo a
 *    compaction.
 *
 * So this module tracks what actually matters — which nodes have the document
 * LOADED — and pairs it with a node liveness heartbeat so that a killed node's
 * entries stop counting instead of blocking compaction forever.
 *
 * FAILURE DIRECTION
 *
 * Every read here fails CLOSED: if Redis cannot answer, the caller must refuse
 * to compact. An unreachable Redis returning "nobody holds it" would be an
 * unreachable Redis authorising a destructive rewrite.
 */
import { randomUUID } from 'node:crypto'
import { getRedis, rkey } from '../db/redis.js'
import { config } from '../config/env.js'

/**
 * How long a node's liveness key survives without a refresh.
 *
 * The window is the cost of a hard kill: for up to this long after a SIGKILL,
 * the dead node's documents still look held and compaction stands down. That is
 * the safe direction, it self-heals, and 90 s is comfortably longer than the
 * refresh interval so a slow event loop cannot expire a node that is merely busy.
 */
const NODE_TTL_SECONDS = 90

/** Refresh interval. Three refreshes fit inside one TTL. */
const HEARTBEAT_INTERVAL_MS = 30_000

/**
 * How long the compaction lock is held before Redis reclaims it.
 *
 * Long enough for a worst-case rebuild (measured 4.7 s of CPU plus the
 * transaction) with a wide margin, short enough that a node dying mid-compaction
 * does not wedge the document for an hour. The transaction is the real safety
 * net — a lock lost to expiry cannot corrupt anything, it can only allow a
 * second attempt that the "document is loaded" checks will handle.
 */
const LOCK_TTL_MS = 120_000

/**
 * This process's identity in the fleet.
 *
 * NOT just `config.hostname`. Two replicas that report the same name are
 * indistinguishable here, and the failure is silent and destructive: this node
 * would filter the OTHER node's holder entry out as "self", conclude nobody
 * holds the document, and compact it out from under a replica that has it open.
 * `markUnloaded` would delete the other node's registration on the way past.
 *
 * That is not hypothetical. `docker-compose.node2.yml` runs two replicas that
 * both report `octo-docs-local`, with a comment calling the shared name a known
 * defect. Kubernetes happens to set HOSTNAME to the unique pod name, so
 * production is fine — but a guard whose failure mode is a destroyed document
 * must not depend on an environment variable happening to be unique.
 *
 * The pid distinguishes processes on one host; the nonce distinguishes a
 * restarted process from its predecessor, whose holder entries may still be in
 * Redis. The hostname stays as the leading segment so logs remain readable.
 */
let instanceId: string | null = null

export function nodeId(): string {
  if (instanceId === null) {
    instanceId = `${config.hostname}#${process.pid}#${randomUUID().slice(0, 8)}`
  }
  return instanceId
}

/**
 * Forget the cached identity, so a test can simulate a second replica by
 * changing the hostname and asking again. Never call this in production: two
 * identities for one process would leave a holder entry nobody ever removes.
 */
export function resetNodeIdForTest(): void {
  instanceId = null
}

function aliveKey(node: string): string {
  return rkey('node-alive', node)
}

function holdersKey(documentName: string): string {
  return rkey('doc-holders', documentName)
}

function lockKey(documentName: string): string {
  return rkey('compact-lock', documentName)
}

/** Announce this node as alive. Called at startup and on every heartbeat. */
export async function announceNode(): Promise<void> {
  await getRedis().set(aliveKey(nodeId()), '1', 'EX', NODE_TTL_SECONDS)
}

/**
 * Withdraw this node from the fleet, on graceful shutdown.
 *
 * Only an optimisation: without it the key expires on its own within
 * NODE_TTL_SECONDS. It just means a rolling deploy stops blocking compaction
 * a minute and a half sooner.
 */
export async function withdrawNode(): Promise<void> {
  try {
    await getRedis().del(aliveKey(nodeId()))
  } catch {
    /* shutting down anyway; the TTL is the backstop */
  }
}

/**
 * Start the liveness heartbeat. Returns a function that stops it.
 *
 * The timer is unref'd so it can never hold the process open during shutdown.
 */
export function startNodeHeartbeat(): () => void {
  void announceNode().catch(() => {
    /* the next tick retries; a missing key only costs a refused compaction */
  })

  const timer = setInterval(() => {
    void announceNode().catch(() => {
      /* see above */
    })
  }, HEARTBEAT_INTERVAL_MS)
  timer.unref()

  return () => clearInterval(timer)
}

/** Record that this node has `documentName` loaded in memory. */
export async function markLoaded(documentName: string): Promise<void> {
  await getRedis().hset(holdersKey(documentName), nodeId(), Date.now().toString())
}

/**
 * Record that this node has released `documentName`.
 *
 * Must run BEFORE the compaction attempt for the unload that triggered it,
 * otherwise the node would see itself in the holder list and stand down forever.
 */
export async function markUnloaded(documentName: string): Promise<void> {
  await getRedis().hdel(holdersKey(documentName), nodeId())
}

/**
 * Nodes OTHER than this one that currently hold `documentName` loaded.
 *
 * Entries belonging to nodes with no liveness key are treated as rubble from a
 * killed pod: they are ignored and deleted, which is what keeps this registry
 * from rotting the way the connection registry did.
 *
 * Throws if Redis cannot be reached. Callers must treat that as "do not
 * compact" — never as "nobody holds it".
 */
export async function otherLiveHolders(documentName: string): Promise<string[]> {
  const redis = getRedis()
  const entries = await redis.hgetall(holdersKey(documentName))

  const candidates = Object.keys(entries).filter((node) => node !== nodeId())
  if (candidates.length === 0) return []

  // One round trip for all liveness keys rather than one per candidate.
  const alive = await redis.mget(...candidates.map(aliveKey))

  const live: string[] = []
  const dead: string[] = []
  candidates.forEach((node, i) => (alive[i] === null ? dead : live).push(node))

  if (dead.length > 0) {
    // Opportunistic cleanup; a failure here is harmless, the entries are simply
    // ignored again next time.
    await redis.hdel(holdersKey(documentName), ...dead).catch(() => 0)
  }

  return live
}

/**
 * Run `fn` while holding the fleet-wide compaction lock for `documentName`.
 *
 * Returns `{ ran: false }` when another node holds the lock — compaction is an
 * optimisation that fires on every unload, so losing the race is a non-event
 * and queueing behind it would only pile up stale attempts.
 *
 * The lock is released with a compare-and-delete script: a plain DEL would, if
 * this node stalled long enough for the lock to expire and another node to take
 * it, delete the OTHER node's lock and let a third node in alongside it.
 */
export async function withCompactionLock<T>(
  documentName: string,
  fn: () => Promise<T>,
): Promise<{ ran: true; value: T } | { ran: false }> {
  const redis = getRedis()
  const owner = `${nodeId()}:${process.pid}:${Date.now()}`

  const acquired = await redis.set(lockKey(documentName), owner, 'PX', LOCK_TTL_MS, 'NX')
  if (acquired !== 'OK') return { ran: false }

  try {
    return { ran: true, value: await fn() }
  } finally {
    await redis
      .eval(
        `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
        1,
        lockKey(documentName),
        owner,
      )
      .catch(() => 0)
  }
}
