import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  SHEET_DATA_VALIDATIONS_FIELD,
  SHEET_LIST_FIELD,
  SHEET_YMAP_FIELD,
  validateSheetDataValidations,
  type StoredDataValidation,
} from '../src/agent/sheetConversion.js'
import { attachSheetDataValidationGuard } from '../src/collab/sheetDataValidationGuard.js'

const limits = { maxRules: 2, maxBytes: 2_000 }

function checkbox(uid: string, extra: Partial<StoredDataValidation> = {}): StoredDataValidation {
  return {
    uid,
    type: 'checkbox',
    allowBlank: true,
    ranges: [{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 }],
    ...extra,
  }
}

function guardedDoc(customLimits = limits): {
  doc: Y.Doc
  validations: Y.Map<unknown>
  dispose: () => void
} {
  const doc = new Y.Doc()
  doc.getMap(SHEET_LIST_FIELD).set('default', { name: 'Sheet1', order: 0 })
  const validations = doc.getMap<unknown>(SHEET_DATA_VALIDATIONS_FIELD)
  return { doc, validations, dispose: attachSheetDataValidationGuard(doc, customLimits) }
}

describe('sheetDataValidationGuard', () => {
  it('keeps a valid collaborative checkbox write', () => {
    const { validations, dispose } = guardedDoc()
    validations.set('default!a', checkbox('a'))
    expect(validations.get('default!a')).toEqual(checkbox('a'))
    dispose()
  })

  it('reverts malformed and orphaned collaborative checkbox writes', () => {
    const { doc, validations, dispose } = guardedDoc()
    doc.transact(() => {
      validations.set('default!broken', { uid: 'broken', type: 'checkbox', ranges: null })
      validations.set('missing!orphan', checkbox('orphan'))
    }, 'client')
    expect([...validations.keys()]).toEqual([])
    dispose()
  })

  it('preserves foreign validation types that predate the guard', () => {
    const doc = new Y.Doc()
    doc.getMap(SHEET_LIST_FIELD).set('default', { name: 'Sheet1', order: 0 })
    const validations = doc.getMap<unknown>(SHEET_DATA_VALIDATIONS_FIELD)
    const listRule = { uid: 'list', type: 'list', ranges: [] }
    validations.set('default!list', listRule)
    const dispose = attachSheetDataValidationGuard(doc, limits)
    validations.set('default!a', checkbox('a'))
    expect(validations.get('default!list')).toEqual(listRule)
    expect(validations.get('default!a')).toEqual(checkbox('a'))
    dispose()
  })

  it('reverts collaborative writes of foreign validation types', () => {
    const { validations, dispose } = guardedDoc()
    validations.set('default!list', { uid: 'list', type: 'list', ranges: [] })
    expect(validations.has('default!list')).toBe(false)
    dispose()
  })

  it('reverts changing an existing checkbox into a foreign validation type', () => {
    const { validations, dispose } = guardedDoc()
    const original = checkbox('a')
    validations.set('default!a', original)
    validations.set('default!a', { uid: 'a', type: 'list', ranges: [] })
    expect(validations.get('default!a')).toEqual(original)
    dispose()
  })

  it('restores the previous rule when a collaborative update becomes invalid', () => {
    const { validations, dispose } = guardedDoc()
    const original = checkbox('a')
    validations.set('default!a', original)
    validations.set('default!a', { ...original, formula1: 'same', formula2: 'same' })
    expect(validations.get('default!a')).toEqual(original)
    dispose()
  })

  it('reverts a transaction that exceeds the persisted rule-count cap', () => {
    const { doc, validations, dispose } = guardedDoc({ maxRules: 1, maxBytes: 2_000 })
    doc.transact(() => {
      validations.set('default!a', checkbox('a'))
      validations.set('default!b', checkbox('b'))
    }, 'client')
    expect([...validations.keys()]).toEqual([])
    dispose()
  })

  it('reverts a transaction that exceeds the persisted checkbox-byte cap', () => {
    const { validations, dispose } = guardedDoc({ maxRules: 10, maxBytes: 100 })
    validations.set('default!large', checkbox('large', { error: 'x'.repeat(200) }))
    expect([...validations.keys()]).toEqual([])
    dispose()
  })

  it('allows deletion-only repair of invalid state that predates the guard', () => {
    const doc = new Y.Doc()
    doc.getMap(SHEET_LIST_FIELD).set('default', { name: 'Sheet1', order: 0 })
    const validations = doc.getMap<unknown>(SHEET_DATA_VALIDATIONS_FIELD)
    validations.set('default!broken', { uid: 'broken', type: 'checkbox', ranges: null })
    const dispose = attachSheetDataValidationGuard(doc, limits)
    validations.delete('default!broken')
    expect([...validations.keys()]).toEqual([])
    dispose()
  })

  it('keeps unrelated malformed legacy entries inert for valid writes', () => {
    const doc = new Y.Doc()
    doc.getMap(SHEET_LIST_FIELD).set('default', { name: 'Sheet1', order: 0 })
    const validations = doc.getMap<unknown>(SHEET_DATA_VALIDATIONS_FIELD)
    validations.set('orphanKeyNoBang', checkbox('orphan'))
    const dispose = attachSheetDataValidationGuard(doc, limits)
    validations.set('default!a', checkbox('a'))
    expect([...validations.keys()].sort()).toEqual(['default!a', 'orphanKeyNoBang'])
    dispose()
  })

  it('keeps deletions and valid additions in a mixed legacy repair transaction', () => {
    const doc = new Y.Doc()
    doc.getMap(SHEET_LIST_FIELD).set('default', { name: 'Sheet1', order: 0 })
    const validations = doc.getMap<unknown>(SHEET_DATA_VALIDATIONS_FIELD)
    validations.set('default!broken-1', { ...checkbox('broken-1'), ranges: null })
    validations.set('default!broken-2', { ...checkbox('broken-2'), ranges: null })
    const dispose = attachSheetDataValidationGuard(doc, limits)
    doc.transact(() => {
      validations.delete('default!broken-1')
      validations.set('default!ok', checkbox('ok'))
    }, 'client')
    expect([...validations.keys()].sort()).toEqual(['default!broken-2', 'default!ok'])
    dispose()
  })

  it('reverts other root-map writes in the same rejected transaction', () => {
    const { doc, validations, dispose } = guardedDoc()
    const cells = doc.getMap(SHEET_YMAP_FIELD)
    doc.transact(() => {
      validations.set('default!broken', { ...checkbox('broken'), ranges: null })
      cells.set('default!7:0', { v: 0 })
    }, 'client')
    expect(validations.has('default!broken')).toBe(false)
    expect(cells.has('default!7:0')).toBe(false)
    dispose()
  })

  it('reverts unmaterialized cell-map writes from the same rejected remote update', () => {
    const seed = new Y.Doc()
    seed.getMap(SHEET_LIST_FIELD).set('default', { name: 'Sheet1', order: 0 })
    seed.getMap(SHEET_YMAP_FIELD).set('default!0:0', { v: 'old' })
    const server = new Y.Doc()
    Y.applyUpdate(server, Y.encodeStateAsUpdate(seed))
    const dispose = attachSheetDataValidationGuard(server, limits)

    const client = new Y.Doc()
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server))
    client.transact(() => {
      client.getMap(SHEET_DATA_VALIDATIONS_FIELD)
        .set('default!broken', { ...checkbox('broken'), ranges: null })
      client.getMap(SHEET_YMAP_FIELD).set('default!0:0', { v: 'new' })
      client.getMap(SHEET_YMAP_FIELD).set('default!1:0', { v: 'added' })
    }, 'client')
    Y.applyUpdate(server, Y.encodeStateAsUpdate(client, Y.encodeStateVector(server)), 'remote')

    expect(server.getMap(SHEET_DATA_VALIDATIONS_FIELD).has('default!broken')).toBe(false)
    expect(server.getMap(SHEET_YMAP_FIELD).toJSON()).toEqual({ 'default!0:0': { v: 'old' } })
    dispose()
  })

  it('checks convergence only for sheets touched by the transaction', () => {
    const doc = new Y.Doc()
    const sheets = doc.getMap(SHEET_LIST_FIELD)
    sheets.set('default', { name: 'Sheet1', order: 0 })
    sheets.set('legacy', { name: 'Sheet2', order: 1 })
    const validations = doc.getMap<unknown>(SHEET_DATA_VALIDATIONS_FIELD)
    const ranges = Array.from({ length: 1_000 }, () => ({
      startRow: 0, startColumn: 0, endRow: 999, endColumn: 0,
    }))
    for (const uid of ['a', 'b', 'c']) validations.set(`legacy!${uid}`, checkbox(uid, { ranges }))
    const dispose = attachSheetDataValidationGuard(doc, { maxRules: 10, maxBytes: 1_000_000 })
    validations.set('default!ok', checkbox('ok'))
    expect(validations.get('default!ok')).toEqual(checkbox('ok'))
    dispose()
  })

  it('counts malformed-key checkbox candidates toward the complete storage cap', () => {
    expect(() => validateSheetDataValidations({
      orphanKeyNoBang: checkbox('orphan'),
      'default!ok': checkbox('ok'),
    }, undefined, false, { maxRules: 1, maxBytes: 2_000 })).toThrow('sheet inspection budget')
  })

  it('rejects storage growth while an unmeasurable historical checkbox remains', () => {
    const seed = new Y.Doc()
    seed.getMap(SHEET_LIST_FIELD).set('default', { name: 'Sheet1', order: 0 })
    seed.getMap(SHEET_DATA_VALIDATIONS_FIELD).set('orphanKeyNoBang', checkbox('orphan', { legacy: 1n } as never))
    const doc = new Y.Doc()
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed))
    const validations = doc.getMap<unknown>(SHEET_DATA_VALIDATIONS_FIELD)
    const dispose = attachSheetDataValidationGuard(doc, { maxRules: 1, maxBytes: 100 })
    validations.set('default!ok', checkbox('ok'))
    expect([...validations.keys()]).toEqual(['orphanKeyNoBang'])
    dispose()
  })

  it('allows explicit deletion of an unmeasurable historical checkbox', () => {
    const seed = new Y.Doc()
    seed.getMap(SHEET_LIST_FIELD).set('default', { name: 'Sheet1', order: 0 })
    seed.getMap(SHEET_DATA_VALIDATIONS_FIELD).set('orphanKeyNoBang', checkbox('orphan', { legacy: 1n } as never))
    const doc = new Y.Doc()
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed))
    const validations = doc.getMap<unknown>(SHEET_DATA_VALIDATIONS_FIELD)
    const dispose = attachSheetDataValidationGuard(doc, { maxRules: 1, maxBytes: 100 })
    validations.delete('orphanKeyNoBang')
    expect([...validations.keys()]).toEqual([])
    dispose()
  })

  it('converges compensating writes relayed between two guarded nodes', () => {
    const seed = new Y.Doc()
    seed.getMap(SHEET_LIST_FIELD).set('default', { name: 'Sheet1', order: 0 })
    const original = checkbox('a', { error: 'x'.repeat(200) })
    seed.getMap(SHEET_DATA_VALIDATIONS_FIELD).set('default!a', original)
    const state = Y.encodeStateAsUpdate(seed)
    const docs = [new Y.Doc(), new Y.Doc()]
    for (const doc of docs) Y.applyUpdate(doc, state)
    const dispose = docs.map((doc) => attachSheetDataValidationGuard(doc, { maxRules: 10, maxBytes: 100 }))
    const redisOrigin = { source: 'redis' }
    const queue: Array<[Y.Doc, Uint8Array]> = []
    docs[0]!.on('update', (update, origin) => { if (origin !== redisOrigin) queue.push([docs[1]!, update]) })
    docs[1]!.on('update', (update, origin) => { if (origin !== redisOrigin) queue.push([docs[0]!, update]) })
    const changed = checkbox('a', { error: 'y'.repeat(201) })
    docs[0]!.getMap(SHEET_DATA_VALIDATIONS_FIELD).set('default!a', changed)
    let hops = 0
    while (queue.length > 0 && hops++ < 20) {
      const [target, update] = queue.shift()!
      Y.applyUpdate(target, update, redisOrigin)
    }
    expect(queue).toHaveLength(0)
    expect(hops).toBeLessThan(20)
    expect(docs.map((doc) => doc.getMap(SHEET_DATA_VALIDATIONS_FIELD).toJSON()))
      .toEqual([{ 'default!a': original }, { 'default!a': original }])
    expect(Buffer.from(Y.encodeStateAsUpdate(docs[0]!))).toEqual(Buffer.from(Y.encodeStateAsUpdate(docs[1]!)))
    dispose.forEach((stop) => stop())
  })

  it('stops enforcing after disposal', () => {
    const { validations, dispose } = guardedDoc()
    dispose()
    validations.set('default!broken', { uid: 'broken', type: 'checkbox', ranges: null })
    expect(validations.has('default!broken')).toBe(true)
  })
})
