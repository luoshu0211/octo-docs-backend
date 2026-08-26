/**
 * MR98-004 and the MR98-003 RESIDUAL: the over-cap interlock must be bound to the
 * REJECTED STATE, not to a replica's lifetime, and it must not be dissolved by a
 * store that does not actually account for that state.
 *
 * TWO SIDES OF ONE ROOT CAUSE — "resolution is decoupled from recovery of the
 * rejected state":
 *
 *   MR98-004. A crosses the cap (its edit lives only in A's IndexedDB), A
 *   disconnects, the document unloads. B opens the document from the persisted
 *   row that never held A's edit, makes a small change, and its store succeeds.
 *   The old code let that success dissolve the WHOLE document's protection — but
 *   B's store proves only that B's loaded state fits, nothing about A. A returns
 *   with the fresher compaction stamp and its cache — the only copy — is wiped.
 *
 *   MR98-003 residual. The unresolved condition lived in process memory, refreshed
 *   by a 10-minute heartbeat. On a hard kill (23 SIGKILLs in the incident) the
 *   heartbeat stops, the per-replica Redis fields lapse after 1h, and the gates
 *   re-open while the rejected edits still sit in the client's cache.
 *
 * THE FIX under test. A DURABLE, document-scoped marker in Redis carries the
 * rejected state vector. It survives replica death with no heartbeat (a 30-day
 * TTL, refreshed by `markCompacted` so it can never lapse before the stamp it
 * guards), and a successful store clears it ONLY when the persisted state vector
 * DOMINATES the rejected one — otherwise it is kept (fail closed). An explicit
 * reconcile is the only other way out.
 *
 * These tests use a TTL-AWARE Redis double on fake timers, so the 1h per-replica
 * expiry is modelled for real and the durable marker's survival is not a fluke of
 * a double that never expires anything.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { evalUnrestored } from './helpers/unrestoredEval.js'

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
    get: async (k: string) => getString(k),
    set: async (k: string, v: string, ...args: unknown[]) => {
      strings.set(k, { v, expireAt: deadlineFromEx(args) })
      return 'OK'
    },
    del: async (k: string) => {
      const had = strings.delete(k) || hashes.delete(k)
      return had ? 1 : 0
    },
    hset: async (k: string, f: string, v: string) => {
      const e = hashes.get(k) ?? { fields: new Map<string, string>(), expireAt: null }
      e.fields.set(f, v)
      hashes.set(k, e)
      return 1
    },
    hdel: async (k: string, ...fields: string[]) => {
      const e = hashes.get(k)
      if (!e) return 0
      let n = 0
      for (const f of fields) if (e.fields.delete(f)) n += 1
      return n
    },
    hgetall: async (k: string) => Object.fromEntries(getHash(k) ?? new Map()),
    eval: async (script: string, _numKeys: number, key: string, ...argv: string[]) =>
      evalUnrestored(script, key, argv, {
        get: getString,
        set: (k: string, v: string, ttlSeconds: number) =>
          strings.set(k, { v, expireAt: Date.now() + ttlSeconds * 1000 }),
        del: (k: string) => {
          strings.delete(k)
        },
      }),
    expire: async (k: string, seconds: number) => {
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
      return 0 // EXPIRE on an absent key is a no-op, exactly as real Redis.
    },
  }),
  rkey: (...parts: string[]) => parts.join(':'),
}))

const {
  isOverCapAnywhere,
  hasUnrestoredOverCap,
  recordUnrestoredOverCap,
  resolveUnrestoredOverCap,
  reconcileUnrestoredOverCap,
  markOverCapShared,
  markCompacted,
  compactedAt,
  noticeStaleCacheOnJoin,
  OVER_CAP_TTL_SECONDS,
} = await import('../src/collab/compactionNotice.js')
const { markOversized, resetOversizedForTest } = await import('../src/collab/oversizeGuard.js')
const { attachCompactedAtForTest } = await import('../src/auth/issueCollabToken.js')

const DOC = 'octo:s1:f_default:d_reject'
const STAMP = 1_756_000_000_000
const STAMP_TTL_MS = 30 * 24 * 60 * 60 * 1000 // mirror STAMP_TTL_SECONDS
const PAST_REPLICA_TTL_MS = OVER_CAP_TTL_SECONDS * 1000 * 3 // three per-replica windows

const tokenEnvelope = () => ({ token: 't', expiresAt: 'x', role: 'writer' as const, permission_epoch: 3 })

/** Drain the short async chain the fire-and-forget mirrors leave behind. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

describe('durable unrestored over-cap marker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(STAMP)
    strings.clear()
    hashes.clear()
    resetOversizedForTest()
  })
  afterEach(() => vi.useRealTimers())

  describe('MR98-003 residual — survives replica death with no heartbeat', () => {
    it('holds the interlock past the 1h per-replica window, with the process state gone', async () => {
      // A store was rejected: the durable marker carries A's state, and (as on the
      // real path) the per-replica field and a compaction stamp exist too.
      await recordUnrestoredOverCap(DOC, { '1': 100 })
      await markOverCapShared(DOC)
      await markCompacted(DOC, STAMP)
      expect(await isOverCapAnywhere(DOC)).toBe(true)

      // The replica is SIGKILLed: in-memory state is gone and NOTHING refreshes
      // anything. Time passes far beyond the 1h per-replica TTL.
      resetOversizedForTest()
      await vi.advanceTimersByTimeAsync(PAST_REPLICA_TTL_MS)

      // The per-replica field has lapsed — but the durable marker has not, so the
      // interlock still holds. This is the residual hole closed.
      expect(await hasUnrestoredOverCap(DOC)).toBe(true)
      expect(await isOverCapAnywhere(DOC)).toBe(true)
      // Guard the guard: the stamp really is still readable, so the ONLY reason
      // the token stays unstamped is the interlock.
      expect(await compactedAt(DOC)).toBe(STAMP)

      const envelope = tokenEnvelope()
      await attachCompactedAtForTest(envelope, DOC)
      expect('compactedAt' in envelope).toBe(false)

      const sent: string[] = []
      expect(await noticeStaleCacheOnJoin(DOC, false, (p) => sent.push(p))).toBe(false)
      expect(sent).toEqual([])
    })

    it('CONTROL: a mark held ONLY by the per-replica field DOES lapse at the TTL', async () => {
      // No durable marker — just the replica field, as the previous round left it.
      // This proves the double models the 1h expiry, so the test above is real.
      await markOverCapShared(DOC)
      expect(await isOverCapAnywhere(DOC)).toBe(true)

      await vi.advanceTimersByTimeAsync(PAST_REPLICA_TTL_MS)
      expect(await isOverCapAnywhere(DOC)).toBe(false)
    })

    it('markCompacted keeps the marker alive at least as long as the stamp it writes', async () => {
      // Reject early; the marker expires STAMP_TTL from now.
      await recordUnrestoredOverCap(DOC, { '1': 100 })

      // Most of a stamp-lifetime later a compaction re-stamps to "now". Without a
      // refresh the marker would expire one stamp-lifetime after the REJECTION,
      // before this fresh stamp — re-opening the wipe window. markCompacted must
      // push the marker out to match the stamp.
      await vi.advanceTimersByTimeAsync(STAMP_TTL_MS - 60_000)
      await markCompacted(DOC, Date.now())

      // Past the marker's ORIGINAL deadline: it survives only because markCompacted
      // refreshed it, and the fresh stamp is still present too.
      await vi.advanceTimersByTimeAsync(2 * 60_000)
      expect(await hasUnrestoredOverCap(DOC)).toBe(true)
      expect(await compactedAt(DOC)).not.toBeNull()
      expect(await isOverCapAnywhere(DOC)).toBe(true)
    })
  })

  describe('MR98-004 — only genuine recovery evidence lifts it', () => {
    it('an unrelated store whose state does NOT cover the rejection leaves it standing', async () => {
      await recordUnrestoredOverCap(DOC, { '1': 100 }) // A rejected at clock 100

      // B loads from a row that never held A's edit and stores: a different client
      // entirely, and A absent.
      await resolveUnrestoredOverCap(DOC, { '2': 5 })
      expect(await hasUnrestoredOverCap(DOC)).toBe(true)

      // Even a store that shares A's client but at a LOWER clock is not proof.
      await resolveUnrestoredOverCap(DOC, { '1': 99 })
      expect(await hasUnrestoredOverCap(DOC)).toBe(true)
    })

    it('a store whose state DOMINATES the rejection clears it', async () => {
      await recordUnrestoredOverCap(DOC, { '1': 100 })
      await resolveUnrestoredOverCap(DOC, { '1': 100, '2': 5 }) // carries A@100 and more
      expect(await hasUnrestoredOverCap(DOC)).toBe(false)
    })

    it('merges rejections so two divergent clients each leave a floor', async () => {
      // Two replicas (or two clients) reject with different clients.
      await recordUnrestoredOverCap(DOC, { '1': 100 })
      await recordUnrestoredOverCap(DOC, { '2': 50 })

      // A store carrying only one of them is not enough.
      await resolveUnrestoredOverCap(DOC, { '1': 100 })
      expect(await hasUnrestoredOverCap(DOC)).toBe(true)

      // Carrying both clears it.
      await resolveUnrestoredOverCap(DOC, { '1': 100, '2': 50 })
      expect(await hasUnrestoredOverCap(DOC)).toBe(false)
    })

    it('keeps the per-client maximum across re-rejections', async () => {
      await recordUnrestoredOverCap(DOC, { '1': 100 })
      await recordUnrestoredOverCap(DOC, { '1': 80 }) // a lower clock must not lower the floor
      await resolveUnrestoredOverCap(DOC, { '1': 90 })
      expect(await hasUnrestoredOverCap(DOC)).toBe(true)
      await resolveUnrestoredOverCap(DOC, { '1': 100 })
      expect(await hasUnrestoredOverCap(DOC)).toBe(false)
    })

    it('explicit reconcile lifts it without state-vector evidence', async () => {
      await recordUnrestoredOverCap(DOC, { '1': 100 })
      expect(await hasUnrestoredOverCap(DOC)).toBe(true)
      await reconcileUnrestoredOverCap(DOC)
      expect(await hasUnrestoredOverCap(DOC)).toBe(false)
    })

    it('never creates a marker for an empty rejection (no phantom protection)', async () => {
      await recordUnrestoredOverCap(DOC, {})
      expect(await hasUnrestoredOverCap(DOC)).toBe(false)
    })
  })

  describe('wiring through markOversized', () => {
    it('markOversized with a state vector arms the durable marker; without one it does not', async () => {
      markOversized(DOC, 18_320_896, 10_485_760, { '1': 100 })
      await flush()
      expect(await hasUnrestoredOverCap(DOC)).toBe(true)

      const OTHER = 'octo:s1:f_default:d_noSV'
      markOversized(OTHER, 18_320_896, 10_485_760) // legacy call: write-guard only
      await flush()
      expect(await hasUnrestoredOverCap(OTHER)).toBe(false)
    })
  })

  /**
   * MR98-005: the marker's Redis updates must be ATOMIC. Two replicas holding
   * divergent copies of the same document (measured in production 2026-08-25)
   * hit the size gate on their own cadence, so record/record and record/resolve
   * interleave for real. The old GET -> merge -> SET / GET -> check -> DEL splits
   * lost a floor on a stale read; the fix collapses each into a single EVAL.
   *
   * The double runs each script synchronously, exactly as Redis serialises EVAL,
   * so `Promise.all` here models the production interleaving. Reverting the source
   * to the split read-modify-write would let these same drivers interleave at the
   * await boundary and drop a floor — which is what these tests would then catch.
   */
  describe('MR98-005 — atomic marker updates survive concurrent replicas', () => {
    it('record/record: two replicas rejecting concurrently keep BOTH floors', async () => {
      await Promise.all([
        recordUnrestoredOverCap(DOC, { '1': 100 }), // R1 rejects with client A
        recordUnrestoredOverCap(DOC, { '2': 200 }), // R2 rejects with client B
      ])
      // A store carrying only ONE of the two clients must NOT clear the marker —
      // proof that neither floor was eaten by the other's concurrent write.
      expect(await resolveUnrestoredOverCap(DOC, { '1': 100 })).toBe('kept')
      expect(await resolveUnrestoredOverCap(DOC, { '2': 200 })).toBe('kept')
      // Only a store dominating BOTH clears it.
      expect(await resolveUnrestoredOverCap(DOC, { '1': 100, '2': 200 })).toBe('cleared')
      expect(await hasUnrestoredOverCap(DOC)).toBe(false)
    })

    it('record/resolve: a stale resolve does not wholesale-delete a concurrently-extended marker', async () => {
      await recordUnrestoredOverCap(DOC, { '1': 100 }) // A already recorded

      // A clean replica resolves reading only A (its store dominates A) while a
      // concurrent rejection adds B. Under the old GET -> check -> DEL split the
      // resolve could DEL the whole {A,B} on its stale read of {A}, dropping B.
      await Promise.all([
        resolveUnrestoredOverCap(DOC, { '1': 100 }),
        recordUnrestoredOverCap(DOC, { '2': 200 }),
      ])

      // Whatever the order, B@200 is still required afterwards:
      //   resolve-then-record: A cleared, marker re-armed to {B}
      //   record-then-resolve: marker is {A,B}, resolve keeps it (B undominated)
      // so B's floor SURVIVES and a store lacking it cannot clear the marker.
      expect(await hasUnrestoredOverCap(DOC)).toBe(true)
      expect(await resolveUnrestoredOverCap(DOC, { '1': 100 })).not.toBe('cleared')
      expect(await hasUnrestoredOverCap(DOC)).toBe(true)

      // A store that DOES carry B@200 clears it — B was never lost, only guarded.
      expect(await resolveUnrestoredOverCap(DOC, { '1': 100, '2': 200 })).toBe('cleared')
      expect(await hasUnrestoredOverCap(DOC)).toBe(false)
    })

    it('resolve without dominance still clears nothing (atomic path preserves fail-closed)', async () => {
      await recordUnrestoredOverCap(DOC, { '1': 100 })
      expect(await resolveUnrestoredOverCap(DOC, { '2': 5 })).toBe('kept')
      expect(await hasUnrestoredOverCap(DOC)).toBe(true)
    })
  })
})
