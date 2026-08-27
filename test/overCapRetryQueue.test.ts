/**
 * MR98-006: a durable over-cap record that FAILS to reach Redis must not be
 * silently dropped — it has to be retried until it lands, or the data-loss path
 * reopens after replica loss.
 *
 * THE FAILURE ARC THESE TESTS PIN (deterministic, no race):
 *   1. Redis blips at the exact moment a store is rejected -> the durable
 *      unrestored marker is never created.
 *   2. The over-cap frame typically locks the client session, so the FIRST
 *      rejection is often the LAST store — there is no natural retry.
 *   3. Redis recovers; the old heartbeat only resurrected the 1h per-replica
 *      field.
 *   4. The pod is SIGKILLed (23 of them in the 2026-08-21 incident) -> the
 *      per-replica field expires.
 *   5. `isOverCapAnywhere` finds no signal -> the token is stamped -> the
 *      browser deletes its only copy. MR98-003's residual, on the write-failure
 *      path.
 *
 * THE FIX. The rejected state vector is held in a bounded in-memory retry queue
 * and re-run — through the SAME atomic RECORD script — by the 10-minute over-cap
 * heartbeat and by graceful shutdown, until the durable record lands. On success
 * it leaves the queue; a dominating store clears it too, so a genuine recovery
 * leaves no phantom to be resurrected.
 *
 * The Redis double is TTL-AWARE on fake timers (so the 1h per-replica expiry is
 * modelled for real) and can be toggled DOWN (every op throws, exactly as a blip
 * would), so "the record failed" is a real failure and not a stubbed branch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { evalUnrestored } from './helpers/unrestoredEval.js'

let redisDown = false
function guard(): void {
  if (redisDown) throw new Error('redis down')
}

const strings = new Map<string, { v: string; expireAt: number | null }>()
const hashes = new Map<string, { fields: Map<string, string>; expireAt: number | null }>()

function alive(expireAt: number | null): boolean {
  return expireAt === null || expireAt > Date.now()
}
function deadlineFromEx(args: unknown[]): number | null {
  const i = args.findIndex((a) => typeof a === 'string' && a.toUpperCase() === 'EX')
  if (i >= 0 && typeof args[i + 1] !== 'undefined') return Date.now() + Number(args[i + 1]) * 1000
  return null
}
function getString(k: string): string | null {
  const e = strings.get(k)
  if (!e) return null
  if (!alive(e.expireAt)) {
    strings.delete(k)
    return null
  }
  return e.v
}
function getHash(k: string): Map<string, string> | null {
  const e = hashes.get(k)
  if (!e) return null
  if (!alive(e.expireAt)) {
    hashes.delete(k)
    return null
  }
  return e.fields
}

vi.mock('../src/db/redis.js', () => ({
  getRedis: () => ({
    get: async (k: string) => {
      guard()
      return getString(k)
    },
    set: async (k: string, v: string, ...args: unknown[]) => {
      guard()
      strings.set(k, { v, expireAt: deadlineFromEx(args) })
      return 'OK'
    },
    del: async (k: string) => {
      guard()
      const had = strings.delete(k) || hashes.delete(k)
      return had ? 1 : 0
    },
    hset: async (k: string, f: string, v: string) => {
      guard()
      const e = hashes.get(k) ?? { fields: new Map<string, string>(), expireAt: null }
      e.fields.set(f, v)
      hashes.set(k, e)
      return 1
    },
    hdel: async (k: string, ...fields: string[]) => {
      guard()
      const e = hashes.get(k)
      if (!e) return 0
      let n = 0
      for (const f of fields) if (e.fields.delete(f)) n += 1
      return n
    },
    hgetall: async (k: string) => {
      guard()
      return Object.fromEntries(getHash(k) ?? new Map())
    },
    eval: async (script: string, _numKeys: number, key: string, ...argv: string[]) => {
      guard()
      return evalUnrestored(script, key, argv, {
        get: getString,
        set: (k: string, v: string, ttlSeconds: number) =>
          strings.set(k, { v, expireAt: Date.now() + ttlSeconds * 1000 }),
        del: (k: string) => {
          strings.delete(k)
        },
      })
    },
    expire: async (k: string, seconds: number) => {
      guard()
      const e = hashes.get(k)
      if (e) {
        e.expireAt = Date.now() + seconds * 1000
        return 1
      }
      const s = strings.get(k)
      if (s) {
        s.expireAt = Date.now() + seconds * 1000
        return 1
      }
      return 0
    },
  }),
  rkey: (...parts: string[]) => parts.join(':'),
}))

const {
  isOverCapAnywhere,
  hasUnrestoredOverCap,
  resolveUnrestoredOverCap,
  markCompacted,
  compactedAt,
  noticeStaleCacheOnJoin,
  OVER_CAP_TTL_SECONDS,
} = await import('../src/collab/compactionNotice.js')
const {
  markOversized,
  resolvePendingUnrestored,
  flushUnrestoredRetries,
  pendingUnrestoredCount,
  startOverCapHeartbeat,
  setMaxPendingUnrestoredForTest,
  resetOversizedForTest,
} = await import('../src/collab/oversizeGuard.js')
const { attachCompactedAtForTest } = await import('../src/auth/issueCollabToken.js')

const DOC = 'octo:s1:f_default:d_blip'
const STAMP = 1_756_000_000_000
const CAP = 10_485_760
const OVER = 10_556_162
const PAST_REPLICA_TTL_MS = OVER_CAP_TTL_SECONDS * 1000 * 3 // three per-replica windows

const tokenEnvelope = () => ({ token: 't', expiresAt: 'x', role: 'writer' as const, permission_epoch: 3 })

/** Drain the short async chain markOversized's fire-and-forget writes leave. */
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}

let stopHeartbeat: (() => void) | null = null

describe('MR98-006 — a failed durable record is retried until it lands', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(STAMP)
    redisDown = false
    strings.clear()
    hashes.clear()
    resetOversizedForTest()
  })
  afterEach(() => {
    stopHeartbeat?.()
    stopHeartbeat = null
    redisDown = false
    vi.useRealTimers()
  })

  it('record fails -> Redis recovers -> heartbeat drains the queue -> protection survives replica death', async () => {
    // A compaction stamp already exists (so a cache-stale notice WOULD fire), and
    // the document is genuinely over cap.
    await markCompacted(DOC, STAMP)

    // Redis blips at the EXACT moment of the rejection: the durable record cannot
    // be written, so nothing durable is created — only the local guard + the
    // in-memory retry entry survive.
    redisDown = true
    markOversized(DOC, OVER, CAP, { '1': 100 })
    await flush()
    expect(pendingUnrestoredCount()).toBe(1)
    redisDown = false
    expect(await hasUnrestoredOverCap(DOC)).toBe(false) // never created during the blip

    // Redis recovers and the heartbeat ticks. On the SAME tick that refreshes the
    // per-replica field it drains the retry queue, so the durable marker now
    // exists — bound to the rejected state vector, not to any replica.
    stopHeartbeat = startOverCapHeartbeat()
    await vi.advanceTimersByTimeAsync(11 * 60_000)
    expect(await hasUnrestoredOverCap(DOC)).toBe(true)
    expect(pendingUnrestoredCount()).toBe(0) // left the queue once it landed

    // The pod is SIGKILLed: in-memory state is gone and time passes far beyond the
    // 1h per-replica window, so that field lapses. The durable marker (30-day TTL)
    // does not — this is the residual hole, now closed on the write-failure path.
    stopHeartbeat()
    stopHeartbeat = null
    resetOversizedForTest()
    await vi.advanceTimersByTimeAsync(PAST_REPLICA_TTL_MS)

    expect(await hasUnrestoredOverCap(DOC)).toBe(true)
    expect(await isOverCapAnywhere(DOC)).toBe(true)
    // Guard the guard: the stamp is still readable, so the ONLY reason the token
    // stays unstamped is the interlock.
    expect(await compactedAt(DOC)).toBe(STAMP)

    const envelope = tokenEnvelope()
    await attachCompactedAtForTest(envelope, DOC)
    expect('compactedAt' in envelope).toBe(false)

    const sent: string[] = []
    expect(await noticeStaleCacheOnJoin(DOC, false, (p) => sent.push(p))).toBe(false)
    expect(sent).toEqual([])
  })

  it('CONTROL: without the drain the same sequence loses protection — this is the hole the fix closes', async () => {
    await markCompacted(DOC, STAMP)

    // Same blip at rejection, so the durable record is never written.
    redisDown = true
    markOversized(DOC, OVER, CAP, { '1': 100 })
    await flush()
    redisDown = false

    // Redis recovers and the OLD behaviour is modelled: the per-replica field is
    // resurrected (a rejected store / the field-only refresh), but the retry queue
    // is NOT drained. The durable marker therefore never appears.
    markOversized(DOC, OVER, CAP) // legacy field-only refresh, no state vector
    await flush()
    expect(await hasUnrestoredOverCap(DOC)).toBe(false)

    // The pod is SIGKILLed and the per-replica field expires.
    resetOversizedForTest()
    await vi.advanceTimersByTimeAsync(PAST_REPLICA_TTL_MS)

    // No signal remains — the token is stamped and a join would clear the cache.
    // This is exactly the data loss the drain prevents in the test above.
    expect(await isOverCapAnywhere(DOC)).toBe(false)
    const envelope = tokenEnvelope()
    await attachCompactedAtForTest(envelope, DOC)
    expect(envelope).toMatchObject({ compactedAt: STAMP })
  })

  it('graceful shutdown drains the queue too, so a clean stop does not lose a raced record', async () => {
    redisDown = true
    markOversized(DOC, OVER, CAP, { '1': 100 })
    await flush()
    expect(pendingUnrestoredCount()).toBe(1)

    // Redis comes back and shutdown runs its final flush (no heartbeat needed).
    redisDown = false
    await flushUnrestoredRetries()
    expect(pendingUnrestoredCount()).toBe(0)
    expect(await hasUnrestoredOverCap(DOC)).toBe(true)
  })

  it('the drain stops once the record succeeds — no duplicate phantoms', async () => {
    // Redis is healthy: the record lands on the immediate attempt and the queue is
    // empty, so nothing is left for the heartbeat to re-write.
    markOversized(DOC, OVER, CAP, { '1': 100 })
    await flush()
    expect(await hasUnrestoredOverCap(DOC)).toBe(true)
    expect(pendingUnrestoredCount()).toBe(0)

    // A dominating store resolves the marker.
    expect(await resolveUnrestoredOverCap(DOC, { '1': 100 })).toBe('cleared')
    expect(await hasUnrestoredOverCap(DOC)).toBe(false)

    // The heartbeat runs again: with an empty queue it resurrects nothing.
    stopHeartbeat = startOverCapHeartbeat()
    await vi.advanceTimersByTimeAsync(11 * 60_000)
    expect(await hasUnrestoredOverCap(DOC)).toBe(false)
  })

  it('a dominating resolve clears a STILL-QUEUED record, so the heartbeat cannot resurrect a phantom', async () => {
    // The record failed and lives ONLY in the retry queue (never reached Redis).
    redisDown = true
    markOversized(DOC, OVER, CAP, { '1': 100 })
    await flush()
    expect(pendingUnrestoredCount()).toBe(1)
    redisDown = false

    // Redis recovers and a store whose state DOMINATES the rejection succeeds. The
    // durable marker is absent (never written), so the Redis-side resolve is a
    // no-op — but the pending entry must be cleared, or the next heartbeat would
    // re-create a marker for state that was already recovered.
    expect(await resolveUnrestoredOverCap(DOC, { '1': 100 })).toBe('absent')
    resolvePendingUnrestored(DOC, { '1': 100 })
    expect(pendingUnrestoredCount()).toBe(0)

    // The heartbeat drains: nothing to write, so no phantom marker appears.
    await flushUnrestoredRetries()
    expect(await hasUnrestoredOverCap(DOC)).toBe(false)
  })

  it('an UNDOMINATED resolve leaves the queued record standing (fail closed)', async () => {
    redisDown = true
    markOversized(DOC, OVER, CAP, { '1': 100 })
    await flush()
    redisDown = false

    // A different client's store does not account for the rejected client, so it
    // may not clear the pending protection.
    resolvePendingUnrestored(DOC, { '2': 5 })
    expect(pendingUnrestoredCount()).toBe(1)

    // The drain then makes the record durable, exactly as it should.
    await flushUnrestoredRetries()
    expect(await hasUnrestoredOverCap(DOC)).toBe(true)
    expect(pendingUnrestoredCount()).toBe(0)
  })

  it('re-rejections merge per-client-max in the queue; a lower clock cannot lower a floor', async () => {
    redisDown = true
    markOversized(DOC, OVER, CAP, { '1': 100 })
    await flush()
    markOversized(DOC, OVER, CAP, { '1': 80, '2': 50 }) // A stays at 100; B added
    await flush()
    expect(pendingUnrestoredCount()).toBe(1)
    redisDown = false

    await flushUnrestoredRetries()
    // The durable marker requires A@100 and B@50: a store missing either is kept.
    expect(await resolveUnrestoredOverCap(DOC, { '1': 90, '2': 50 })).toBe('kept')
    expect(await resolveUnrestoredOverCap(DOC, { '1': 100, '2': 50 })).toBe('cleared')
  })

  it('bounded queue fails closed on overflow: a tracked entry is never evicted', async () => {
    setMaxPendingUnrestoredForTest(1)
    redisDown = true // keep everything queued so the bound is exercised
    const errs = vi.spyOn(console, 'error').mockImplementation(() => {})

    markOversized('octo:s1:f_default:d_first', OVER, CAP, { '1': 100 })
    await flush()
    expect(pendingUnrestoredCount()).toBe(1)

    // A second distinct document cannot be admitted — but the first (undurable)
    // entry is NOT evicted to make room: dropping it is the data-loss direction.
    // The refusal is logged loudly rather than swallowed.
    markOversized('octo:s1:f_default:d_second', OVER, CAP, { '2': 200 })
    await flush()
    expect(pendingUnrestoredCount()).toBe(1)
    expect(errs).toHaveBeenCalledWith(expect.stringContaining('retry queue full'))
    errs.mockRestore()

    // Recover: the retained entry lands durably.
    redisDown = false
    await flushUnrestoredRetries()
    expect(await hasUnrestoredOverCap('octo:s1:f_default:d_first')).toBe(true)
  })
})
