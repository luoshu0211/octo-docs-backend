import * as Y from 'yjs'
import { SHEET_MAX_CELLS, SHEET_MAX_COLUMNS, SHEET_MAX_ROWS, SheetSnapshotInvalidError, validateResourceLogicalId } from './sheetConversion.js'

export const SHEET_CONDITIONAL_FORMATS_FIELD = 'sheetConditionalFormats'
export type ConditionalFormatChanges = Record<string, Record<string, unknown> | null>

function validateKey(key: string): string {
  const parts = key.split('!')
  if (parts.length !== 2 || !parts[1] || parts[1].length > 128 || Array.from(key).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new SheetSnapshotInvalidError('invalid conditional formatting key')
  }
  return validateResourceLogicalId(parts[0], 'conditional formatting logicalId')
}

function isConditionalFormatThreshold(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const threshold = value as Record<string, unknown>
  return ['min', 'max', 'num', 'percent', 'percentile', 'formula'].includes(String(threshold.type)) &&
    (threshold.value === undefined || typeof threshold.value === 'string' || Number.isFinite(threshold.value))
}

export function validateConditionalFormat(key: string, value: unknown, logicalIds?: Set<string>): Record<string, unknown> {
  const invalid = (): never => { throw new SheetSnapshotInvalidError('invalid conditional formatting rule') }
  const logicalId = validateKey(key)
  if (logicalIds && !logicalIds.has(logicalId)) throw new SheetSnapshotInvalidError('conditional formatting sheet does not exist')
  const parts = key.split('!')
  if (parts.length !== 2 || !parts[0] || !parts[1] || parts[1].length > 128 || ['__proto__', 'constructor', 'prototype'].includes(parts[0])) invalid()
  const text = JSON.stringify(value)
  if (!text || Buffer.byteLength(text) > 65_536) invalid()
  const stored = JSON.parse(text) as Record<string, unknown>
  if (!stored || typeof stored !== 'object' || !Number.isFinite(stored.priority)) invalid()
  const rule = stored.rule as Record<string, unknown> | undefined
  if (!rule || rule.cfId !== parts[1] || typeof rule.stopIfTrue !== 'boolean' || !Array.isArray(rule.ranges) || !rule.ranges.length || rule.ranges.length > 512) invalid()
  for (const range of rule!.ranges as Array<{ startRow: number; endRow: number; startColumn: number; endColumn: number }>) {
    if (!range || ![range.startRow, range.endRow, range.startColumn, range.endColumn].every(Number.isSafeInteger) ||
      range.startRow < 0 || range.startColumn < 0 || range.endRow < range.startRow || range.endColumn < range.startColumn ||
      range.endRow >= SHEET_MAX_ROWS || range.endColumn >= SHEET_MAX_COLUMNS || (range.endRow + 1) > Math.floor(SHEET_MAX_CELLS / (range.endColumn + 1))) invalid()
  }
  const config = rule!.rule as Record<string, unknown> | undefined
  if (!config || !['highlightCell', 'colorScale', 'dataBar', 'iconSet'].includes(String(config.type))) invalid()
  if (config!.type === 'highlightCell') {
    if (!['uniqueValues', 'duplicateValues', 'rank', 'text', 'timePeriod', 'number', 'average', 'formula'].includes(String(config!.subType)) ||
      !config!.style || typeof config!.style !== 'object' || Array.isArray(config!.style)) invalid()
  } else if (config!.type === 'colorScale' || config!.type === 'iconSet') {
    if (!Array.isArray(config!.config) || config!.config.length < 2 || config!.config.length > 10 ||
      config!.config.some((entry) => !entry || !isConditionalFormatThreshold(entry.value))) invalid()
  } else {
    const options = config!.config as Record<string, unknown> | undefined
    if (!isConditionalFormatThreshold(options?.min) || !isConditionalFormatThreshold(options?.max) || typeof options?.positiveColor !== 'string') invalid()
  }
  return stored
}

export function readConditionalFormats(doc: Y.Doc): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = Object.create(null)
  for (const [key, value] of doc.getMap(SHEET_CONDITIONAL_FORMATS_FIELD)) result[key] = validateConditionalFormat(key, value)
  return result
}

export function decodeConditionalFormats(state: Uint8Array): Record<string, Record<string, unknown>> {
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, state)
    return readConditionalFormats(doc)
  } finally {
    doc.destroy()
  }
}

export function prepareConditionalFormatChanges(
  doc: Y.Doc,
  changes: ConditionalFormatChanges,
  logicalIds: Set<string>,
  deletedSheets: string[],
): { toSet: Array<[string, Record<string, unknown>]>; toDelete: string[] } {
  const candidate = new Map(doc.getMap(SHEET_CONDITIONAL_FORMATS_FIELD).entries())
  const toSet: Array<[string, Record<string, unknown>]> = []
  const toDelete = new Set<string>()
  for (const [key, value] of Object.entries(changes)) {
    validateKey(key)
    if (value === null) {
      candidate.delete(key)
      toDelete.add(key)
    } else {
      const validated = validateConditionalFormat(key, value, logicalIds)
      candidate.set(key, validated)
      toSet.push([key, validated])
    }
  }
  for (const key of candidate.keys()) {
    if (deletedSheets.includes(key.split('!')[0]!)) {
      candidate.delete(key)
      toDelete.add(key)
    }
  }
  if (candidate.size > 1000 || Buffer.byteLength(JSON.stringify(Object.fromEntries(candidate))) > 1_048_576) {
    throw new SheetSnapshotInvalidError('conditional formatting storage limit exceeded')
  }
  return { toSet, toDelete: [...toDelete] }
}
