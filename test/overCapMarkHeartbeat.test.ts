/**
 * MR98-003: the over-cap interlock must not lapse while the document is still
 * over cap, even after the editing client goes idle and the document unloads.
 *
 * THE HOLE THESE TESTS PIN. The shared over-cap mark used to be refreshed ONLY
 * by a fresh rejected store. That assumption ("a document over the cap is being
 * rejected continuously, so the mark cannot lapse") holds only while someone is
 * actively editing. The everyday sequence that breaks it:
 *
 *   1. A store is rejected for size — the mark is written, TTL 1h.
 *   2. The client goes idle (lunch, overnight): no more rejected stores, so
 *      nothing refreshes the mark.
 *   3. Hocuspocus unloads the document after ~30s idle, clearing even the source
 *      replica's LOCAL guard (`clearOversized`).
 *   4. After 1h the shared mark's TTL lapses while the document is STILL over cap
 *      (the rejected writes were never persisted; the in-memory copy is gone).
 *   5. The client returns: no local mark, `isOverCapAnywhere` now false, but the
 *      compaction stamp is still present -> the token is stamped and the join
 *      sends `doc.cache-stale` -> the client deletes its IndexedDB cache, which
 *      was the ONLY copy of everything typed since the cap was hit. Work lost.
 *
 * THE FIX. `oversizeGuard` keeps the over-cap CONDITION in a durable set that
 * survives unload, and a heartbeat re-mirrors it to Redis well within the TTL.
 * The mark therefore tracks the condition, not the last store attempt, and only
 * a successful store (persistence.store -> clearOversized + clearOverCapResolved
 * + clearOverCapShared) lets it go.
 *
 * These tests use a TTL-AWARE Redis double driven by fake timers, so the 1h
 * expiry is modelled for real: without the heartbeat the mark genuinely lapses
 * (the control test proves it), so the primary tests cannot be falsely green.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * In-memory Redis double that HONOURS key TTLs against the fake clock.
 *
 * The existing over-cap doubles stub `expire` as a no-op, which is fine for the
 * cross-replica tests but useless here: the whole point is that a mark expires
 * after 1h unless something refreshes it. So this one records `EX` / `expire`
 * deadlines and prunes on read, exactly as Redis would.
 */
const strings = new Map<string, { v: string; expireAt: number | null }>()
const hashes = new Map<string, { fields: Map<string, string>; expireAt: number | null }>()

function alive(expireAt: number | null): boolean {
  return expireAt === null || expireAt > Date.now()
}
function deadlineFromEx(args: unknown[]): number | null {
  // set(key, value, 'EX', seconds): pull the seconds if present.
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
      return 0
    },
  }),
  rkey: (...parts: string[]) => parts.join(':'),
}))

const {
  clearOverCapShared,
  isOverCapAnywhere,
  compactedAt,
  markCompacted,
  noticeStaleCacheOnJoin,
  OVER_CAP_TTL_SECONDS,
} = await import('../src/collab/compactionNotice.js')
const {
  markOversized,
  clearOversized,
  clearOverCapResolved,
  getOversized,
  startOverCapHeartbeat,
  resetOversizedForTest,
} = await import('../src/collab/oversizeGuard.js')
const { attachCompactedAtForTest } = await import('../src/auth/issueCollabToken.js')

const DOC = 'octo:s1:f_default:d_idle'
const STAMP = 1_756_000_000_000
const CAP = 10_485_760
const OVER = 10_556_162
const PAST_TTL_MS = OVER_CAP_TTL_SECONDS * 1000 * 3 // three fallback-TTL windows

const tokenEnvelope = () => ({ token: 't', expiresAt: 'x', role: 'writer' as const, permission_epoch: 3 })

/** Drain the short async chain markOversized's fire-and-forget mirror leaves. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

let stopHeartbeat: (() => void) | null = null

describe('over-cap mark survives an idle client past the fallback TTL (MR98-003)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(STAMP)
    strings.clear()
    hashes.clear()
    resetOversizedForTest()
  })

  afterEach(() => {
    stopHeartbeat?.()
    stopHeartbeat = null
    vi.useRealTimers()
  })

  it('the heartbeat keeps the mark live for 3× the TTL with no store, so the token is NOT stamped', async () => {
    // A store was rejected for size: local guard + durable condition + shared mark.
    markOversized(DOC, OVER, CAP)
    await markCompacted(DOC, STAMP) // a compaction stamp exists, so the notice WOULD fire
    await flush()
    expect(await isOverCapAnywhere(DOC)).toBe(true)

    // The client goes idle and Hocuspocus unloads the document: the LOCAL guard is
    // dropped (server.ts afterUnloadDocument), but the condition is unresolved.
    clearOversized(DOC)
    expect(getOversized(DOC)).toBeNull()

    // Time passes far beyond the 1h fallback TTL, with NO successful store. The
    // heartbeat is the only thing refreshing the mark now.
    stopHeartbeat = startOverCapHeartbeat()
    await vi.advanceTimersByTimeAsync(PAST_TTL_MS)

    // The shared mark is still live: the interlock held across the whole idle span.
    expect(await isOverCapAnywhere(DOC)).toBe(true)
    // Guard the guard: the compaction stamp really is still readable, so the only
    // reason the token stays unstamped is the over-cap interlock.
    expect(await compactedAt(DOC)).toBe(STAMP)

    // Token path (issued a full handshake before any frame): NOT stamped.
    const envelope = tokenEnvelope()
    await attachCompactedAtForTest(envelope, DOC)
    expect('compactedAt' in envelope).toBe(false)

    // Frame path: cache-stale stays suppressed too.
    const sent: string[] = []
    expect(await noticeStaleCacheOnJoin(DOC, /* isOverCap (local) */ false, (p) => sent.push(p))).toBe(
      false,
    )
    expect(sent).toEqual([])
  })

  it('CONTROL: without the heartbeat the same mark lapses after the TTL — this is the hole', async () => {
    // Identical setup, but nothing refreshes the mark. This proves the double
    // really models the 1h expiry, so the test above is not passing by accident.
    markOversized(DOC, OVER, CAP)
    await markCompacted(DOC, STAMP)
    await flush()
    clearOversized(DOC)
    expect(await isOverCapAnywhere(DOC)).toBe(true)

    await vi.advanceTimersByTimeAsync(PAST_TTL_MS) // no heartbeat started

    // The mark has lapsed even though the document is still over cap — exactly the
    // data-loss gap MR98-003 describes. The primary test above closes it.
    expect(await isOverCapAnywhere(DOC)).toBe(false)
    const envelope = tokenEnvelope()
    await attachCompactedAtForTest(envelope, DOC)
    expect(envelope).toMatchObject({ compactedAt: STAMP })
  })

  it('interlock holds across unload + reconnect and lifts ONLY when a store finally succeeds', async () => {
    // Over cap, nothing persisted, then unloaded with the condition unresolved.
    markOversized(DOC, OVER, CAP)
    await markCompacted(DOC, STAMP)
    await flush()
    clearOversized(DOC) // unload
    stopHeartbeat = startOverCapHeartbeat()

    // A long idle span — well past the TTL — while the client is away.
    await vi.advanceTimersByTimeAsync(PAST_TTL_MS)

    // The client reconnects. The token still must not be stamped and the join
    // must not clear the cache: the document is still over cap.
    expect(await isOverCapAnywhere(DOC)).toBe(true)
    const onReconnect = tokenEnvelope()
    await attachCompactedAtForTest(onReconnect, DOC)
    expect('compactedAt' in onReconnect).toBe(false)

    // The reconnecting client re-inflates its over-cap cache and its store is
    // rejected again — re-arming the local guard, exactly as on first rejection.
    markOversized(DOC, OVER, CAP)
    await flush()
    const stillSent: string[] = []
    expect(await noticeStaleCacheOnJoin(DOC, false, (p) => stillSent.push(p))).toBe(false)
    expect(stillSent).toEqual([])

    // The user finally copies work out / deletes rows and a store SUCCEEDS. This
    // is the exact trio persistence.store runs on its success path (persistence.ts):
    // lift the write guard, end the durable condition, retract the shared mark.
    clearOversized(DOC)
    clearOverCapResolved(DOC)
    await clearOverCapShared(DOC)

    // Only now does the interlock lift: a later join can be told its cache is stale.
    expect(await isOverCapAnywhere(DOC)).toBe(false)
    const afterResolve = tokenEnvelope()
    await attachCompactedAtForTest(afterResolve, DOC)
    expect(afterResolve).toMatchObject({ compactedAt: STAMP })

    // And the heartbeat no longer refreshes anything — the condition is gone, so
    // the mark stays clear even after another long span.
    await vi.advanceTimersByTimeAsync(PAST_TTL_MS)
    expect(await isOverCapAnywhere(DOC)).toBe(false)
  })
})
