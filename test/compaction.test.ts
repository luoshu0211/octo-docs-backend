import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { readFileSync, existsSync } from 'node:fs'
import { rebuildFromValues, isFlatMapOnlyDocument } from '../src/collab/compaction.ts'

/**
 * Compaction semantics, pinned on synthetic documents here and — when the
 * incident capture is present locally — on the real 17.47 MB sheet.
 *
 * The `compactDocument` orchestration (loaded-check, backup row, UPSERT) is not
 * covered here: it needs the collab server and a DB, so it belongs to an
 * integration run rather than this unit suite.
 */

function sheetLike(cells: number, rewrites: number): Y.Doc {
  const doc = new Y.Doc()
  const map = doc.getMap('sheet')
  for (let r = 0; r < rewrites; r++) {
    doc.transact(() => {
      for (let i = 0; i < cells; i++) map.set(`default!${i}:0`, { v: `${r}-${i}`, t: 1 })
    })
  }
  return doc
}

describe('rebuildFromValues', () => {
  it('keeps every live entry', () => {
    const doc = sheetLike(50, 3)
    const { rebuilt, entries } = rebuildFromValues(doc)
    expect(entries).toBe(50)
    expect(rebuilt.getMap('sheet').size).toBe(50)
  })

  it('preserves the exact value of every entry', () => {
    const doc = sheetLike(30, 4)
    const { rebuilt } = rebuildFromValues(doc)
    const before = doc.getMap('sheet')
    const after = rebuilt.getMap('sheet')
    before.forEach((v, k) => expect(JSON.stringify(after.get(k))).toBe(JSON.stringify(v)))
  })

  it('carries every top-level map across, not just the biggest one', () => {
    const doc = new Y.Doc()
    doc.transact(() => {
      doc.getMap('sheet').set('a', 1)
      doc.getMap('sheetDims').set('c1', 100)
      doc.getMap('sheetMerges').set('m1', { r: 0 })
      doc.getMap('sheetProtection').set('p1', { w: [] })
    })
    const { rebuilt } = rebuildFromValues(doc)
    for (const key of ['sheet', 'sheetDims', 'sheetMerges', 'sheetProtection']) {
      expect(rebuilt.getMap(key).size).toBe(1)
    }
  })

  it('sheds the tombstones that repeated rewrites accumulate', () => {
    const doc = sheetLike(200, 12)
    let deleted = 0
    for (const [, structs] of doc.store.clients) for (const s of structs) if (s.deleted) deleted++
    expect(deleted).toBeGreaterThan(0) // the fixture really did accumulate history

    const { rebuilt } = rebuildFromValues(doc)
    let deletedAfter = 0
    for (const [, structs] of rebuilt.store.clients) for (const s of structs) if (s.deleted) deletedAfter++
    expect(deletedAfter).toBe(0)
    expect(Y.encodeStateAsUpdateV2(rebuilt).length).toBeLessThan(Y.encodeStateAsUpdateV2(doc).length)
  })
})

describe('isFlatMapOnlyDocument — the guard against silently dropping a doc body', () => {
  it('accepts a sheet-shaped document', () => {
    expect(isFlatMapOnlyDocument(sheetLike(5, 1))).toBe(true)
  })

  it('rejects a document containing Y.Text', () => {
    const doc = new Y.Doc()
    doc.transact(() => doc.getText('body').insert(0, 'prose'))
    expect(isFlatMapOnlyDocument(doc)).toBe(false)
  })

  it('rejects a document containing Y.XmlFragment (the ProseMirror body)', () => {
    const doc = new Y.Doc()
    doc.transact(() => doc.get('default', Y.XmlFragment).insert(0, [new Y.XmlElement('p')]))
    expect(isFlatMapOnlyDocument(doc)).toBe(false)
  })

  it('rejects a document containing Y.Array', () => {
    const doc = new Y.Doc()
    doc.transact(() => doc.getArray('items').insert(0, [1, 2, 3]))
    expect(isFlatMapOnlyDocument(doc)).toBe(false)
  })

  // The three cases below are why the structural test requires a non-empty
  // `_map` and not merely `_start === null`: each of these has a null `_start`
  // and would otherwise have been accepted, then rebuilt as an empty Y.Map —
  // losing the body outright.
  it('rejects an EMPTY Y.Text (a doc body nobody has typed into yet)', () => {
    const doc = new Y.Doc()
    doc.getText('body')
    expect(isFlatMapOnlyDocument(doc)).toBe(false)
  })

  it('rejects an EMPTY Y.Array', () => {
    const doc = new Y.Doc()
    doc.getArray('items')
    expect(isFlatMapOnlyDocument(doc)).toBe(false)
  })

  it('rejects an EMPTY Y.XmlFragment', () => {
    const doc = new Y.Doc()
    doc.get('default', Y.XmlFragment)
    expect(isFlatMapOnlyDocument(doc)).toBe(false)
  })

  // Whiteboards nest a Y.Map per element (whiteboard/boardEdit.ts). Rebuilding
  // those would flatten them into plain objects, so concurrent edits to one
  // element would clobber the whole value instead of merging per field.
  it('rejects a whiteboard-shaped document with nested Y.Map values', () => {
    const doc = new Y.Doc()
    doc.transact(() => {
      const el = new Y.Map()
      el.set('x', 1)
      doc.getMap('elements').set('el-1', el)
    })
    expect(isFlatMapOnlyDocument(doc)).toBe(false)
  })

  it('keeps flat map values byte-identical through a rebuild', () => {
    const doc = sheetLike(20, 3)
    const before = doc.getMap('sheet').toJSON()
    const { rebuilt } = rebuildFromValues(doc)
    expect(rebuilt.getMap('sheet').toJSON()).toEqual(before)
  })
})

/**
 * The capture from the incident, when it is available on this machine. Skipped
 * everywhere else so the suite stays hermetic — this is a characterisation test
 * for the document that actually broke production, not a fixture we ship.
 */
const CAPTURE = '/tmp/v18.bin'
describe.skipIf(!existsSync(CAPTURE))('the incident document (local capture only)', () => {
  it('compacts far below the cap while keeping every cell', () => {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, new Uint8Array(readFileSync(CAPTURE)))
    const beforeCells = doc.getMap('sheet').size

    const { rebuilt } = rebuildFromValues(doc)
    expect(rebuilt.getMap('sheet').size).toBe(beforeCells)

    const before = Y.encodeStateAsUpdate(doc).length
    const after = Y.encodeStateAsUpdateV2(rebuilt).length
    expect(after).toBeLessThan(before / 3)
    expect(after).toBeLessThan(10 * 1024 * 1024)
  })
})

/**
 * Everything above builds its documents in-process with `getMap()`/`getText()`.
 * A document reaching compaction never looks like that: it was just decoded from
 * the database, and yjs leaves a decoded share as an untyped `AbstractType`
 * until the first `getMap`/`getText` call promotes it.
 *
 * That difference hid a total failure. The predicate used to test
 * `instanceof Y.Map`, which is false for EVERY decoded share — so compaction
 * would have refused every real document as "not compactable" while this whole
 * file passed. These cases run each fixture through an encode/decode round trip,
 * which is the shape production actually sees.
 */
describe('isFlatMapOnlyDocument — on documents decoded from bytes, as in production', () => {
  const roundTrip = (build: (doc: Y.Doc) => void): Y.Doc => {
    const source = new Y.Doc()
    build(source)
    const decoded = new Y.Doc()
    Y.applyUpdateV2(decoded, Y.encodeStateAsUpdateV2(source))
    return decoded
  }

  it('accepts a decoded sheet — the case the old predicate got wrong', () => {
    const doc = roundTrip((d) => d.transact(() => d.getMap('sheet').set('A1', { v: 1 })))

    // Guards the reason it was wrong, so a future refactor cannot quietly
    // reintroduce an `instanceof` test by making the fixture typed.
    expect(doc.share.get('sheet') instanceof Y.Map).toBe(false)
    expect(isFlatMapOnlyDocument(doc)).toBe(true)
  })

  it('rejects a decoded ProseMirror body', () => {
    const doc = roundTrip((d) =>
      d.transact(() => d.get('default', Y.XmlFragment).insert(0, [new Y.XmlElement('p')])),
    )
    expect(isFlatMapOnlyDocument(doc)).toBe(false)
  })

  it('rejects a decoded Y.Text', () => {
    const doc = roundTrip((d) => d.transact(() => d.getText('body').insert(0, 'prose')))
    expect(isFlatMapOnlyDocument(doc)).toBe(false)
  })

  it('rejects a decoded Y.Array', () => {
    const doc = roundTrip((d) => d.transact(() => d.getArray('items').insert(0, [1, 2, 3])))
    expect(isFlatMapOnlyDocument(doc)).toBe(false)
  })

  /** Tombstones must not let an emptied list pass as a map. */
  it('rejects a decoded Y.Text whose content was all deleted', () => {
    const doc = roundTrip((d) => {
      d.transact(() => d.getText('body').insert(0, 'prose'))
      d.transact(() => d.getText('body').delete(0, 5))
    })
    expect(isFlatMapOnlyDocument(doc)).toBe(false)
  })

  it('rejects a decoded whiteboard with nested Y.Map values', () => {
    const doc = roundTrip((d) =>
      d.transact(() => {
        const el = new Y.Map()
        el.set('x', 1)
        d.getMap('elements').set('el-1', el)
      }),
    )
    expect(isFlatMapOnlyDocument(doc)).toBe(false)
  })
})
