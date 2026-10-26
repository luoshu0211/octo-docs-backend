// @vitest-environment node
import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function workbook(rows: number, columns: number): Promise<Buffer> {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('Styled')
  for (let c = 1; c <= columns; c++) sheet.getColumn(c).font = { bold: true }
  sheet.getCell(rows, columns).value = 'last'
  return Buffer.from(await book.xlsx.writeBuffer() as ArrayBuffer)
}

describe('bounded XLSX inherited-style allocation', () => {
  it('rejects a compact four-million-cell styled workbook without exhausting a 256 MiB heap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xlsx-allocation-'))
    try {
      const bytes = await workbook(400, 10_000)
      expect(bytes.byteLength).toBeLessThan(60_000)
      const fixture = join(directory, 'styled.xlsx')
      await writeFile(fixture, bytes)
      const moduleUrl = new URL('../src/import/xlsx/parse.ts', import.meta.url).href
      const script = `
        import { readFile } from 'node:fs/promises';
        const { parseXlsx } = await import(${JSON.stringify(moduleUrl)});
        const bytes = await readFile(${JSON.stringify(fixture)});
        try {
          const result = await parseXlsx(bytes);
          console.log(JSON.stringify({ ok: true, reason: result.reason }));
        } catch (error) { console.log(JSON.stringify({ ok: false, reason: error.reason })); }
      `
      const { stdout } = await promisify(execFile)(process.execPath,
        ['--max-old-space-size=256', '--import', 'tsx', '--input-type=module', '-e', script],
        { cwd: process.cwd(), timeout: 20_000, env: { ...process.env, NODE_OPTIONS: '' } })
      expect(JSON.parse(stdout.trim())).toEqual({ ok: false, reason: 'resource-limit' })
    } finally { await rm(directory, { recursive: true, force: true }) }
  }, 30_000)
})

it('admits content below 20 MiB even when parser-only coordinate/value fields exceed it', async () => {
  const { randomBytes } = await import('node:crypto')
  const { parseXlsx } = await import('../src/import/xlsx/parse.js')
  const { xlsxWorkbookToSheetBatch } = await import('../src/import/xlsx/toSheetBatch.js')
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('Text')
  const value = randomBytes(9060).toString('base64')
  for (let row = 1; row <= 1730; row++) sheet.getCell(row, 1).value = value
  const parsed = await parseXlsx(Buffer.from(await book.xlsx.writeBuffer() as ArrayBuffer))
  expect(parsed.sheets[0]!.cells).toHaveLength(1730)
  const parserFields = Object.fromEntries(parsed.sheets[0]!.cells.map(cell => [`default!${cell.row}:${cell.col}`, cell]))
  expect(Buffer.byteLength(JSON.stringify(parserFields))).toBeGreaterThan(20 * 1024 * 1024)
  expect(Buffer.byteLength(JSON.stringify(xlsxWorkbookToSheetBatch(parsed).cells))).toBeLessThan(20 * 1024 * 1024)
}, 15_000)
