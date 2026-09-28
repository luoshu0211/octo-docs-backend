import { SHEET_MAX_COLUMNS, SHEET_MAX_ROWS, SheetSnapshotInvalidError } from './sheetConversion.js'

export const SHEET_CONDITIONAL_FORMATS_FIELD = 'sheetConditionalFormats'

export function validateConditionalFormat(key: string, value: unknown): Record<string, unknown> {
  const invalid = (): never => { throw new SheetSnapshotInvalidError('invalid conditional formatting rule') }
  const parts = key.split('!')
  if (parts.length !== 2 || !parts[0] || !parts[1] || parts[1].length > 128 || ['__proto__', 'constructor', 'prototype'].includes(parts[0])) invalid()
  const text = JSON.stringify(value)
  if (!text || text.length > 65_536) invalid()
  const stored = JSON.parse(text) as Record<string, unknown>
  if (!stored || typeof stored !== 'object' || !Number.isFinite(stored.priority)) invalid()
  const rule = stored.rule as Record<string, unknown> | undefined
  if (!rule || rule.cfId !== parts[1] || typeof rule.stopIfTrue !== 'boolean' || !Array.isArray(rule.ranges) || !rule.ranges.length || rule.ranges.length > 512) invalid()
  for (const range of rule!.ranges as Array<{ startRow: number; endRow: number; startColumn: number; endColumn: number }>) {
    if (!range || ![range.startRow, range.endRow, range.startColumn, range.endColumn].every(Number.isSafeInteger) ||
      range.startRow < 0 || range.startColumn < 0 || range.endRow < range.startRow || range.endColumn < range.startColumn ||
      range.endRow >= SHEET_MAX_ROWS || range.endColumn >= SHEET_MAX_COLUMNS) invalid()
  }
  const config = rule!.rule as Record<string, unknown> | undefined
  if (!config || !['highlightCell', 'colorScale', 'dataBar', 'iconSet'].includes(String(config.type))) invalid()
  if (config!.type === 'highlightCell') {
    if (!['uniqueValues', 'duplicateValues', 'rank', 'text', 'timePeriod', 'number', 'average', 'formula'].includes(String(config!.subType)) ||
      !config!.style || typeof config!.style !== 'object' || Array.isArray(config!.style)) invalid()
  } else if (config!.type === 'colorScale' || config!.type === 'iconSet') {
    if (!Array.isArray(config!.config) || config!.config.length < 2 || config!.config.length > 10) invalid()
  } else {
    const options = config!.config as Record<string, unknown> | undefined
    if (!options?.min || !options?.max || typeof options.positiveColor !== 'string') invalid()
  }
  return stored
}
