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
  type StoredFreeze,
  type StoredHyperLink,
  type StoredSheetMeta,
  type StoredSheetRange,
} from './sheetConversion.js'

/** Must match octo-docs-module's live comment-anchor Y.Map field. */
export const SHEET_COMMENT_ANCHORS_FIELD = 'sheetCommentAnchors'

export interface SheetRowInsert {
  logicalId: string
  /** Existing row after which the new rows are inserted. Zero-based. */
  afterRow: number
  count: number
}

export type SheetRowInsertErrorCode =
  | 'sheet_not_found'
  | 'sheet_row_out_of_bounds'
  | 'sheet_row_limit_exceeded'
  | 'sheet_formula_unsupported'

export class SheetRowInsertError extends Error {
  constructor(readonly code: SheetRowInsertErrorCode) {
    super(code)
    this.name = 'SheetRowInsertError'
  }
}

interface MapBatch<T> {
  toDelete: string[]
  toSet: Array<[string, T]>
}

export interface SheetRowInsertPlan {
  logicalId: string
  insertAt: number
  count: number
  rowCount: number
  cells: MapBatch<SheetCell>
  dims: MapBatch<number>
  drawings: MapBatch<StoredDrawing>
  hyperlinks: MapBatch<StoredHyperLink>
  merges: MapBatch<true>
  sheetMeta: StoredSheetMeta
  freeze: StoredFreeze | null
  filter: StoredFilter | null
  dataValidations: Array<[string, StoredDataValidation]>
  commentAnchors: Array<[string, string]>
  protections: Array<[string, unknown]>
}

function assertRowIndex(index: number): number {
  if (index >= SHEET_MAX_ROWS) throw new SheetRowInsertError('sheet_row_limit_exceeded')
  return index
}

/** Relocate an inclusive row interval through an insertion. */
function insertIntoRange(
  range: StoredSheetRange,
  insertAt: number,
  count: number,
  expandWhenAdjacent: boolean,
): StoredSheetRange {
  if (insertAt <= range.startRow) {
    return {
      ...range,
      startRow: assertRowIndex(range.startRow + count),
      endRow: assertRowIndex(range.endRow + count),
    }
  }
  if (insertAt <= range.endRow + (expandWhenAdjacent ? 1 : 0)) {
    return { ...range, endRow: assertRowIndex(range.endRow + count) }
  }
  return range
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

function rowDimTarget(key: string): { logicalId: string; row: number; prefix: string } | null {
  const colon = key.indexOf(':')
  const logicalId = colon < 0 ? 'default' : key.slice(0, colon)
  const dim = colon < 0 ? key : key.slice(colon + 1)
  if (!dim.startsWith('r')) return null
  return { logicalId, row: Number(dim.slice(1)), prefix: colon < 0 ? '' : `${logicalId}:` }
}

function relocateDrawing(
  key: string,
  value: unknown,
  insertAt: number,
  count: number,
): StoredDrawing | null {
  const drawing = validateSheetDrawing(key, value)
  const next = structuredClone(drawing) as StoredDrawing
  let changed = false

  const shiftRow = (holder: Record<string, unknown>, label: string): void => {
    if (!Object.prototype.hasOwnProperty.call(holder, 'row')) return
    const row = holder.row
    if (!Number.isInteger(row) || (row as number) < 0) {
      throw new SheetSnapshotInvalidError(`${label}.row must be a non-negative integer`)
    }
    if ((row as number) >= insertAt) {
      holder.row = assertRowIndex((row as number) + count)
      changed = true
    }
  }

  shiftRow(next as Record<string, unknown>, `drawing ${key}`)
  for (const field of ['sheetTransform', 'axisAlignSheetTransform'] as const) {
    const transform = next[field]
    if (transform === undefined) continue
    if (transform === null || typeof transform !== 'object' || Array.isArray(transform)) {
      throw new SheetSnapshotInvalidError(`drawing ${key}.${field} must be an object`)
    }
    for (const endpoint of ['from', 'to'] as const) {
      const point = (transform as Record<string, unknown>)[endpoint]
      if (point === undefined) continue
      if (point === null || typeof point !== 'object' || Array.isArray(point)) {
        throw new SheetSnapshotInvalidError(`drawing ${key}.${field}.${endpoint} must be an object`)
      }
      shiftRow(point as Record<string, unknown>, `drawing ${key}.${field}.${endpoint}`)
    }
  }
  return changed ? validateSheetDrawing(key, next) : null
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

function relocateProtection(
  key: string,
  value: unknown,
  insertAt: number,
  count: number,
): unknown | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SheetSnapshotInvalidError(`sheetProtection ${key}: value is not a plain object`)
  }
  // Worksheet protection has no coordinate range.
  if (key.slice(key.indexOf('!') + 1).startsWith('w:')) return null
  const source = value as Record<string, unknown>
  if (!Array.isArray(source.ranges)) {
    throw new SheetSnapshotInvalidError(`sheetProtection ${key}.ranges must be an array`)
  }
  let changed = false
  const ranges = source.ranges.map((raw, index) => {
    const validated = validateSheetRange(raw, `sheetProtection ${key}.ranges[${index}]`)
    const relocated = insertIntoRange(validated, insertAt, count, false)
    if (
      relocated.startRow !== validated.startRow ||
      relocated.endRow !== validated.endRow
    ) changed = true
    return { ...(raw as Record<string, unknown>), ...relocated }
  })
  return changed ? { ...source, ranges } : null
}

/**
 * Validate and plan a structural row insertion without mutating the Y.Doc.
 * Every coordinate-bearing map is inspected first so apply cannot fail halfway.
 */
export function prepareSheetRowInsert(doc: Y.Doc, raw: SheetRowInsert): SheetRowInsertPlan {
  const logicalId = validateResourceLogicalId(raw.logicalId, 'row insert logicalId')
  if (!Number.isInteger(raw.afterRow) || raw.afterRow < 0) {
    throw new SheetRowInsertError('sheet_row_out_of_bounds')
  }
  if (!Number.isInteger(raw.count) || raw.count < 1 || raw.count > SHEET_MAX_ROWS) {
    throw new SheetRowInsertError('sheet_row_limit_exceeded')
  }

  const listMap = doc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD)
  let currentMeta: StoredSheetMeta
  if (listMap.size === 0 && logicalId === 'default') {
    currentMeta = {
      name: 'Sheet1',
      order: 0,
      rowCount: SHEET_LEGACY_ROWS,
      columnCount: SHEET_LEGACY_COLUMNS,
    }
  } else {
    const stored = listMap.get(logicalId)
    if (stored === undefined) throw new SheetRowInsertError('sheet_not_found')
    currentMeta = validateSheetListEntry(logicalId, stored)
  }
  const currentRows = currentMeta.rowCount ?? SHEET_LEGACY_ROWS
  if (raw.afterRow >= currentRows) throw new SheetRowInsertError('sheet_row_out_of_bounds')
  if (currentRows + raw.count > SHEET_MAX_ROWS) {
    throw new SheetRowInsertError('sheet_row_limit_exceeded')
  }
  const insertAt = raw.afterRow + 1
  const sheetMeta = validateSheetListEntry(logicalId, {
    ...currentMeta,
    rowCount: currentRows + raw.count,
    columnCount: currentMeta.columnCount ?? SHEET_LEGACY_COLUMNS,
  })

  const cells: MapBatch<SheetCell> = { toDelete: [], toSet: [] }
  for (const [key, value] of doc.getMap<SheetCell>(SHEET_YMAP_FIELD).entries()) {
    const cell = validateSheetCell(key, value)
    // A formula anywhere in the workbook may refer to this sheet. Without a formula engine the
    // server cannot promise Excel/Univer reference re-anchoring, so refuse instead of corrupting it.
    if (cell.f !== undefined) throw new SheetRowInsertError('sheet_formula_unsupported')
    const at = parseCellKey(key)
    if (at.logicalId !== logicalId || at.row < insertAt) continue
    const nextRow = assertRowIndex(at.row + raw.count)
    cells.toDelete.push(key)
    cells.toSet.push([`${logicalId}!${nextRow}:${at.column}`, cell])
  }

  const dims: MapBatch<number> = { toDelete: [], toSet: [] }
  for (const [key, rawValue] of doc.getMap<number>(SHEET_DIMS_FIELD).entries()) {
    const value = validateSheetDim(key, rawValue)
    const at = rowDimTarget(key)
    if (!at || at.logicalId !== logicalId || at.row < insertAt) continue
    const nextRow = assertRowIndex(at.row + raw.count)
    dims.toDelete.push(key)
    dims.toSet.push([`${at.prefix}r${nextRow}`, value])
  }

  const drawings: MapBatch<StoredDrawing> = { toDelete: [], toSet: [] }
  for (const [key, value] of doc.getMap<StoredDrawing>(SHEET_DRAWINGS_FIELD).entries()) {
    if (!key.startsWith(`${logicalId}!`)) continue
    const relocated = relocateDrawing(key, value, insertAt, raw.count)
    if (relocated) drawings.toSet.push([key, relocated])
  }

  const hyperlinks: MapBatch<StoredHyperLink> = { toDelete: [], toSet: [] }
  for (const [key, rawValue] of doc.getMap<StoredHyperLink>(SHEET_HYPERLINKS_FIELD).entries()) {
    if (!key.startsWith(`${logicalId}!`)) continue
    const value = validateSheetHyperLink(key, rawValue)
    if (value.row < insertAt) continue
    const next = { ...value, row: assertRowIndex(value.row + raw.count) }
    hyperlinks.toSet.push([key, validateSheetHyperLink(key, next)])
  }

  const merges: MapBatch<true> = { toDelete: [], toSet: [] }
  for (const [key, value] of doc.getMap<boolean>(SHEET_MERGES_FIELD).entries()) {
    if (!key.startsWith(`${logicalId}:`)) continue
    validateSheetMerge(key, value)
    const parts = key.split(':')
    const [startRow, startColumn, endRow, endColumn] = parts.slice(-4).map(Number)
    const range = insertIntoRange({ startRow: startRow!, startColumn: startColumn!, endRow: endRow!, endColumn: endColumn! }, insertAt, raw.count, false)
    const nextKey = `${logicalId}:${range.startRow}:${range.startColumn}:${range.endRow}:${range.endColumn}`
    if (nextKey !== key) {
      validateSheetMerge(nextKey, true)
      merges.toDelete.push(key)
      merges.toSet.push([nextKey, true])
    }
  }

  let freeze: StoredFreeze | null = null
  const storedFreeze = doc.getMap<StoredFreeze>(SHEET_FREEZE_FIELD).get(logicalId)
  if (storedFreeze !== undefined) {
    const current = validateSheetFreeze(logicalId, storedFreeze)
    const next = { ...current }
    if (next.ySplit > 0 && insertAt < next.ySplit) next.ySplit = assertRowIndex(next.ySplit + raw.count)
    if (next.startRow >= 0 && insertAt < next.startRow) next.startRow = assertRowIndex(next.startRow + raw.count)
    if (next.startRow !== current.startRow || next.ySplit !== current.ySplit) {
      freeze = validateSheetFreeze(logicalId, next)
    }
  }

  let filter: StoredFilter | null = null
  const storedFilter = doc.getMap<StoredFilter>(SHEET_FILTERS_FIELD).get(logicalId)
  if (storedFilter !== undefined) {
    const current = validateSheetFilter(logicalId, storedFilter)
    const ref = insertIntoRange(current.ref, insertAt, raw.count, true)
    if (ref.startRow !== current.ref.startRow || ref.endRow !== current.ref.endRow) {
      filter = validateSheetFilter(logicalId, { ...current, ref })
    }
  }

  const dataValidations: Array<[string, StoredDataValidation]> = []
  for (const [key, rawValue] of doc.getMap<StoredDataValidation>(SHEET_DATA_VALIDATIONS_FIELD).entries()) {
    const parsed = parseSheetDataValidationKey(key)
    const current = validateSheetDataValidationRule(parsed.logicalId, rawValue, 0)
    if (current.uid !== parsed.uid) {
      throw new SheetSnapshotInvalidError(`sheetDataValidations ${key}: uid must match its key`)
    }
    if (parsed.logicalId !== logicalId) continue
    let changed = false
    const ranges = current.ranges.map((range) => {
      const next = insertIntoRange(range, insertAt, raw.count, true)
      if (next.startRow !== range.startRow || next.endRow !== range.endRow) changed = true
      return next
    })
    if (changed) {
      dataValidations.push([key, validateSheetDataValidationRule(logicalId, { ...current, ranges }, 0)])
    }
  }

  const commentAnchors: Array<[string, string]> = []
  for (const [key, value] of doc.getMap<string>(SHEET_COMMENT_ANCHORS_FIELD).entries()) {
    if (value === '') continue
    if (typeof value !== 'string') {
      throw new SheetSnapshotInvalidError(`sheetCommentAnchors ${key}: value must be a string`)
    }
    const current = parseCommentRange(value)
    if (!current) throw new SheetSnapshotInvalidError(`sheetCommentAnchors ${key}: invalid anchor`)
    if (current.logicalId !== logicalId) continue
    const range = insertIntoRange({
      startRow: current.row,
      startColumn: current.column,
      endRow: current.endRow,
      endColumn: current.endColumn,
    }, insertAt, raw.count, false)
    const next = encodeCommentRange({
      logicalId,
      row: range.startRow,
      column: range.startColumn,
      endRow: range.endRow,
      endColumn: range.endColumn,
    })
    if (next !== value) commentAnchors.push([key, next])
  }

  const protections: Array<[string, unknown]> = []
  for (const [key, value] of doc.getMap<unknown>(SHEET_PROTECTION_FIELD).entries()) {
    if (!key.startsWith(`${logicalId}!`)) continue
    const relocated = relocateProtection(key, value, insertAt, raw.count)
    if (relocated) protections.push([key, relocated])
  }

  return {
    logicalId,
    insertAt,
    count: raw.count,
    rowCount: sheetMeta.rowCount!,
    cells,
    dims,
    drawings,
    hyperlinks,
    merges,
    sheetMeta,
    freeze,
    filter,
    dataValidations,
    commentAnchors,
    protections,
  }
}

function applyMapBatch<T>(map: Y.Map<T>, batch: MapBatch<T>): void {
  for (const key of batch.toDelete) map.delete(key)
  for (const [key, value] of batch.toSet) map.set(key, value)
}

/** Apply a fully validated plan. Caller owns the surrounding Yjs transaction. */
export function applySheetRowInsertPlan(doc: Y.Doc, plan: SheetRowInsertPlan): void {
  applyMapBatch(doc.getMap<SheetCell>(SHEET_YMAP_FIELD), plan.cells)
  applyMapBatch(doc.getMap<number>(SHEET_DIMS_FIELD), plan.dims)
  applyMapBatch(doc.getMap<StoredDrawing>(SHEET_DRAWINGS_FIELD), plan.drawings)
  applyMapBatch(doc.getMap<StoredHyperLink>(SHEET_HYPERLINKS_FIELD), plan.hyperlinks)
  applyMapBatch(doc.getMap<true>(SHEET_MERGES_FIELD), plan.merges)
  doc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD).set(plan.logicalId, plan.sheetMeta)
  if (plan.freeze) doc.getMap<StoredFreeze>(SHEET_FREEZE_FIELD).set(plan.logicalId, plan.freeze)
  if (plan.filter) doc.getMap<StoredFilter>(SHEET_FILTERS_FIELD).set(plan.logicalId, plan.filter)
  for (const [key, value] of plan.dataValidations) {
    doc.getMap<StoredDataValidation>(SHEET_DATA_VALIDATIONS_FIELD).set(key, value)
  }
  for (const [key, value] of plan.commentAnchors) {
    doc.getMap<string>(SHEET_COMMENT_ANCHORS_FIELD).set(key, value)
  }
  for (const [key, value] of plan.protections) {
    doc.getMap<unknown>(SHEET_PROTECTION_FIELD).set(key, value)
  }
}

export function measureSheetAfterRowInsert(
  preEditState: Uint8Array,
  rowInsert: SheetRowInsert,
): { docBytes: number; payloadBytes: number; rowCount: number } {
  const scratch = new Y.Doc()
  Y.applyUpdate(scratch, preEditState)
  const plan = prepareSheetRowInsert(scratch, rowInsert)
  scratch.transact(() => applySheetRowInsertPlan(scratch, plan))
  return {
    docBytes: persistedByteLength(scratch),
    payloadBytes: measureSheetReadPayloadBytes(scratch),
    rowCount: plan.rowCount,
  }
}
