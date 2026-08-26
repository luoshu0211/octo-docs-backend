import { describe, it, expect, beforeEach, vi } from 'vitest'
import { evalUnrestored } from './helpers/unrestoredEval.js'

/**
 * Integration shape of the 2026-08-21 oversize incident, at the seam that
 * actually failed: `persistence.store` rejects the write, but nothing stopped
 * the document from accepting the NEXT one. These tests pin the two halves of
 * the fix — arm on rejection, disarm on a successful store — with the database
 * mocked out, so they exercise the guard wiring rather than MySQL.
 */

const TINY_LIMIT = 1024

vi.mock('../src/config/env.js', () => ({
  config: { maxDocBytes: TINY_LIMIT },
}))

const upsertStateTx = vi.fn(async () => {})
const selectForUpdateTx = vi.fn(async () => null)
const txQuery = vi.fn(async () => [])

vi.mock('../src/db/pool.js', () => ({
  transaction: async (fn: (tx: { query: typeof txQuery }) => Promise<void>) => fn({ query: txQuery }),
}))

vi.mock('../src/db/repos/yjsDocumentRepo.js', () => ({
  yjsDocumentRepo: {
    fetchState: async () => null,
    selectForUpdateTx: (...a: unknown[]) => selectForUpdateTx(...(a as [])),
    upsertStateTx: (...a: unknown[]) => upsertStateTx(...(a as [])),
  },
}))

/**
 * The oversize mark is mirrored to Redis so the OTHER replicas can see it —
 * without that, a replica whose own store was never rejected tells an arriving
 * client its cache is stale and the client wipes the only copy of the edits that
 * could not be persisted. Held in a plain Map here so the wiring is observable.
 */
const redisStore = new Map<string, string>()

/**
 * In-memory Redis double.
 *
 * The hash half mirrors the real over-cap mark, which is a HASH of
 * `replicaId -> epoch millis`. `isOverCapAnywhere` fails CLOSED, so a double
 * missing `hgetall` does not skip a path — it throws into the guard's catch and
 * reports "over cap" unconditionally, turning these tests into assertions about
 * a broken double.
 */
const redisHashes = new Map<string, Map<string, string>>()
function redisHash(key: string): Map<string, string> {
  let h = redisHashes.get(key)
  if (!h) {
    h = new Map()
    redisHashes.set(key, h)
  }
  return h
}

vi.mock('../src/db/redis.js', () => ({
  getRedis: () => ({
    get: async (k: string) => redisStore.get(k) ?? null,
    set: async (k: string, v: string) => {
      redisStore.set(k, v)
      return 'OK'
    },
    /** Real DEL is type-agnostic; the double must be too. */
    del: async (k: string) => {
      const had = redisStore.delete(k) || redisHashes.delete(k)
      return had ? 1 : 0
    },
    hset: async (k: string, f: string, v: string) => {
      redisHash(k).set(f, v)
      return 1
    },
    hdel: async (k: string, ...fields: string[]) => {
      const h = redisHash(k)
      let n = 0
      for (const f of fields) if (h.delete(f)) n += 1
      return n
    },
    hgetall: async (k: string) => Object.fromEntries(redisHash(k)),
    expire: async () => 1,
    eval: async (script: string, _numKeys: number, key: string, ...argv: string[]) =>
      evalUnrestored(script, key, argv, {
        get: (k: string) => redisStore.get(k) ?? null,
        set: (k: string, v: string) => {
          redisStore.set(k, v)
        },
        del: (k: string) => {
          redisStore.delete(k)
        },
      }),
  }),
  rkey: (...parts: string[]) => parts.join(':'),
}))

import * as Y from 'yjs'

/**
 * Build a document whose v2 encoding lands either side of TINY_LIMIT. The cap is
 * now measured against the v2 bytes we actually persist, so the fixture has to
 * be a real document rather than a raw byte array.
 */
function docOfAtLeast(bytes: number): Y.Doc {
  const doc = new Y.Doc()
  const text = doc.getText('t')
  while (Y.encodeStateAsUpdateV2(doc).length <= bytes) {
    doc.transact(() => text.insert(text.length, 'x'.repeat(256)))
  }
  return doc
}

const { persistence } = await import('../src/collab/persistence.js')
const { getOversized, resetOversizedForTest } = await import('../src/collab/oversizeGuard.js')
const { isOverCapAnywhere, markCompacted, noticeStaleCacheOnJoin } = await import(
  '../src/collab/compactionNotice.js'
)
const { config } = await import('../src/config/env.js')

/** The real config types `maxDocBytes` readonly; a test may move the cap to model an ops change. */
const setCap = (n: number): void => {
  ;(config as { maxDocBytes: number }).maxDocBytes = n
}

const DOC = 'octo:space:f_default:d_incident'
const small = (): Y.Doc => new Y.Doc()
const huge = (): Y.Doc => docOfAtLeast(TINY_LIMIT)

describe('persistence.store oversize guard wiring', () => {
  beforeEach(() => {
    resetOversizedForTest()
    upsertStateTx.mockClear()
    redisStore.clear()
    // The over-cap mark now lives in the hash keyspace. Leaving it uncleared
    // would leak one test's mark into the next and suppress its notice.
    redisHashes.clear()
    // A test may raise the cap to model a genuine recovery; restore it so the
    // default here is "the incident cap".
    setCap(TINY_LIMIT)
  })

  it('an oversized store is rejected AND arms the guard', async () => {
    await expect(persistence.store(DOC, huge())).rejects.toThrow(/exceeds max size/)
    expect(getOversized(DOC)?.bytes).toBeGreaterThan(TINY_LIMIT)
    expect(getOversized(DOC)?.limit).toBe(TINY_LIMIT)
  })

  it('the oversized store never reaches the database', async () => {
    await expect(persistence.store(DOC, huge())).rejects.toThrow()
    // The throw is before `transaction(...)`, so no row is locked or written —
    // this is what keeps a 17 MB decode out of the row lock.
    expect(upsertStateTx).not.toHaveBeenCalled()
  })

  it('a successful store disarms the guard (document shrank back under the cap)', async () => {
    await expect(persistence.store(DOC, huge())).rejects.toThrow()
    expect(getOversized(DOC)).not.toBeNull()

    await persistence.store(DOC, small())
    expect(upsertStateTx).toHaveBeenCalledTimes(1)
    expect(getOversized(DOC)).toBeNull()
  })

  it('a small store on a healthy document leaves the guard disarmed', async () => {
    await persistence.store(DOC, small())
    expect(getOversized(DOC)).toBeNull()
  })

  it('arming one document does not arm another', async () => {
    await expect(persistence.store(DOC, huge())).rejects.toThrow()
    expect(getOversized('octo:space:f_default:d_bystander')).toBeNull()
  })

  it('a rejected store mirrors the mark so other replicas suppress cache-clear notices', async () => {
    await expect(persistence.store(DOC, huge())).rejects.toThrow()

    // Asked the way a DIFFERENT replica would: it has no local mark, only Redis.
    expect(await isOverCapAnywhere(DOC)).toBe(true)

    const sent: string[] = []
    await markCompacted(DOC, Date.now())
    const fired = await noticeStaleCacheOnJoin(DOC, /* isOverCap (local) */ false, (p) =>
      sent.push(p),
    )

    // The client is holding edits that could not be persisted; telling it to
    // drop its IndexedDB would delete them.
    expect(fired).toBe(false)
    expect(sent).toEqual([])
  })

  it('a store that RECOVERS the rejected state lifts the shared mark, so the notice can fire again', async () => {
    // The document that was rejected — kept so the recovering store can carry
    // its exact state (same clientID, same clocks).
    const doc = huge()
    await expect(persistence.store(DOC, doc)).rejects.toThrow()
    expect(await isOverCapAnywhere(DOC)).toBe(true)

    // A genuine recovery: the cap is raised (an ops response to the incident) and
    // the SAME document — the one whose bytes were rejected — is now persisted.
    // Its state vector dominates the recorded one, which is the evidence that the
    // rejected state actually landed.
    setCap(Number.MAX_SAFE_INTEGER)
    await persistence.store(DOC, doc)
    expect(upsertStateTx).toHaveBeenCalledTimes(1)

    // The store proved the rejected state fits AND is persisted, so suppression
    // must lift — otherwise compaction can never invalidate a cache once a
    // document has tripped the cap.
    //
    // WAITED FOR, NOT READ ONCE. `persistence.store` retracts the shared mark and
    // clears the durable marker with `void`: deliberately fire-and-forget, so a
    // Redis round-trip never delays a committed write. Eventual clearance is
    // therefore the actual contract, and the gap it opens is the safe direction —
    // while it is open the mark still reads as set, which withholds a cache-clear
    // notice. That costs a missed notice, never a lost cache.
    await vi.waitFor(async () => {
      expect(await isOverCapAnywhere(DOC)).toBe(false)
    })

    const sent: string[] = []
    await markCompacted(DOC, Date.now())
    expect(await noticeStaleCacheOnJoin(DOC, false, (p) => sent.push(p))).toBe(true)
    expect(sent).toHaveLength(1)
  })

  /**
   * MR98-004: one unrelated small store must NOT dissolve another client's
   * protection. A crosses the cap (its edit lives only in A's IndexedDB), A
   * disconnects, the document unloads; B then opens the document from the
   * persisted row that never held A's edit and saves a small change. B's store
   * succeeds and retracts B's own replica field — but it accounts for nothing
   * about A, so the interlock must hold until A's bytes actually land.
   */
  it('an unrelated small store does NOT lift protection for a still-unpersisted rejection', async () => {
    // A's over-cap store is rejected: the durable marker now carries A's state.
    await expect(persistence.store(DOC, huge())).rejects.toThrow()
    expect(await isOverCapAnywhere(DOC)).toBe(true)

    // The document unloads (its local write guard is dropped) and B opens it and
    // saves a small, unrelated change. This store fits and SUCCEEDS.
    await persistence.store(DOC, small())
    expect(upsertStateTx).toHaveBeenCalledTimes(1)

    // The interlock still stands: B's store did not carry A's rejected state, so
    // A's cache — the only copy of its unsaved edits — must not be wiped.
    expect(await isOverCapAnywhere(DOC)).toBe(true)

    const sent: string[] = []
    await markCompacted(DOC, Date.now())
    expect(await noticeStaleCacheOnJoin(DOC, false, (p) => sent.push(p))).toBe(false)
    expect(sent).toEqual([])
  })
})
