import { isDeepStrictEqual } from 'node:util'
import {
  SheetSnapshotInvalidError,
  type SheetCell,
  type StoredSheetRange,
  validateSheetCellBatch,
} from '../../agent/sheetConversion.js'
import { readLiveSheet } from '../../collab/liveSheetWrite.js'
import { decodeSheetSnapshot } from '../../collab/versionRestore.js'
import { encodeBaseVersion, stateVectorsEqual } from '../../collab/docBodyEdit.js'
import { config } from '../../config/env.js'
import { editDocSheet, type EditDocSheetResult } from './editDocSheet.js'

export type SheetFindBy = 'value' | 'formula'

export interface BuildSheetReplacementBatchInput {
  cells: Record<string, SheetCell>
  findString: string
  replaceString: string
  findBy: SheetFindBy
  caseSensitive: boolean
  matchesTheWholeCell: boolean
  logicalId?: string
  range?: StoredSheetRange
}

export interface SheetReplacementBatch {
  cells: Record<string, SheetCell>
  matchedCells: number
  replacedCells: number
  replacements: number
}

export interface ReplaceDocSheetInput extends Omit<BuildSheetReplacementBatchInput, 'cells'> {
  uid: string
  docId: string
  documentName: string
  principalSpaceId: string
  clientBaseVersion: Uint8Array
  authorizedEpoch: number
  isBot?: boolean
  token?: string
}

export type ReplaceDocSheetResult =
  | ({
      ok: true
      matchedCells: number
      replacedCells: number
      replacements: number
    } & (
      | { baseVersion: string }
      | Pick<Extract<EditDocSheetResult, { ok: true }>, 'bytes' | 'baseVersion' | 'newDocVersionSeq'>
    ))
  | Extract<EditDocSheetResult, { ok: false }>

export class SheetReplacementLimitError extends Error {
  constructor(readonly code: 'too_many_cells' | 'cell_too_large') {
    super(code)
    this.name = 'SheetReplacementLimitError'
  }
}

interface LiteralReplacement {
  value: string
  count: number
}

interface LiteralMatch {
  index: number
  length: number
  bytes: number
}

// Rich-text metadata adjustment is still proportional to matches x metadata.
// Bound that work before entering the mutation loop so one writer cannot block
// the shared Node.js event loop with an otherwise-valid replacement request.
const MAX_RICH_TEXT_REPLACEMENT_WORK = 10_000_000

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function literalMatches(source: string, findString: string, caseSensitive: boolean): LiteralMatch[] {
  const expression = new RegExp(escapeRegExp(findString), caseSensitive ? 'g' : 'gi')
  return Array.from(source.matchAll(expression), (match) => ({
    index: match.index,
    length: match[0].length,
    bytes: Buffer.byteLength(match[0]),
  }))
}

function replacementOutputBytes(source: string, matches: LiteralMatch[], replaceString: string): number {
  const matchedBytes = matches.reduce((sum, match) => sum + match.bytes, 0)
  return Buffer.byteLength(source) - matchedBytes + matches.length * Buffer.byteLength(replaceString)
}

function rebuildWithLiteralMatches(source: string, matches: LiteralMatch[], replaceString: string): string {
  const parts: string[] = []
  let cursor = 0
  for (const match of matches) {
    parts.push(source.slice(cursor, match.index), replaceString)
    cursor = match.index + match.length
  }
  parts.push(source.slice(cursor))
  return parts.join('')
}

/** Replace a literal globally. The function replacer keeps `$&`, `$1`, and `$$` literal. */
function replaceLiteral(
  source: string,
  findString: string,
  replaceString: string,
  caseSensitive: boolean,
): LiteralReplacement {
  const matches = literalMatches(source, findString, caseSensitive)
  if (matches.length === 0) return { value: source, count: 0 }
  const outputBytes = replacementOutputBytes(source, matches, replaceString)
  if (outputBytes > config.sheetWrite.maxCellContentBytes) {
    throw new SheetReplacementLimitError('cell_too_large')
  }
  return {
    value: rebuildWithLiteralMatches(source, matches, replaceString),
    count: matches.length,
  }
}

function richTextDataStream(cell: SheetCell): string | undefined {
  const body = cell.p?.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const dataStream = (body as Record<string, unknown>).dataStream
  return typeof dataStream === 'string' ? dataStream : undefined
}

type RichTextRecord = Record<string, unknown>

function richTextRecords(body: RichTextRecord, key: string): RichTextRecord[] | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new SheetSnapshotInvalidError(`rich-text ${key} must be an object array`)
  }
  return value as RichTextRecord[]
}

function richTextIndex(record: RichTextRecord, key: string, label: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new SheetSnapshotInvalidError(`rich-text ${label}.${key} must be an integer`)
  }
  return value
}

function rootRangeId(value: unknown): unknown {
  return typeof value === 'string' ? value.split('$')[0] : value
}

function normalizeTextRuns(runs: RichTextRecord[]): RichTextRecord[] {
  const normalized: RichTextRecord[] = []
  for (const run of runs.sort((left, right) => Number(left.st) - Number(right.st))) {
    const st = richTextIndex(run, 'st', 'textRuns')
    const ed = richTextIndex(run, 'ed', 'textRuns')
    if (st >= ed) continue
    const hasStyle = run.sId !== undefined ||
      (run.ts !== undefined && (!isDeepStrictEqual(run.ts, {}) || run.ts === null))
    if (!hasStyle) continue
    const previous = normalized.at(-1)
    if (
      previous &&
      richTextIndex(previous, 'ed', 'textRuns') >= st &&
      previous.sId === run.sId &&
      isDeepStrictEqual(previous.ts, run.ts)
    ) {
      previous.ed = ed
    } else {
      normalized.push(run)
    }
  }
  return normalized
}

function normalizeCustomRanges(ranges: RichTextRecord[]): RichTextRecord[] {
  ranges.sort((left, right) => Number(left.startIndex) - Number(right.startIndex))
  const merged: RichTextRecord[] = []
  for (const range of ranges) {
    const startIndex = richTextIndex(range, 'startIndex', 'customRanges')
    const endIndex = richTextIndex(range, 'endIndex', 'customRanges')
    const rangeId = rootRangeId(range.rangeId)
    const previous = merged.at(-1)
    if (
      previous &&
      rootRangeId(previous.rangeId) === rangeId &&
      richTextIndex(previous, 'endIndex', 'customRanges') + 1 >= startIndex &&
      isDeepStrictEqual(previous.properties, range.properties)
    ) {
      previous.endIndex = endIndex
      continue
    }
    merged.push({ ...range, rangeId })
  }

  const idCounts = new Map<unknown, number>()
  for (const range of merged) {
    const id = range.rangeId
    const count = idCounts.get(id) ?? 0
    if (count > 0 && typeof id === 'string') range.rangeId = `${id}$${count}`
    idCounts.set(id, count + 1)
  }
  return merged
}

function normalizeCustomDecorations(ranges: RichTextRecord[]): RichTextRecord[] {
  ranges.sort((left, right) => Number(left.startIndex) - Number(right.startIndex))
  const merged: RichTextRecord[] = []
  for (const range of ranges) {
    const startIndex = richTextIndex(range, 'startIndex', 'customDecorations')
    const endIndex = richTextIndex(range, 'endIndex', 'customDecorations')
    const previous = merged.at(-1)
    if (
      previous &&
      previous.id === range.id &&
      richTextIndex(previous, 'endIndex', 'customDecorations') + 1 >= startIndex
    ) {
      previous.endIndex = endIndex
    } else {
      merged.push(range)
    }
  }
  return merged
}

function insertRichText(body: RichTextRecord, index: number, target: string, sourceEnd: number): void {
  if (target.length === 0) return
  const textRuns = richTextRecords(body, 'textRuns')
  const sourceTextRun = textRuns?.find((run) => {
    const st = richTextIndex(run, 'st', 'textRuns')
    const ed = richTextIndex(run, 'ed', 'textRuns')
    return st < sourceEnd && ed > index
  })
  if (textRuns) {
    const shifted: RichTextRecord[] = []
    for (const run of textRuns) {
      const st = richTextIndex(run, 'st', 'textRuns')
      const ed = richTextIndex(run, 'ed', 'textRuns')
      if (ed <= index) {
        shifted.push(run)
      } else if (st < index && index < ed) {
        shifted.push({ ...run, ed: index })
        shifted.push({ ...run, st: index + target.length, ed: ed + target.length })
      } else {
        shifted.push({ ...run, st: st + target.length, ed: ed + target.length })
      }
    }
    if (sourceTextRun) {
      shifted.push({ ...sourceTextRun, st: index, ed: index + target.length })
    }
    body.textRuns = normalizeTextRuns(shifted)
  }

  for (const key of ['paragraphs', 'sectionBreaks', 'customBlocks']) {
    const records = richTextRecords(body, key)
    if (!records) continue
    for (const record of records) {
      const startIndex = richTextIndex(record, 'startIndex', key)
      if (startIndex >= index) record.startIndex = startIndex + target.length
    }
  }

  const tables = richTextRecords(body, 'tables')
  if (tables) {
    for (const table of tables) {
      const startIndex = richTextIndex(table, 'startIndex', 'tables')
      const endIndex = richTextIndex(table, 'endIndex', 'tables')
      if (startIndex > index) {
        table.startIndex = startIndex + target.length
        table.endIndex = endIndex + target.length
      } else if (endIndex > index) {
        table.endIndex = endIndex + target.length
      }
    }
  }

  const blockRanges = richTextRecords(body, 'blockRanges')
  if (blockRanges) {
    for (const range of blockRanges) {
      const startIndex = richTextIndex(range, 'startIndex', 'blockRanges')
      const endIndex = richTextIndex(range, 'endIndex', 'blockRanges')
      if (startIndex >= index) {
        range.startIndex = startIndex + target.length
        range.endIndex = endIndex + target.length
      } else if (endIndex >= index) {
        range.endIndex = endIndex + target.length
      }
    }
  }

  const customRanges = richTextRecords(body, 'customRanges')
  if (customRanges) {
    const sourceRange = customRanges.find((range) => {
      const startIndex = richTextIndex(range, 'startIndex', 'customRanges')
      const endIndex = richTextIndex(range, 'endIndex', 'customRanges')
      return Math.max(startIndex, index) <= Math.min(endIndex, sourceEnd - 1)
    })
    const crossingIndex = customRanges.findIndex((range) => {
      const startIndex = richTextIndex(range, 'startIndex', 'customRanges')
      const endIndex = richTextIndex(range, 'endIndex', 'customRanges')
      return startIndex < index && endIndex >= index
    })
    const split = customRanges.flatMap((range, rangeIndex) => {
      const endIndex = richTextIndex(range, 'endIndex', 'customRanges')
      if (rangeIndex !== crossingIndex) return [range]
      const properties = range.properties && typeof range.properties === 'object' && !Array.isArray(range.properties)
        ? { ...range.properties }
        : {}
      return [
        { ...range, endIndex: index - 1, properties },
        { ...range, startIndex: index, endIndex, properties },
      ]
    })
    const shifted = split.map((range) => {
      const startIndex = richTextIndex(range, 'startIndex', 'customRanges')
      const endIndex = richTextIndex(range, 'endIndex', 'customRanges')
      if (startIndex >= index) {
        return { ...range, startIndex: startIndex + target.length, endIndex: endIndex + target.length }
      }
      return range
    })
    if (sourceRange) {
      shifted.push({ ...sourceRange, startIndex: index, endIndex: index + target.length - 1 })
    }
    body.customRanges = normalizeCustomRanges(shifted)
  }

  const customDecorations = richTextRecords(body, 'customDecorations')
  if (customDecorations) {
    const shifted: RichTextRecord[] = []
    for (const decoration of customDecorations) {
      const startIndex = richTextIndex(decoration, 'startIndex', 'customDecorations')
      const endIndex = richTextIndex(decoration, 'endIndex', 'customDecorations')
      if (startIndex < index && endIndex >= index) {
        shifted.push({ ...decoration, endIndex: index - 1 })
        shifted.push({ ...decoration, startIndex: index + target.length, endIndex: endIndex + target.length })
      } else if (startIndex >= index) {
        shifted.push({ ...decoration, startIndex: startIndex + target.length, endIndex: endIndex + target.length })
      } else {
        shifted.push(decoration)
      }
    }
    body.customDecorations = normalizeCustomDecorations(shifted)
  }
}

function subtractInclusiveRange(
  record: RichTextRecord,
  startIndex: number,
  endIndex: number,
  textLength: number,
): RichTextRecord | null {
  const st = richTextIndex(record, 'startIndex', 'range')
  const ed = richTextIndex(record, 'endIndex', 'range')
  if (st >= startIndex && ed <= endIndex) return null
  if (Math.max(startIndex, st) <= Math.min(endIndex, ed)) {
    if (st < startIndex && ed > endIndex) return { ...record, endIndex: ed - textLength }
    if (startIndex <= st) return { ...record, startIndex: startIndex, endIndex: ed - textLength }
    return { ...record, endIndex: startIndex - 1 }
  }
  if (endIndex < st) {
    return { ...record, startIndex: st - textLength, endIndex: ed - textLength }
  }
  return record
}

function deleteRichText(body: RichTextRecord, index: number, textLength: number): void {
  if (textLength === 0) return
  const endExclusive = index + textLength
  const endInclusive = endExclusive - 1
  const textRuns = richTextRecords(body, 'textRuns')
  if (textRuns) {
    const kept: RichTextRecord[] = []
    for (const run of textRuns) {
      const st = richTextIndex(run, 'st', 'textRuns')
      const ed = richTextIndex(run, 'ed', 'textRuns')
      if (index <= st && endExclusive >= ed) continue
      if (st <= index && ed >= endExclusive) {
        kept.push({ ...run, ed: ed - textLength })
      } else if (index >= st && index < ed) {
        kept.push({ ...run, ed: index })
      } else if (endExclusive > st && endExclusive <= ed) {
        kept.push({ ...run, st: index, ed: ed - textLength })
      } else if (st >= endExclusive) {
        kept.push({ ...run, st: st - textLength, ed: ed - textLength })
      } else {
        kept.push(run)
      }
    }
    body.textRuns = kept
  }

  const paragraphs = richTextRecords(body, 'paragraphs')
  if (paragraphs) {
    body.paragraphs = paragraphs.flatMap((paragraph) => {
      const startIndex = richTextIndex(paragraph, 'startIndex', 'paragraphs')
      if (startIndex >= index && startIndex < endExclusive) return []
      return [{ ...paragraph, startIndex: startIndex >= endExclusive ? startIndex - textLength : startIndex }]
    })
  }
  for (const key of ['sectionBreaks', 'customBlocks']) {
    const records = richTextRecords(body, key)
    if (!records) continue
    body[key] = records.flatMap((record) => {
      const startIndex = richTextIndex(record, 'startIndex', key)
      if (startIndex >= index && startIndex <= endInclusive) return []
      return [{ ...record, startIndex: startIndex > endInclusive ? startIndex - textLength : startIndex }]
    })
  }

  for (const key of ['tables', 'blockRanges', 'customRanges', 'customDecorations']) {
    const records = richTextRecords(body, key)
    if (!records) continue
    const adjusted = records.flatMap((record) => {
      const next = subtractInclusiveRange(record, index, endInclusive, textLength)
      return next ? [next] : []
    })
    body[key] = key === 'customRanges'
      ? normalizeCustomRanges(adjusted)
      : key === 'customDecorations'
        ? normalizeCustomDecorations(adjusted)
        : adjusted
  }
}

function richTextMetadataWork(body: RichTextRecord, matchCount: number, sourceLength: number): number {
  const fixedKeys = ['paragraphs', 'sectionBreaks', 'customBlocks', 'tables', 'blockRanges']
  const expandingKeys = ['textRuns', 'customRanges', 'customDecorations']
  let fixedRecords = 0
  let expandingRecords = 0
  for (const key of fixedKeys) fixedRecords += richTextRecords(body, key)?.length ?? 0
  for (const key of expandingKeys) expandingRecords += richTextRecords(body, key)?.length ?? 0
  const possibleExpandedRecords = expandingRecords === 0
    ? 0
    : expandingRecords + matchCount * expandingKeys.length
  return sourceLength + matchCount * Math.max(1, fixedRecords + possibleExpandedRecords)
}

/**
 * Mirrors Univer 0.25.1 rich-text metadata semantics while resolving matches
 * against the original stream and rebuilding the text once. Matching with a
 * RegExp keeps indices in the original UTF-16 stream even when case folding
 * changes string length (for example U+0130 LATIN CAPITAL LETTER I WITH DOT).
 */
function replaceInRichTextBody(
  body: RichTextRecord,
  findString: string,
  replaceString: string,
  caseSensitive: boolean,
): number {
  const source = String(body.dataStream)
  const matches = literalMatches(source, findString, caseSensitive)
  if (matches.length === 0) return 0

  if (replacementOutputBytes(source, matches, replaceString) > config.sheetWrite.maxCellContentBytes) {
    throw new SheetReplacementLimitError('cell_too_large')
  }
  if (richTextMetadataWork(body, matches.length, source.length) > MAX_RICH_TEXT_REPLACEMENT_WORK) {
    throw new SheetReplacementLimitError('cell_too_large')
  }

  // Work backwards so every original match index remains valid while metadata
  // after the match is shifted. The data stream itself is rebuilt once below.
  for (let matchIndex = matches.length - 1; matchIndex >= 0; matchIndex -= 1) {
    const match = matches[matchIndex]!
    const sourceEnd = match.index + match.length
    insertRichText(body, match.index, replaceString, sourceEnd)
    deleteRichText(body, match.index + replaceString.length, match.length)
  }
  body.dataStream = rebuildWithLiteralMatches(source, matches, replaceString)
  return matches.length
}

/** Same value coercion used by Univer 0.25.1's sheets find/replace provider. */
function searchableValue(cell: SheetCell): string | undefined {
  const richText = richTextDataStream(cell)
  if (richText !== undefined) return richText
  if (typeof cell.v === 'number') return String(cell.v)
  if (typeof cell.v === 'boolean') return cell.v ? '1' : '0'
  return typeof cell.v === 'string' ? cell.v : undefined
}

function cellIsInScope(key: string, logicalId?: string, range?: StoredSheetRange): boolean {
  const match = /^([^!]+)!([0-9]+):([0-9]+)$/.exec(key)
  if (!match) return false
  if (logicalId !== undefined && match[1] !== logicalId) return false
  if (!range) return true
  const row = Number(match[2])
  const column = Number(match[3])
  return row >= range.startRow && row <= range.endRow &&
    column >= range.startColumn && column <= range.endColumn
}

function cellMatches(value: string | undefined, input: BuildSheetReplacementBatchInput): boolean {
  if (!value) return false
  if (input.matchesTheWholeCell) {
    // Univer trims spaces (but not line breaks) from the cell for whole-cell matching.
    const comparable = value.replace(/^ +/g, '').replace(/ +$/g, '')
    const expression = new RegExp(`^(?:${escapeRegExp(input.findString)})$`, input.caseSensitive ? '' : 'i')
    return expression.test(comparable)
  }
  return literalMatches(value, input.findString, input.caseSensitive).length > 0
}

function replacedCell(
  cell: SheetCell,
  input: BuildSheetReplacementBatchInput,
): { cell: SheetCell; replacements: number } | null {
  const isFormula = Boolean(cell.f)
  if (isFormula) {
    if (input.findBy !== 'formula') return null
    const replaced = replaceLiteral(cell.f!, input.findString, input.replaceString, input.caseSensitive)
    return replaced.count === 0 ? null : {
      cell: { ...structuredClone(cell), f: replaced.value, v: null },
      replacements: replaced.count,
    }
  }

  const richText = richTextDataStream(cell)
  if (richText !== undefined) {
    const next = structuredClone(cell)
    const body = next.p!.body as Record<string, unknown>
    const replacements = replaceInRichTextBody(body, input.findString, input.replaceString, input.caseSensitive)
    return replacements === 0 ? null : { cell: next, replacements }
  }

  if (cell.v === undefined || cell.v === null) return null
  const replaced = replaceLiteral(searchableValue(cell)!, input.findString, input.replaceString, input.caseSensitive)
  return replaced.count === 0 ? null : {
    cell: { ...structuredClone(cell), v: replaced.value },
    replacements: replaced.count,
  }
}

/** Build the complete atomic cell batch without mutating the decoded snapshot. */
export function buildSheetReplacementBatch(input: BuildSheetReplacementBatchInput): SheetReplacementBatch {
  const normalizedInput = { ...input, findString: input.findString.trim() }
  if (normalizedInput.findString === '') {
    throw new SheetSnapshotInvalidError('replace findString must not be empty')
  }
  const cells: Record<string, SheetCell> = Object.create(null)
  let matchedCells = 0
  let replacedCells = 0
  let replacements = 0

  for (const [key, cell] of Object.entries(input.cells)) {
    if (!cellIsInScope(key, normalizedInput.logicalId, normalizedInput.range)) continue
    const candidate = normalizedInput.findBy === 'formula' && cell.f
      ? cell.f
      : searchableValue(cell)
    if (!cellMatches(candidate, normalizedInput)) continue
    matchedCells += 1

    const replaced = replacedCell(cell, normalizedInput)
    if (!replaced) continue
    if (Buffer.byteLength(JSON.stringify(replaced.cell)) > config.sheetWrite.maxCellContentBytes) {
      throw new SheetReplacementLimitError('cell_too_large')
    }
    cells[key] = replaced.cell
    replacedCells += 1
    replacements += replaced.replacements
    if (replacedCells > config.sheetWrite.maxCells) {
      throw new SheetReplacementLimitError('too_many_cells')
    }
  }

  validateSheetCellBatch(cells)
  return { cells, matchedCells, replacedCells, replacements }
}

export async function replaceDocSheet(input: ReplaceDocSheetInput): Promise<ReplaceDocSheetResult> {
  const { state, baseSV } = await readLiveSheet(input.documentName)
  if (!stateVectorsEqual(input.clientBaseVersion, baseSV)) {
    return { ok: false, status: 412, error: 'base_version_stale' }
  }

  const cells = decodeSheetSnapshot(state) as Record<string, SheetCell>
  let batch: SheetReplacementBatch
  try {
    batch = buildSheetReplacementBatch({
      cells,
      findString: input.findString,
      replaceString: input.replaceString,
      findBy: input.findBy,
      caseSensitive: input.caseSensitive,
      matchesTheWholeCell: input.matchesTheWholeCell,
      logicalId: input.logicalId,
      range: input.range,
    })
  } catch (err) {
    if (err instanceof SheetReplacementLimitError) {
      return { ok: false, status: 413, error: err.code }
    }
    if (err instanceof SheetSnapshotInvalidError) {
      return { ok: false, status: 422, error: 'sheet_cell_invalid' }
    }
    throw err
  }

  if (batch.replacedCells === 0) {
    return {
      ok: true,
      matchedCells: batch.matchedCells,
      replacedCells: 0,
      replacements: 0,
      baseVersion: encodeBaseVersion(baseSV),
    }
  }

  const edited = await editDocSheet({
    uid: input.uid,
    docId: input.docId,
    documentName: input.documentName,
    principalSpaceId: input.principalSpaceId,
    clientBaseVersion: input.clientBaseVersion,
    cells: batch.cells,
    dims: {},
    drawings: {},
    hyperlinks: {},
    merges: {},
    sheets: {},
    freeze: {},
    filters: {},
    dataValidations: {},
    authorizedEpoch: input.authorizedEpoch,
    isBot: input.isBot,
    token: input.token,
  })
  if (!edited.ok) return edited
  return {
    ok: true,
    matchedCells: batch.matchedCells,
    replacedCells: batch.replacedCells,
    replacements: batch.replacements,
    bytes: edited.bytes,
    baseVersion: edited.baseVersion,
    newDocVersionSeq: edited.newDocVersionSeq,
  }
}
