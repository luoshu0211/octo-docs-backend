import * as Y from 'yjs'
import {
  SHEET_YMAP_FIELD, SHEET_DIMS_FIELD, SHEET_HYPERLINKS_FIELD, SHEET_MERGES_FIELD,
  SHEET_LIST_FIELD, SHEET_FREEZE_FIELD, SHEET_FILTERS_FIELD, SHEET_DATA_VALIDATIONS_FIELD,
  SHEET_LEGACY_ROWS, SHEET_LEGACY_COLUMNS,
  validateSheetCells, validateSheetDims, validateSheetHyperLinks, validateSheetMerges,
  validateSheetList, validateSheetFreezes, validateSheetFilters, validateSheetDataValidationResources,
  sheetLogicalIdsWithLegacyDefault, type StoredSheetMeta,
} from '../../agent/sheetConversion.js'
import {
  SHEET_CONDITIONAL_FORMATS_FIELD, validateConditionalFormat,
} from '../../agent/sheetConditionalFormatting.js'
import {
  decodeSheetCursor, sheetVersionFingerprint, InvalidSheetCursorError,
  type CompactSheetCursor, type SheetCursor,
} from './sheetPagination.js'

export class SheetReadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly candidates?: Array<{ sheetId: string; name: string }>,
  ) {
    super(code)
  }
}

export interface SheetSelection {
  sheetId?: string
  sheetName?: string
}

export function parseSheetSelection(sheetId: unknown, sheetName: unknown): SheetSelection {
  if (sheetId !== undefined && sheetName !== undefined) {
    throw new SheetReadError(400, 'invalid_sheet_selector')
  }
  if (sheetId !== undefined && (
    typeof sheetId !== 'string' || !/^[^\p{Cc}:!]{1,64}$/u.test(sheetId) ||
    ['__proto__', 'constructor', 'prototype'].includes(sheetId)
  )) {
    throw new SheetReadError(400, 'invalid_sheet_selector')
  }
  if (sheetName !== undefined && (typeof sheetName !== 'string' || sheetName.trim() === '')) {
    throw new SheetReadError(400, 'invalid_sheet_selector')
  }
  return { sheetId: sheetId as string | undefined, sheetName: sheetName as string | undefined }
}

export function parseSheetReadCursor(raw: unknown): SheetCursor | null {
  if (raw === undefined || raw === '') return null
  if (typeof raw !== 'string') throw new InvalidSheetCursorError('expected one cursor')
  return decodeSheetCursor(raw)
}

export class SheetReadSnapshot {
  private readonly doc = new Y.Doc()
  readonly sheets: Record<string, StoredSheetMeta>

  constructor(state: Uint8Array) {
    try {
      Y.applyUpdate(this.doc, state)
      this.sheets = validateSheetList(this.raw(SHEET_LIST_FIELD))
    } catch (error) {
      this.doc.destroy()
      throw error
    }
  }

  destroy(): void {
    this.doc.destroy()
  }

  private raw(field: string, include: (key: string) => boolean = () => true): Record<string, unknown> {
    const result: Record<string, unknown> = Object.create(null)
    for (const [key, value] of this.doc.getMap(field)) {
      if (include(key)) result[key] = value
    }
    return result
  }

  directory(): Array<{ sheetId: string; name: string; order: number; rowCount: number; columnCount: number }> {
    const sheets = Object.keys(this.sheets).length === 0
      ? { default: { name: 'Sheet1', order: 0 } }
      : this.sheets
    return Object.entries(sheets).map(([sheetId, meta]) => ({
      sheetId, name: meta.name, order: meta.order,
      rowCount: meta.rowCount ?? SHEET_LEGACY_ROWS,
      columnCount: meta.columnCount ?? SHEET_LEGACY_COLUMNS,
    })).sort((left, right) => left.order - right.order ||
      (left.sheetId < right.sheetId ? -1 : left.sheetId > right.sheetId ? 1 : 0))
  }

  resolveSelection(selection: SheetSelection, cursor: SheetCursor | null, docId: string, baseVersion: string): {
    sheetId: string | null
    cursorTemplate: Omit<CompactSheetCursor, 'k'>
  } {
    const fingerprint = sheetVersionFingerprint(baseVersion)
    if (cursor) {
      if (cursor.t === 2 && cursor.d !== docId) throw new InvalidSheetCursorError('different document')
      if (cursor.v !== (cursor.t === 2 ? fingerprint : baseVersion)) {
        throw new SheetReadError(409, 'sheet_changed')
      }
    }
    let sheetId = selection.sheetId ?? null
    const items = this.directory()
    if (selection.sheetName !== undefined) {
      const candidates = items.filter((item) => item.name === selection.sheetName)
      if (candidates.length === 0) throw new SheetReadError(404, 'sheet_not_found')
      if (candidates.length > 1) {
        throw new SheetReadError(409, 'ambiguous_sheet_name', candidates.map(({ sheetId: id, name }) => ({ sheetId: id, name })))
      }
      sheetId = candidates[0]!.sheetId
    }
    if (cursor?.t === 2) {
      if (selection.sheetId === undefined && selection.sheetName === undefined) sheetId = cursor.s
      if (sheetId !== cursor.s) throw new InvalidSheetCursorError('different worksheet')
    } else if (cursor && sheetId !== null) {
      throw new InvalidSheetCursorError('legacy cursor has no worksheet scope')
    }
    if (sheetId !== null && !items.some((item) => item.sheetId === sheetId)) {
      throw new SheetReadError(404, 'sheet_not_found')
    }
    return { sheetId, cursorTemplate: { t: 2, v: fingerprint, d: docId, s: sheetId } }
  }

  read(sheetId: string | null) {
    const qualified = (separator: string) => (key: string) => sheetId === null || key.startsWith(`${sheetId}${separator}`)
    const exact = (key: string) => sheetId === null || key === sheetId
    const dims = (key: string) => sheetId === null || key.startsWith(`${sheetId}:`) ||
      (sheetId === 'default' && /^[cr]\d+$/.test(key))
    const sheetList = sheetId === null ? this.sheets : {
      [sheetId]: this.sheets[sheetId] ?? {
        name: 'Sheet1', order: 0, rowCount: SHEET_LEGACY_ROWS, columnCount: SHEET_LEGACY_COLUMNS,
      },
    }
    const conditionalFormats = this.raw(SHEET_CONDITIONAL_FORMATS_FIELD, qualified('!'))
    const sheetConditionalFormats = Object.fromEntries(Object.entries(conditionalFormats)
      .map(([key, value]) => [key, validateConditionalFormat(key, value)]))
    return {
      sheetCells: validateSheetCells(this.raw(SHEET_YMAP_FIELD, qualified('!'))),
      sheetDims: validateSheetDims(this.raw(SHEET_DIMS_FIELD, dims)),
      sheetHyperLinks: validateSheetHyperLinks(this.raw(SHEET_HYPERLINKS_FIELD, qualified('!'))),
      sheetMerges: validateSheetMerges(this.raw(SHEET_MERGES_FIELD, qualified(':'))),
      sheetList,
      sheetFreeze: validateSheetFreezes(this.raw(SHEET_FREEZE_FIELD, exact)),
      sheetFilters: validateSheetFilters(this.raw(SHEET_FILTERS_FIELD, exact)),
      sheetDataValidations: validateSheetDataValidationResources(
        this.raw(SHEET_DATA_VALIDATIONS_FIELD, qualified('!')),
        sheetLogicalIdsWithLegacyDefault(Object.keys(sheetList)),
      ),
      sheetConditionalFormats,
    }
  }
}
