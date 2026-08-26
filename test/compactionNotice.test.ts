/**
 * Compaction cache-invalidation notice.
 *
 * The safety property under test is NOT "the frame gets sent" — it is
 * "the frame is withheld whenever sending it could destroy work". Clearing a
 * browser's IndexedDB copy is irreversible for anything that copy holds and the
 * server does not, so every refusal path here is a data-loss guard and is
 * asserted as such.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Minimal in-memory stand-in for the ioredis calls this module makes.
 *
 * The hash half is not decoration: the over-cap mark is a HASH of
 * `replicaId -> epoch millis`, and `isOverCapAnywhere` fails CLOSED. A double
 * that omits `hgetall` therefore does not merely skip a code path — it throws,
 * lands in the guard's catch, and reports "still over cap" for every document,
 * which silently converts unrelated tests into assertions about a broken
 * double rather than about behaviour.
 */
class FakeRedis {
  strings = new Map<string, string>()
  hashes = new Map<string, Map<string, string>>()
  /** Set by a test to make the next call of a given method throw. */
  failOn: string | null = null
  /** Records the TTL arguments so expiry is asserted rather than assumed. */
  lastSetArgs: unknown[] = []
  /**
   * The TTL (seconds) most recently armed for each key, whether via SET ... EX or
   * EXPIRE. Lets a test prove the marker's deadline outlives the stamp's rather
   * than assuming the two commands agree.
   */
  ttls = new Map<string, number>()

  private hash(key: string): Map<string, string> {
    let h = this.hashes.get(key)
    if (!h) {
      h = new Map()
      this.hashes.set(key, h)
    }
    return h
  }

  async set(key: string, value: string, ...args: unknown[]): Promise<'OK'> {
    if (this.failOn === 'set') throw new Error('connection refused')
    this.lastSetArgs = args
    this.strings.set(key, value)
    const exAt = args.findIndex((a) => a === 'EX' || a === 'ex')
    if (exAt >= 0 && args[exAt + 1] != null) this.ttls.set(key, Number(args[exAt + 1]))
    return 'OK'
  }

  async get(key: string): Promise<string | null> {
    if (this.failOn === 'get') throw new Error('connection refused')
    return this.strings.get(key) ?? null
  }

  /** Real DEL is type-agnostic; the double must be too. */
  async del(key: string): Promise<number> {
    if (this.failOn === 'del') throw new Error('connection refused')
    const had = this.strings.delete(key) || this.hashes.delete(key)
    this.ttls.delete(key)
    return had ? 1 : 0
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    if (this.failOn === 'hset') throw new Error('connection refused')
    this.hash(key).set(field, value)
    return 1
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    if (this.failOn === 'hdel') throw new Error('connection refused')
    const h = this.hash(key)
    let n = 0
    for (const f of fields) if (h.delete(f)) n += 1
    return n
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    if (this.failOn === 'hgetall') throw new Error('connection refused')
    return Object.fromEntries(this.hash(key))
  }

  /**
   * Real EXPIRE semantics: returns 1 when the key exists and the TTL is armed, 0
   * when the key is absent (a no-op — it never conjures a phantom key). A test
   * may make it throw to simulate a mid-sequence Redis blip on the renewal.
   */
  async expire(key: string, seconds: number): Promise<number> {
    if (this.failOn === 'expire') throw new Error('connection refused')
    if (!this.strings.has(key) && !this.hashes.has(key)) return 0
    this.ttls.set(key, Number(seconds))
    return 1
  }
}

let redis = new FakeRedis()

vi.mock('../src/db/redis.js', () => ({
  getRedis: () => redis,
  rkey: (...parts: string[]) => ['octo-docs', ...parts].join(':'),
}))

const {
  markCompacted,
  compactedAt,
  noticeStaleCacheOnJoin,
  staleCacheFramePayload,
  STALE_CACHE_FRAME_TYPE,
} = await import('../src/collab/compactionNotice.js')

const DOC = 'octo:minglue_default:f_default:d_317d4a51'
const AT = 1_756_000_000_000

describe('the compaction generation stamp', () => {
  beforeEach(() => {
    redis = new FakeRedis()
  })

  it('round-trips through Redis', async () => {
    await markCompacted(DOC, AT)
    expect(await compactedAt(DOC)).toBe(AT)
  })

  it('reports nothing for a document that was never compacted', async () => {
    expect(await compactedAt(DOC)).toBeNull()
  })

  it('is per-document', async () => {
    await markCompacted(DOC, AT)
    expect(await compactedAt('octo:minglue_default:f_default:d_other')).toBeNull()
  })

  it('expires rather than living forever', async () => {
    await markCompacted(DOC, AT)
    expect(redis.lastSetArgs).toContain('EX')
  })

  /**
   * Compaction has already committed when this runs. Throwing would turn a
   * rewrite that really happened into a reported failure.
   */
  it('never throws when Redis refuses the write', async () => {
    redis.failOn = 'set'
    await expect(markCompacted(DOC, AT)).resolves.toBeUndefined()
  })

  /** FAIL OPEN: an unreachable Redis must not be able to trigger a cache wipe. */
  it('reports nothing (not a stale stamp) when Redis cannot be read', async () => {
    await markCompacted(DOC, AT)
    redis.failOn = 'get'
    expect(await compactedAt(DOC)).toBeNull()
  })

  /**
   * `Number('nonsense')` is NaN and `Number('')` is 0. Either one coerced into a
   * generation would compare as older than every client stamp — or, worse, be
   * treated as a real generation and clear a cache once for no reason.
   */
  it.each(['nonsense', '', '0', '-1'])('ignores the corrupt stored value %j', async (bad) => {
    await markCompacted(DOC, AT)
    redis.strings.set('octo-docs:compacted:' + DOC, bad)
    expect(await compactedAt(DOC)).toBeNull()
  })

  /**
   * MR98-007. Publishing the fresh stamp and renewing the marker are two
   * commands. If they run stamp-first and Redis blips between them, a fresh
   * 30-day destructive stamp is left visible while the marker keeps its OLD,
   * shorter deadline — the marker expires weeks before the stamp and a cache of
   * rejected edits becomes wipeable. The fix renews FIRST and publishes LAST,
   * aborting the publish if the renewal fails. The invariant these tests pin is:
   * NEVER "new stamp present, marker not renewed".
   */
  const STAMP_KEY = 'octo-docs:compacted:' + DOC
  const MARKER_KEY = 'octo-docs:overcap-unrestored:' + DOC

  it('does NOT publish a fresh stamp when the marker renewal fails', async () => {
    // A pre-existing marker with an OLD, short deadline — the thing the renewal
    // is meant to extend.
    redis.strings.set(MARKER_KEY, JSON.stringify({ 'client-a': 5 }))
    redis.ttls.set(MARKER_KEY, 60)
    redis.failOn = 'expire'

    await expect(markCompacted(DOC, AT)).resolves.toBeUndefined()

    // No renewal → no new stamp. The stamp must never outlive its guard.
    expect(redis.strings.get(STAMP_KEY)).toBeUndefined()
    expect(await compactedAt(DOC)).toBeNull()
    // The marker keeps whatever deadline it had; it was never shortened.
    expect(redis.ttls.get(MARKER_KEY)).toBe(60)
  })

  it('still publishes the stamp when EXPIRE is a no-op on an absent marker', async () => {
    // Healthy document: no marker. EXPIRE returns 0 and must not abort anything.
    await markCompacted(DOC, AT)

    expect(await compactedAt(DOC)).toBe(AT)
    expect(redis.strings.has(MARKER_KEY)).toBe(false)
    expect(redis.ttls.get(STAMP_KEY)).toBe(30 * 24 * 60 * 60)
  })

  it("renews the marker to at least the stamp's TTL when both are present", async () => {
    redis.strings.set(MARKER_KEY, JSON.stringify({ 'client-a': 5 }))
    redis.ttls.set(MARKER_KEY, 60) // old, about-to-expire deadline

    await markCompacted(DOC, AT)

    expect(await compactedAt(DOC)).toBe(AT)
    const markerTtl = redis.ttls.get(MARKER_KEY)
    const stampTtl = redis.ttls.get(STAMP_KEY)
    expect(markerTtl).toBeDefined()
    expect(stampTtl).toBeDefined()
    expect(markerTtl as number).toBeGreaterThanOrEqual(stampTtl as number)
  })

  /**
   * The blip-recovery sequence: a first attempt fails on the renewal (no stamp
   * written), a later retry succeeds. After recovery the invariant must hold —
   * marker TTL >= stamp TTL — with no fresh stamp ever having outlived the guard.
   */
  it("keeps marker TTL >= stamp TTL across a failed-then-recovered compaction", async () => {
    redis.strings.set(MARKER_KEY, JSON.stringify({ 'client-a': 5 }))
    redis.ttls.set(MARKER_KEY, 60)

    redis.failOn = 'expire'
    await markCompacted(DOC, AT)
    expect(redis.strings.get(STAMP_KEY)).toBeUndefined() // nothing published yet

    redis.failOn = null
    await markCompacted(DOC, AT)

    expect(await compactedAt(DOC)).toBe(AT)
    expect(redis.ttls.get(MARKER_KEY) as number).toBeGreaterThanOrEqual(
      redis.ttls.get(STAMP_KEY) as number,
    )
  })
})

describe('noticeStaleCacheOnJoin — when a client is asked to drop its cache', () => {
  beforeEach(() => {
    redis = new FakeRedis()
  })

  const collect = () => {
    const sent: string[] = []
    return { sent, send: (p: string) => sent.push(p) }
  }

  it('tells a client whose cache predates the compaction', async () => {
    await markCompacted(DOC, AT)
    const { sent, send } = collect()

    await expect(noticeStaleCacheOnJoin(DOC, false, send)).resolves.toBe(true)
    expect(sent).toHaveLength(1)
    expect(JSON.parse(sent[0] as string)).toEqual({
      type: STALE_CACHE_FRAME_TYPE,
      compactedAt: AT,
    })
  })

  it('stays silent for a document that was never compacted', async () => {
    const { sent, send } = collect()
    await expect(noticeStaleCacheOnJoin(DOC, false, send)).resolves.toBe(false)
    expect(sent).toEqual([])
  })

  /**
   * THE DATA-LOSS GUARD.
   *
   * A capped document cannot persist what the client is holding — that is what
   * being capped means. Its IndexedDB copy is therefore the ONLY place those
   * edits exist, and it is exactly the content the over-size-cap banner tells
   * the user to copy out by hand. Asking that client to clear its cache deletes
   * the work. The notice must wait until a successful store clears the mark.
   */
  it('REFUSES to ask an over-cap document to clear its cache', async () => {
    await markCompacted(DOC, AT)
    const { sent, send } = collect()

    await expect(noticeStaleCacheOnJoin(DOC, true, send)).resolves.toBe(false)
    expect(sent).toEqual([])
  })

  /** Fail-open again, at the join path this time. */
  it('stays silent when Redis cannot answer', async () => {
    await markCompacted(DOC, AT)
    redis.failOn = 'get'
    const { sent, send } = collect()

    await expect(noticeStaleCacheOnJoin(DOC, false, send)).resolves.toBe(false)
    expect(sent).toEqual([])
  })

  it('never throws, so it cannot take a connection down with it', async () => {
    redis.failOn = 'get'
    await expect(
      noticeStaleCacheOnJoin(DOC, false, () => {
        /* noop */
      }),
    ).resolves.toBe(false)
  })
})

describe('the wire frame', () => {
  /**
   * The literal the frontend matches on. A rename on one side only is a silent
   * no-op: the server keeps sending and no client ever acts. Pinned here, and on
   * the frontend against its own copy of the constant.
   */
  it('is named doc.cache-stale', () => {
    expect(STALE_CACHE_FRAME_TYPE).toBe('doc.cache-stale')
  })

  it('carries the generation the client compares against', () => {
    expect(JSON.parse(staleCacheFramePayload(AT))).toEqual({
      type: 'doc.cache-stale',
      compactedAt: AT,
    })
  })

  /** The documentName is not on the wire: the client already knows which doc. */
  it('does not put the documentName on the wire', () => {
    expect(staleCacheFramePayload(AT)).not.toContain('minglue')
  })
})
