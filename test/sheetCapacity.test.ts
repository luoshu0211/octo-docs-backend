import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { validateSheetListEntry, validateSheetListBatch, prepareSheetListBatchForWrite, SHEET_LIST_FIELD, SHEET_YMAP_FIELD } from '../src/agent/sheetConversion.js'
import { attachSheetDataValidationGuard } from '../src/collab/sheetDataValidationGuard.js'
import { prepareSheetRowInsert } from '../src/agent/sheetRowInsert.js'
import { prepareSheetStructuralEdit } from '../src/agent/sheetStructuralEdit.js'

const meta = (rowCount: number, columnCount: number) => ({ name: 'Sheet1', order: 0, rowCount, columnCount })
describe('four million allocated cells per worksheet', () => {
  it.each([[40_000, 100], [4_000, 1_000], [1, 4_000_000], [4_000_000, 1]])('accepts %i × %i, rejects one extra row/column', (rows, columns) => {
    expect(validateSheetListEntry('default', meta(rows, columns))).toEqual(meta(rows, columns))
    expect(() => validateSheetListEntry('default', meta(rows + 1, columns))).toThrow()
    expect(() => validateSheetListEntry('default', meta(rows, columns + 1))).toThrow()
  })
  it('inherits the other dimension for a partial REST metadata update', () => {
    const current = new Map([['default', meta(4_000_000, 1)]])
    const rename = validateSheetListBatch({ default: { name: 'Renamed', order: 0 } })
    expect(prepareSheetListBatchForWrite(current, rename, {}).toSet[0]?.[1]).toEqual({ ...meta(4_000_000, 1), name: 'Renamed' })
    const growColumns = validateSheetListBatch({ default: { name: 'Renamed', order: 0, columnCount: 2 } })
    expect(() => prepareSheetListBatchForWrite(current, growColumns, {})).toThrow('sheet_cell_limit_exceeded')
  })
  it('checks cumulative growth from multiple cells before producing a REST batch', () => {
    const existing = new Map([['default', meta(200, 20)]])
    expect(() => prepareSheetListBatchForWrite(existing, { toDelete: [], toSet: [] }, {
      'default!39999:0': { v: 'tall' }, 'default!0:100': { v: 'wide' },
    })).toThrow('sheet_cell_limit_exceeded')
    expect(existing.get('default')).toEqual(meta(200, 20))
    expect(prepareSheetListBatchForWrite(existing, { toDelete: [], toSet: [] }, { 'default!39999:99': { v: 'edge' } }).toSet[0]?.[1]).toEqual(meta(40_000,100))
  })
  it('does not let clearing cells free capacity, and deletion of columns does', () => {
    const doc = new Y.Doc(); doc.getMap(SHEET_LIST_FIELD).set('default', meta(40_000,100))
    doc.getMap(SHEET_YMAP_FIELD).clear()
    expect(() => prepareSheetRowInsert(doc, { logicalId: 'default', afterRow: 0, count: 1 })).toThrow('sheet_row_limit_exceeded')
    const deletion = prepareSheetStructuralEdit(doc, { kind: 'columns.delete', logicalId: 'default', startColumn: 99, count: 1 })
    expect(deletion.columnCount).toBe(99)
    doc.getMap(SHEET_LIST_FIELD).set('default', meta(40_000,99))
    expect(prepareSheetRowInsert(doc, { logicalId: 'default', afterRow: 0, count: 1 }).rowCount).toBe(40_001)
    doc.destroy()
  })
  it('rolls back an over-budget websocket transaction including sibling cells, then survives reload', () => {
    const doc = new Y.Doc(); doc.getMap(SHEET_LIST_FIELD).set('default', meta(40_000,100))
    const dispose = attachSheetDataValidationGuard(doc, { maxRules: 5000, maxBytes: 1024 * 1024 })
    doc.transact(() => {
      doc.getMap(SHEET_LIST_FIELD).set('default', meta(40_000,101))
      doc.getMap(SHEET_YMAP_FIELD).set('default!0:100', { v: 'must roll back' })
    }, { source: 'connection' })
    expect(doc.getMap(SHEET_LIST_FIELD).get('default')).toEqual(meta(40_000,100))
    expect(doc.getMap(SHEET_YMAP_FIELD).has('default!0:100')).toBe(false)
    const reloaded = new Y.Doc(); Y.applyUpdateV2(reloaded, Y.encodeStateAsUpdateV2(doc))
    expect(reloaded.getMap(SHEET_LIST_FIELD).get('default')).toEqual(meta(40_000,100))
    dispose(); doc.destroy(); reloaded.destroy()
  })
})
