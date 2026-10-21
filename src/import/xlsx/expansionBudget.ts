import { config } from '../../config/env.js'

/** A processing limit, distinct from archive bytes, allocated grid cells and final Yjs bytes. */
export class XlsxExpansionError extends Error {
  constructor() { super('xlsx_expansion_limit'); this.name = 'XlsxExpansionError' }
}

/** Preflight without retaining converted cells; reject before constructing the output grid. */
export class XlsxExpansionBudget {
  private contentBytes = 0
  private allocationBytes = 0
  private readonly encoder = new TextEncoder()

  reserveGrid(rows: number, columns: number): void {
    // Array slots plus per-row headers. The server uses a sparse list but shares this bound.
    this.allocationBytes += rows * 32 + rows * columns * 8
    this.check()
  }

  addCell(value: unknown, row: number, column: number, allocationValue: unknown = value): void {
    if (value == null) return
    const bytes = this.encoder.encode(JSON.stringify(value)).byteLength
    // Include the eventual coordinate key; images are kept outside this cell representation.
    this.contentBytes += bytes + `default!${row}:${column}`.length + 4
    // Conservative accounting for object headers, UTF-16 strings and nested style objects.
    const allocated = allocationValue === value ? bytes : this.encoder.encode(JSON.stringify(allocationValue)).byteLength
    this.allocationBytes += 128 + allocated * 4
    this.check()
  }

  private check(): void {
    if (this.contentBytes > config.maxDocBytes || this.allocationBytes > 128 * 1024 * 1024) {
      throw new XlsxExpansionError()
    }
  }
}

/** Match ExcelJS Cell._mergeStyle: row groups override column groups, without creating a Cell. */
export function inheritedCellStyle(row: Record<string, unknown>, column: Record<string, unknown>): Record<string, unknown> {
  const style: Record<string, unknown> = {}
  for (const key of ['numFmt', 'font', 'alignment', 'border', 'fill', 'protection']) {
    const value = row[key] || column[key]
    if (value) style[key] = value
  }
  return style
}
