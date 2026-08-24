import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { computeFinalState, isEmptyUpdate, isEmptyUpdateV2 } from '../src/collab/persistence.js'
import { applyStoredState, storedStateAsV1 } from '../src/collab/collabDatabase.js'
import type { StoredYjsState } from '../src/db/repos/yjsDocumentRepo.js'

function docWith(mutate: (doc: Y.Doc) => void): Y.Doc {
  const doc = new Y.Doc()
  doc.transact(() => mutate(doc))
  return doc
}
const v1 = (d: Y.Doc): StoredYjsState => ({ state: Y.encodeStateAsUpdate(d), encoding: 1 })
const v2 = (d: Y.Doc): StoredYjsState => ({ state: Y.encodeStateAsUpdateV2(d), encoding: 2 })

describe('v2 persistence: format dispatch on load', () => {
  it('decodes a legacy v1 row with the v1 decoder', () => {
    const src = docWith((d) => d.getText('t').insert(0, 'legacy'))
    const out = new Y.Doc()
    applyStoredState(out, v1(src))
    expect(out.getText('t').toString()).toBe('legacy')
  })

  it('decodes a v2 row with the v2 decoder', () => {
    const src = docWith((d) => d.getText('t').insert(0, 'modern'))
    const out = new Y.Doc()
    applyStoredState(out, v2(src))
    expect(out.getText('t').toString()).toBe('modern')
  })

  /**
   * The reason the encoding column exists. Yjs does not reject a v2 payload fed
   * to the v1 decoder with a clean error — it produces a document that is wrong.
   * If this ever starts passing, the dispatch in applyStoredState is no longer
   * load-bearing and the column could be dropped; until then it is a correctness
   * boundary, not an optimisation.
   */
  it('mis-dispatching v2 bytes to the v1 decoder does NOT round-trip', () => {
    const src = docWith((d) => d.getText('t').insert(0, 'content that must survive'))
    const wrong = new Y.Doc()
    let threw = false
    try {
      applyStoredState(wrong, { state: Y.encodeStateAsUpdateV2(src), encoding: 1 })
    } catch {
      threw = true
    }
    expect(threw || wrong.getText('t').toString() !== 'content that must survive').toBe(true)
  })
})

/**
 * This suite is specifically about the v2 write path, i.e. what happens AFTER
 * `YJS_WRITE_V2` is flipped (phase 2 — see collab/persistedEncoding.ts). The
 * encoding is therefore pinned to 2 on every call rather than read from config:
 * these cases must keep describing v2 behaviour even while the fleet default is
 * still v1. The phase-1 (v1 write) counterparts live in persistence.test.ts,
 * which runs its whole suite once per phase.
 */
const WRITE_V2 = 2 as const

describe('v2 persistence: computeFinalState', () => {
  it('persists v2 when there is no existing row', () => {
    const live = docWith((d) => d.getText('t').insert(0, 'hello'))
    const incoming = Y.encodeStateAsUpdateV2(live)
    const { finalState, usedUnion } = computeFinalState(null, live, incoming, WRITE_V2)
    expect(usedUnion).toBe(false)
    expect(new Uint8Array(finalState)).toEqual(incoming)
  })

  it('single-writer path over a LEGACY v1 row: no union, writes the v2 encoding', () => {
    const base = docWith((d) => d.getText('t').insert(0, 'hello'))
    const existing = v1(base) // row predates the v2 rollout
    base.getText('t').insert(5, ' world') // same doc continues => superset
    const incoming = Y.encodeStateAsUpdateV2(base)

    const { finalState, usedUnion } = computeFinalState(existing, base, incoming, WRITE_V2)
    expect(usedUnion).toBe(false)
    expect(new Uint8Array(finalState)).toEqual(incoming)
  })

  it('single-writer path over a v2 row: no union', () => {
    const base = docWith((d) => d.getText('t').insert(0, 'hello'))
    const existing = v2(base)
    base.getText('t').insert(5, ' world')
    const incoming = Y.encodeStateAsUpdateV2(base)

    const { usedUnion } = computeFinalState(existing, base, incoming, WRITE_V2)
    expect(usedUnion).toBe(false)
  })

  it('concurrency over a LEGACY v1 row: unions, losing no edit from either side', () => {
    const a = docWith((d) => d.getText('t').insert(0, 'AAA'))
    const b = docWith((d) => d.getText('t').insert(0, 'BBB'))
    const { finalState, usedUnion } = computeFinalState(v1(a), b, Y.encodeStateAsUpdateV2(b), WRITE_V2)
    expect(usedUnion).toBe(true)

    const merged = new Y.Doc()
    Y.applyUpdateV2(merged, new Uint8Array(finalState))
    const text = merged.getText('t').toString()
    expect(text).toContain('AAA')
    expect(text).toContain('BBB')
  })

  it('concurrency over a v2 row: unions, losing no edit from either side', () => {
    const a = docWith((d) => d.getText('t').insert(0, 'AAA'))
    const b = docWith((d) => d.getText('t').insert(0, 'BBB'))
    const { finalState, usedUnion } = computeFinalState(v2(a), b, Y.encodeStateAsUpdateV2(b), WRITE_V2)
    expect(usedUnion).toBe(true)

    const merged = new Y.Doc()
    Y.applyUpdateV2(merged, new Uint8Array(finalState))
    const text = merged.getText('t').toString()
    expect(text).toContain('AAA')
    expect(text).toContain('BBB')
  })

  it('always persists v2, whatever the existing row was', () => {
    for (const existing of [null, v1(docWith((d) => d.getText('t').insert(0, 'x'))), v2(docWith((d) => d.getText('t').insert(0, 'x')))]) {
      const live = docWith((d) => d.getText('t').insert(0, 'y'))
      const { finalState } = computeFinalState(existing, live, Y.encodeStateAsUpdateV2(live), WRITE_V2)
      // Decodable as v2 and NOT as v1 => the bytes really are v2.
      const asV2 = new Y.Doc()
      expect(() => Y.applyUpdateV2(asV2, new Uint8Array(finalState))).not.toThrow()
    }
  })
})

describe('empty-update detection per format', () => {
  it('recognises an empty v1 update', () => {
    expect(isEmptyUpdate(Y.encodeStateAsUpdate(new Y.Doc()))).toBe(true)
    expect(isEmptyUpdate(Y.encodeStateAsUpdate(docWith((d) => d.getText('t').insert(0, 'x'))))).toBe(false)
  })

  it('recognises an empty v2 update (the v1 two-zero-byte check does not apply)', () => {
    expect(isEmptyUpdateV2(Y.encodeStateAsUpdateV2(new Y.Doc()))).toBe(true)
    expect(isEmptyUpdateV2(Y.encodeStateAsUpdateV2(docWith((d) => d.getText('t').insert(0, 'x'))))).toBe(false)
  })
})

describe('storedStateAsV1 (rare v1-speaking call sites, e.g. version restore)', () => {
  it('passes a v1 row through untouched', () => {
    const d = docWith((x) => x.getText('t').insert(0, 'abc'))
    const stored = v1(d)
    expect(storedStateAsV1(stored)).toBe(stored.state)
  })

  it('converts a v2 row into an equivalent v1 update', () => {
    const d = docWith((x) => x.getText('t').insert(0, 'abc'))
    const asV1 = storedStateAsV1(v2(d))
    expect(asV1).not.toBeNull()
    const out = new Y.Doc()
    Y.applyUpdate(out, asV1!)
    expect(out.getText('t').toString()).toBe('abc')
  })

  it('maps a missing row to null', () => {
    expect(storedStateAsV1(null)).toBeNull()
  })
})
