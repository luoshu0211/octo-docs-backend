import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * An in-memory stand-in for the subset of ioredis this module uses. Enough to
 * exercise the real logic — key naming, TTL filtering, the compare-and-delete
 * release — without a live Redis.
 */
class FakeRedis {
  strings = new Map<string, string>()
  hashes = new Map<string, Map<string, string>>()
  /** Set by a test to make the next call of a given method throw. */
  failOn: string | null = null

  private guard(name: string): void {
    if (this.failOn === name) throw new Error('connection refused')
  }

  async set(key: string, value: string, ..._args: unknown[]): Promise<'OK' | null> {
    this.guard('set')
    const nx = _args.includes('NX')
    if (nx && this.strings.has(key)) return null
    this.strings.set(key, value)
    return 'OK'
  }

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0
    for (const k of keys) if (this.strings.delete(k)) n++
    return n
  }

  async mget(...keys: string[]): Promise<(string | null)[]> {
    this.guard('mget')
    return keys.map((k) => this.strings.get(k) ?? null)
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    this.guard('hset')
    const h = this.hashes.get(key) ?? new Map()
    this.hashes.set(key, h)
    h.set(field, value)
    return 1
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    const h = this.hashes.get(key)
    if (!h) return 0
    let n = 0
    for (const f of fields) if (h.delete(f)) n++
    return n
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    this.guard('hgetall')
    return Object.fromEntries(this.hashes.get(key) ?? new Map())
  }

  async eval(_script: string, _n: number, key: string, expected: string): Promise<number> {
    if (this.strings.get(key) !== expected) return 0
    this.strings.delete(key)
    return 1
  }
}

const redis = new FakeRedis()
let hostname = 'pod-a'

vi.mock('../src/db/redis.js', () => ({
  getRedis: () => redis,
  rkey: (...parts: string[]) => ['octo-docs', ...parts].join(':'),
}))
vi.mock('../src/config/env.js', () => ({
  get config() {
    return { hostname }
  },
}))

const {
  announceNode,
  markLoaded,
  markUnloaded,
  otherLiveHolders,
  withCompactionLock,
  withdrawNode,
  nodeId,
  resetNodeIdForTest,
} = await import('../src/collab/compactionCluster.js')

const DOC = 'octo:s:f_default:d_1'

/**
 * Run `fn` as if it were executing on another replica.
 *
 * The identity is cached per process, so the cache has to be dropped on the way
 * in AND on the way out — otherwise the "other" replica keeps this test's
 * identity, and every holder entry looks like our own.
 */
async function asNode<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const previous = hostname
  hostname = name
  resetNodeIdForTest()
  try {
    return await fn()
  } finally {
    hostname = previous
    resetNodeIdForTest()
  }
}


beforeEach(() => {
  redis.strings.clear()
  redis.hashes.clear()
  redis.failOn = null
  hostname = 'pod-a'
})

describe('fleet-wide holder tracking', () => {
  it('reports a document held by another live replica', async () => {
    // Captured inside the block: an identity carries a per-process nonce, so
    // asking again outside would mint a different one.
    let other = ''
    await asNode('pod-b', async () => {
      other = nodeId()
      await announceNode()
      await markLoaded(DOC)
    })

    expect(await otherLiveHolders(DOC)).toEqual([other])
    expect(other).toMatch(/^pod-b#/) // still readable in a log
  })

  /**
   * REGRESSION. The identity used to be `config.hostname` alone. Two replicas
   * reporting the same name are then indistinguishable: each filters the
   * other's holder entry out as "self", concludes nobody holds the document,
   * and compacts it out from under a replica that has it open.
   *
   * Not hypothetical — `docker-compose.node2.yml` runs exactly that, with a
   * comment calling the shared name a known defect. Kubernetes happens to set
   * HOSTNAME to the unique pod name, which is why production never showed it.
   */
  it('distinguishes two replicas that report the SAME hostname', async () => {
    let first = ''
    await asNode('octo-docs-local', async () => {
      first = nodeId()
      await announceNode()
      await markLoaded(DOC)
    })

    let second = ''
    await asNode('octo-docs-local', async () => {
      second = nodeId()
      await announceNode()
      // The second replica must SEE the first, despite the identical hostname.
      expect(await otherLiveHolders(DOC)).toEqual([first])
    })

    expect(second).not.toBe(first)
  })

  it('never reports this replica against itself', async () => {
    await announceNode()
    await markLoaded(DOC)

    // Otherwise the node that just unloaded a document could never compact it —
    // and that unload is the only moment compaction is safe.
    expect(await otherLiveHolders(DOC)).toEqual([])
  })

  it('stops reporting a replica once it has unloaded the document', async () => {
    await asNode('pod-b', async () => {
      await announceNode()
      await markLoaded(DOC)
      await markUnloaded(DOC)
    })

    expect(await otherLiveHolders(DOC)).toEqual([])
  })

  it('keeps holders separate per document', async () => {
    await asNode('pod-b', async () => {
      await announceNode()
      await markLoaded('octo:s:f_default:d_other')
    })

    expect(await otherLiveHolders(DOC)).toEqual([])
  })

  /**
   * The defect that made the existing connection registry unusable as a gate:
   * a SIGKILLed pod (exit 137, as in the incident) never runs its cleanup, and a
   * live production read found 88% of that registry was rubble from five pods
   * of which only one still existed. Entries outliving their node must stop
   * counting, or compaction refuses forever on exactly the biggest documents.
   */
  it('ignores a holder whose node is gone', async () => {
    let dead = ''
    await asNode('pod-dead', async () => {
      dead = nodeId()
      await announceNode()
      await markLoaded(DOC)
    })
    // The node dies: its liveness key expires, its holder entry does not.
    await redis.del(`octo-docs:node-alive:${dead}`)

    expect(await otherLiveHolders(DOC)).toEqual([])
  })

  it('deletes the dead entry rather than re-examining it forever', async () => {
    let dead = ''
    await asNode('pod-dead', async () => {
      dead = nodeId()
      await announceNode()
      await markLoaded(DOC)
    })
    await redis.del(`octo-docs:node-alive:${dead}`)

    await otherLiveHolders(DOC)
    expect(redis.hashes.get(`octo-docs:doc-holders:${DOC}`)?.size ?? 0).toBe(0)
  })

  it('keeps the live holders when a dead one is cleaned up alongside them', async () => {
    const ids: Record<string, string> = {}
    for (const node of ['pod-dead', 'pod-live']) {
      await asNode(node, async () => {
        ids[node] = nodeId()
        await announceNode()
        await markLoaded(DOC)
      })
    }
    await redis.del(`octo-docs:node-alive:${ids['pod-dead']}`)

    expect(await otherLiveHolders(DOC)).toEqual([ids['pod-live']])
  })

  it('withdraws the liveness key on graceful shutdown', async () => {
    await announceNode()
    expect(await redis.get(`octo-docs:node-alive:${nodeId()}`)).toBe('1')

    await withdrawNode()
    expect(await redis.get(`octo-docs:node-alive:${nodeId()}`)).toBeNull()
  })

  /**
   * The direction that matters. An unreachable Redis answering "nobody holds
   * it" would authorise a destructive rewrite of a document that other replicas
   * are actively editing.
   */
  it('throws rather than reporting an empty holder list when Redis is down', async () => {
    redis.failOn = 'hgetall'
    await expect(otherLiveHolders(DOC)).rejects.toThrow()
  })

  it('throws when the liveness lookup itself fails', async () => {
    await asNode('pod-b', async () => {
      await announceNode()
      await markLoaded(DOC)
    })
    redis.failOn = 'mget'

    await expect(otherLiveHolders(DOC)).rejects.toThrow()
  })
})

describe('withCompactionLock', () => {
  it('runs the work and reports it ran', async () => {
    const out = await withCompactionLock(DOC, async () => 'done')
    expect(out).toEqual({ ran: true, value: 'done' })
  })

  it('stands down while another replica holds the lock', async () => {
    let released = false
    const first = withCompactionLock(DOC, async () => {
      const second = await asNode('pod-b', () => withCompactionLock(DOC, async () => 'should not run'))
      expect(second).toEqual({ ran: false })
      released = true
      return 'first'
    })

    expect(await first).toEqual({ ran: true, value: 'first' })
    expect(released).toBe(true)
  })

  it('releases the lock so the next attempt can take it', async () => {
    await withCompactionLock(DOC, async () => 'first')
    const second = await withCompactionLock(DOC, async () => 'second')
    expect(second).toEqual({ ran: true, value: 'second' })
  })

  it('releases the lock even when the work throws', async () => {
    await expect(
      withCompactionLock(DOC, async () => {
        throw new Error('rebuild failed')
      }),
    ).rejects.toThrow('rebuild failed')

    expect(await withCompactionLock(DOC, async () => 'after')).toEqual({ ran: true, value: 'after' })
  })

  /**
   * A plain DEL on release would delete whatever lock is there — including one
   * another replica took after this node stalled past the TTL, letting a third
   * replica in alongside it. The release is a compare-and-delete for that reason.
   */
  it('does not release a lock that another replica has since taken', async () => {
    await withCompactionLock(DOC, async () => {
      // Simulate this node stalling past the TTL and pod-b taking over.
      redis.strings.set(`octo-docs:compact-lock:${DOC}`, 'pod-b:1:1')
      return null
    })

    expect(redis.strings.get(`octo-docs:compact-lock:${DOC}`)).toBe('pod-b:1:1')
  })

  it('locks per document, not globally', async () => {
    await withCompactionLock(DOC, async () => {
      const other = await withCompactionLock('octo:s:f_default:d_other', async () => 'ran')
      expect(other).toEqual({ ran: true, value: 'ran' })
      return null
    })
  })
})
