/**
 * MR98-006 (durable bottom): the retry CARRIER itself must survive replica death.
 *
 * The in-memory retry queue fixed the "alive replica" blip — a Redis failure at
 * the moment of a rejection no longer silently drops the record while the process
 * lives. But that queue is PROCESS MEMORY, and the proven failure shape of this
 * system is the pod dying (SIGKILL/OOM — 23 SIGKILL-137s in the 2026-08-21
 * incident) DURING the outage window, before Redis recovers. Then the queue
 * evaporates with the process, the per-replica field lapses on its 1h TTL, and
 * `isOverCapAnywhere` finds nothing while the compaction stamp still stands — the
 * browser is told to delete its only copy (MR98-003, reopened on the write path).
 *
 * THE FIX these tests pin: the rejected state vector is ALSO written to a durable,
 * replica-independent database record AT REJECTION TIME. A fresh replica (or the
 * 10-minute heartbeat) reconciles that record into the Redis marker through the
 * SAME atomic RECORD script; the row is removed only once the marker lands or a
 * dominating store clears it.
 *
 * Doubles: a TTL-aware, toggleable Redis double (the 1h per-replica expiry is
 * modelled on fake timers, and "Redis down" makes every op throw) and an
 * in-memory pool double backing the REAL `overcapUnrestoredRepo`. The DB double's
 * table is module-level and is NOT cleared by `resetOversizedForTest`, which is
 * exactly the property under test: the database outlives the process.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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

// ----- Database double (in-memory table backing the REAL repo) -------------
//
// Module-level so it SURVIVES `resetOversizedForTest` — the database outliving
// the process is the whole point. Toggleable down to model a DB blip.
let dbDown = false
const table = new Map<string, string>() // document_name -> state_vector JSON

async function runSql(sql: string, params: unknown[] = []): Promise<unknown[]> {
  if (dbDown) throw new Error('db down')
  const s = sql.trim()
  if (s.startsWith('SELECT document_name')) {
    return Array.from(table.entries()).map(([document_name, state_vector]) => ({ document_name, state_vector }))
  }
  if (s.startsWith('SELECT state_vector')) {
    const v = table.get(params[0] as string)
    return v === undefined ? [] : [{ state_vector: v }]
  }
  if (s.startsWith('INSERT IGNORE')) {
    // Idempotent seed: only creates the row when absent, never clobbers a
    // present one (mirrors real INSERT IGNORE). The literal '{}' is inline SQL,
    // so params carries only the document_name.
    if (!table.has(params[0] as string)) table.set(params[0] as string, '{}')
    return []
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

const {
  isOverCapAnywhere,
  hasUnrestoredOverCap,
  markCompacted,
  compactedAt,
  noticeStaleCacheOnJoin,
  markOverCapShared,
  OVER_CAP_TTL_SECONDS,
} = await import('../src/collab/compactionNotice.js')
const {
  markOversized,
  resolvePendingUnrestored,
  resolveDurableUnrestored,
  reconcileDurableUnrestored,
  flushUnrestoredRetries,
  refreshSharedOverCapMarks,
  pendingUnrestoredCount,
  startOverCapHeartbeat,
  setUnrestoredDurableStore,
  resetOversizedForTest,
  resetDurableReconcileForTest,
  durablePendingCountForTest,
  redisFailureObservedForTest,
} = await import('../src/collab/oversizeGuard.js')
const { overcapUnrestoredRepo } = await import('../src/db/repos/overcapUnrestoredRepo.js')
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

describe('MR98-006 durable bottom — the retry carrier survives replica death', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(STAMP)
    redisDown = false
    dbDown = false
    strings.clear()
    hashes.clear()
    table.clear()
    resetOversizedForTest()
    resetDurableReconcileForTest()
    // A fresh replica boots with the durable store wired (index.ts does this).
    setUnrestoredDurableStore(overcapUnrestoredRepo)
  })
  afterEach(() => {
    stopHeartbeat?.()
    stopHeartbeat = null
    setUnrestoredDurableStore(null)
    redisDown = false
    dbDown = false
    vi.useRealTimers()
  })

  it('Redis down at rejection -> replica dies BEFORE Redis recovers -> a fresh replica reconciles from the DB -> protection holds', async () => {
    await markCompacted(DOC, STAMP)

    // (1) Redis blips at the EXACT moment of the rejection. The DB is up (we are
    // on the persistence path), so the durable record lands in the database even
    // though nothing reaches Redis.
    redisDown = true
    markOversized(DOC, OVER, CAP, { '1': 100 })
    await flush()
    expect(table.size).toBe(1) // durable DB record written AT rejection time
    expect(pendingUnrestoredCount()).toBe(1) // in-memory fast path also holds it

    // (2) The pod is SIGKILLed while Redis is STILL down: in-memory state is gone.
    // The DB record is untouched — the durable bottom does not share the process's
    // fate.
    resetOversizedForTest()
    setUnrestoredDurableStore(overcapUnrestoredRepo) // the replacement replica re-wires it
    expect(pendingUnrestoredCount()).toBe(0) // the in-memory retry died with the pod
    expect(table.size).toBe(1) // the durable record survived

    // (3) Redis recovers. There is STILL no marker — nothing has reconciled yet;
    // this is the exact window the in-memory queue could not cover.
    redisDown = false
    expect(await hasUnrestoredOverCap(DOC)).toBe(false)

    // (4) The fresh replica's startup reconcile drains the DB record into the
    // Redis marker through the same atomic RECORD script.
    await reconcileDurableUnrestored()
    expect(await hasUnrestoredOverCap(DOC)).toBe(true)
    expect(table.size).toBe(0) // row trimmed once the marker landed

    // (5) Time passes far beyond the 1h per-replica window (the pod is long gone).
    // The durable marker (30-day TTL) does not lapse.
    await vi.advanceTimersByTimeAsync(PAST_REPLICA_TTL_MS)
    expect(await hasUnrestoredOverCap(DOC)).toBe(true)
    expect(await isOverCapAnywhere(DOC)).toBe(true)
    // Guard the guard: the stamp is still readable, so the ONLY reason the token
    // stays unstamped is the interlock the reconcile rebuilt.
    expect(await compactedAt(DOC)).toBe(STAMP)

    const envelope = tokenEnvelope()
    await attachCompactedAtForTest(envelope, DOC)
    expect('compactedAt' in envelope).toBe(false)

    const sent: string[] = []
    expect(await noticeStaleCacheOnJoin(DOC, false, (p) => sent.push(p))).toBe(false)
    expect(sent).toEqual([])
  })

  it('the over-cap heartbeat tick also reconciles the DB record (not only the explicit startup pass)', async () => {
    // Rejection while Redis is down; the record lands only in the DB. The pod dies.
    redisDown = true
    markOversized(DOC, OVER, CAP, { '1': 100 })
    await flush()
    resetOversizedForTest()
    setUnrestoredDurableStore(overcapUnrestoredRepo)
    redisDown = false
    expect(table.size).toBe(1)

    // No explicit reconcile — only the heartbeat runs. On the SAME tick that
    // refreshes the replica fields it reconciles the durable store.
    stopHeartbeat = startOverCapHeartbeat()
    await vi.advanceTimersByTimeAsync(11 * 60_000)
    expect(await hasUnrestoredOverCap(DOC)).toBe(true)
    expect(table.size).toBe(0)
  })

  it('shutdown flush fails (Redis still down) -> the durable DB record survives and is drained later', async () => {
    redisDown = true
    markOversized(DOC, OVER, CAP, { '1': 100 })
    await flush()
    expect(table.size).toBe(1)
    expect(pendingUnrestoredCount()).toBe(1)

    // Graceful shutdown runs its final in-memory flush, but Redis is still down,
    // so it lands nothing. Durability does NOT depend on this flush — the DB
    // record is untouched.
    await flushUnrestoredRetries()
    expect(table.size).toBe(1)
    expect(table.get(DOC)).toBe(JSON.stringify({ '1': 100 }))

    // The pod exits; a later replica (Redis now up) reconciles the DB record.
    resetOversizedForTest()
    setUnrestoredDurableStore(overcapUnrestoredRepo)
    redisDown = false
    await reconcileDurableUnrestored()
    expect(await hasUnrestoredOverCap(DOC)).toBe(true)
    expect(table.size).toBe(0)
  })

  it('a dominating store clears the durable record, so a later reconcile cannot resurrect a phantom', async () => {
    // Record fails to reach Redis; it lives in the DB (and the in-memory queue).
    redisDown = true
    markOversized(DOC, OVER, CAP, { '1': 100 })
    await flush()
    expect(table.size).toBe(1)
    redisDown = false

    // A genuine recovery: a store whose state DOMINATES the rejection succeeds.
    // The Redis marker was never written (absent), but the durable DB row MUST be
    // cleared, or the next reconcile would rebuild a marker for state already saved.
    resolvePendingUnrestored(DOC, { '1': 100 })
    await resolveDurableUnrestored(DOC, { '1': 100 })
    expect(pendingUnrestoredCount()).toBe(0)
    expect(table.size).toBe(0)

    // The reconcile drains: nothing to write, so no phantom marker appears.
    await reconcileDurableUnrestored()
    expect(await hasUnrestoredOverCap(DOC)).toBe(false)
  })

  it('an UNDOMINATED store does NOT clear the durable record (fail closed)', async () => {
    redisDown = true
    markOversized(DOC, OVER, CAP, { '1': 100 })
    await flush()
    redisDown = false

    // A different client's store does not account for the rejected client, so it
    // may not clear the durable protection.
    await resolveDurableUnrestored(DOC, { '2': 5 })
    expect(table.size).toBe(1)

    // The reconcile then makes the record durable, exactly as it should.
    await reconcileDurableUnrestored()
    expect(await hasUnrestoredOverCap(DOC)).toBe(true)
    expect(table.size).toBe(0)
  })

  it('a DB write failure at rejection time is loud and fail-closed (never silently downgrades protection)', async () => {
    const errs = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Both Redis AND the DB are down at the moment of rejection.
    redisDown = true
    dbDown = true
    markOversized(DOC, OVER, CAP, { '1': 100 })
    await flush()

    // The DB failure is surfaced loudly, not swallowed...
    expect(errs).toHaveBeenCalledWith(expect.stringContaining('durable unrestored-over-cap record'))
    // ...and protection is NOT downgraded: the in-memory retry still holds the
    // vector, so the absence of a durable row can never read as "resolved".
    expect(pendingUnrestoredCount()).toBe(1)
    expect(table.size).toBe(0)
    errs.mockRestore()

    // Once the DB recovers, a re-run of the rejection path persists it durably
    // (the write path degraded while the DB was down, exactly as expected).
    dbDown = false
    markOversized(DOC, OVER, CAP, { '1': 100 })
    await flush()
    expect(table.size).toBe(1)
  })

  it('per-client-max merge in the durable store: a lower re-rejection clock cannot lower a floor', async () => {
    redisDown = true
    markOversized(DOC, OVER, CAP, { '1': 100 })
    await flush()
    markOversized(DOC, OVER, CAP, { '1': 80, '2': 50 }) // A stays at 100; B added
    await flush()
    redisDown = false
    expect(table.get(DOC)).toBe(JSON.stringify({ '1': 100, '2': 50 }))

    await reconcileDurableUnrestored()
    // The durable marker now requires A@100 AND B@50.
    expect(await hasUnrestoredOverCap(DOC)).toBe(true)
  })

  it('CONTROL: with the durable store UNWIRED, the same death-during-outage sequence loses protection', async () => {
    setUnrestoredDurableStore(null) // no durable bottom — the pre-fix world
    await markCompacted(DOC, STAMP)

    // Same blip at rejection: nothing durable is written anywhere.
    redisDown = true
    markOversized(DOC, OVER, CAP, { '1': 100 })
    await flush()
    expect(table.size).toBe(0)

    // The pod dies before Redis recovers; the in-memory queue evaporates.
    resetOversizedForTest()
    redisDown = false

    // A fresh replica reconciles — but there is no durable record to reconcile.
    setUnrestoredDurableStore(null)
    await reconcileDurableUnrestored()
    await vi.advanceTimersByTimeAsync(PAST_REPLICA_TTL_MS)

    // No signal remains — the token is stamped and a join would wipe the cache.
    // This is exactly the data loss the durable bottom prevents above.
    expect(await isOverCapAnywhere(DOC)).toBe(false)
    const envelope = tokenEnvelope()
    await attachCompactedAtForTest(envelope, DOC)
    expect(envelope).toMatchObject({ compactedAt: STAMP })
  })

  it('refreshSharedOverCapMarks drives the reconcile (the heartbeat wiring, not just a standalone call)', async () => {
    redisDown = true
    markOversized(DOC, OVER, CAP, { '1': 100 })
    await flush()
    resetOversizedForTest()
    setUnrestoredDurableStore(overcapUnrestoredRepo)
    redisDown = false
    expect(table.size).toBe(1)

    refreshSharedOverCapMarks()
    await flush()
    expect(await hasUnrestoredOverCap(DOC)).toBe(true)
    expect(table.size).toBe(0)
  })
})

/**
 * MR98-010 —— 启动期 reconcile 失败必须让缓存失效 fail-closed。
 *
 * 缺陷的形状是【await 了一个永远说自己成功的调用】：
 *
 *   reconcileDurableUnrestored   store.list() 抛错 → 记日志 → return（无返回值）
 *   index.ts                     await 它 → 无条件 listen()
 *
 * index.ts 的注释写着 "Awaited (NOT fire-and-forget) precisely to close the startup
 * window"，但同一段注释下一句就承认它 "never throws ... degrades to a logged no-op"。
 * await 一个不会失败的东西，等于没 await —— 窗口原样敞着。
 *
 * 可达链条就是 8/21 那个形状：
 *   副本猝死（当天 23 次 exitCode 137）→ 拒绝记录只剩在 overcap_unrestored 表里
 *   → 新 pod 启动、list() 抖一下 → reconcile 静默"成功" → 开始服务
 *   → Redis 健康但没有超限标记 → attachCompactedAt 读成"这文档没超限"
 *   → 发下 compactedAt → 浏览器删掉自己那份唯一副本
 */
describe('MR98-010 startup reconcile — a failed reconcile must not license cache deletion', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(STAMP)
    redisDown = false
    dbDown = false
    strings.clear()
    hashes.clear()
    table.clear()
    resetOversizedForTest()
    resetDurableReconcileForTest()
    setUnrestoredDurableStore(overcapUnrestoredRepo)
  })
  afterEach(() => {
    setUnrestoredDurableStore(null)
    redisDown = false
    dbDown = false
    vi.useRealTimers()
  })

  /** 失败必须【说出来】。静默 return 让调用方的 await 变成装饰。 */
  it('reports failure when the durable store cannot be read', async () => {
    dbDown = true
    await expect(reconcileDurableUnrestored()).resolves.toBe(false)
  })

  /** 对照：正常情况必须报告成功,否则就只是把闸门永久焊死。 */
  it('reports success on a clean pass', async () => {
    await expect(reconcileDurableUnrestored()).resolves.toBe(true)
  })

  /**
   * 核心：reconcile 没成功过,token 通道就不能发代际戳。
   * 此时 Redis 是【健康】的 —— 只是还没被灌入那些拒绝记录,
   * 所以现有的两道闸门（本地标记 / isOverCapAnywhere）都查不出问题。
   */
  it('withholds compactedAt on the token after a failed startup reconcile', async () => {
    await markCompacted(DOC, STAMP)
    dbDown = true
    await reconcileDurableUnrestored() // 启动时那一跑，失败了
    dbDown = false // 数据库恢复了，但这次启动从未成功 reconcile 过

    const r = tokenEnvelope()
    await attachCompactedAtForTest(r, DOC)
    expect(r.compactedAt).toBeUndefined()
  })

  /** 同一件事的另一个入口：连上来的 socket 也不能收到 doc.cache-stale。 */
  it('withholds the stale-cache frame after a failed startup reconcile', async () => {
    await markCompacted(DOC, STAMP)
    dbDown = true
    await reconcileDurableUnrestored()
    dbDown = false

    const sent: string[] = []
    await expect(noticeStaleCacheOnJoin(DOC, false, (p) => sent.push(p))).resolves.toBe(false)
    expect(sent).toEqual([])
  })

  /**
   * 判据双向标定 —— 这两条必须和上面两条【同时】通过。
   * 只让上面红转绿的话，等于把功能整个关掉，测不出闸门是否有判别力。
   */
  it('resumes issuing compactedAt once a reconcile succeeds', async () => {
    await markCompacted(DOC, STAMP)
    dbDown = true
    await reconcileDurableUnrestored()
    dbDown = false
    await reconcileDurableUnrestored() // 心跳的下一次重试成功了

    const r = tokenEnvelope()
    await attachCompactedAtForTest(r, DOC)
    expect(r.compactedAt).toBe(STAMP)
  })

  it('resumes sending the stale-cache frame once a reconcile succeeds', async () => {
    await markCompacted(DOC, STAMP)
    dbDown = true
    await reconcileDurableUnrestored()
    dbDown = false
    await reconcileDurableUnrestored()

    const sent: string[] = []
    await expect(noticeStaleCacheOnJoin(DOC, false, (p) => sent.push(p))).resolves.toBe(true)
    expect(sent).toHaveLength(1)
  })

  /**
   * 收严的那一条：`list()` 读到了记录,但 Redis 拒绝写入 —— 这些记录【仍然】
   * 不在 isOverCapAnywhere 看得见的地方。把这种"读成功了"当作 reconcile 成功,
   * 就是同一个洞换了个门。所以部分镜像不能 settle。
   */
  it('does NOT settle when Redis refuses to mirror a record it did read', async () => {
    // 隔离很关键：待镜像的记录挂在 DOC 上,而判据要落在【另一个干净文档】上。
    // 用同一个文档的话,`isOverCapAnywhere` 那道旧闸门会先把它拦下 ——
    // 测试照样绿，但绿的原因不是我要验的那道门（第一版就是这么假绿的）。
    const CLEAN = 'octo:s1:f_default:d_clean_bystander'
    redisDown = true
    markOversized(DOC, OVER, CAP)
    await flush()
    redisDown = false
    await reconcileDurableUnrestored()

    // 新进程启动：DB 里还有待镜像的行，而 Redis 拒绝写入。
    table.set(DOC, JSON.stringify({ '1': 5 }))
    resetDurableReconcileForTest()
    redisDown = true

    await expect(reconcileDurableUnrestored()).resolves.toBe(false)

    // Redis 恢复。这个旁观文档自己毫无问题、也没有任何 over-cap 标记 ——
    // 唯一该拦住它的就是"本进程从未完整镜像过"这一条。
    redisDown = false
    await markCompacted(CLEAN, STAMP)
    const r = tokenEnvelope()
    await attachCompactedAtForTest(r, CLEAN)
    expect(r.compactedAt).toBeUndefined()
  })

  /**
   * 没有持久层（durableStore 为 null）时不该 fail-closed：没有待同步的 DB 记录,
   * 也就没有"记录还没进 Redis"这回事。否则未启用该层的部署会永久失去这个功能。
   */
  it('does not fail closed when the durable layer is not wired at all', async () => {
    setUnrestoredDurableStore(null)
    await markCompacted(DOC, STAMP)

    const r = tokenEnvelope()
    await attachCompactedAtForTest(r, DOC)
    expect(r.compactedAt).toBe(STAMP)
  })
})

/**
 * MR98-011 —— 运行期复发。MR98-010 那道门是【一次性】的：`durableReconcileSettled`
 * 一旦 true 就永不回头。但"DB 有行、Redis 没镜像"不是启动期专属状态,它由普通的
 * 拒绝路径在【任意时刻】产生：
 *
 *   markOversized -> rememberUnrestored -> persistDurableUnrestored  (DB 行写下)
 *   markOverCapShared                                                 (Redis 标记失败)
 *
 * 抖动【期间】是安全的 —— isOverCapAnywhere 遇 Redis 错误 fail closed。洞在 Redis
 * 【恢复的那一刻】张开：标记仍未补,而一个启动时已 settle 的副本读到一个健康的、
 * 没有标记的 Redis,于是为这个文档发出 compactedAt —— 而它被拒的那批编辑,唯一的
 * 副本还在浏览器缓存里。
 */
describe('MR98-011 runtime relapse — the gate must re-close, not only settle once', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(STAMP)
    redisDown = false
    dbDown = false
    strings.clear()
    hashes.clear()
    table.clear()
    resetOversizedForTest()
    resetDurableReconcileForTest()
    setUnrestoredDurableStore(overcapUnrestoredRepo)
  })
  afterEach(() => {
    stopHeartbeat?.()
    stopHeartbeat = null
    setUnrestoredDurableStore(null)
    redisDown = false
    dbDown = false
    vi.useRealTimers()
  })

  /**
   * 判据落在【另一个干净文档】上,理由和 MR98-010 那条一样：判据若落在 DOC 自己
   * 身上,`isOverCapAnywhere` 那道旧闸门会先拦下它,测试照样绿但绿错了原因。
   */
  it('a runtime Redis outage re-closes the gate that startup had already settled', async () => {
    const CLEAN = 'octo:s1:f_default:d_clean_bystander'

    // 启动一切正常：门 settle 了。这是和 MR98-010 的关键区别 ——
    // 那条测的是"启动就失败",这条测的是"启动成功之后才出事"。
    await expect(reconcileDurableUnrestored()).resolves.toBe(true)
    await markCompacted(CLEAN, STAMP)
    const before = tokenEnvelope()
    await attachCompactedAtForTest(before, CLEAN)
    expect(before.compactedAt).toBe(STAMP) // 门确实是开的

    // 运行期 Redis 抖动,一个文档被拒:DB 行写下,Redis 标记没落。
    redisDown = true
    markOversized(DOC, OVER, CAP, { '1': 5 })
    await flush()

    // Redis 恢复 —— 一次性门在这一刻会重新放行,这正是 MR98-011 的洞。
    redisDown = false

    const after = tokenEnvelope()
    await attachCompactedAtForTest(after, CLEAN)
    expect(after.compactedAt).toBeUndefined()
  })

  it('withholds the stale-cache frame during the same runtime relapse', async () => {
    const CLEAN = 'octo:s1:f_default:d_clean_frame'
    await expect(reconcileDurableUnrestored()).resolves.toBe(true)

    redisDown = true
    markOversized(DOC, OVER, CAP, { '1': 5 })
    await flush()
    redisDown = false

    const sent: string[] = []
    await expect(noticeStaleCacheOnJoin(CLEAN, false, (p) => sent.push(p))).resolves.toBe(false)
    expect(sent).toHaveLength(0)
  })

  /**
   * 围栏必须【能开回去】,否则就是把"永久放行"换成了"永久沉默" —— 同样是缺陷,
   * 只是方向相反。Redis 恢复后 drain 补上标记,门就该重新放行。
   */
  it('the gate re-opens once the drain mirrors the record into Redis', async () => {
    const CLEAN = 'octo:s1:f_default:d_clean_reopen'
    await expect(reconcileDurableUnrestored()).resolves.toBe(true)

    redisDown = true
    markOversized(DOC, OVER, CAP, { '1': 5 })
    await flush()
    redisDown = false

    const closed = tokenEnvelope()
    await attachCompactedAtForTest(closed, CLEAN)
    expect(closed.compactedAt).toBeUndefined()

    // 心跳的下一拍把积压的记录补进 Redis。
    await flushUnrestoredRetries()

    // 本用例的判别对象是 MR98-011 的那道围栏 —— drain 之后它必须真的空掉。
    // 这一条【必须留着】:下面新增的 reconcile 会顺带清空围栏,若不在此处先钉,
    // 用例就退化成"只要跑过 reconcile 就绿",drain 有没有生效再也测不出来。
    expect(durablePendingCountForTest()).toBe(0)

    // MR98-012 新增的前提:抖动期间 markOverCapShared 失败是一次被观察到的 Redis
    // 故障,它单独把门再上一道锁。drain 只镜像【本进程队列里】的行,读不到兄弟
    // 副本写下的行,因此不足以证明视图完整 —— 解锁只认一次完整 reconcile。
    await expect(reconcileDurableUnrestored()).resolves.toBe(true)

    await markCompacted(CLEAN, STAMP)
    const reopened = tokenEnvelope()
    await attachCompactedAtForTest(reopened, CLEAN)
    expect(reopened.compactedAt).toBe(STAMP)
  })

  /**
   * `put` 抛错【不】证明"库里没有这一行" —— 超时的响应、丢失的 commit ack 都会让
   * 一次"失败"的写入其实已经落库。所以围栏在 DB 写失败时【不】清除。
   * 判错的代价:少发一次优化信号。判反的代价:授权一次删除。
   */
  it('keeps the fence when the durable write itself fails (a failed put does not prove no row)', async () => {
    const CLEAN = 'octo:s1:f_default:d_clean_dbfail'
    await expect(reconcileDurableUnrestored()).resolves.toBe(true)

    redisDown = true
    dbDown = true
    markOversized(DOC, OVER, CAP, { '1': 5 })
    await flush()
    redisDown = false
    dbDown = false

    await markCompacted(CLEAN, STAMP)
    const r = tokenEnvelope()
    await attachCompactedAtForTest(r, CLEAN)
    expect(r.compactedAt).toBeUndefined()
  })

  /**
   * 边界如实声明:一行由【另一个已在运行的副本】写下的记录,在本进程完成下一次
   * 心跳 reconcile 之前是看不见的。心跳间隔 OVER_CAP_REFRESH_INTERVAL_MS = 10 分钟,
   * 所以这就是该窗口的实际长度 —— 本用例把它钉成可执行的判据,而不是散文。
   */
  it('a sibling-written row becomes visible to this gate at the next heartbeat reconcile', async () => {
    const CLEAN = 'octo:s1:f_default:d_clean_sibling'
    await expect(reconcileDurableUnrestored()).resolves.toBe(true)

    // 另一个副本在抖动期间写下的行:直接落在 DB 上,本进程的内存里毫无痕迹。
    table.set('octo:s1:f_default:d_sibling', JSON.stringify({ '7': 9 }))
    redisDown = true

    // 心跳还没到:本进程确实看不见它 —— 这就是被声明的窗口。
    // (Redis 此刻是 down 的,旧闸门 fail-closed 会盖住,所以这里只验心跳后的行为。)
    redisDown = false
    await reconcileDurableUnrestored()
    await markCompacted(CLEAN, STAMP)
    const healthy = tokenEnvelope()
    await attachCompactedAtForTest(healthy, CLEAN)
    expect(healthy.compactedAt).toBe(STAMP)

    // 同样的兄弟行,但 Redis 拒绝镜像 -> 本次 reconcile 直接观测到"未镜像",
    // 于是围栏在这一拍关上。
    table.set('octo:s1:f_default:d_sibling2', JSON.stringify({ '7': 9 }))
    redisDown = true
    await expect(reconcileDurableUnrestored()).resolves.toBe(false)
    redisDown = false

    const fenced = tokenEnvelope()
    await attachCompactedAtForTest(fenced, CLEAN)
    expect(fenced.compactedAt).toBeUndefined()
  })
})

/**
 * MR98-012 —— 兄弟副本写下的行 + Redis 恢复窗口。
 *
 * MR98-011 关掉的是【本进程自己写下】的那些行。但 reviewer 点名的路径是另一条:
 *
 *   副本 A: 拒绝 -> DB 行写下 -> markOverCapShared 失败(抖动)
 *   副本 B: 一直在跑、启动时已 settle、durablePending 为空 —— 抖动没碰它
 *   Redis 恢复 -> B 读到一个健康、无标记的 Redis -> B 发出 compactedAt
 *
 * B 在抖动【期间】被 isOverCapAnywhere 的 fail-closed 盖住;洞在【恢复之后、B 的
 * 下一次心跳 reconcile 之前】那段(最长 10 分钟)。B 不需要集群状态就能知道自己
 * 的视图不完整 —— 它和 A 看到的是同一次 Redis 故障。
 *
 * 这些用例的 DOC 行【不经过本进程的拒绝路径】,而是直接写进 table(=兄弟副本写的),
 * 因此 durablePending 恒为空;唯一能救场的就是"观察到 Redis 故障"这个新判据。
 */
describe('MR98-012 sibling-written rows — an observed Redis failure re-arms the gate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(STAMP)
    redisDown = false
    dbDown = false
    strings.clear()
    hashes.clear()
    table.clear()
    resetOversizedForTest()
    resetDurableReconcileForTest()
    setUnrestoredDurableStore(overcapUnrestoredRepo)
  })
  afterEach(() => {
    stopHeartbeat?.()
    stopHeartbeat = null
    setUnrestoredDurableStore(null)
    redisDown = false
    dbDown = false
    vi.useRealTimers()
  })

  /**
   * 本用例是 reviewer 原文那条路径的可执行版本。注意 DOC 行是【直接落 table】的,
   * 本进程从未走过拒绝路径,所以 durablePending 为空 —— MR98-011 那道围栏在这里
   * 完全使不上劲,必须由观察判据接住。
   */
  it('an already-running replica withholds compactedAt after recovery, before its next heartbeat', async () => {
    const CLEAN = 'octo:s1:f_default:d_clean_b_token'

    // B 启动正常,门是开的。
    await expect(reconcileDurableUnrestored()).resolves.toBe(true)
    await markCompacted(CLEAN, STAMP)
    const before = tokenEnvelope()
    await attachCompactedAtForTest(before, CLEAN)
    expect(before.compactedAt).toBe(STAMP)
    expect(durablePendingCountForTest()).toBe(0)

    // 抖动:A 把行写进 DB(本进程内存里毫无痕迹),B 只是碰巧也读了一次 Redis。
    redisDown = true
    table.set('octo:s1:f_default:d_sibling_b', JSON.stringify({ '7': 9 }))
    await isOverCapAnywhere(CLEAN) // B 自己观察到的那次故障

    // Redis 恢复。B 的心跳还没到 —— 这正是被质询的窗口。
    redisDown = false
    expect(durablePendingCountForTest()).toBe(0) // 围栏确实是空的

    const after = tokenEnvelope()
    await attachCompactedAtForTest(after, CLEAN)
    expect(after.compactedAt).toBeUndefined()
  })

  it('withholds the stale-cache frame in the same window', async () => {
    const CLEAN = 'octo:s1:f_default:d_clean_b_frame'
    await expect(reconcileDurableUnrestored()).resolves.toBe(true)

    redisDown = true
    table.set('octo:s1:f_default:d_sibling_frame', JSON.stringify({ '7': 9 }))
    await isOverCapAnywhere(CLEAN)
    redisDown = false

    const sent: string[] = []
    await expect(noticeStaleCacheOnJoin(CLEAN, false, (p) => sent.push(p))).resolves.toBe(false)
    expect(sent).toHaveLength(0)
  })

  /**
   * 另一个观察点:镜像写失败本身也是"Redis 此刻不接受超限状态"的直接证据。
   * 这条走 markOverCapShared 的 catch,不走 isOverCapAnywhere 的 catch。
   */
  it('a failed mark mirror is itself an observation that re-arms the gate', async () => {
    const CLEAN = 'octo:s1:f_default:d_clean_b_mark'
    await expect(reconcileDurableUnrestored()).resolves.toBe(true)
    expect(redisFailureObservedForTest()).toBe(false)

    redisDown = true
    await markOverCapShared('octo:s1:f_default:d_other')
    redisDown = false

    expect(redisFailureObservedForTest()).toBe(true)
    await markCompacted(CLEAN, STAMP)
    const r = tokenEnvelope()
    await attachCompactedAtForTest(r, CLEAN)
    expect(r.compactedAt).toBeUndefined()
  })

  /**
   * 必须【能开回去】。解锁的唯一证据是一次端到端读完并全部镜像成功的 reconcile ——
   * 那一刻本进程的视图重新完整,兄弟行也已经被读进来了。
   */
  it('re-opens only after a full reconcile proves the view complete again', async () => {
    const CLEAN = 'octo:s1:f_default:d_clean_b_reopen'
    await expect(reconcileDurableUnrestored()).resolves.toBe(true)

    redisDown = true
    table.set('octo:s1:f_default:d_sibling_reopen', JSON.stringify({ '7': 9 }))
    await isOverCapAnywhere(CLEAN)
    redisDown = false

    const closed = tokenEnvelope()
    await attachCompactedAtForTest(closed, CLEAN)
    expect(closed.compactedAt).toBeUndefined()

    // 心跳到了:兄弟行被读进来并镜像进 Redis,视图重新完整。
    await expect(reconcileDurableUnrestored()).resolves.toBe(true)
    expect(redisFailureObservedForTest()).toBe(false)

    await markCompacted(CLEAN, STAMP)
    const reopened = tokenEnvelope()
    await attachCompactedAtForTest(reopened, CLEAN)
    expect(reopened.compactedAt).toBe(STAMP)
  })

  /**
   * 负控:一次【读库就失败】的 reconcile 不得解锁 —— 它压根没读到兄弟行,
   * 没有任何证据证明视图完整。方向搞反的话就是把观察判据变成摆设。
   */
  it('a reconcile that could not read the store does NOT re-open the gate', async () => {
    const CLEAN = 'octo:s1:f_default:d_clean_b_readfail'
    await expect(reconcileDurableUnrestored()).resolves.toBe(true)

    redisDown = true
    await isOverCapAnywhere(CLEAN)
    redisDown = false

    dbDown = true
    await expect(reconcileDurableUnrestored()).resolves.toBe(false)
    dbDown = false

    expect(redisFailureObservedForTest()).toBe(true)
    await markCompacted(CLEAN, STAMP)
    const r = tokenEnvelope()
    await attachCompactedAtForTest(r, CLEAN)
    expect(r.compactedAt).toBeUndefined()
  })

  /**
   * 负控(不该触发):没有任何 Redis 故障被观察到时,门必须照常放行。
   * 少了这条,一个"恒真"的判据也会让上面 5 条全绿。
   */
  it('CONTROL: with no observed failure the gate stays open', async () => {
    const CLEAN = 'octo:s1:f_default:d_clean_b_control'
    await expect(reconcileDurableUnrestored()).resolves.toBe(true)

    await isOverCapAnywhere(CLEAN) // Redis 健康,不该记任何东西
    expect(redisFailureObservedForTest()).toBe(false)

    await markCompacted(CLEAN, STAMP)
    const r = tokenEnvelope()
    await attachCompactedAtForTest(r, CLEAN)
    expect(r.compactedAt).toBe(STAMP)
  })
})

