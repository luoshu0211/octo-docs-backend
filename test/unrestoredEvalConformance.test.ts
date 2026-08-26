/**
 * CONFORMANCE: the JS double in test/helpers/unrestoredEval.ts must behave
 * identically to the real Lua in src/collab/compactionNotice.ts.
 *
 * WHY THIS FILE EXISTS. Every atomicity test in this suite drives the two
 * scripts through an in-memory Redis double, because the doubles cannot run
 * Lua. That makes `evalUnrestored` a second implementation of production
 * logic -- and an unverified second implementation is exactly the failure
 * mode where a fixture whose shape differs from production lets a whole
 * suite pass while the real path is broken. The atomicity tests prove the
 * SHAPE is atomic; this file proves the double they run against is a
 * faithful stand-in for the Lua that actually ships.
 *
 * METHOD. For each case, run the SAME script source and the SAME argv
 * against (a) the JS double over a plain Map, and (b) a real Redis EVAL.
 * Assert both the return value AND the resulting key state match. The Lua
 * source is imported from the production module, not copy-pasted, so a Lua
 * edit that diverges from the double fails here.
 *
 * ON THE OPTIONAL DEPENDENCY. CI's `build` job declares no services (see
 * .gitlab-ci.yml), so a real Redis is not available there and MUST NOT be a
 * hard requirement -- making it one turns a green pipeline red for a reason
 * that has nothing to do with the code under review. But "skip when absent"
 * is how a suite quietly becomes decorative, so the skip is deliberately
 * loud rather than silent:
 *
 *   - the cross-check cases skip individually, so the report shows exactly
 *     how many comparisons did NOT run;
 *   - a sentinel case fails outright if CONFORMANCE_REQUIRE_REDIS=1, which
 *     is how you assert locally that the comparison really happened;
 *   - the JS-double invariants below run unconditionally, so this file still
 *     carries weight with no Redis at all.
 *
 * Run the real comparison locally with a Redis on 26379 (the repo's compose
 * already exposes one) or point CONFORMANCE_REDIS_URL elsewhere.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Redis from 'ioredis'
import { evalUnrestored, type UnrestoredStringStore } from './helpers/unrestoredEval.js'
import { RECORD_UNRESTORED_LUA_FOR_TEST, RESOLVE_UNRESTORED_LUA_FOR_TEST } from '../src/collab/compactionNotice.js'

const REDIS_URL = process.env.CONFORMANCE_REDIS_URL ?? 'redis://127.0.0.1:26379'

/** Minimal string store backing the JS double, plus a peek for the assertion. */
function makeStore(): UnrestoredStringStore & { peek(key: string): string | null } {
  const m = new Map<string, string>()
  return {
    get: (k) => (m.has(k) ? (m.get(k) as string) : null),
    set: (k, v) => void m.set(k, v),
    del: (k) => void m.delete(k),
    peek: (k) => (m.has(k) ? (m.get(k) as string) : null),
  }
}

/**
 * Compare markers as parsed objects: cjson and JSON.stringify order keys
 * differently, so raw string equality would report false divergence. An
 * unparseable value is returned verbatim (wrapped) rather than throwing --
 * some cases deliberately seed garbage and assert the script LEAVES it alone,
 * and the two sides must still be comparable.
 */
type MarkerState = Record<string, number> | { raw: string } | null

function normalise(raw: string | null): MarkerState {
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { raw }
  }
  if (!parsed || typeof parsed !== 'object') return { raw }
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) out[k] = Number(v)
  return out
}

let redis: Redis | null = null
let reachable = false

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null })
  try {
    await redis.connect()
    await redis.ping()
    reachable = true
  } catch {
    reachable = false
    try { redis.disconnect() } catch { /* already down */ }
    redis = null
  }
}, 20_000)

afterAll(async () => {
  if (redis) {
    try { await redis.disconnect() } catch { /* nothing to close */ }
  }
})

/**
 * Run one case through both implementations. `seed` is the marker value the
 * key starts at (null = absent), exactly as it would be mid-flight.
 */
async function bothWays(
  lua: string,
  seed: string | null,
  argv: string[],
): Promise<{ js: { ret: number; state: MarkerState }; redis: { ret: number; state: MarkerState } }> {
  const key = `conformance:${Math.random().toString(36).slice(2)}`

  const store = makeStore()
  if (seed !== null) store.set(key, seed, 60)
  const jsRet = evalUnrestored(lua, key, argv, store)
  const jsState = normalise(store.peek(key))

  const r = redis as Redis
  await r.del(key)
  if (seed !== null) await r.set(key, seed, 'EX', 60)
  const redisRet = Number(await r.eval(lua, 1, key, ...argv))
  const redisState = normalise(await r.get(key))
  await r.del(key)

  return { js: { ret: jsRet, state: jsState }, redis: { ret: redisRet, state: redisState } }
}

/**
 * The cross-check cases. `it.skip` (not a silent early return) so an absent
 * Redis shows up in the report as a precise count of comparisons that did not
 * run, instead of masquerading as passes.
 */
/**
 * NOTE ON TIMING -- this bit me once, do not "simplify" it back.
 * A wrapper that branches on `reachable` at call time is evaluated while the
 * module is still being collected, BEFORE beforeAll has run, so `reachable` is
 * always false and every cross-check silently skips even with Redis up. That
 * failure is invisible: the suite reports green. `it.skipIf` takes a lazy
 * predicate that vitest evaluates at RUN time, after beforeAll, which is the
 * only reason these cases actually execute.
 */
const itIfRedis = (name: string, fn: () => Promise<void>) =>
  it(name, async (ctx) => {
    // Evaluated at RUN time (after beforeAll), unlike a wrapper or a skipIf
    // predicate computed while the module is being collected.
    if (!reachable) {
      ctx.skip(`no Redis at ${REDIS_URL}`)
      return
    }
    await fn()
  })

describe('CONFORMANCE: JS double vs real Lua (unrestored-marker scripts)', () => {
  it('states plainly whether the real-Lua comparison ran', () => {
    if (!reachable) {
      // CI has no Redis service, so absence alone must not fail the pipeline.
      // Set CONFORMANCE_REQUIRE_REDIS=1 to turn absence into a hard failure --
      // that is how you assert locally that the comparison really happened,
      // rather than trusting a green run that skipped every comparison.
      expect(
        process.env.CONFORMANCE_REQUIRE_REDIS !== '1',
        `CONFORMANCE_REQUIRE_REDIS=1 but no Redis at ${REDIS_URL}: the double is unverified`,
      ).toBe(true)
      return
    }
    expect(reachable).toBe(true)
  })

  describe('RECORD_UNRESTORED', () => {
    const lua = RECORD_UNRESTORED_LUA_FOR_TEST

    itIfRedis('writes a fresh marker when none exists', async () => {
      const { js, redis: rd } = await bothWays(lua, null, [JSON.stringify({ a: 5 }), '60'])
      expect(js).toEqual(rd)
      expect(rd.state).toEqual({ a: 5 })
    })

    itIfRedis('merges per-client maxima, keeping the higher clock on each side', async () => {
      const { js, redis: rd } = await bothWays(
        lua,
        JSON.stringify({ a: 9, b: 2 }),
        [JSON.stringify({ a: 4, b: 7, c: 1 }), '60'],
      )
      expect(js).toEqual(rd)
      // a keeps the stored 9 (higher), b takes the incoming 7, c is new.
      expect(rd.state).toEqual({ a: 9, b: 7, c: 1 })
    })

    itIfRedis('writes no phantom marker when the merge is empty', async () => {
      const { js, redis: rd } = await bothWays(lua, null, [JSON.stringify({}), '60'])
      expect(js).toEqual(rd)
      expect(rd.ret).toBe(0)
      expect(rd.state).toBeNull()
    })

    itIfRedis('drops non-positive and non-finite clocks exactly as parseStateVector does', async () => {
      const { js, redis: rd } = await bothWays(
        lua,
        null,
        [JSON.stringify({ ok: 3, zero: 0, neg: -4, nan: 'xyz', nul: null }), '60'],
      )
      expect(js).toEqual(rd)
      expect(rd.state).toEqual({ ok: 3 })
    })

    itIfRedis('treats an unparseable stored marker as empty rather than throwing', async () => {
      const { js, redis: rd } = await bothWays(lua, 'not-json-at-all', [JSON.stringify({ a: 2 }), '60'])
      expect(js).toEqual(rd)
      expect(rd.state).toEqual({ a: 2 })
    })

    itIfRedis('treats an unparseable argv as empty rather than throwing', async () => {
      const { js, redis: rd } = await bothWays(lua, JSON.stringify({ a: 2 }), ['}{bad', '60'])
      expect(js).toEqual(rd)
      expect(rd.state).toEqual({ a: 2 })
    })

    itIfRedis('sets a TTL on the marker (it must not become immortal)', async () => {
      if (!reachable) return
      const r = redis as Redis
      const key = `conformance:ttl:${Math.random().toString(36).slice(2)}`
      await r.del(key)
      await r.eval(lua, 1, key, JSON.stringify({ a: 1 }), '77')
      const ttl = await r.ttl(key)
      await r.del(key)
      expect(ttl).toBeGreaterThan(0)
      expect(ttl).toBeLessThanOrEqual(77)
    })
  })

  describe('RESOLVE_UNRESTORED', () => {
    const lua = RESOLVE_UNRESTORED_LUA_FOR_TEST

    itIfRedis('returns 0 when there is no marker', async () => {
      const { js, redis: rd } = await bothWays(lua, null, [JSON.stringify({ a: 9 })])
      expect(js).toEqual(rd)
      expect(rd.ret).toBe(0)
    })

    itIfRedis('clears (1) when the persisted vector dominates every recorded clock', async () => {
      const { js, redis: rd } = await bothWays(
        lua,
        JSON.stringify({ a: 3, b: 4 }),
        [JSON.stringify({ a: 3, b: 9, c: 1 })],
      )
      expect(js).toEqual(rd)
      expect(rd.ret).toBe(1)
      expect(rd.state).toBeNull()
    })

    itIfRedis('keeps (2) when one recorded client is not dominated', async () => {
      const { js, redis: rd } = await bothWays(
        lua,
        JSON.stringify({ a: 3, b: 8 }),
        [JSON.stringify({ a: 3, b: 7 })],
      )
      expect(js).toEqual(rd)
      expect(rd.ret).toBe(2)
      expect(rd.state).toEqual({ a: 3, b: 8 })
    })

    itIfRedis('keeps (2) when a recorded client is absent from the persisted vector', async () => {
      const { js, redis: rd } = await bothWays(lua, JSON.stringify({ a: 3 }), [JSON.stringify({ z: 99 })])
      expect(js).toEqual(rd)
      expect(rd.ret).toBe(2)
      expect(rd.state).toEqual({ a: 3 })
    })

    itIfRedis('returns 0 for a marker whose entries are all invalid, and leaves it alone', async () => {
      const { js, redis: rd } = await bothWays(lua, JSON.stringify({ a: 0, b: -1 }), [JSON.stringify({ a: 5 })])
      expect(js).toEqual(rd)
      expect(rd.ret).toBe(0)
    })

    itIfRedis('treats an unparseable marker as absent (0)', async () => {
      const { js, redis: rd } = await bothWays(lua, '<<garbage>>', [JSON.stringify({ a: 5 })])
      expect(js).toEqual(rd)
      expect(rd.ret).toBe(0)
    })

    itIfRedis('treats an unparseable persisted vector as empty, so a live marker is kept', async () => {
      const { js, redis: rd } = await bothWays(lua, JSON.stringify({ a: 5 }), ['not json'])
      expect(js).toEqual(rd)
      expect(rd.ret).toBe(2)
      expect(rd.state).toEqual({ a: 5 })
    })
  })

  /**
   * These run with or without Redis. They cannot prove the double MATCHES the
   * Lua -- only the cross-checks above do that -- but they do pin the double's
   * own behaviour, so this file still catches a regression in it on a runner
   * with no Redis service (i.e. CI). Without this block, a Redis-less run of
   * this file would assert nothing at all.
   */
  describe('JS double invariants (no Redis required)', () => {
    it('RECORD takes the per-client maximum rather than overwriting', () => {
      const store = makeStore()
      const key = 'k'
      store.set(key, JSON.stringify({ a: 9, b: 2 }), 60)
      evalUnrestored(RECORD_UNRESTORED_LUA_FOR_TEST, key, [JSON.stringify({ a: 4, b: 7 }), '60'], store)
      // `a` must stay 9 (higher already recorded); `b` must rise to 7.
      expect(normalise(store.peek(key))).toEqual({ a: 9, b: 7 })
    })

    it('RECORD writes no marker at all when every clock is invalid', () => {
      const store = makeStore()
      evalUnrestored(RECORD_UNRESTORED_LUA_FOR_TEST, 'k', [JSON.stringify({ a: 0, b: -3 }), '60'], store)
      // A phantom marker here would strand a document as permanently unrestored.
      expect(store.peek('k')).toBeNull()
    })

    it('RESOLVE distinguishes dominated (1) from not-dominated (2) from absent (0)', () => {
      const lua = RESOLVE_UNRESTORED_LUA_FOR_TEST

      const dominated = makeStore()
      dominated.set('k', JSON.stringify({ a: 3 }), 60)
      expect(evalUnrestored(lua, 'k', [JSON.stringify({ a: 5 })], dominated)).toBe(1)
      expect(dominated.peek('k')).toBeNull()

      const notDominated = makeStore()
      notDominated.set('k', JSON.stringify({ a: 8 }), 60)
      expect(evalUnrestored(lua, 'k', [JSON.stringify({ a: 7 })], notDominated)).toBe(2)
      expect(normalise(notDominated.peek('k'))).toEqual({ a: 8 })

      expect(evalUnrestored(lua, 'k', [JSON.stringify({ a: 7 })], makeStore())).toBe(0)
    })

    it('RESOLVE keeps a marker when the persisted vector is unparseable', () => {
      const store = makeStore()
      store.set('k', JSON.stringify({ a: 5 }), 60)
      // Garbage must not be read as "everything is dominated" and clear it.
      expect(evalUnrestored(RESOLVE_UNRESTORED_LUA_FOR_TEST, 'k', ['not json'], store)).toBe(2)
      expect(normalise(store.peek('k'))).toEqual({ a: 5 })
    })
  })
})
