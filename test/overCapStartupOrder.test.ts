/**
 * MR98-008 (startup ordering): the guard must be ARMED before traffic that can
 * read the stamp it protects is served.
 *
 * The durable bottom (MR98-006) makes a rejected over-cap state vector survive a
 * SIGKILLed pod by writing it to `overcap_unrestored`. A replacement replica
 * reconciles those rows into the Redis marker. But reconciling is USELESS if the
 * replica accepts joins/token requests while that drain is still in flight:
 *
 *   dead pod's row in DB, not yet in Redis
 *     -> isOverCapAnywhere: unrestored marker absent, legacy key absent,
 *        dead pod's per-replica field lapsed on its 1h TTL   -> false
 *     -> compactedAt still returns the surviving stamp
 *     -> the frame rides the token/join and the browser deletes the IndexedDB
 *        copy holding the refused edits.
 *
 * That is the module's own MR98-007 invariant violated at boot: "the guard must
 * be armed for the stamp it protects, or the stamp must not exist".
 *
 * These tests pin BOTH halves of the fix:
 *   (a) the window is REAL — a join racing an undrained row loses the cache
 *       (CONTROL, reproduces the pre-fix loss);
 *   (b) `reconcileDurableUnrestored` never rejects, on any infra failure —
 *       this is what makes AWAITING it at startup safe rather than a new
 *       crashloop (the reviewer's stated premise, verified here, not assumed);
 *   (c) src/index.ts actually awaits it BEFORE hocuspocus.listen() — the
 *       ordering itself, which no behavioural test in this suite can see.
 *
 * Doubles mirror test/overCapDurableRetry.test.ts: a toggleable Redis double and
 * an in-memory pool double backing the REAL `overcapUnrestoredRepo`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { evalUnrestored } from './helpers/unrestoredEval.js'

// ----- Redis double (TTL-aware, toggleable) --------------------------------
let redisDown = false
function redisGuard(): void {
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
      redisGuard()
      return getString(k)
    },
    set: async (k: string, v: string, ...args: unknown[]) => {
      redisGuard()
      strings.set(k, { v, expireAt: deadlineFromEx(args) })
      return 'OK'
    },
    del: async (k: string) => {
      redisGuard()
      const had = strings.delete(k) || hashes.delete(k)
      return had ? 1 : 0
    },
    hset: async (k: string, f: string, v: string) => {
      redisGuard()
      const e = hashes.get(k) ?? { fields: new Map<string, string>(), expireAt: null }
      e.fields.set(f, v)
      hashes.set(k, e)
      return 1
    },
    hdel: async (k: string, ...fields: string[]) => {
      redisGuard()
      const e = hashes.get(k)
      if (!e) return 0
      let n = 0
      for (const f of fields) if (e.fields.delete(f)) n += 1
      return n
    },
    hgetall: async (k: string) => {
      redisGuard()
      return Object.fromEntries(getHash(k) ?? new Map())
    },
    eval: async (script: string, _numKeys: number, key: string, ...argv: string[]) => {
      redisGuard()
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
      redisGuard()
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

// ----- Database double ------------------------------------------------------
//
// Module-level so it SURVIVES `resetOversizedForTest`: the database outliving
// the process is the property under test. `listGate` lets a test hold the
// reconcile's very first DB round-trip open — that pending promise IS the
// startup window a racing join would land in.
let dbDown = false
let listGate: Promise<void> | null = null
const table = new Map<string, string>() // document_name -> state_vector JSON

async function runSql(sql: string, params: unknown[] = []): Promise<unknown[]> {
  if (dbDown) throw new Error('db down')
  const s = sql.trim()
  if (s.startsWith('SELECT document_name')) {
    if (listGate) await listGate
    return Array.from(table.entries()).map(([document_name, state_vector]) => ({ document_name, state_vector }))
  }
  if (s.startsWith('SELECT state_vector')) {
    const v = table.get(params[0] as string)
    return v === undefined ? [] : [{ state_vector: v }]
  }
  if (s.startsWith('INSERT')) {
    table.set(params[0] as string, params[1] as string)
    return []
  }
  if (s.startsWith('UPDATE')) {
    table.set(params[1] as string, params[0] as string)
    return []
  }
  if (s.startsWith('DELETE')) {
    table.delete(params[0] as string)
    return []
  }
  throw new Error(`unhandled sql in double: ${s}`)
}

vi.mock('../src/db/pool.js', () => ({
  query: async (sql: string, params?: unknown[]) => runSql(sql, params ?? []),
  transaction: async (fn: (tx: { query: (sql: string, params?: unknown[]) => Promise<unknown[]> }) => Promise<unknown>) =>
    fn({ query: async (sql: string, params?: unknown[]) => runSql(sql, params ?? []) }),
}))

const { isOverCapAnywhere, hasUnrestoredOverCap, markCompacted, OVER_CAP_TTL_SECONDS } = await import(
  '../src/collab/compactionNotice.js'
)
const { markOversized, reconcileDurableUnrestored, setUnrestoredDurableStore, resetOversizedForTest } = await import(
  '../src/collab/oversizeGuard.js'
)
const { overcapUnrestoredRepo } = await import('../src/db/repos/overcapUnrestoredRepo.js')
const { attachCompactedAtForTest } = await import('../src/auth/issueCollabToken.js')

const DOC = 'octo:s1:f_default:d_startup'
const STAMP = 1_756_000_000_000
const CAP = 10_485_760
const OVER = 10_556_162
const PAST_REPLICA_TTL_MS = OVER_CAP_TTL_SECONDS * 1000 * 3

const tokenEnvelope = () => ({ token: 't', expiresAt: 'x', role: 'writer' as const, permission_epoch: 3 })

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}

/**
 * Put the fleet in the exact post-death state: a compaction stamp stands, the
 * rejected vector is durable in the DB only, the dead pod's per-replica field
 * has lapsed, and this process has no in-memory queue.
 */
async function bootReplacementReplicaState(): Promise<void> {
  await markCompacted(DOC, STAMP)
  redisDown = true
  markOversized(DOC, OVER, CAP, { '1': 100 })
  await flush()
  redisDown = false
  expect(table.size).toBe(1) // durable row landed; no Redis marker exists
  resetOversizedForTest() // the pod is SIGKILLed: process memory evaporates
  await vi.advanceTimersByTimeAsync(PAST_REPLICA_TTL_MS) // its 1h field lapses
  setUnrestoredDurableStore(overcapUnrestoredRepo) // the replacement wires the store
}

describe('MR98-008 startup ordering — the guard must be armed before traffic is served', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(STAMP)
    redisDown = false
    dbDown = false
    listGate = null
    strings.clear()
    hashes.clear()
    table.clear()
    resetOversizedForTest()
    setUnrestoredDurableStore(overcapUnrestoredRepo)
  })
  afterEach(() => {
    setUnrestoredDurableStore(null)
    redisDown = false
    dbDown = false
    listGate = null
    vi.useRealTimers()
  })

  /**
   * 这条原本是 CONTROL（负控）：证明"reconcile 还在飞、记录尚未进 Redis 时，
   * token 照样带着代际戳下发"这个洞真实存在，期望 `compactedAt: STAMP`。
   *
   * MR98-010 把这个洞堵上了 —— `mayInvalidateClientCaches()` 在本进程完成一次
   * 完整 reconcile 之前一律不放行，所以这个场景不会再发生，负控自然不再成立。
   * 期望随之反转。
   *
   * 【判别力去哪了】：负控原本的作用是证明判据不是恒真。那个职责现在由变异验证
   * 承担 —— 去掉 token 闸门 / 去掉 frame 闸门 / list 失败仍报成功 / 部分镜像也算成功，
   * 四个变异体各拉红一条用例。下面这行断言不是"恒绿"的。
   */
  it('a join landing while the reconcile is still in flight is refused the stamp', async () => {
    await bootReplacementReplicaState()

    // The replacement replica starts the drain but does NOT await it (the
    // pre-fix `void reconcileDurableUnrestored()`), and accepts traffic now.
    let openGate: () => void = () => {}
    listGate = new Promise<void>((resolve) => {
      openGate = resolve
    })
    const inFlight = reconcileDurableUnrestored()
    await flush()

    // Traffic arrives inside the window: the durable row is real, but nothing
    // has reached Redis yet.
    expect(await hasUnrestoredOverCap(DOC)).toBe(false)
    expect(await isOverCapAnywhere(DOC)).toBe(false)
    const envelope = tokenEnvelope()
    await attachCompactedAtForTest(envelope, DOC)
    // 修复后：戳发不出去。浏览器那份持有被拒编辑的 IndexedDB 副本得以保留。
    expect(envelope.compactedAt).toBeUndefined()

    openGate()
    await inFlight
  })

  it('awaiting the reconcile BEFORE serving arms the guard: the same join is refused the stamp', async () => {
    await bootReplacementReplicaState()

    // The fix: the drain completes before any traffic is accepted.
    await reconcileDurableUnrestored()

    expect(await hasUnrestoredOverCap(DOC)).toBe(true)
    expect(await isOverCapAnywhere(DOC)).toBe(true)
    const envelope = tokenEnvelope()
    await attachCompactedAtForTest(envelope, DOC)
    expect(envelope).not.toHaveProperty('compactedAt')
  })

  // --- the premise that makes `await` safe, verified rather than assumed -----

  // 返回值从 void 变成成败标志（MR98-010）。这几条测的意图不变 —— 不抛错、行留着 ——
  // 只是"报告失败"现在有了明确的表达方式，而不再是静默 return。
  it('never rejects when the DB refuses the list (rows stay for the heartbeat)', async () => {
    await bootReplacementReplicaState()
    dbDown = true
    await expect(reconcileDurableUnrestored()).resolves.toBe(false)
    dbDown = false
    // Nothing was consumed: the row is still there for the next pass.
    expect(table.size).toBe(1)
  })

  it('never rejects when Redis refuses the record (row is left, not dropped)', async () => {
    await bootReplacementReplicaState()
    redisDown = true
    await expect(reconcileDurableUnrestored()).resolves.toBe(false)
    redisDown = false
    expect(table.size).toBe(1)
  })

  it('never rejects when BOTH the DB and Redis are down — an unhealthy boot degrades to a no-op, not a crashloop', async () => {
    await bootReplacementReplicaState()
    dbDown = true
    redisDown = true
    await expect(reconcileDurableUnrestored()).resolves.toBe(false)
  })

  it('never rejects with no durable store wired at all', async () => {
    setUnrestoredDurableStore(null)
    await expect(reconcileDurableUnrestored()).resolves.toBe(true)
  })

  // --- the ordering itself ---------------------------------------------------
  //
  // No behavioural test in this process can see src/index.ts's statement order,
  // and that order IS the bug. Pin it structurally so moving the call back below
  // listen() — or dropping the await — goes red.

  it('src/index.ts awaits reconcileDurableUnrestored BEFORE hocuspocus.listen()', () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

    const reconcileIdx = src.indexOf('await reconcileDurableUnrestored()')
    const listenIdx = src.indexOf('await hocuspocus.listen()')

    // Calibrate the probe: both anchors must actually be found, or "-1 < n"
    // would pass vacuously.
    expect(listenIdx).toBeGreaterThan(-1)
    expect(reconcileIdx).toBeGreaterThan(-1)
    expect(reconcileIdx).toBeLessThan(listenIdx)

    // And it must not be fire-and-forget: `void` returns before the drain lands.
    expect(src).not.toContain('void reconcileDurableUnrestored()')
  })

  it('src/index.ts wires the durable store before it reconciles from it', () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    const wireIdx = src.indexOf('setUnrestoredDurableStore(overcapUnrestoredRepo)')
    const reconcileIdx = src.indexOf('await reconcileDurableUnrestored()')
    expect(wireIdx).toBeGreaterThan(-1)
    expect(reconcileIdx).toBeGreaterThan(-1)
    expect(wireIdx).toBeLessThan(reconcileIdx)
  })
})
