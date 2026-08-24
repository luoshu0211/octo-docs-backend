import { describe, it, expect, vi, beforeEach } from 'vitest'

const CAP = 10 * 1024 * 1024
vi.mock('../src/config/env.js', () => ({ config: { maxDocBytes: CAP } }))

const { maybeCompactOnUnload } = await import('../src/collab/autoCompact.js')
const {
  DocumentLoadedError,
  CompactionLockedError,
  ClusterStateUnknownError,
  CompactionNotWorthItError,
} = await import(
  '../src/collab/compaction.js'
)

const DOC = 'octo:s:f_default:d_1'
type Deps = Parameters<typeof maybeCompactOnUnload>[1]

function deps(over: Partial<Deps> = {}) {
  return {
    storedBytes: vi.fn(async () => CAP * 0.8),
    compact: vi.fn(async () => ({
      documentName: DOC,
      beforeBytes: 8_000_000,
      afterBytes: 3_000_000,
      entries: 100,
      backupVersionId: 1,
    })),
    log: vi.fn(),
    ...over,
  } as unknown as Deps & {
    storedBytes: ReturnType<typeof vi.fn>
    compact: ReturnType<typeof vi.fn>
    log: ReturnType<typeof vi.fn>
  }
}

describe('maybeCompactOnUnload', () => {
  beforeEach(() => vi.clearAllMocks())

  it('compacts a document using most of its budget', async () => {
    const d = deps()
    const out = await maybeCompactOnUnload(DOC, d)

    expect(d.compact).toHaveBeenCalledWith(DOC)
    expect(out).toEqual({ ran: true, beforeBytes: 8_000_000, afterBytes: 3_000_000 })
  })

  /** Rewriting a small document costs a transaction to save nothing. */
  it('leaves a small document alone', async () => {
    const d = deps({ storedBytes: vi.fn(async () => 1_000) })
    const out = await maybeCompactOnUnload(DOC, d)

    expect(d.compact).not.toHaveBeenCalled()
    expect(out).toEqual({ ran: false, reason: 'below-threshold' })
  })

  it('leaves a document with no persisted row alone', async () => {
    const d = deps({ storedBytes: vi.fn(async () => null) })
    expect(await maybeCompactOnUnload(DOC, d)).toEqual({ ran: false, reason: 'below-threshold' })
  })

  /**
   * The race compactDocument refuses: someone reopened the document between the
   * unload and the compaction. Routine — the next unload tries again.
   */
  it('stands down when a client reconnected during the attempt', async () => {
    const d = deps({
      compact: vi.fn(async () => {
        throw new DocumentLoadedError(DOC)
      }),
    })
    const out = await maybeCompactOnUnload(DOC, d)

    expect(out).toEqual({ ran: false, reason: 'reloaded' })
    expect(d.log).not.toHaveBeenCalled()
  })

  /**
   * Under multi-replica another node may be compacting the same document. The
   * work still happens, just not here — this must not read as a failure.
   */
  it('stands down when another replica holds the compaction lock', async () => {
    const d = deps({
      compact: vi.fn(async () => {
        throw new CompactionLockedError(DOC)
      }),
    })
    const out = await maybeCompactOnUnload(DOC, d)

    expect(out).toEqual({ ran: false, reason: 'held-elsewhere' })
    expect(d.log).not.toHaveBeenCalled()
  })

  /**
   * Redis being unreachable makes the fleet-wide guard blind, so compaction
   * refuses. Unlike the routine stand-downs this one is logged: a document that
   * never compacts because Redis has been down for a week must be visible.
   */
  it('reports and logs a blind fleet check', async () => {
    const d = deps({
      compact: vi.fn(async () => {
        throw new ClusterStateUnknownError(DOC, new Error('connection refused'))
      }),
    })
    const out = await maybeCompactOnUnload(DOC, d)

    expect(out).toEqual({ ran: false, reason: 'cluster-unknown' })
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('cannot determine which replicas'))
  })

  it('reports a rich-text document as permanently not compactable', async () => {
    const d = deps({
      compact: vi.fn(async () => {
        throw new Error('refusing to compact x: it contains types this rebuild cannot reproduce')
      }),
    })
    expect(await maybeCompactOnUnload(DOC, d)).toEqual({ ran: false, reason: 'not-compactable' })
  })

  /**
   * The saving threshold is enforced inside compactDocument's transaction, so a
   * rewrite that is not worth doing arrives here as an error with NOTHING
   * written.
   *
   * The previous version of this test asserted the old shape — `compact`
   * resolving with a marginal saving, this module reporting `no-saving` — and it
   * passed while the real code had already committed the rewrite and a
   * multi-megabyte backup row. `compact` is a `vi.fn` here, so it never touches
   * a database and could never have shown that. The mock now returns what the
   * real function returns in that case: a throw.
   */
  it('reports a rebuild that was refused for freeing too little', async () => {
    const d = deps({
      compact: vi.fn(async () => {
        throw new CompactionNotWorthItError(DOC, 36, 504483)
      }),
    })
    const out = await maybeCompactOnUnload(DOC, d)

    expect(out).toEqual({ ran: false, reason: 'no-saving' })
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('only 36 of 504483'))
  })

  /**
   * This runs on a teardown path: a failed optimisation must never propagate
   * into the unload — and must not vanish silently either.
   */
  it('never throws, and logs an unexpected failure', async () => {
    const d = deps({
      compact: vi.fn(async () => {
        throw new Error('deadlock found when trying to get lock')
      }),
    })
    const out = await maybeCompactOnUnload(DOC, d)

    expect(out).toEqual({ ran: false, reason: 'failed' })
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('leaving it untouched'))
  })

  it('never throws when the size lookup itself fails', async () => {
    const d = deps({
      storedBytes: vi.fn(async () => {
        throw new Error('connection lost')
      }),
    })
    await expect(maybeCompactOnUnload(DOC, d)).resolves.toEqual({ ran: false, reason: 'failed' })
  })
})

describe('contentDrift — the check that stands between a bad rebuild and a destroyed document', () => {
  it('reports no drift for an identical rebuild', async () => {
    const Y = await import('yjs')
    const { contentDrift } = await import('../src/collab/compaction.js')

    const a = new Y.Doc()
    a.transact(() => a.getMap('cells').set('r1', { v: 1 }))
    const b = new Y.Doc()
    b.transact(() => b.getMap('cells').set('r1', { v: 1 }))

    expect(contentDrift(a, b)).toBeNull()
  })

  it('catches a top-level type the rebuild dropped', async () => {
    const Y = await import('yjs')
    const { contentDrift } = await import('../src/collab/compaction.js')

    const a = new Y.Doc()
    a.transact(() => {
      a.getMap('cells').set('r1', { v: 1 })
      a.getMap('sheetDims').set('c1', 100)
    })
    const b = new Y.Doc()
    b.transact(() => b.getMap('cells').set('r1', { v: 1 })) // sheetDims lost

    expect(contentDrift(a, b)).toMatch(/top-level types differ/)
  })

  it('catches a value the rebuild mangled', async () => {
    const Y = await import('yjs')
    const { contentDrift } = await import('../src/collab/compaction.js')

    const a = new Y.Doc()
    a.transact(() => a.getMap('cells').set('r1', { v: 1, s: { ff: 'Arial' } }))
    const b = new Y.Doc()
    b.transact(() => b.getMap('cells').set('r1', { v: 1 })) // style dropped

    expect(contentDrift(a, b)).toBe('"cells" differs')
  })
})
