/**
 * The stale-cache interlock has to hold ACROSS REPLICAS.
 *
 * `oversizeGuard`'s mark is a per-process Map, set only on the replica whose own
 * store was rejected. Production runs two replicas and they were caught holding
 * different views of the same document on 2026-08-25: one logging 10,556,162
 * bytes and kicking connections, the other serving a clean 659,725. A client
 * landing on the clean replica would see `isOverCap = false` and be told to wipe
 * its IndexedDB — the only copy of the edits that never reached the database,
 * i.e. exactly the content the over-size-cap banner tells the user to copy out.
 *
 * These tests pin the Redis-mirrored half of the interlock. They are written
 * against the observable behaviour (a frame is / is not sent), not against the
 * key names, so a reimplementation that keeps the guarantee still passes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

/** Minimal in-memory Redis double: only what the notice module calls. */
const store = new Map<string, string>()
/** Hash keyspace, kept separate so a hash and a string key can never alias. */
const hashes = new Map<string, Map<string, string>>()
let getShouldThrow = false
let setShouldThrow = false
/** Fail only the gets whose key matches, so one lookup can break in isolation. */
let failGetsMatching: ((key: string) => boolean) | null = null

function hash(k: string): Map<string, string> {
  let h = hashes.get(k)
  if (!h) {
    h = new Map()
    hashes.set(k, h)
  }
  return h
}

vi.mock('../src/db/redis.js', () => ({
  getRedis: () => ({
    get: async (k: string) => {
      if (getShouldThrow) throw new Error('redis down')
      if (failGetsMatching?.(k)) throw new Error('redis down')
      return store.get(k) ?? null
    },
    set: async (k: string, v: string) => {
      if (setShouldThrow) throw new Error('redis down')
      store.set(k, v)
      return 'OK'
    },
    del: async (k: string) => {
      // Real DEL removes the key whatever its type. The double must too, or a
      // mutant that wrongly deletes the hash would look suppressed-by-design.
      const had = store.delete(k) || hashes.delete(k)
      return had ? 1 : 0
    },
    hset: async (k: string, f: string, v: string) => {
      if (setShouldThrow) throw new Error('redis down')
      hash(k).set(f, v)
      return 1
    },
    hdel: async (k: string, ...fields: string[]) => {
      const h = hash(k)
      let n = 0
      for (const f of fields) if (h.delete(f)) n += 1
      return n
    },
    hgetall: async (k: string) => {
      if (getShouldThrow) throw new Error('redis down')
      if (failGetsMatching?.(k)) throw new Error('redis down')
      return Object.fromEntries(hash(k))
    },
    expire: async () => 1,
  }),
  rkey: (...parts: string[]) => parts.join(':'),
}))

const {
  noticeStaleCacheOnJoin,
  markCompacted,
  markOverCapShared,
  clearOverCapShared,
  isOverCapAnywhere,
  replicaIdForTest,
} = await import('../src/collab/compactionNotice.js')

const DOC = 'd_07cec60fc3fa54b986d3917c'

/** Write a mark as if a DIFFERENT replica had set it. */
function markFromOtherReplica(doc: string, at = Date.now()): string {
  const other = `octo-docs-prod-other:${process.pid + 1}`
  hash(`overcap-replicas:${doc}`).set(other, String(at))
  return other
}

function collect() {
  const sent: string[] = []
  return { sent, send: (p: string) => sent.push(p) }
}

describe('stale-cache interlock across replicas', () => {
  beforeEach(() => {
    store.clear()
    hashes.clear()
    getShouldThrow = false
    setShouldThrow = false
    failGetsMatching = null
  })

  it('a replica that never rejected the store still suppresses the notice (the data-loss gap)', async () => {
    // Document was compacted, so a stamp exists and the notice WOULD fire...
    await markCompacted(DOC, Date.now())
    // ...but another replica has rejected its store: the document is over the
    // cap deployment-wide even though THIS process's Map is empty.
    await markOverCapShared(DOC)

    const { sent, send } = collect()
    const fired = await noticeStaleCacheOnJoin(DOC, /* isOverCap (local) */ false, send)

    expect(fired).toBe(false)
    expect(sent).toEqual([])
  })

  it('without the shared mark the notice still fires (the guard is not simply always-off)', async () => {
    await markCompacted(DOC, 1_756_000_000_000)

    const { sent, send } = collect()
    const fired = await noticeStaleCacheOnJoin(DOC, false, send)

    expect(fired).toBe(true)
    expect(sent).toHaveLength(1)
    expect(JSON.parse(sent[0]!)).toEqual({
      type: 'doc.cache-stale',
      compactedAt: 1_756_000_000_000,
    })
  })

  it('a successful store lifts the suppression (recovery needs no operator action)', async () => {
    await markCompacted(DOC, 1_756_000_000_000)
    await markOverCapShared(DOC)
    expect(await isOverCapAnywhere(DOC)).toBe(true)

    // persistence.store clears it on the success path.
    await clearOverCapShared(DOC)

    const { sent, send } = collect()
    expect(await noticeStaleCacheOnJoin(DOC, false, send)).toBe(true)
    expect(sent).toHaveLength(1)
  })

  it('an unreadable Redis suppresses the notice — this lookup fails CLOSED', async () => {
    await markCompacted(DOC, Date.now())
    getShouldThrow = true

    const { sent, send } = collect()
    const fired = await noticeStaleCacheOnJoin(DOC, false, send)

    // We cannot tell whether the client's cache is the only copy of its work,
    // so we must not ask it to throw that cache away.
    expect(fired).toBe(false)
    expect(sent).toEqual([])
  })

  it('the over-cap lookup fails CLOSED even when the stamp is readable', async () => {
    // The previous test also passes if `compactedAt` merely returns null on the
    // same outage — it never puts a question to the over-cap lookup. Here ONLY
    // the over-cap read fails, and the stamp is served normally, so the notice
    // fires unless `isOverCapAnywhere` refuses on error.
    const stamp = 1_756_000_000_000
    await markCompacted(DOC, stamp)
    const stampKeys = [...store.keys()].filter((k) => k.includes('compacted'))
    expect(stampKeys).toHaveLength(1)

    failGetsMatching = (k) => !k.includes('compacted')

    // Guard the guard: the stamp really is still readable on this outage.
    expect(await isOverCapAnywhere(DOC)).toBe(true)

    const { sent, send } = collect()
    const fired = await noticeStaleCacheOnJoin(DOC, false, send)

    expect(fired).toBe(false)
    expect(sent).toEqual([])
  })

  it('mirroring never throws, so a Redis outage cannot mask a size rejection', async () => {
    setShouldThrow = true
    await expect(markOverCapShared(DOC)).resolves.toBeUndefined()
  })

  it('the local flag alone still suppresses, independently of Redis', async () => {
    await markCompacted(DOC, Date.now())

    const { sent, send } = collect()
    const fired = await noticeStaleCacheOnJoin(DOC, /* isOverCap (local) */ true, send)

    expect(fired).toBe(false)
    expect(sent).toEqual([])
  })
})

/**
 * THE DIVERGENCE GUARD (the retraction half of the interlock).
 *
 * The mark used to be one shared boolean, so whichever replica stored successfully first deleted
 * it for everybody — including a replica that was still rejecting 10,556,162 bytes for the same
 * document. That is the measured 2026-08-25 divergence, and it turned the interlock off at exactly
 * the moment it was needed: the next client to land on the clean replica would be told to drop the
 * cache holding work the other replica could not persist.
 *
 * These tests are written against behaviour — "is the document still over cap anywhere" — not
 * against key layout, so a reimplementation that keeps the guarantee still passes.
 */
describe('over-cap retraction is per-replica', () => {
  beforeEach(() => {
    store.clear()
    hashes.clear()
    getShouldThrow = false
    setShouldThrow = false
    failGetsMatching = null
  })

  it('a clean replica cannot retract a mark another replica is still enforcing', async () => {
    markFromOtherReplica(DOC)
    expect(await isOverCapAnywhere(DOC)).toBe(true)

    // THIS replica's store succeeded, so it retracts. The other one has not.
    await clearOverCapShared(DOC)

    expect(await isOverCapAnywhere(DOC)).toBe(true)
  })

  it('and the notice stays suppressed for that document', async () => {
    await markCompacted(DOC, 1_756_000_000_000)
    markFromOtherReplica(DOC)
    await clearOverCapShared(DOC)

    const { sent, send } = collect()
    expect(await noticeStaleCacheOnJoin(DOC, false, send)).toBe(false)
    expect(sent).toEqual([])
  })

  it('retracting the LAST live mark does clear it (the guard is not simply always-on)', async () => {
    await markOverCapShared(DOC)
    expect(await isOverCapAnywhere(DOC)).toBe(true)

    await clearOverCapShared(DOC)

    expect(await isOverCapAnywhere(DOC)).toBe(false)
  })

  it('a replica retracts only its OWN field, leaving the other in place', async () => {
    const other = markFromOtherReplica(DOC)
    await markOverCapShared(DOC)

    await clearOverCapShared(DOC)

    const remaining = [...hash(`overcap-replicas:${DOC}`).keys()]
    expect(remaining).toEqual([other])
    expect(remaining).not.toContain(replicaIdForTest())
  })

  /**
   * The 2026-08-21 incident ended with 23 restarts, so fields left by killed pods are the normal
   * case, not the exotic one. The key's TTL cannot bound them — every other replica's write
   * refreshes the whole key — so a stale field must be read as absent or it suppresses notices
   * forever.
   */
  it('a field left by a pod killed mid-incident expires instead of suppressing forever', async () => {
    const longAgo = Date.now() - 40 * 24 * 60 * 60 * 1000
    markFromOtherReplica(DOC, longAgo)

    expect(await isOverCapAnywhere(DOC)).toBe(false)
  })

  it('reaps those dead fields once nobody is oversized, so the hash cannot grow forever', async () => {
    markFromOtherReplica(DOC, Date.now() - 40 * 24 * 60 * 60 * 1000)
    await markOverCapShared(DOC)

    await clearOverCapShared(DOC)

    expect([...hash(`overcap-replicas:${DOC}`).keys()]).toEqual([])
  })

  /**
   * Rolling deploy: an OLD replica only ever writes the legacy bare key. Reading it is what keeps
   * a half-upgraded deployment safe, and deleting it on someone else's behalf is the original bug
   * in its other shape.
   */
  it('reads a legacy bare mark written by an old replica', async () => {
    store.set(`overcap:${DOC}`, 'octo-docs-prod-old:1')

    expect(await isOverCapAnywhere(DOC)).toBe(true)
  })

  it('does not delete a legacy mark that belongs to an old replica', async () => {
    store.set(`overcap:${DOC}`, 'octo-docs-prod-old:1')

    await clearOverCapShared(DOC)

    expect(store.get(`overcap:${DOC}`)).toBe('octo-docs-prod-old:1')
    expect(await isOverCapAnywhere(DOC)).toBe(true)
  })

  it('does delete the legacy mark it wrote itself', async () => {
    await markOverCapShared(DOC)
    expect(store.get(`overcap:${DOC}`)).toBe(replicaIdForTest())

    await clearOverCapShared(DOC)

    expect(store.get(`overcap:${DOC}`)).toBeUndefined()
  })

  /** A retraction that fails leaves the mark standing: a missed notice, never a lost cache. */
  it('never throws, and a failed retraction leaves suppression in place', async () => {
    await markOverCapShared(DOC)
    getShouldThrow = true

    await expect(clearOverCapShared(DOC)).resolves.toBeUndefined()

    getShouldThrow = false
    expect(await isOverCapAnywhere(DOC)).toBe(true)
  })
})
