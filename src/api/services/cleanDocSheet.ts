import * as Y from 'yjs'
import {
  assertSheetWriteAllowed, ProtectedRangeError, SheetSnapshotInvalidError,
  SHEET_LEGACY_COLUMNS, SHEET_LEGACY_ROWS, SHEET_LIST_FIELD, SHEET_YMAP_FIELD,
  sheetLogicalIdsWithLegacyDefault, validateResourceLogicalId, validateSheetRange,
  validateSheetCellBatch, type SheetCell, type StoredSheetMeta, type StoredSheetRange,
} from '../../agent/sheetConversion.js'
import { readLiveSheet } from '../../collab/liveSheetWrite.js'
import { encodeBaseVersion, stateVectorsEqual } from '../../collab/docBodyEdit.js'
import { config } from '../../config/env.js'
import { editDocSheet, type EditDocSheetInput } from './editDocSheet.js'

export interface SheetCleaningOptions {
  logicalId: string
  range: StoredSheetRange
  mode: 'split' | 'deduplicate'
  delimiter?: string
  header?: boolean
  caseSensitive?: boolean
}

export type CleanDocSheetInput = SheetCleaningOptions & Pick<EditDocSheetInput,
  'uid' | 'docId' | 'documentName' | 'principalSpaceId' | 'clientBaseVersion' | 'authorizedEpoch' | 'isBot' | 'token'
> & { preview: boolean; overwrite: boolean; isAdmin: boolean }

export class SheetCleaningError extends Error {
  constructor(readonly code: string, readonly status = 422) { super(code) }
}

function cellText(cell: SheetCell | undefined): string {
  return String(cell?.v ?? '')
}

function hasContent(cell: SheetCell | undefined): boolean {
  return cell?.v != null && cell.v !== '' || Boolean(cell?.f || cell?.p)
}

export function planSheetCleaning(doc: Y.Doc, options: SheetCleaningOptions) {
  const logicalId = validateResourceLogicalId(options.logicalId, 'cleaning logicalId')
  const sourceRange = validateSheetRange(options.range, 'cleaning range')
  const list = doc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD)
  if (!sheetLogicalIdsWithLegacyDefault(list.keys()).has(logicalId)) throw new SheetCleaningError('sheet_not_found')
  const meta = list.get(logicalId)
  const rows = sourceRange.endRow - sourceRange.startRow + 1
  const sourceColumns = sourceRange.endColumn - sourceRange.startColumn + 1
  const maxCells = Math.min(20_000, config.sheetWrite.maxCells)
  if (rows * sourceColumns > maxCells) throw new SheetCleaningError('too_many_cells', 413)
  if (sourceRange.endRow >= (meta?.rowCount ?? SHEET_LEGACY_ROWS)) throw new SheetCleaningError('cleaning_range_out_of_bounds')
  const map = doc.getMap<SheetCell & { si?: string }>(SHEET_YMAP_FIELD)
  const source = Array.from({ length: rows }, (_, rowIndex) =>
    Array.from({ length: sourceColumns }, (_, columnIndex) => {
      const cell = map.get(`${logicalId}!${sourceRange.startRow + rowIndex}:${sourceRange.startColumn + columnIndex}`)
      if (cell?.f || cell?.si) throw new SheetCleaningError('cleaning_formula_unsupported')
      if (cell?.p !== undefined) throw new SheetCleaningError('cleaning_complex_sheet')
      return cell
    }),
  )
  let values: Array<Array<SheetCell | undefined>>
  let columns = sourceColumns
  let removedRows = 0
  if (options.mode === 'split') {
    if (sourceColumns !== 1) throw new SheetCleaningError('cleaning_single_column_required')
    if (!options.delimiter || options.delimiter.length > 16) throw new SheetCleaningError('cleaning_invalid_delimiter')
    const maxColumns = Math.floor(maxCells / rows)
    values = source.map(([cell]) => {
      if (cell === undefined) return []
      const parts = cellText(cell).split(options.delimiter!, maxColumns + 1)
      if (parts.length > maxColumns) throw new SheetCleaningError('too_many_cells', 413)
      return parts.map((value) => ({ v: value, t: 2 }))
    })
    columns = Math.max(...values.map((row) => row.length))
    if (columns < 2) throw new SheetCleaningError('cleaning_delimiter_not_found')
  } else {
    const seen = new Set<string>()
    values = []
    source.forEach((row, rowIndex) => {
      const key = JSON.stringify(row.map((cell) => {
        const value = cell?.v ?? null
        return typeof value === 'string' && !options.caseSensitive ? value.toLowerCase() : value
      }))
      if (options.header && rowIndex === 0 || !row.some(hasContent)) values.push(row)
      else if (seen.has(key)) removedRows++
      else {
        seen.add(key)
        values.push(row)
      }
    })
  }
  const range = { ...sourceRange, endColumn: sourceRange.startColumn + columns - 1 }
  if (range.endColumn >= (meta?.columnCount ?? SHEET_LEGACY_COLUMNS)) throw new SheetCleaningError('cleaning_range_out_of_bounds')
  if (doc.getMap('sheetFilters').has(logicalId)) throw new SheetCleaningError('cleaning_filtered_sheet')
  for (const field of ['sheetDrawings', 'sheetHyperLinks', 'sheetDataValidations']) {
    if (Array.from(doc.getMap(field).keys()).some((key) => key.startsWith(`${logicalId}!`))) throw new SheetCleaningError('cleaning_complex_sheet')
  }
  if (Array.from(doc.getMap('sheetCommentAnchors').values()).some((value) => typeof value === 'string' && value.startsWith(`${logicalId}!`))) {
    throw new SheetCleaningError('cleaning_complex_sheet')
  }
  for (const key of doc.getMap('sheetMerges').keys()) {
    if (!key.startsWith(`${logicalId}:`)) continue
    const [, startRow, startColumn, endRow, endColumn] = key.split(':').map(Number)
    if ([startRow, startColumn, endRow, endColumn].some((value) => !Number.isSafeInteger(value))) throw new SheetCleaningError('cleaning_complex_sheet')
    if (startRow! <= range.endRow && endRow! >= range.startRow && startColumn! <= range.endColumn && endColumn! >= range.startColumn) {
      throw new SheetCleaningError('cleaning_merged_range')
    }
  }
  const cells: Record<string, SheetCell> = Object.create(null)
  let overwrittenCells = 0
  let payloadBytes = 0
  for (let rowIndex = 0; rowIndex < rows; rowIndex++) {
    for (let columnIndex = 0; columnIndex < columns; columnIndex++) {
      const key = `${logicalId}!${range.startRow + rowIndex}:${range.startColumn + columnIndex}`
      const previous = map.get(key)
      const value = values[rowIndex]?.[columnIndex]
      if (options.mode === 'split' && value === undefined && previous === undefined) continue
      const cell: SheetCell = { v: value?.v ?? null }
      if (value?.t !== undefined) cell.t = value.t
      if (previous?.s) cell.s = { ...previous.s }
      if (options.mode === 'split') {
        if (value !== undefined) {
          cell.t = 2
          cell.s = { ...cell.s, n: { ...(cell.s?.n as Record<string, unknown> | undefined), pattern: '@' } }
        }
        if (columnIndex > 0 && hasContent(previous)) overwrittenCells++
      }
      const bytes = Buffer.byteLength(JSON.stringify(cell))
      if (bytes > config.sheetWrite.maxCellContentBytes) throw new SheetCleaningError('cell_too_large', 413)
      payloadBytes += bytes + Buffer.byteLength(key) + 4
      if (payloadBytes > config.sheetRead.maxCellBytes) throw new SheetCleaningError('sheet_too_large', 413)
      cells[key] = cell
    }
  }
  validateSheetCellBatch(cells)
  return { cells, range, rows, columns, removedRows, overwrittenCells }
}

export async function cleanDocSheet(input: CleanDocSheetInput) {
  const { state, baseSV } = await readLiveSheet(input.documentName)
  if (!stateVectorsEqual(input.clientBaseVersion, baseSV)) return { ok: false as const, status: 412, error: 'base_version_stale' }
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, state)
    const { cells, ...summary } = planSheetCleaning(doc, input)
    assertSheetWriteAllowed(doc, cells, input.uid, input.isAdmin)
    if (input.preview) return { ok: true as const, preview: true, baseVersion: encodeBaseVersion(baseSV), cells, ...summary }
    if (summary.overwrittenCells > 0 && !input.overwrite) return { ok: false as const, status: 409, error: 'cleaning_overwrite_required' }
    const result = await editDocSheet({
      uid: input.uid, docId: input.docId, documentName: input.documentName,
      principalSpaceId: input.principalSpaceId, clientBaseVersion: input.clientBaseVersion,
      authorizedEpoch: input.authorizedEpoch, isBot: input.isBot, token: input.token,
      cells, dims: {}, drawings: {}, hyperlinks: {}, merges: {}, sheets: {},
    })
    return result.ok ? { ...result, preview: false, ...summary } : result
  } catch (error) {
    if (error instanceof SheetCleaningError) return { ok: false as const, status: error.status, error: error.code }
    if (error instanceof ProtectedRangeError) return { ok: false as const, status: 403, error: 'protected_range' }
    if (error instanceof SheetSnapshotInvalidError) return { ok: false as const, status: 422, error: 'sheet_cell_invalid' }
    throw error
  } finally {
    doc.destroy()
  }
}
