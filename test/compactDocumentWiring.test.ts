/**
 * Wire-up test for `compactDocument`.
 *
 * The pure pieces are covered elsewhere: compaction.test.ts checks the rebuild,
 * compactionWorker.test.ts checks the worker, compactionCluster.test.ts checks
 * the holder registry and the lock. Every one of those passes whether or not
 * `compactDocument` actually CALLS them — which was not a hypothetical: removing
 * both fleet-wide checks from the orchestration left all 2910 tests green.
 *
 * So this file asserts the wiring, and specifically that each guard fires
 * BEFORE the destructive write. A guard that runs after the UPSERT is not a
 * guard.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const CAP = 10 * 1024 * 1024
const DOC = 'octo:s:f_default:d_1'

// Mutable so the two-phase-rollout cases below can flip the write flag; every
// other case runs with v2 writes ON, which is the end state of the rollout.
const config = { maxDocBytes: CAP, hostname: 'test-node', yjsWriteV2: true }
vi.mock('../src/config/env.js', () => ({ config }))

const documents = new Map<string, unknown>()
vi.mock('../src/collab/server.js', () => ({
  getCollabServer: () => ({ hocuspocus: { documents } }),
}))

vi.mock('../src/db/pool.js', () => ({
  // Runs the callback immediately with a dummy tx: this test is about ordering
  // and refusal, not about SQL.
  transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
}))

const selectForUpdateTx = vi.fn()
const upsertStateTx = vi.fn()
vi.mock('../src/db/repos/yjsDocumentRepo.js', () => ({
  yjsDocumentRepo: {
    selectForUpdateTx: (...a: unknown[]) => selectForUpdateTx(...a),
    upsertStateTx: (...a: unknown[]) => upsertStateTx(...a),
  },
}))

const createTx = vi.fn(async (..._a: unknown[]) => 4242)
vi.mock('../src/db/repos/docVersionRepo.js', () => ({
  docVersionRepo: { createTx: (...a: unknown[]) => createTx(...a) },
  KIND_AUTO: 'auto',
}))

const runCompactionOffThread = vi.fn()
vi.mock('../src/collab/compactionRunner.js', () => ({
  runCompactionOffThread: (...a: unknown[]) => runCompactionOffThread(...a),
}))

const markCompacted = vi.fn(async (_documentName: string, _at: number) => {})
vi.mock('../src/collab/compactionNotice.js', () => ({
  markCompacted: (documentName: string, at: number) => markCompacted(documentName, at),
}))

const otherLiveHolders = vi.fn(async () => [] as string[])
/**
 * Mirrors the real `withCompactionLock` result shape: `{ ran: false }` (lock held
 * elsewhere, `value` absent) or `{ ran: true, value }`. Typed as a union rather
 * than `{ ran: boolean; value: unknown }` so `mockResolvedValue({ ran: false })`
 * type-checks — with the wider object type it does not, since `value` would be
 * required on both arms.
 */
type LockOutcome = { ran: false } | { ran: true; value: unknown }
const withCompactionLock = vi.fn(
  async (_name: string, fn: () => Promise<unknown>): Promise<LockOutcome> => ({
    ran: true,
    value: await fn(),
  }),
)
vi.mock('../src/collab/compactionCluster.js', () => ({
  // Forwarded with the spies' own parameter types (not `...unknown[]`): these two
  // spies are typed, so an untyped spread does not type-check against them.
  otherLiveHolders: (...a: Parameters<typeof otherLiveHolders>) => otherLiveHolders(...a),
  withCompactionLock: (...a: Parameters<typeof withCompactionLock>) => withCompactionLock(...a),
}))

const {
  compactDocument,
  DocumentLoadedError,
  ClusterStateUnknownError,
  CompactionLockedError,
  CompactionNotWorthItError,
} = await import('../src/collab/compaction.js')

/** A row that would compact successfully if every guard let it through. */
function healthyRow(): void {
  selectForUpdateTx.mockResolvedValue({ state: Buffer.alloc(9_000_000, 1), encoding: 2 })
  runCompactionOffThread.mockResolvedValue({
    ok: true,
    compacted: new Uint8Array(3_000_000),
    backupV1: new Uint8Array(9_500_000),
    entries: 1000,
    beforeBytes: 9_000_000,
    baselineBytes: 9_000_000,
  })
}

/** Nothing was written to either table. */
function expectNothingWritten(): void {
  expect(upsertStateTx).not.toHaveBeenCalled()
  expect(createTx).not.toHaveBeenCalled()
}

describe('compactDocument — the fleet-wide guards are actually wired in', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    documents.clear()
    otherLiveHolders.mockResolvedValue([])
    withCompactionLock.mockImplementation(async (_n, fn) => ({ ran: true, value: await fn() }))
    healthyRow()
  })

  it('compacts when no replica holds the document', async () => {
    const result = await compactDocument(DOC)

    expect(otherLiveHolders).toHaveBeenCalledWith(DOC)
    expect(upsertStateTx).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ beforeBytes: 9_000_000, afterBytes: 3_000_000 })
  })

  /**
   * The reason this module exists. Another replica holding the document in
   * memory will flush its pre-compaction state back over the compacted row.
   */
  it('refuses, without writing, when another live replica holds it', async () => {
    otherLiveHolders.mockResolvedValue(['octo-docs-backend-prod-other'])

    await expect(compactDocument(DOC)).rejects.toThrow(DocumentLoadedError)
    expectNothingWritten()
  })

  it('names the replica that is holding it, so the log is actionable', async () => {
    otherLiveHolders.mockResolvedValue(['pod-a', 'pod-b'])

    await expect(compactDocument(DOC)).rejects.toThrow(/pod-a, pod-b/)
  })

  /**
   * Fail-closed. An unreachable Redis reporting "nobody holds it" would be an
   * unreachable Redis authorising a destructive rewrite.
   */
  it('refuses, without writing, when Redis cannot answer', async () => {
    otherLiveHolders.mockRejectedValue(new Error('ECONNREFUSED'))

    await expect(compactDocument(DOC)).rejects.toThrow(ClusterStateUnknownError)
    expectNothingWritten()
  })

  it('refuses, without writing, when another replica holds the lock', async () => {
    withCompactionLock.mockResolvedValue({ ran: false })

    await expect(compactDocument(DOC)).rejects.toThrow(CompactionLockedError)
    expectNothingWritten()
  })

  it('refuses, without writing, when the document is loaded on THIS replica', async () => {
    documents.set(DOC, {})

    await expect(compactDocument(DOC)).rejects.toThrow(DocumentLoadedError)
    expectNothingWritten()
    // The local check is free, so it must come first: no Redis round trip, no
    // lock acquisition, no row lock taken for a document we already know is busy.
    expect(otherLiveHolders).not.toHaveBeenCalled()
    expect(withCompactionLock).not.toHaveBeenCalled()
  })

  /**
   * A holder that appears between the first check and the lock must still be
   * caught — that window is the whole reason the check is repeated.
   */
  it('re-checks the fleet after taking the lock, not just before', async () => {
    otherLiveHolders.mockResolvedValueOnce([]).mockResolvedValueOnce(['pod-late'])

    await expect(compactDocument(DOC)).rejects.toThrow(DocumentLoadedError)
    expect(otherLiveHolders).toHaveBeenCalledTimes(2)
    expectNothingWritten()
  })

  it('re-checks THIS replica after taking the lock', async () => {
    withCompactionLock.mockImplementation(async (_n, fn) => {
      documents.set(DOC, {}) // a client reconnected while we waited for the lock
      return { ran: true, value: await fn() }
    })

    await expect(compactDocument(DOC)).rejects.toThrow(DocumentLoadedError)
    expectNothingWritten()
  })

  /** Everything destructive has to happen inside the lock, or it is decorative. */
  it('does all of its work inside the lock', async () => {
    let insideLock = false
    withCompactionLock.mockImplementation(async (_n, fn) => {
      insideLock = true
      const value = await fn()
      insideLock = false
      return { ran: true, value }
    })
    upsertStateTx.mockImplementation(() => {
      expect(insideLock).toBe(true)
      return Promise.resolve()
    })

    await compactDocument(DOC)
    expect(upsertStateTx).toHaveBeenCalledTimes(1)
  })

  it('writes the backup before the compacted state, never after', async () => {
    const order: string[] = []
    createTx.mockImplementation(async () => {
      order.push('backup')
      return 4242
    })
    upsertStateTx.mockImplementation(async () => {
      order.push('upsert')
    })

    await compactDocument(DOC)
    expect(order).toEqual(['backup', 'upsert'])
  })

  it('refuses, without writing, when the worker rejects the rebuild', async () => {
    runCompactionOffThread.mockResolvedValue({ ok: false, reason: 'the rebuild is not smaller' })

    await expect(compactDocument(DOC)).rejects.toThrow(/not smaller/)
    expectNothingWritten()
  })

  /**
   * The defect this test exists for: the saving threshold used to be checked in
   * autoCompact.ts, AFTER compactDocument had committed. Measured live, that
   * spent a full worker rebuild, a rewrite of the row and a 0.92 MB doc_version
   * backup to save 36 bytes — and would have repeated on every unload.
   *
   * So the assertion that matters is not the returned reason, it is that NOTHING
   * was written.
   */
  it('refuses, without writing, when the rebuild frees too little to be worth it', async () => {
    runCompactionOffThread.mockResolvedValue({
      ok: true,
      compacted: new Uint8Array(504_447),
      backupV1: new Uint8Array(966_535),
      entries: 1500,
      beforeBytes: 504_483,
      baselineBytes: 504_483, // 36 bytes saved — the real measurement
    })

    await expect(compactDocument(DOC)).rejects.toThrow(CompactionNotWorthItError)
    expectNothingWritten()
  })

  /** Just over the 10% line — this one IS worth writing. */
  it('writes a rebuild that clears the saving threshold', async () => {
    runCompactionOffThread.mockResolvedValue({
      ok: true,
      compacted: new Uint8Array(800_000),
      backupV1: new Uint8Array(1_000_000),
      entries: 1500,
      beforeBytes: 1_000_000,
      baselineBytes: 1_000_000, // 20% freed
    })

    await compactDocument(DOC)
    expect(upsertStateTx).toHaveBeenCalledTimes(1)
    expect(createTx).toHaveBeenCalledTimes(1)
  })

  /**
   * The units trap. A v1 row is roughly twice its v2 size, so measuring the v2
   * rebuild against the stored v1 length credits it with the encoding change and
   * lets a rebuild that achieved NOTHING clear a 10% threshold. The worker
   * reports a v2 baseline for exactly this reason; this asserts the gate uses it.
   */
  it('judges the saving in v2 on both sides, not against the stored v1 size', async () => {
    runCompactionOffThread.mockResolvedValue({
      ok: true,
      compacted: new Uint8Array(4_990_000),
      backupV1: new Uint8Array(10_000_000),
      // Stored as v1 at 10 MB; the same content as v2 is 5 MB. The rebuild got
      // it to 4.99 MB — a 0.2% win, not the 50% the v1 number would suggest.
      beforeBytes: 10_000_000,
      baselineBytes: 5_000_000,
    })

    await expect(compactDocument(DOC)).rejects.toThrow(CompactionNotWorthItError)
    expectNothingWritten()
  })

  it('refuses, without writing, when the rebuild is still over the cap', async () => {
    runCompactionOffThread.mockResolvedValue({
      ok: true,
      compacted: new Uint8Array(CAP + 1),
      backupV1: new Uint8Array(10),
      entries: 1,
      beforeBytes: CAP + 2,
    })

    await expect(compactDocument(DOC)).rejects.toThrow(/exceeds the cap/)
    expectNothingWritten()
  })

  /**
   * Compaction rewrites the authoritative row, so it is bound by the SAME
   * two-phase rollout constraint as persistence.store. A v2 row written while
   * the fleet is still in phase 1 is handed to instances that decode it as v1
   * and get an EMPTY document — the corruption the flag exists to prevent.
   *
   * Both halves matter and both are asserted: the encoding requested from the
   * worker, and the label recorded on the row. Those two disagreeing is worse
   * than either being wrong, because a mislabelled row decodes empty instead of
   * failing loudly.
   */
  it('asks for v1 and labels the row v1 while the write flag is off (phase 1)', async () => {
    config.yjsWriteV2 = false
    try {
      await compactDocument(DOC)

      expect(runCompactionOffThread).toHaveBeenCalledWith(
        expect.objectContaining({ writeEncoding: 1 }),
      )
      expect(upsertStateTx).toHaveBeenCalledTimes(1)
      // 4th arg = the encoding label written onto the row.
      expect(upsertStateTx.mock.calls[0]?.[3]).toBe(1)
    } finally {
      config.yjsWriteV2 = true
    }
  })

  it('asks for v2 and labels the row v2 once the write flag is on (phase 2)', async () => {
    await compactDocument(DOC)

    expect(runCompactionOffThread).toHaveBeenCalledWith(
      expect.objectContaining({ writeEncoding: 2 }),
    )
    expect(upsertStateTx).toHaveBeenCalledTimes(1)
    expect(upsertStateTx.mock.calls[0]?.[3]).toBe(2)
  })
})

/**
 * The compaction generation stamp is what tells the next client its IndexedDB
 * copy is stale. Without it compaction is undone on the next open (the browser
 * syncs the old history back), so "did we stamp" is part of the wiring, not a
 * detail — and "did we NOT stamp when nothing was written" is a data-loss guard:
 * a stamp left by a refused compaction makes clients clear a cache that is
 * still correct, and a cache clear costs whatever that client had not synced.
 */
describe('compactDocument — the cache-invalidation stamp', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    documents.clear()
    otherLiveHolders.mockResolvedValue([])
    withCompactionLock.mockImplementation(async (_n, fn) => ({ ran: true, value: await fn() }))
    healthyRow()
  })

  it('stamps the generation after a compaction that was written', async () => {
    await compactDocument(DOC)
    expect(upsertStateTx).toHaveBeenCalledTimes(1)
    expect(markCompacted).toHaveBeenCalledTimes(1)
    expect(markCompacted).toHaveBeenCalledWith(DOC, expect.any(Number))
  })

  it('does NOT stamp when the saving was too small to write', async () => {
    runCompactionOffThread.mockResolvedValue({
      ok: true,
      compacted: new Uint8Array(504_447),
      backupV1: new Uint8Array(966_535),
      entries: 1500,
      beforeBytes: 504_483,
      baselineBytes: 504_483,
    })

    await expect(compactDocument(DOC)).rejects.toThrow(CompactionNotWorthItError)
    expectNothingWritten()
    expect(markCompacted).not.toHaveBeenCalled()
  })

  it('does NOT stamp when another replica holds the document', async () => {
    otherLiveHolders.mockResolvedValue(['pod-b'])

    await expect(compactDocument(DOC)).rejects.toThrow(DocumentLoadedError)
    expect(markCompacted).not.toHaveBeenCalled()
  })

  it('does NOT stamp when the lock was lost', async () => {
    withCompactionLock.mockResolvedValue({ ran: false })

    await expect(compactDocument(DOC)).rejects.toThrow(CompactionLockedError)
    expect(markCompacted).not.toHaveBeenCalled()
  })

  it('does NOT stamp when the worker refused the rebuild', async () => {
    runCompactionOffThread.mockResolvedValue({ ok: false, reason: 'the rebuild is not smaller' })

    await expect(compactDocument(DOC)).rejects.toThrow(/not smaller/)
    expect(markCompacted).not.toHaveBeenCalled()
  })

  /**
   * The stamp must sit OUTSIDE the transaction.
   *
   * Every other refusal in this file aborts before the UPSERT, so a stamp placed
   * just after the write would still look correct in all of them — this case is
   * the one that separates the two placements: the write runs, and THEN the
   * commit fails. A stamp recorded inside the transaction survives a rollback
   * that undid the very compaction it advertises, and every client would then
   * clear a cache that is still correct, losing whatever it had not synced.
   *
   * (Added because mutation testing showed moving the call inside the
   * transaction left all 23 tests green.)
   */
  it('does NOT stamp when the write happened but the commit failed', async () => {
    const { transaction } = await import('../src/db/pool.js')
    // `transaction` is generic in its return type, which a one-off mock cannot
    // satisfy structurally (it never returns R — it throws). The cast is on the
    // MOCK, not on production code, and the behaviour it stands in for is exactly
    // what the test name says: callback completes, commit fails.
    const rollbackAfterWrite = async (fn: (tx: unknown) => Promise<unknown>) => {
      await fn({}) // the callback runs to completion, UPSERT included
      throw new Error('commit failed') // ...and then the commit rolls it all back
    }
    vi.mocked(transaction).mockImplementationOnce(
      rollbackAfterWrite as unknown as typeof transaction,
    )

    await expect(compactDocument(DOC)).rejects.toThrow('commit failed')
    expect(upsertStateTx).toHaveBeenCalledTimes(1)
    expect(markCompacted).not.toHaveBeenCalled()
  })

  /** Stamping is best-effort; it must not turn a committed rewrite into a failure. */
  it('still reports success when stamping fails', async () => {
    markCompacted.mockRejectedValueOnce(new Error('redis down'))
    await expect(compactDocument(DOC)).resolves.toMatchObject({ afterBytes: 3_000_000 })
  })
})
