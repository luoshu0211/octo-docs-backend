import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { compactState } from '../src/collab/compactionWorker.js'
import { runCompactionOffThread, isCompactionRunning } from '../src/collab/compactionRunner.js'

/** A sheet-shaped document with `rounds` of churn over every cell. */
function churned(cells: number, rounds: number): Y.Doc {
  const doc = new Y.Doc()
  const map = doc.getMap('cells')
  doc.transact(() => {
    for (let i = 0; i < cells; i++) map.set(`r${i}`, { v: i, s: { ff: 'Arial', fs: 8 } })
  })
  for (let r = 0; r < rounds; r++) {
    doc.transact(() => {
      for (const k of map.keys()) map.set(k, { ...(map.get(k) as object), r })
    })
  }
  return doc
}

describe('compactState — the pure rebuild the worker runs', () => {
  it('sheds history while reproducing every value', () => {
    const doc = churned(300, 20)
    const before = Y.encodeStateAsUpdateV2(doc)

    const out = compactState({ state: before, encoding: 2, writeEncoding: 2 })
    expect(out.ok).toBe(true)
    if (!out.ok) return

    expect(out.compacted.length).toBeLessThan(before.length)

    const revived = new Y.Doc()
    Y.applyUpdateV2(revived, out.compacted)
    expect(revived.getMap('cells').toJSON()).toEqual(doc.getMap('cells').toJSON())
  })

  it('reads a legacy v1 row and writes v2', () => {
    const doc = churned(200, 15)
    const v1 = Y.encodeStateAsUpdate(doc)
    const out = compactState({ state: v1, encoding: 1, writeEncoding: 2 })
    expect(out.ok).toBe(true)
    if (!out.ok) return

    const revived = new Y.Doc()
    Y.applyUpdateV2(revived, out.compacted)
    expect(revived.getMap('cells').size).toBe(200)
    // Already v1: the backup is the row's own bytes, no conversion paid for.
    expect(out.backupV1).toBe(v1)
  })

  /**
   * The baseline the saving gate divides by. It must be what the document costs
   * as v2 WITHOUT a rebuild — for a v1 row that is a different number from the
   * stored length, and using the stored length would credit the rebuild with the
   * encoding change (worth about half the bytes) instead of its own work.
   */
  it('reports a v2 baseline, not the stored length, for a v1 row', () => {
    const doc = churned(400, 20)
    const v1 = Y.encodeStateAsUpdate(doc)

    const out = compactState({ state: v1, encoding: 1, writeEncoding: 2 })
    expect(out.ok).toBe(true)
    if (!out.ok) return

    expect(out.beforeBytes).toBe(v1.length)
    // The like-for-like number: same content, v2, no rebuild.
    expect(out.baselineBytes).toBe(Y.encodeStateAsUpdateV2(doc).length)
    expect(out.baselineBytes).toBeLessThan(out.beforeBytes)
  })

  it('reports the stored length as the baseline for a row already in v2', () => {
    const doc = churned(400, 20)
    const v2 = Y.encodeStateAsUpdateV2(doc)

    const out = compactState({ state: v2, encoding: 2, writeEncoding: 2 })
    expect(out.ok).toBe(true)
    if (!out.ok) return

    expect(out.baselineBytes).toBe(v2.length)
    expect(out.baselineBytes).toBe(out.beforeBytes)
  })

  /*
   * There is deliberately NO "refuses a document with no history to shed" case
   * here, and it must not be added back with a zero-churn fixture.
   *
   * Measured over 200 draws per row, a zero-churn document (1, 10, 50 or 200
   * cells alike) rebuilds 1 byte SMALLER on ~3% of draws and 1 byte larger on the
   * rest: Y.Doc's clientID is random and its varint width moves the total, so the
   * margin is ±1 byte no matter the cell count. An assertion on that boundary
   * passes 12/12 in isolation and fails roughly once every 25 full-suite runs —
   * exactly how it behaved before this comment replaced it.
   *
   * The `>=` floor in compactState is still worth having (it is what stops a v1
   * row being credited for the encoding change), but the case that MATTERS in
   * production is the 10% worth-it floor in compaction.ts, which runs ahead of
   * both the backup and the write. That one is asserted in compaction.test.ts
   * against a margin far outside the noise.
   */

  /**
   * A ProseMirror body is a Y.XmlFragment, which this rebuild cannot reproduce.
   * It must be refused, never flattened into a Y.Map — that would silently
   * destroy the document body.
   */
  it('refuses a rich-text document rather than flattening it', () => {
    const doc = new Y.Doc()
    doc.transact(() => doc.getXmlFragment('body').insert(0, [new Y.XmlText('hello')]))

    const out = compactState({ state: Y.encodeStateAsUpdateV2(doc), encoding: 2, writeEncoding: 2 })
    expect(out).toEqual({ ok: false, reason: expect.stringContaining('cannot reproduce') })
  })

  /**
   * Whiteboard elements are `new Y.Map()` values inside a top-level map. Copying
   * one across would either fail or degrade it into a plain object, so a nested
   * type is a refusal too — verified here because the failure would be silent.
   */
  it('refuses a document with nested collaborative values', () => {
    const doc = new Y.Doc()
    doc.transact(() => {
      const el = new Y.Map<unknown>()
      el.set('x', 1)
      doc.getMap('elements').set('e1', el)
    })

    const out = compactState({ state: Y.encodeStateAsUpdateV2(doc), encoding: 2, writeEncoding: 2 })
    expect(out).toEqual({ ok: false, reason: expect.stringContaining('cannot reproduce') })
  })

  /** The backup blob must be v1 whatever the row was, or restore cannot read it. */
  it('returns a v1 backup of the ORIGINAL state alongside the v2 rebuild', () => {
    const doc = churned(300, 20)
    const before = Y.encodeStateAsUpdateV2(doc)

    const out = compactState({ state: before, encoding: 2, writeEncoding: 2 })
    expect(out.ok).toBe(true)
    if (!out.ok) return

    // Readable as v1, and carrying the pre-compaction content.
    const restored = new Y.Doc()
    Y.applyUpdate(restored, out.backupV1)
    expect(restored.getMap('cells').toJSON()).toEqual(doc.getMap('cells').toJSON())
  })

  it('returns a reason instead of throwing on malformed input', () => {
    const out = compactState({
      state: new Uint8Array([1, 2, 3, 4, 5]),
      encoding: 2,
      writeEncoding: 2,
    })
    expect(out.ok).toBe(false)
  })
})

describe('runCompactionOffThread — the property the whole change rests on', () => {
  /**
   * The bug this replaced: the rebuild ran on the event loop, and `void`-ing the
   * promise did not move it. Several seconds of synchronous CPU there is exactly
   * what fails a liveness probe.
   *
   * A 20 ms heartbeat measures it, and the assertion counts BEATS rather than
   * measuring gap length. That distinction is the whole test: when the main
   * thread is fully blocked the timer never fires at all, so a gap array stays
   * empty and `Math.max([])` is -Infinity — which sails past any "no gap longer
   * than N" check. Silence would look exactly like success. Counting beats
   * against the number expected for the elapsed time fails loudly instead.
   *
   * Mutation-checked by running the same rebuild inline on this thread:
   * 24/26 beats through the worker, 0/21 inline.
   */
  it('leaves the event loop responsive while it works', async () => {
    const doc = churned(25_000, 30)
    const state = Y.encodeStateAsUpdateV2(doc)

    let beats = 0
    const tick = setInterval(() => beats++, 20)

    const startedAt = Date.now()
    const out = await runCompactionOffThread({ state, encoding: 2, writeEncoding: 2 })
    const elapsed = Date.now() - startedAt
    clearInterval(tick)

    expect(out.ok).toBe(true)
    // Surfaces the reason on failure. A worker that fails to START reports
    // `ok: false` exactly like a business-level refusal does, and asserting on
    // the boolean alone turns "the thread never ran" into an opaque
    // `expected false to be true` — which is how a dev/test path where the
    // worker could not resolve its own imports stayed unexplained.
    if (!out.ok) throw new Error(`worker did not complete: ${out.reason}`)
    // Without this the comparison below would be vacuous on a fast machine.
    expect(elapsed).toBeGreaterThan(200)
    expect(beats).toBeGreaterThanOrEqual(Math.floor(elapsed / 20) / 2)
  }, 60_000)

  it('refuses a second compaction while one is in flight', async () => {
    const state = Y.encodeStateAsUpdateV2(churned(2_000, 20))
    const second = Y.encodeStateAsUpdateV2(churned(2_000, 20))

    const first = runCompactionOffThread({ state, encoding: 2, writeEncoding: 2 })
    // The slot is taken synchronously, before the first await resolves.
    const rejected = await runCompactionOffThread({ state: second, encoding: 2, writeEncoding: 2 })
    expect(rejected).toEqual({ ok: false, reason: 'busy' })

    await first
    expect(isCompactionRunning()).toBe(false) // the slot is released
  }, 30_000)
})
