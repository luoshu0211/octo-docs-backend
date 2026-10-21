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
import { SHEET_COMMENT_ANCHORS_FIELD } from '../src/agent/sheetRowInsert.js'
import {
  SheetStructuralEditError,
  applySheetStructuralEditPlan,
  measureSheetAfterStructuralEdit,
  prepareSheetStructuralEdit,
  type SheetStructuralEdit,
} from '../src/agent/sheetStructuralEdit.js'

function seededDoc(): Y.Doc {
  const doc = new Y.Doc()
  doc.transact(() => {
    const sheets = doc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD)
    sheets.set('default', { name: 'Sheet1', order: 0, rowCount: 12, columnCount: 10 })
    sheets.set('other', { name: 'Other', order: 1, rowCount: 12, columnCount: 10 })

    const cells = doc.getMap<SheetCell>(SHEET_YMAP_FIELD)
    cells.set('default!2:2', { v: 'before' })
    cells.set('default!3:3', { v: 'deleted' })
    cells.set('default!5:5', { v: 'moves' })
    cells.set('other!5:5', { v: 'other sheet' })

    const dims = doc.getMap<number>(SHEET_DIMS_FIELD)
    dims.set('default:r3', 33)
    dims.set('r5', 55)
    dims.set('default:c3', 73)
    dims.set('default:c5', 95)

    doc.getMap<StoredDrawing>(SHEET_DRAWINGS_FIELD).set('default!image', {
      drawingId: 'image',
      row: 5,
      column: 5,
      sheetTransform: { from: { row: 3, column: 3 }, to: { row: 7, column: 7 } },
      axisAlignSheetTransform: { from: { row: 3, column: 3 }, to: { row: 7, column: 7 } },
    })

    const links = doc.getMap<StoredHyperLink>(SHEET_HYPERLINKS_FIELD)
    links.set('default!move', {
      id: 'move', row: 5, column: 5, payload: 'https://octo.example/move',
    })
    links.set('default!gone', {
      id: 'gone', row: 3, column: 3, payload: 'https://octo.example/gone',
    })

    const merges = doc.getMap<boolean>(SHEET_MERGES_FIELD)
    merges.set('default:2:2:6:6', true)
    merges.set('default:3:7:4:8', true)
    merges.set('default:7:3:8:4', true)

    doc.getMap<StoredFreeze>(SHEET_FREEZE_FIELD).set('default', {
      startRow: 4, startColumn: 4, xSplit: 4, ySplit: 4,
    })
    doc.getMap<StoredFilter>(SHEET_FILTERS_FIELD).set('default', {
      ref: { startRow: 1, startColumn: 1, endRow: 8, endColumn: 8 },
      filterColumns: [{ colId: 2 }, { colId: 3 }, { colId: 5 }],
      enabledColumns: [2, 3, 5],
    })

    const validations = doc.getMap<StoredDataValidation>(SHEET_DATA_VALIDATIONS_FIELD)
    validations.set('default!main', {
      uid: 'main', type: 'list', formula1: '["a","b"]',
      ranges: [{ startRow: 2, startColumn: 2, endRow: 6, endColumn: 6 }],
    })
    validations.set('default!row-gone', {
      uid: 'row-gone', type: 'list', formula1: '["a"]',
      ranges: [{ startRow: 3, startColumn: 7, endRow: 4, endColumn: 8 }],
    })
    validations.set('default!column-gone', {
      uid: 'column-gone', type: 'list', formula1: '["a"]',
      ranges: [{ startRow: 7, startColumn: 3, endRow: 8, endColumn: 4 }],
    })

    const comments = doc.getMap<string>(SHEET_COMMENT_ANCHORS_FIELD)
    comments.set('move', 'default!5:5')
    comments.set('gone', 'default!3:3')
    comments.set('range', 'default!2:2:6:6')

    const protections = doc.getMap<unknown>(SHEET_PROTECTION_FIELD)
    protections.set('default!r:protected', {
      kind: 'r', permissionId: 'perm',
      ranges: [{ startRow: 2, startColumn: 2, endRow: 6, endColumn: 6, label: 'keep-me' }],
    })
    protections.set('default!w:', { kind: 'w', permissionId: 'sheet-perm' })
  })
  return doc
}

function apply(doc: Y.Doc, edit: SheetStructuralEdit): void {
  const plan = prepareSheetStructuralEdit(doc, edit)
  doc.transact(() => applySheetStructuralEditPlan(doc, plan))
}

describe('structural sheet row/column edits', () => {
  it('deletes rows and relocates or removes every persisted row-bearing resource', () => {
    const doc = seededDoc()
    const plan = prepareSheetStructuralEdit(doc, {
      kind: 'rows.delete', logicalId: 'default', startRow: 3, count: 2,
    })
    expect(plan.rowCount).toBe(10)
    expect(doc.getMap(SHEET_YMAP_FIELD).get('default!3:3')).toEqual({ v: 'deleted' })
    doc.transact(() => applySheetStructuralEditPlan(doc, plan))

    const cells = doc.getMap<SheetCell>(SHEET_YMAP_FIELD)
    expect(cells.get('default!2:2')).toEqual({ v: 'before' })
    expect(cells.has('default!3:3')).toBe(false)
    expect(cells.get('default!3:5')).toEqual({ v: 'moves' })
    expect(cells.get('other!5:5')).toEqual({ v: 'other sheet' })

    const dims = doc.getMap<number>(SHEET_DIMS_FIELD)
    expect(dims.has('default:r3')).toBe(false)
    expect(dims.get('r3')).toBe(55)
    expect(dims.get('default:c3')).toBe(73)

    const drawing = doc.getMap<StoredDrawing>(SHEET_DRAWINGS_FIELD).get('default!image')!
    expect(drawing.row).toBe(3)
    expect((drawing.sheetTransform as { from: { row: number }; to: { row: number } }).from.row).toBe(3)
    expect((drawing.sheetTransform as { from: { row: number }; to: { row: number } }).to.row).toBe(5)
    expect(doc.getMap<StoredHyperLink>(SHEET_HYPERLINKS_FIELD).get('default!move')?.row).toBe(3)
    expect(doc.getMap<StoredHyperLink>(SHEET_HYPERLINKS_FIELD).has('default!gone')).toBe(false)

    const merges = doc.getMap<boolean>(SHEET_MERGES_FIELD)
    expect(merges.has('default:2:2:4:6')).toBe(true)
    expect(merges.has('default:3:7:4:8')).toBe(false)
    expect(merges.has('default:5:3:6:4')).toBe(true)
    expect(doc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD).get('default')?.rowCount).toBe(10)
    expect(doc.getMap<StoredFreeze>(SHEET_FREEZE_FIELD).get('default')).toEqual({
      startRow: 3, startColumn: 4, xSplit: 4, ySplit: 3,
    })

    const filter = doc.getMap<StoredFilter>(SHEET_FILTERS_FIELD).get('default')!
    expect(filter.ref).toEqual({ startRow: 1, startColumn: 1, endRow: 6, endColumn: 8 })
    expect(filter.enabledColumns).toEqual([2, 3, 5])
    const validations = doc.getMap<StoredDataValidation>(SHEET_DATA_VALIDATIONS_FIELD)
    expect(validations.get('default!main')?.ranges).toEqual([
      { startRow: 2, startColumn: 2, endRow: 4, endColumn: 6 },
    ])
    expect(validations.has('default!row-gone')).toBe(false)
    expect(validations.get('default!column-gone')?.ranges).toEqual([
      { startRow: 5, startColumn: 3, endRow: 6, endColumn: 4 },
    ])

    const comments = doc.getMap<string>(SHEET_COMMENT_ANCHORS_FIELD)
    expect(comments.get('move')).toBe('default!3:5')
    expect(comments.has('gone')).toBe(false)
    expect(comments.get('range')).toBe('default!2:2:4:6')
    expect((doc.getMap(SHEET_PROTECTION_FIELD).get('default!r:protected') as {
      ranges: Array<Record<string, unknown>>
    }).ranges).toEqual([
      { startRow: 2, startColumn: 2, endRow: 4, endColumn: 6, label: 'keep-me' },
    ])
    expect(doc.getMap(SHEET_PROTECTION_FIELD).get('default!w:')).toEqual({
      kind: 'w', permissionId: 'sheet-perm',
    })
  })

  it('inserts columns and relocates every persisted column-bearing resource', () => {
    const doc = seededDoc()
    apply(doc, { kind: 'columns.insert', logicalId: 'default', afterColumn: 2, count: 2 })

    const cells = doc.getMap<SheetCell>(SHEET_YMAP_FIELD)
    expect(cells.get('default!2:2')).toEqual({ v: 'before' })
    expect(cells.get('default!3:5')).toEqual({ v: 'deleted' })
    expect(cells.get('default!5:7')).toEqual({ v: 'moves' })
    expect(cells.get('other!5:5')).toEqual({ v: 'other sheet' })
    const dims = doc.getMap<number>(SHEET_DIMS_FIELD)
    expect(dims.get('default:c5')).toBe(73)
    expect(dims.get('default:c7')).toBe(95)
    expect(dims.get('default:r3')).toBe(33)

    const drawing = doc.getMap<StoredDrawing>(SHEET_DRAWINGS_FIELD).get('default!image')!
    expect(drawing.column).toBe(7)
    expect((drawing.sheetTransform as { from: { column: number }; to: { column: number } }).from.column).toBe(5)
    expect((drawing.sheetTransform as { from: { column: number }; to: { column: number } }).to.column).toBe(9)
    expect(doc.getMap<StoredHyperLink>(SHEET_HYPERLINKS_FIELD).get('default!move')?.column).toBe(7)

    const merges = doc.getMap<boolean>(SHEET_MERGES_FIELD)
    expect(merges.has('default:2:2:6:8')).toBe(true)
    expect(merges.has('default:3:9:4:10')).toBe(true)
    expect(merges.has('default:7:5:8:6')).toBe(true)
    expect(doc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD).get('default')?.columnCount).toBe(12)
    expect(doc.getMap<StoredFreeze>(SHEET_FREEZE_FIELD).get('default')).toEqual({
      startRow: 4, startColumn: 6, xSplit: 6, ySplit: 4,
    })

    const filter = doc.getMap<StoredFilter>(SHEET_FILTERS_FIELD).get('default')!
    expect(filter.ref).toEqual({ startRow: 1, startColumn: 1, endRow: 8, endColumn: 10 })
    expect(filter.filterColumns?.map((column) => column.colId)).toEqual([2, 5, 7])
    expect(filter.enabledColumns).toEqual([2, 5, 7])
    expect(doc.getMap<StoredDataValidation>(SHEET_DATA_VALIDATIONS_FIELD)
      .get('default!main')?.ranges[0]).toEqual({
      startRow: 2, startColumn: 2, endRow: 6, endColumn: 8,
    })
    expect(doc.getMap<string>(SHEET_COMMENT_ANCHORS_FIELD).get('move')).toBe('default!5:7')
    expect(doc.getMap<string>(SHEET_COMMENT_ANCHORS_FIELD).get('range')).toBe('default!2:2:6:8')
    expect((doc.getMap(SHEET_PROTECTION_FIELD).get('default!r:protected') as {
      ranges: Array<Record<string, unknown>>
    }).ranges[0]).toEqual({
      startRow: 2, startColumn: 2, endRow: 6, endColumn: 8, label: 'keep-me',
    })
  })

  it('deletes columns and relocates or removes every persisted column-bearing resource', () => {
    const doc = seededDoc()
    apply(doc, { kind: 'columns.delete', logicalId: 'default', startColumn: 3, count: 2 })

    const cells = doc.getMap<SheetCell>(SHEET_YMAP_FIELD)
    expect(cells.has('default!3:3')).toBe(false)
    expect(cells.get('default!5:3')).toEqual({ v: 'moves' })
    expect(cells.get('other!5:5')).toEqual({ v: 'other sheet' })
    const dims = doc.getMap<number>(SHEET_DIMS_FIELD)
    expect(dims.get('default:c3')).toBe(95)
    expect(dims.has('default:c5')).toBe(false)
    expect(dims.get('default:r3')).toBe(33)

    const drawing = doc.getMap<StoredDrawing>(SHEET_DRAWINGS_FIELD).get('default!image')!
    expect(drawing.column).toBe(3)
    expect((drawing.sheetTransform as { from: { column: number }; to: { column: number } }).from.column).toBe(3)
    expect((drawing.sheetTransform as { from: { column: number }; to: { column: number } }).to.column).toBe(5)
    expect(doc.getMap<StoredHyperLink>(SHEET_HYPERLINKS_FIELD).get('default!move')?.column).toBe(3)
    expect(doc.getMap<StoredHyperLink>(SHEET_HYPERLINKS_FIELD).has('default!gone')).toBe(false)

    const merges = doc.getMap<boolean>(SHEET_MERGES_FIELD)
    expect(merges.has('default:2:2:6:4')).toBe(true)
    expect(merges.has('default:3:5:4:6')).toBe(true)
    expect(merges.has('default:7:3:8:4')).toBe(false)
    expect(doc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD).get('default')?.columnCount).toBe(8)
    expect(doc.getMap<StoredFreeze>(SHEET_FREEZE_FIELD).get('default')).toEqual({
      startRow: 4, startColumn: 3, xSplit: 3, ySplit: 4,
    })

    const filter = doc.getMap<StoredFilter>(SHEET_FILTERS_FIELD).get('default')!
    expect(filter.ref).toEqual({ startRow: 1, startColumn: 1, endRow: 8, endColumn: 6 })
    expect(filter.filterColumns?.map((column) => column.colId)).toEqual([2, 3])
    expect(filter.enabledColumns).toEqual([2, 3])
    const validations = doc.getMap<StoredDataValidation>(SHEET_DATA_VALIDATIONS_FIELD)
    expect(validations.get('default!main')?.ranges[0]).toEqual({
      startRow: 2, startColumn: 2, endRow: 6, endColumn: 4,
    })
    expect(validations.has('default!column-gone')).toBe(false)
    expect(doc.getMap<string>(SHEET_COMMENT_ANCHORS_FIELD).get('move')).toBe('default!5:3')
    expect(doc.getMap<string>(SHEET_COMMENT_ANCHORS_FIELD).has('gone')).toBe(false)
    expect(doc.getMap<string>(SHEET_COMMENT_ANCHORS_FIELD).get('range')).toBe('default!2:2:6:4')
    expect((doc.getMap(SHEET_PROTECTION_FIELD).get('default!r:protected') as {
      ranges: Array<Record<string, unknown>>
    }).ranges[0]).toEqual({
      startRow: 2, startColumn: 2, endRow: 6, endColumn: 4, label: 'keep-me',
    })
  })

  it('uses legacy dimensions, reports both axes, and refuses invalid boundaries', () => {
    const legacy = new Y.Doc()
    legacy.getMap<SheetCell>(SHEET_YMAP_FIELD).set('default!999:99', { v: 'tail' })
    const rowInsert = measureSheetAfterStructuralEdit(Y.encodeStateAsUpdate(legacy), {
      kind: 'rows.insert', logicalId: 'default', afterRow: 999, count: 1,
    })
    expect(rowInsert).toMatchObject({
      rowCount: SHEET_LEGACY_ROWS + 1,
      columnCount: SHEET_LEGACY_COLUMNS,
    })

    const columnDelete = measureSheetAfterStructuralEdit(Y.encodeStateAsUpdate(legacy), {
      kind: 'columns.delete', logicalId: 'default', startColumn: 99, count: 1,
    })
    expect(columnDelete).toMatchObject({
      rowCount: SHEET_LEGACY_ROWS,
      columnCount: SHEET_LEGACY_COLUMNS - 1,
    })

    const doc = seededDoc()
    expect(() => prepareSheetStructuralEdit(doc, {
      kind: 'rows.delete', logicalId: 'missing', startRow: 0, count: 1,
    })).toThrowError(new SheetStructuralEditError('sheet_not_found'))
    expect(() => prepareSheetStructuralEdit(doc, {
      kind: 'rows.delete', logicalId: 'default', startRow: 0, count: 12,
    })).toThrowError(new SheetStructuralEditError('sheet_row_out_of_bounds'))
    expect(() => prepareSheetStructuralEdit(doc, {
      kind: 'columns.delete', logicalId: 'default', startColumn: 9, count: 2,
    })).toThrowError(new SheetStructuralEditError('sheet_column_out_of_bounds'))
    expect(() => prepareSheetStructuralEdit(doc, {
      kind: 'columns.insert', logicalId: 'default', afterColumn: 9, count: 400_000,
    })).toThrowError(new SheetStructuralEditError('sheet_column_limit_exceeded'))
  })

  it('refuses every non-row-insert structural edit when any workbook cell has a formula', () => {
    for (const edit of [
      { kind: 'rows.delete', logicalId: 'default', startRow: 0, count: 1 },
      { kind: 'columns.insert', logicalId: 'default', afterColumn: 0, count: 1 },
      { kind: 'columns.delete', logicalId: 'default', startColumn: 0, count: 1 },
    ] satisfies SheetStructuralEdit[]) {
      const doc = seededDoc()
      doc.getMap<SheetCell>(SHEET_YMAP_FIELD).set('other!0:0', { v: 1, f: '=default!A1' })
      expect(() => prepareSheetStructuralEdit(doc, edit))
        .toThrowError(new SheetStructuralEditError('sheet_formula_unsupported'))
    }
  })
})
