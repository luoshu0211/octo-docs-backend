import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { computeFinalState, isEmptyUpdate, isEmptyUpdateV2 } from '../src/collab/persistence.js'
import type { StoredYjsState, YjsEncoding } from '../src/db/repos/yjsDocumentRepo.js'

function docWith(mutate: (doc: Y.Doc) => void): Y.Doc {
  const doc = new Y.Doc()
  doc.transact(() => mutate(doc))
  return doc
}

/** A persisted row in the legacy v1 encoding (everything written before the v2 rollout). */
function storedV1(doc: Y.Doc): StoredYjsState {
  return { state: Y.encodeStateAsUpdate(doc), encoding: 1 }
}

/** A persisted row in the v2 encoding (everything written since). */
function storedV2(doc: Y.Doc): StoredYjsState {
  return { state: Y.encodeStateAsUpdateV2(doc), encoding: 2 }
}

/**
 * WHICH ENCODING THE PROCESS WRITES IS NOW A DEPLOY PHASE, NOT A CONSTANT.
 *
 * `computeFinalState` used to hardcode v2 on every path, so this suite could
 * assume the result was always v2-decodable. Since the two-phase rollout
 * (`YJS_WRITE_V2`, default OFF — see collab/persistedEncoding.ts) the process
 * writes v1 during phase 1 and v2 only after the flag is flipped, and the
 * encoding is passed in explicitly so the row label can never disagree with the
 * bytes.
 *
 * So every case below runs TWICE, once per phase. That is deliberately stronger
 * than the old single-state suite: a regression that re-hardcodes v2 (the exact
 * silent-data-loss bug the flag exists to prevent) fails the phase-1 pass, and a
 * regression that re-hardcodes v1 fails the phase-2 pass.
 */
const PHASES: Array<[string, YjsEncoding]> = [
  ['phase 1 — YJS_WRITE_V2 off, process writes v1', 1],
  ['phase 2 — YJS_WRITE_V2 on, process writes v2', 2],
]

/** What computeFinalState is handed for the live document, in this phase's encoding. */
function live(doc: Y.Doc, enc: YjsEncoding): [Y.Doc, Uint8Array, YjsEncoding] {
  return [doc, enc === 2 ? Y.encodeStateAsUpdateV2(doc) : Y.encodeStateAsUpdate(doc), enc]
}

/** Decode a persisted result using the encoding this phase writes. */
function decode(finalState: Buffer, enc: YjsEncoding): Y.Doc {
  const d = new Y.Doc()
  if (enc === 2) Y.applyUpdateV2(d, new Uint8Array(finalState))
  else Y.applyUpdate(d, new Uint8Array(finalState))
  return d
}

describe.each(PHASES)('merge-on-write computeFinalState (§3.2 / P1-D) [%s]', (_phase, WRITE) => {
  it('writes the live encoding directly when there is no existing row', () => {
    const doc = docWith((d) => d.getText('t').insert(0, 'hello'))
    const { finalState, usedUnion } = computeFinalState(null, ...live(doc, WRITE))
    expect(usedUnion).toBe(false)
    expect(decode(finalState, WRITE).getText('t').toString()).toBe('hello')
  })

  it('persists in THIS phase\u2019s encoding even when the existing row is legacy v1', () => {
    const doc = docWith((d) => d.getText('t').insert(0, 'hello'))
    const existing = storedV1(doc)
    doc.getText('t').insert(5, ' world')

    const { finalState } = computeFinalState(existing, ...live(doc, WRITE))
    // The result must be readable in the encoding upsertStateTx records on the
    // row — which is this phase's, not unconditionally v2.
    expect(decode(finalState, WRITE).getText('t').toString()).toBe('hello world')
  })

  it.each([
    ['v1 existing row (pre-rollout)', storedV1],
    ['v2 existing row (post-rollout)', storedV2],
  ])('single-writer path over a %s: no union re-encode', (_label, makeStored) => {
    const doc = docWith((d) => d.getText('t').insert(0, 'hello'))
    const existing = makeStored(doc)
    doc.getText('t').insert(5, ' world') // live is now a superset of existing

    const { finalState, usedUnion } = computeFinalState(existing, ...live(doc, WRITE))
    expect(usedUnion).toBe(false)
    expect(decode(finalState, WRITE).getText('t').toString()).toBe('hello world')
  })

  it.each([
    ['v1 existing row (pre-rollout)', storedV1],
    ['v2 existing row (post-rollout)', storedV2],
  ])('concurrency over a %s: union keeps both sides', (_label, makeStored) => {
    // Two independent docs with concurrent edits (neither a superset).
    const a = docWith((d) => d.getText('t').insert(0, 'AAA'))
    const b = docWith((d) => d.getText('t').insert(0, 'BBB'))
    const existing = makeStored(a)

    const { finalState, usedUnion } = computeFinalState(existing, ...live(b, WRITE))
    expect(usedUnion).toBe(true)
    const text = decode(finalState, WRITE).getText('t').toString()
    expect(text).toContain('AAA')
    expect(text).toContain('BBB')
  })

  it.each([
    ['v1 existing row (pre-rollout)', storedV1],
    ['v2 existing row (post-rollout)', storedV2],
  ])('STALE live doc against a %s must NOT drop existing edits (direction guard)', (_label, makeStored) => {
    // The persisted row has MORE than the live document — the live one is stale.
    const stale = docWith((d) => d.getText('t').insert(0, 'base'))
    const ahead = new Y.Doc()
    Y.applyUpdate(ahead, Y.encodeStateAsUpdate(stale))
    ahead.getText('t').insert(4, '-extra')
    const existing = makeStored(ahead)

    const { finalState, usedUnion } = computeFinalState(existing, ...live(stale, WRITE))
    expect(usedUnion).toBe(true)
    // The edits present only in the persisted row must survive.
    expect(decode(finalState, WRITE).getText('t').toString()).toContain('extra')
  })

  /**
   * The reason this refactor exists: the same document is far smaller as v2, so
   * a document that could not be persisted at all now fits. (Ratio, not an exact
   * figure — the real sheet measured 18,320,896 -> 6,073,851 bytes.)
   *
   * This one is deliberately NOT phase-parameterised: it is a claim about the v2
   * encoder itself (the reason phase 2 is worth reaching), so it pins v2 on both
   * passes rather than following WRITE.
   */
  it('the persisted v2 encoding is smaller than the v1 encoding of the same doc', () => {
    const doc = new Y.Doc()
    const map = doc.getMap('cells')
    // Churn: overwrite the same keys many times, which is what grows a sheet's
    // history (and what made the incident document 17 MB).
    for (let round = 0; round < 40; round++) {
      doc.transact(() => {
        for (let i = 0; i < 200; i++) map.set(`r${i}`, { v: round, s: { ff: 'Arial', fs: 8 } })
      })
    }
    const v1 = Y.encodeStateAsUpdate(doc)
    const { finalState } = computeFinalState(null, doc, Y.encodeStateAsUpdateV2(doc), 2)
    expect(finalState.length).toBeLessThan(v1.length)
  })
})

describe('isEmptyUpdate / isEmptyUpdateV2', () => {
  it('recognizes the empty Yjs v1 update encoding', () => {
    const empty = Y.encodeStateAsUpdate(new Y.Doc(), Y.encodeStateVector(new Y.Doc()))
    expect(isEmptyUpdate(empty)).toBe(true)
  })

  it('a non-empty v1 update is not empty', () => {
    const u = Y.encodeStateAsUpdate(docWith((d) => d.getText('t').insert(0, 'x')))
    expect(isEmptyUpdate(u)).toBe(false)
  })

  it('recognizes the empty Yjs v2 update encoding', () => {
    const empty = Y.encodeStateAsUpdateV2(new Y.Doc(), Y.encodeStateVector(new Y.Doc()))
    expect(isEmptyUpdateV2(empty)).toBe(true)
  })

  it('a non-empty v2 update is not empty', () => {
    const u = Y.encodeStateAsUpdateV2(docWith((d) => d.getText('t').insert(0, 'x')))
    expect(isEmptyUpdateV2(u)).toBe(false)
  })

  /** The two checks are NOT interchangeable — the encodings differ in length. */
  it('the v1 check does not accept a v2 empty update', () => {
    expect(isEmptyUpdate(Y.encodeStateAsUpdateV2(new Y.Doc()))).toBe(false)
  })
})
