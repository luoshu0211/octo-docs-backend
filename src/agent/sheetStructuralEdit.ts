import * as Y from 'yjs'
import { persistedByteLength } from '../collab/persistedEncoding.js'
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
  SHEET_MAX_COLUMNS,
  SHEET_MAX_ROWS,
  SHEET_MERGES_FIELD,
  SHEET_PROTECTION_FIELD,
  SHEET_YMAP_FIELD,
  SheetSnapshotInvalidError,
  measureSheetReadPayloadBytes,
  parseSheetDataValidationKey,
  validateResourceLogicalId,
  validateSheetCell,
  validateSheetDataValidationRule,
  validateSheetDim,
  validateSheetDrawing,
  validateSheetFilter,
  validateSheetFreeze,
  validateSheetHyperLink,
  validateSheetListEntry,
  validateSheetMerge,
  validateSheetRange,
  type SheetCell,
  type StoredDataValidation,
  type StoredDrawing,
  type StoredFilter,
  type StoredFilterColumn,
  type StoredFreeze,
  type StoredHyperLink,
  type StoredSheetMeta,
  type StoredSheetRange,
} from './sheetConversion.js'
import {
  SHEET_COMMENT_ANCHORS_FIELD,
  applySheetRowInsertPlan,
  prepareSheetRowInsert,
  type SheetRowInsertPlan,
} from './sheetRowInsert.js'

export type SheetStructuralEdit =
  | { kind: 'rows.insert'; logicalId: string; afterRow: number; count: number }
  | { kind: 'rows.delete'; logicalId: string; startRow: number; count: number }
  | { kind: 'columns.insert'; logicalId: string; afterColumn: number; count: number }
  | { kind: 'columns.delete'; logicalId: string; startColumn: number; count: number }

export type SheetStructuralEditErrorCode =
  | 'sheet_not_found'
  | 'sheet_row_out_of_bounds'
  | 'sheet_row_limit_exceeded'
  | 'sheet_column_out_of_bounds'
  | 'sheet_column_limit_exceeded'
  | 'sheet_formula_unsupported'

export class SheetStructuralEditError extends Error {
  constructor(readonly code: SheetStructuralEditErrorCode) {
    super(code)
    this.name = 'SheetStructuralEditError'
  }
}

interface MapBatch<T> {
  toDelete: string[]
  toSet: Array<[string, T]>
}

type Axis = 'row' | 'column'
type EditMode = 'insert' | 'delete'

interface AxisEditPlan {
  logicalId: string
  axis: Axis
  mode: EditMode
  start: number
  count: number
  rowCount: number
  columnCount: number
  sheetMeta: StoredSheetMeta
  cells: MapBatch<SheetCell>
  dims: MapBatch<number>
  drawings: MapBatch<StoredDrawing>
  hyperlinks: MapBatch<StoredHyperLink>
  merges: MapBatch<true>
  freeze: MapBatch<StoredFreeze>
  filter: MapBatch<StoredFilter>
  dataValidations: MapBatch<StoredDataValidation>
  commentAnchors: MapBatch<string>
  protections: MapBatch<unknown>
}

export type SheetStructuralEditPlan =
  | {
      kind: 'rows.insert'
      logicalId: string
      rowCount: number
      columnCount: number
      sheetMeta: StoredSheetMeta
      rowInsertPlan: SheetRowInsertPlan
    }
  | {
      kind: 'rows.delete' | 'columns.insert' | 'columns.delete'
      logicalId: string
      rowCount: number
      columnCount: number
      sheetMeta: StoredSheetMeta
      axisEditPlan: AxisEditPlan
    }

function axisFields(axis: Axis): {
  start: 'startRow' | 'startColumn'
  end: 'endRow' | 'endColumn'
  max: number
  legacy: number
  outOfBounds: SheetStructuralEditErrorCode
  limitExceeded: SheetStructuralEditErrorCode
} {
  return axis === 'row'
    ? {
        start: 'startRow', end: 'endRow', max: SHEET_MAX_ROWS, legacy: SHEET_LEGACY_ROWS,
        outOfBounds: 'sheet_row_out_of_bounds', limitExceeded: 'sheet_row_limit_exceeded',
      }
    : {
        start: 'startColumn', end: 'endColumn', max: SHEET_MAX_COLUMNS, legacy: SHEET_LEGACY_COLUMNS,
        outOfBounds: 'sheet_column_out_of_bounds', limitExceeded: 'sheet_column_limit_exceeded',
      }
}

function relocatePoint(
  value: number,
  mode: EditMode,
  start: number,
  count: number,
  max: number,
  collapseDeleted = false,
): number | null {
  if (mode === 'insert') {
    if (value < start) return value
    const next = value + count
    if (next >= max) {
      throw new SheetStructuralEditError(max === SHEET_MAX_ROWS
        ? 'sheet_row_limit_exceeded'
        : 'sheet_column_limit_exceeded')
    }
    return next
  }
  const end = start + count
  if (value < start) return value
  if (value >= end) return value - count
  return collapseDeleted ? start : null
}

function relocateRange(
  range: StoredSheetRange,
  axis: Axis,
  mode: EditMode,
  start: number,
  count: number,
  expandWhenAdjacent: boolean,
): StoredSheetRange | null {
  const fields = axisFields(axis)
  const rangeStart = range[fields.start]
  const rangeEnd = range[fields.end]
  if (mode === 'insert') {
    if (start <= rangeStart) {
      const nextStart = relocatePoint(rangeStart, mode, start, count, fields.max)!
      const nextEnd = relocatePoint(rangeEnd, mode, start, count, fields.max)!
      return { ...range, [fields.start]: nextStart, [fields.end]: nextEnd }
    }
    if (start <= rangeEnd + (expandWhenAdjacent ? 1 : 0)) {
      const nextEnd = rangeEnd + count
      if (nextEnd >= fields.max) {
        throw new SheetStructuralEditError(fields.limitExceeded)
      }
      return { ...range, [fields.end]: nextEnd }
    }
    return range
  }

  const deleteEnd = start + count
  if (rangeEnd < start) return range
  if (rangeStart >= deleteEnd) {
    return {
      ...range,
      [fields.start]: rangeStart - count,
      [fields.end]: rangeEnd - count,
    }
  }
  const nextStart = rangeStart < start ? rangeStart : start
  const nextEnd = rangeEnd >= deleteEnd ? rangeEnd - count : start - 1
  if (nextStart > nextEnd) return null
  return { ...range, [fields.start]: nextStart, [fields.end]: nextEnd }
}

function parseCellKey(key: string): { logicalId: string; row: number; column: number } {
  const bang = key.indexOf('!')
  const colon = key.indexOf(':', bang + 1)
  return {
    logicalId: key.slice(0, bang),
    row: Number(key.slice(bang + 1, colon)),
    column: Number(key.slice(colon + 1)),
  }
}

function dimTarget(key: string): { logicalId: string; axis: Axis; index: number; prefix: string } {
  const colon = key.indexOf(':')
  const logicalId = colon < 0 ? 'default' : key.slice(0, colon)
  const dim = colon < 0 ? key : key.slice(colon + 1)
  return {
    logicalId,
    axis: dim[0] === 'r' ? 'row' : 'column',
    index: Number(dim.slice(1)),
    prefix: colon < 0 ? '' : `${logicalId}:`,
  }
}

function parseCommentRange(value: string): {
  logicalId: string
  row: number
  column: number
  endRow: number
  endColumn: number
} | null {
  const bang = value.indexOf('!')
  if (bang <= 0 || bang !== value.lastIndexOf('!')) return null
  const logicalId = value.slice(0, bang)
  const parts = value.slice(bang + 1).split(':')
  if (parts.length !== 2 && parts.length !== 4) return null
  if (!parts.every((part) => /^\d+$/.test(part))) return null
  const [row, column, endRow = row, endColumn = column] = parts.map(Number)
  if (![row, column, endRow, endColumn].every(Number.isSafeInteger)) return null
  if (row! < 0 || column! < 0 || endRow! < row! || endColumn! < column!) return null
  return { logicalId, row: row!, column: column!, endRow: endRow!, endColumn: endColumn! }
}

function encodeCommentRange(range: ReturnType<typeof parseCommentRange> & {}): string {
  const start = `${range.logicalId}!${range.row}:${range.column}`
  return range.row === range.endRow && range.column === range.endColumn
    ? start
    : `${start}:${range.endRow}:${range.endColumn}`
}

function relocateDrawing(
  key: string,
  value: unknown,
  axis: Axis,
  mode: EditMode,
  start: number,
  count: number,
  nextSize: number,
): StoredDrawing | null {
  const drawing = validateSheetDrawing(key, value)
  const next = structuredClone(drawing) as StoredDrawing
  let changed = false
  const field = axis

  const shiftPoint = (holder: Record<string, unknown>, label: string): void => {
    if (!Object.prototype.hasOwnProperty.call(holder, field)) return
    const coordinate = holder[field]
    if (!Number.isInteger(coordinate) || (coordinate as number) < 0) {
      throw new SheetSnapshotInvalidError(`${label}.${field} must be a non-negative integer`)
    }
    let relocated = relocatePoint(coordinate as number, mode, start, count, axisFields(axis).max, true)!
    if (mode === 'delete') relocated = Math.min(relocated, nextSize - 1)
    if (relocated !== coordinate) {
      holder[field] = relocated
      changed = true
    }
  }

  shiftPoint(next as Record<string, unknown>, `drawing ${key}`)
  for (const transformField of ['sheetTransform', 'axisAlignSheetTransform'] as const) {
    const transform = next[transformField]
    if (transform === undefined) continue
    if (transform === null || typeof transform !== 'object' || Array.isArray(transform)) {
      throw new SheetSnapshotInvalidError(`drawing ${key}.${transformField} must be an object`)
    }
    for (const endpoint of ['from', 'to'] as const) {
      const point = (transform as Record<string, unknown>)[endpoint]
      if (point === undefined) continue
      if (point === null || typeof point !== 'object' || Array.isArray(point)) {
        throw new SheetSnapshotInvalidError(`drawing ${key}.${transformField}.${endpoint} must be an object`)
      }
      shiftPoint(point as Record<string, unknown>, `drawing ${key}.${transformField}.${endpoint}`)
    }
  }
  return changed ? validateSheetDrawing(key, next) : null
}

function relocateFreeze(
  logicalId: string,
  current: StoredFreeze,
  axis: Axis,
  mode: EditMode,
  start: number,
  count: number,
  nextSize: number,
): StoredFreeze | null {
  const next = { ...current }
  const splitField = axis === 'row' ? 'ySplit' : 'xSplit'
  const startField = axis === 'row' ? 'startRow' : 'startColumn'
  const split = current[splitField]
  const startCoordinate = current[startField]

  if (mode === 'insert') {
    if (split > 0 && start < split) next[splitField] = relocatePoint(split, mode, start, count, axisFields(axis).max)!
    if (startCoordinate >= 0 && start < startCoordinate) {
      next[startField] = relocatePoint(startCoordinate, mode, start, count, axisFields(axis).max)!
    }
  } else {
    const deleteEnd = start + count
    const removedFrozen = Math.max(0, Math.min(deleteEnd, split) - Math.min(Math.max(start, 0), split))
    next[splitField] = split - removedFrozen
    if (next[splitField] === 0) {
      next[startField] = -1
    } else {
      const relocated = relocatePoint(startCoordinate, mode, start, count, axisFields(axis).max, true)!
      next[startField] = Math.max(next[splitField], Math.min(relocated, nextSize - 1))
    }
  }

  return next.startRow !== current.startRow || next.startColumn !== current.startColumn ||
    next.xSplit !== current.xSplit || next.ySplit !== current.ySplit
    ? validateSheetFreeze(logicalId, next)
    : null
}

function relocateFilter(
  logicalId: string,
  current: StoredFilter,
  axis: Axis,
  mode: EditMode,
  start: number,
  count: number,
): StoredFilter | null | 'delete' {
  const ref = relocateRange(current.ref, axis, mode, start, count, true)
  if (!ref) return 'delete'
  const next: StoredFilter = { ...current, ref }
  if (axis === 'column') {
    if (current.filterColumns) {
      const columns: StoredFilterColumn[] = []
      for (const column of current.filterColumns) {
        const colId = relocatePoint(column.colId, mode, start, count, SHEET_MAX_COLUMNS)
        if (colId !== null) columns.push({ ...column, colId })
      }
      if (columns.length > 0) next.filterColumns = columns
      else delete next.filterColumns
    }
    if (current.enabledColumns) {
      const enabledColumns = current.enabledColumns
        .map((column) => relocatePoint(column, mode, start, count, SHEET_MAX_COLUMNS))
        .filter((column): column is number => column !== null)
      if (enabledColumns.length === 0) return 'delete'
      next.enabledColumns = enabledColumns
    }
  }
  return validateSheetFilter(logicalId, next)
}

function prepareAxisEdit(
  doc: Y.Doc,
  edit: Exclude<SheetStructuralEdit, { kind: 'rows.insert' }>,
): AxisEditPlan {
  const logicalId = validateResourceLogicalId(edit.logicalId, 'structural edit logicalId')
  const axis: Axis = edit.kind.startsWith('rows.') ? 'row' : 'column'
  const mode: EditMode = edit.kind.endsWith('.insert') ? 'insert' : 'delete'
  const fields = axisFields(axis)
  const listMap = doc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD)
  let currentMeta: StoredSheetMeta
  if (listMap.size === 0 && logicalId === 'default') {
    currentMeta = {
      name: 'Sheet1', order: 0, rowCount: SHEET_LEGACY_ROWS, columnCount: SHEET_LEGACY_COLUMNS,
    }
  } else {
    const stored = listMap.get(logicalId)
    if (stored === undefined) throw new SheetStructuralEditError('sheet_not_found')
    currentMeta = validateSheetListEntry(logicalId, stored)
  }
  const currentRows = currentMeta.rowCount ?? SHEET_LEGACY_ROWS
  const currentColumns = currentMeta.columnCount ?? SHEET_LEGACY_COLUMNS
  const currentSize = axis === 'row' ? currentRows : currentColumns
  const anchor = edit.kind === 'columns.insert' ? edit.afterColumn
    : edit.kind === 'rows.delete' ? edit.startRow
      : edit.startColumn
  if (!Number.isInteger(anchor) || anchor < 0 || anchor >= currentSize) {
    throw new SheetStructuralEditError(fields.outOfBounds)
  }
  if (!Number.isInteger(edit.count) || edit.count < 1 || edit.count > fields.max) {
    throw new SheetStructuralEditError(fields.limitExceeded)
  }
  const start = mode === 'insert' ? anchor + 1 : anchor
  if (mode === 'insert' && currentSize + edit.count > fields.max) {
    throw new SheetStructuralEditError(fields.limitExceeded)
  }
  if (mode === 'delete' && (start + edit.count > currentSize || currentSize - edit.count < 1)) {
    throw new SheetStructuralEditError(fields.outOfBounds)
  }
  const nextSize = mode === 'insert' ? currentSize + edit.count : currentSize - edit.count
  const rowCount = axis === 'row' ? nextSize : currentRows
  const columnCount = axis === 'column' ? nextSize : currentColumns
  const sheetMeta = validateSheetListEntry(logicalId, { ...currentMeta, rowCount, columnCount })

  const cells: MapBatch<SheetCell> = { toDelete: [], toSet: [] }
  for (const [key, rawValue] of doc.getMap<SheetCell>(SHEET_YMAP_FIELD).entries()) {
    const value = validateSheetCell(key, rawValue)
    if (value.f !== undefined) throw new SheetStructuralEditError('sheet_formula_unsupported')
    const at = parseCellKey(key)
    if (at.logicalId !== logicalId) continue
    const coordinate = axis === 'row' ? at.row : at.column
    const relocated = relocatePoint(coordinate, mode, start, edit.count, fields.max)
    if (relocated === coordinate) continue
    cells.toDelete.push(key)
    if (relocated !== null) {
      const row = axis === 'row' ? relocated : at.row
      const column = axis === 'column' ? relocated : at.column
      cells.toSet.push([`${logicalId}!${row}:${column}`, value])
    }
  }

  const dims: MapBatch<number> = { toDelete: [], toSet: [] }
  for (const [key, rawValue] of doc.getMap<number>(SHEET_DIMS_FIELD).entries()) {
    const value = validateSheetDim(key, rawValue)
    const at = dimTarget(key)
    if (at.logicalId !== logicalId || at.axis !== axis) continue
    const relocated = relocatePoint(at.index, mode, start, edit.count, fields.max)
    if (relocated === at.index) continue
    dims.toDelete.push(key)
    if (relocated !== null) {
      const marker = axis === 'row' ? 'r' : 'c'
      dims.toSet.push([`${at.prefix}${marker}${relocated}`, value])
    }
  }

  const drawings: MapBatch<StoredDrawing> = { toDelete: [], toSet: [] }
  for (const [key, value] of doc.getMap<StoredDrawing>(SHEET_DRAWINGS_FIELD).entries()) {
    if (!key.startsWith(`${logicalId}!`)) continue
    const relocated = relocateDrawing(key, value, axis, mode, start, edit.count, nextSize)
    if (relocated) drawings.toSet.push([key, relocated])
  }

  const hyperlinks: MapBatch<StoredHyperLink> = { toDelete: [], toSet: [] }
  for (const [key, rawValue] of doc.getMap<StoredHyperLink>(SHEET_HYPERLINKS_FIELD).entries()) {
    if (!key.startsWith(`${logicalId}!`)) continue
    const value = validateSheetHyperLink(key, rawValue)
    const coordinate = axis === 'row' ? value.row : value.column
    const relocated = relocatePoint(coordinate, mode, start, edit.count, fields.max)
    if (relocated === coordinate) continue
    if (relocated === null) hyperlinks.toDelete.push(key)
    else {
      const next = { ...value, [axis]: relocated }
      hyperlinks.toSet.push([key, validateSheetHyperLink(key, next)])
    }
  }

  const merges: MapBatch<true> = { toDelete: [], toSet: [] }
  for (const [key, value] of doc.getMap<boolean>(SHEET_MERGES_FIELD).entries()) {
    if (!key.startsWith(`${logicalId}:`)) continue
    validateSheetMerge(key, value)
    const parts = key.split(':')
    const [startRow, startColumn, endRow, endColumn] = parts.slice(-4).map(Number)
    const relocated = relocateRange(
      { startRow: startRow!, startColumn: startColumn!, endRow: endRow!, endColumn: endColumn! },
      axis, mode, start, edit.count, false,
    )
    if (!relocated) {
      merges.toDelete.push(key)
      continue
    }
    const nextKey = `${logicalId}:${relocated.startRow}:${relocated.startColumn}:${relocated.endRow}:${relocated.endColumn}`
    if (nextKey !== key) {
      validateSheetMerge(nextKey, true)
      merges.toDelete.push(key)
      merges.toSet.push([nextKey, true])
    }
  }

  const freeze: MapBatch<StoredFreeze> = { toDelete: [], toSet: [] }
  const storedFreeze = doc.getMap<StoredFreeze>(SHEET_FREEZE_FIELD).get(logicalId)
  if (storedFreeze !== undefined) {
    const current = validateSheetFreeze(logicalId, storedFreeze)
    const relocated = relocateFreeze(logicalId, current, axis, mode, start, edit.count, nextSize)
    if (relocated) freeze.toSet.push([logicalId, relocated])
  }

  const filter: MapBatch<StoredFilter> = { toDelete: [], toSet: [] }
  const storedFilter = doc.getMap<StoredFilter>(SHEET_FILTERS_FIELD).get(logicalId)
  if (storedFilter !== undefined) {
    const current = validateSheetFilter(logicalId, storedFilter)
    const relocated = relocateFilter(logicalId, current, axis, mode, start, edit.count)
    if (relocated === 'delete') filter.toDelete.push(logicalId)
    else if (relocated) filter.toSet.push([logicalId, relocated])
  }

  const dataValidations: MapBatch<StoredDataValidation> = { toDelete: [], toSet: [] }
  for (const [key, rawValue] of doc.getMap<StoredDataValidation>(SHEET_DATA_VALIDATIONS_FIELD).entries()) {
    const parsed = parseSheetDataValidationKey(key)
    const current = validateSheetDataValidationRule(parsed.logicalId, rawValue, 0)
    if (current.uid !== parsed.uid) {
      throw new SheetSnapshotInvalidError(`sheetDataValidations ${key}: uid must match its key`)
    }
    if (parsed.logicalId !== logicalId) continue
    const ranges = current.ranges
      .map((range) => relocateRange(range, axis, mode, start, edit.count, true))
      .filter((range): range is StoredSheetRange => range !== null)
    if (ranges.length === 0) dataValidations.toDelete.push(key)
    else if (JSON.stringify(ranges) !== JSON.stringify(current.ranges)) {
      dataValidations.toSet.push([
        key,
        validateSheetDataValidationRule(logicalId, { ...current, ranges }, 0),
      ])
    }
  }

  const commentAnchors: MapBatch<string> = { toDelete: [], toSet: [] }
  for (const [key, value] of doc.getMap<string>(SHEET_COMMENT_ANCHORS_FIELD).entries()) {
    if (value === '') continue
    if (typeof value !== 'string') {
      throw new SheetSnapshotInvalidError(`sheetCommentAnchors ${key}: value must be a string`)
    }
    const current = parseCommentRange(value)
    if (!current) throw new SheetSnapshotInvalidError(`sheetCommentAnchors ${key}: invalid anchor`)
    if (current.logicalId !== logicalId) continue
    const relocated = relocateRange({
      startRow: current.row,
      startColumn: current.column,
      endRow: current.endRow,
      endColumn: current.endColumn,
    }, axis, mode, start, edit.count, false)
    if (!relocated) commentAnchors.toDelete.push(key)
    else {
      const next = encodeCommentRange({
        logicalId,
        row: relocated.startRow,
        column: relocated.startColumn,
        endRow: relocated.endRow,
        endColumn: relocated.endColumn,
      })
      if (next !== value) commentAnchors.toSet.push([key, next])
    }
  }

  const protections: MapBatch<unknown> = { toDelete: [], toSet: [] }
  for (const [key, value] of doc.getMap<unknown>(SHEET_PROTECTION_FIELD).entries()) {
    if (!key.startsWith(`${logicalId}!`)) continue
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new SheetSnapshotInvalidError(`sheetProtection ${key}: value is not a plain object`)
    }
    if (key.slice(key.indexOf('!') + 1).startsWith('w:')) continue
    const source = value as Record<string, unknown>
    if (!Array.isArray(source.ranges)) {
      throw new SheetSnapshotInvalidError(`sheetProtection ${key}.ranges must be an array`)
    }
    const sourceRanges = source.ranges
    const ranges = sourceRanges
      .map((raw, index) => {
        const relocated = relocateRange(
          validateSheetRange(raw, `sheetProtection ${key}.ranges[${index}]`),
          axis, mode, start, edit.count, false,
        )
        return relocated === null
          ? null
          : { ...(raw as Record<string, unknown>), ...relocated }
      })
      .filter((range): range is StoredSheetRange => range !== null)
    if (ranges.length === 0) protections.toDelete.push(key)
    else {
      const changed = ranges.length !== sourceRanges.length || ranges.some((range, index) => {
        const previous = sourceRanges[index] as Record<string, unknown>
        return range.startRow !== previous.startRow || range.startColumn !== previous.startColumn ||
          range.endRow !== previous.endRow || range.endColumn !== previous.endColumn
      })
      if (changed) protections.toSet.push([key, { ...source, ranges }])
    }
  }

  return {
    logicalId, axis, mode, start, count: edit.count, rowCount, columnCount, sheetMeta,
    cells, dims, drawings, hyperlinks, merges, freeze, filter,
    dataValidations, commentAnchors, protections,
  }
}

export function prepareSheetStructuralEdit(
  doc: Y.Doc,
  edit: SheetStructuralEdit,
): SheetStructuralEditPlan {
  if (edit.kind === 'rows.insert') {
    const rowInsertPlan = prepareSheetRowInsert(doc, edit)
    return {
      kind: edit.kind,
      logicalId: rowInsertPlan.logicalId,
      rowCount: rowInsertPlan.rowCount,
      columnCount: rowInsertPlan.sheetMeta.columnCount ?? SHEET_LEGACY_COLUMNS,
      sheetMeta: rowInsertPlan.sheetMeta,
      rowInsertPlan,
    }
  }
  const axisEditPlan = prepareAxisEdit(doc, edit)
  return {
    kind: edit.kind,
    logicalId: axisEditPlan.logicalId,
    rowCount: axisEditPlan.rowCount,
    columnCount: axisEditPlan.columnCount,
    sheetMeta: axisEditPlan.sheetMeta,
    axisEditPlan,
  }
}

function applyMapBatch<T>(map: Y.Map<T>, batch: MapBatch<T>): void {
  for (const key of batch.toDelete) map.delete(key)
  for (const [key, value] of batch.toSet) map.set(key, value)
}

export function applySheetStructuralEditPlan(doc: Y.Doc, plan: SheetStructuralEditPlan): void {
  if (plan.kind === 'rows.insert') {
    applySheetRowInsertPlan(doc, plan.rowInsertPlan)
    return
  }
  const edit = plan.axisEditPlan
  applyMapBatch(doc.getMap<SheetCell>(SHEET_YMAP_FIELD), edit.cells)
  applyMapBatch(doc.getMap<number>(SHEET_DIMS_FIELD), edit.dims)
  applyMapBatch(doc.getMap<StoredDrawing>(SHEET_DRAWINGS_FIELD), edit.drawings)
  applyMapBatch(doc.getMap<StoredHyperLink>(SHEET_HYPERLINKS_FIELD), edit.hyperlinks)
  applyMapBatch(doc.getMap<true>(SHEET_MERGES_FIELD), edit.merges)
  doc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD).set(edit.logicalId, edit.sheetMeta)
  applyMapBatch(doc.getMap<StoredFreeze>(SHEET_FREEZE_FIELD), edit.freeze)
  applyMapBatch(doc.getMap<StoredFilter>(SHEET_FILTERS_FIELD), edit.filter)
  applyMapBatch(doc.getMap<StoredDataValidation>(SHEET_DATA_VALIDATIONS_FIELD), edit.dataValidations)
  applyMapBatch(doc.getMap<string>(SHEET_COMMENT_ANCHORS_FIELD), edit.commentAnchors)
  applyMapBatch(doc.getMap<unknown>(SHEET_PROTECTION_FIELD), edit.protections)
}

export function measureSheetAfterStructuralEdit(
  preEditState: Uint8Array,
  edit: SheetStructuralEdit,
): { docBytes: number; payloadBytes: number; rowCount: number; columnCount: number } {
  const scratch = new Y.Doc()
  Y.applyUpdate(scratch, preEditState)
  const plan = prepareSheetStructuralEdit(scratch, edit)
  scratch.transact(() => applySheetStructuralEditPlan(scratch, plan))
  return {
    docBytes: persistedByteLength(scratch),
    payloadBytes: measureSheetReadPayloadBytes(scratch),
    rowCount: plan.rowCount,
    columnCount: plan.columnCount,
  }
}
