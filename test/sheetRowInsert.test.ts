import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  SHEET_DATA_VALIDATIONS_FIELD,
  SHEET_DIMS_FIELD,
  SHEET_DRAWINGS_FIELD,
  SHEET_FILTERS_FIELD,
  SHEET_FREEZE_FIELD,
  SHEET_HYPERLINKS_FIELD,
  SHEET_LEGACY_COLUMNS,
  SHEET_LEGACY_ROWS,
  SHEET_LIST_FIELD,
  SHEET_MERGES_FIELD,
  SHEET_PROTECTION_FIELD,
  SHEET_YMAP_FIELD,
  type SheetCell,
  type StoredDataValidation,
  type StoredDrawing,
  type StoredFilter,
  type StoredFreeze,
  type StoredHyperLink,
  type StoredSheetMeta,
} from '../src/agent/sheetConversion.js'
import {
  SHEET_COMMENT_ANCHORS_FIELD,
  SheetRowInsertError,
  applySheetRowInsertPlan,
  measureSheetAfterRowInsert,
  prepareSheetRowInsert,
} from '../src/agent/sheetRowInsert.js'

function seededDoc(): Y.Doc {
  const doc = new Y.Doc()
  doc.transact(() => {
    doc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD).set('default', {
      name: 'Sheet1', order: 0, rowCount: 20, columnCount: 20,
    })
    doc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD).set('other', {
      name: 'Other', order: 1, rowCount: 20, columnCount: 20,
    })
    const cells = doc.getMap<SheetCell>(SHEET_YMAP_FIELD)
    cells.set('default!9:0', { v: 'before' })
    cells.set('default!10:0', { v: 'moves' })
    cells.set('other!10:0', { v: 'other sheet' })
    const dims = doc.getMap<number>(SHEET_DIMS_FIELD)
    dims.set('default:r10', 30)
    dims.set('r11', 31)
    dims.set('default:c1', 120)
    doc.getMap<StoredHyperLink>(SHEET_HYPERLINKS_FIELD).set('default!link', {
      id: 'link', row: 10, column: 0, payload: 'https://octo.example',
    })
    const drawing: StoredDrawing = {
      drawingId: 'image',
      row: 10,
      sheetTransform: { from: { row: 10, column: 0 }, to: { row: 12, column: 1 } },
      axisAlignSheetTransform: { from: { row: 10, column: 0 }, to: { row: 12, column: 1 } },
    }
    doc.getMap<StoredDrawing>(SHEET_DRAWINGS_FIELD).set('default!image', drawing)
    const merges = doc.getMap<boolean>(SHEET_MERGES_FIELD)
    merges.set('default:8:0:12:1', true)
    merges.set('default:10:3:11:4', true)
    doc.getMap<StoredFreeze>(SHEET_FREEZE_FIELD).set('default', {
      startRow: 3, startColumn: -1, xSplit: 0, ySplit: 3,
    })
    doc.getMap<StoredFilter>(SHEET_FILTERS_FIELD).set('default', {
      ref: { startRow: 0, startColumn: 0, endRow: 9, endColumn: 3 },
      enabledColumns: [0],
    })
    doc.getMap<StoredDataValidation>(SHEET_DATA_VALIDATIONS_FIELD).set('default!rule', {
      uid: 'rule',
      type: 'list',
      formula1: '["a","b"]',
      ranges: [{ startRow: 9, startColumn: 0, endRow: 9, endColumn: 0 }],
    })
    doc.getMap<string>(SHEET_COMMENT_ANCHORS_FIELD).set('1', 'default!10:0')
    doc.getMap<string>(SHEET_COMMENT_ANCHORS_FIELD).set('2', 'default!8:1:11:2')
    doc.getMap<unknown>(SHEET_PROTECTION_FIELD).set('default!r:protected', {
      kind: 'r',
      permissionId: 'perm',
      ranges: [{ startRow: 8, startColumn: 0, endRow: 11, endColumn: 2 }],
    })
  })
  return doc
}

describe('structural sheet row insertion', () => {
  it('plans without mutation, then relocates every persisted row coordinate atomically', () => {
    const doc = seededDoc()
    const plan = prepareSheetRowInsert(doc, { logicalId: 'default', afterRow: 9, count: 2 })

    expect(doc.getMap(SHEET_YMAP_FIELD).has('default!10:0')).toBe(true)
    expect(plan.rowCount).toBe(22)

    doc.transact(() => applySheetRowInsertPlan(doc, plan))

    const cells = doc.getMap<SheetCell>(SHEET_YMAP_FIELD)
    expect(cells.get('default!9:0')).toEqual({ v: 'before' })
    expect(cells.has('default!10:0')).toBe(false)
    expect(cells.get('default!12:0')).toEqual({ v: 'moves' })
    expect(cells.get('other!10:0')).toEqual({ v: 'other sheet' })

    const dims = doc.getMap<number>(SHEET_DIMS_FIELD)
    expect(dims.get('default:r12')).toBe(30)
    expect(dims.get('r13')).toBe(31)
    expect(dims.get('default:c1')).toBe(120)

    expect(doc.getMap<StoredHyperLink>(SHEET_HYPERLINKS_FIELD).get('default!link')?.row).toBe(12)
    const drawing = doc.getMap<StoredDrawing>(SHEET_DRAWINGS_FIELD).get('default!image')!
    expect(drawing.row).toBe(12)
    expect((drawing.sheetTransform as { from: { row: number }; to: { row: number } }).from.row).toBe(12)
    expect((drawing.sheetTransform as { from: { row: number }; to: { row: number } }).to.row).toBe(14)

    const merges = doc.getMap<boolean>(SHEET_MERGES_FIELD)
    expect(merges.has('default:8:0:14:1')).toBe(true)
    expect(merges.has('default:12:3:13:4')).toBe(true)
    expect(merges.has('default:10:3:11:4')).toBe(false)

    expect(doc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD).get('default')?.rowCount).toBe(22)
    expect(doc.getMap<StoredFreeze>(SHEET_FREEZE_FIELD).get('default')).toEqual({
      startRow: 3, startColumn: -1, xSplit: 0, ySplit: 3,
    })
    expect(doc.getMap<StoredFilter>(SHEET_FILTERS_FIELD).get('default')?.ref.endRow).toBe(11)
    expect(doc.getMap<StoredDataValidation>(SHEET_DATA_VALIDATIONS_FIELD)
      .get('default!rule')?.ranges).toEqual([
      { startRow: 9, startColumn: 0, endRow: 11, endColumn: 0 },
    ])
    expect(doc.getMap<string>(SHEET_COMMENT_ANCHORS_FIELD).get('1')).toBe('default!12:0')
    expect(doc.getMap<string>(SHEET_COMMENT_ANCHORS_FIELD).get('2')).toBe('default!8:1:13:2')
    expect((doc.getMap(SHEET_PROTECTION_FIELD).get('default!r:protected') as {
      ranges: Array<{ startRow: number; endRow: number }>
    }).ranges[0]).toMatchObject({ startRow: 8, endRow: 13 })
  })

  it('grows frozen-row coordinates when inserting inside the frozen band', () => {
    const doc = seededDoc()
    const plan = prepareSheetRowInsert(doc, { logicalId: 'default', afterRow: 0, count: 2 })
    doc.transact(() => applySheetRowInsertPlan(doc, plan))
    expect(doc.getMap<StoredFreeze>(SHEET_FREEZE_FIELD).get('default')).toEqual({
      startRow: 5, startColumn: -1, xSplit: 0, ySplit: 5,
    })
  })

  it('materializes the implicit legacy default sheet and reports the measured result', () => {
    const doc = new Y.Doc()
    doc.getMap<SheetCell>(SHEET_YMAP_FIELD).set('default!999:0', { v: 'tail' })
    const measured = measureSheetAfterRowInsert(
      Y.encodeStateAsUpdate(doc),
      { logicalId: 'default', afterRow: 999, count: 5 },
    )
    expect(measured.rowCount).toBe(1005)
    expect(measured.docBytes).toBeGreaterThan(0)
    expect(measured.payloadBytes).toBeGreaterThan(0)
  })

  it('preserves legacy grid width when materializing a dimensionless stored sheet', () => {
    const doc = new Y.Doc()
    doc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD).set('default', {
      name: 'Renamed', order: 0,
    })
    doc.getMap<SheetCell>(SHEET_YMAP_FIELD).set('default!5:50', { v: 'wide legacy cell' })

    const plan = prepareSheetRowInsert(doc, { logicalId: 'default', afterRow: 2, count: 1 })
    doc.transact(() => applySheetRowInsertPlan(doc, plan))

    expect(doc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD).get('default')).toEqual({
      name: 'Renamed',
      order: 0,
      rowCount: SHEET_LEGACY_ROWS + 1,
      columnCount: SHEET_LEGACY_COLUMNS,
    })
    expect(doc.getMap<SheetCell>(SHEET_YMAP_FIELD).get('default!6:50'))
      .toEqual({ v: 'wide legacy cell' })
  })

  it('rejects missing sheets, out-of-bounds anchors, the cell budget, and formulas', () => {
    const doc = seededDoc()
    expect(() => prepareSheetRowInsert(doc, { logicalId: 'missing', afterRow: 0, count: 1 }))
      .toThrowError(new SheetRowInsertError('sheet_not_found'))
    expect(() => prepareSheetRowInsert(doc, { logicalId: 'default', afterRow: 20, count: 1 }))
      .toThrowError(new SheetRowInsertError('sheet_row_out_of_bounds'))

    doc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD).set('default', {
      name: 'Sheet1', order: 0, rowCount: 199_999, columnCount: 20,
    })
    expect(() => prepareSheetRowInsert(doc, { logicalId: 'default', afterRow: 199_998, count: 2 }))
      .toThrowError(new SheetRowInsertError('sheet_row_limit_exceeded'))

    doc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD).set('default', {
      name: 'Sheet1', order: 0, rowCount: 20, columnCount: 20,
    })
    doc.getMap<SheetCell>(SHEET_YMAP_FIELD).set('other!0:1', { v: 1, f: 'default!A1' })
    expect(() => prepareSheetRowInsert(doc, { logicalId: 'default', afterRow: 0, count: 1 }))
      .toThrowError(new SheetRowInsertError('sheet_formula_unsupported'))
  })
})
