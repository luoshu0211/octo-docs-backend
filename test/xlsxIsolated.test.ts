import { afterEach, describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { config } from '../src/config/env.js'
import { parseXlsxIsolated } from '../src/import/xlsx/parseIsolated.js'

const timeout = config.docxImport.timeoutMs
afterEach(() => { config.docxImport.timeoutMs = timeout })
async function input(): Promise<Buffer> {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('Small')
  sheet.getColumn(1).font = { bold: true }
  sheet.getRow(2).font = { italic: true }
  sheet.getCell(2, 2).value = 'row-anchor'
  sheet.getColumn(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00FF00' } }
  sheet.getCell(3, 2).value = 'end'
  return Buffer.from(await book.xlsx.writeBuffer() as ArrayBuffer)
}

describe('isolated XLSX parsing', () => {
  it('retains inherited blank formatting and row-over-column precedence in a real child', async () => {
    const workbook = await parseXlsxIsolated(await input())
    const cells = workbook.sheets[0]!.cells
    expect(cells.find(c => c.row === 0 && c.col === 0)?.style).toMatchObject({ bl: 1, bg: { rgb: '#00FF00' } })
    expect(cells.find(c => c.row === 1 && c.col === 0)?.style).toEqual({ it: 1, bg: { rgb: '#00FF00' } })
    expect(cells.find(c => c.row === 2 && c.col === 1)?.value).toBe('end')
  })

  it('bounds concurrent work and frees its slot after cancellation', async () => {
    const bytes = await input(), controller = new AbortController()
    const running = parseXlsxIsolated(bytes, controller.signal)
    await expect(parseXlsxIsolated(bytes)).rejects.toMatchObject({ reason: 'busy' })
    controller.abort()
    await expect(running).rejects.toMatchObject({ reason: 'cancelled' })
    expect((await parseXlsxIsolated(bytes)).sheets[0]!.name).toBe('Small')
  })

  it('kills a timed-out child and accepts the next valid import', async () => {
    const bytes = await input()
    config.docxImport.timeoutMs = 1
    await expect(parseXlsxIsolated(bytes)).rejects.toMatchObject({ reason: 'resource-limit' })
    config.docxImport.timeoutMs = timeout
    expect((await parseXlsxIsolated(bytes)).sheets[0]!.name).toBe('Small')
  })
})

it('survives parser heap exhaustion before grid validation and accepts a subsequent import', async () => {
  const { buildZip } = await import('./helpers/capacityZip.js')
  const bytes = buildZip(Object.entries({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Huge merge" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="A1:XFD1048576"/></mergeCells></worksheet>',
  }).map(([name, content]) => ({ name, content: Buffer.from(content) })))
  let ticks = 0
  const timer = setInterval(() => ticks++, 5)
  try {
    await expect(parseXlsxIsolated(bytes)).rejects.toMatchObject({ reason: 'resource-limit' })
    expect(ticks).toBeGreaterThan(5)
    expect((await parseXlsxIsolated(await input())).sheets[0]!.name).toBe('Small')
  } finally { clearInterval(timer) }
}, 30_000)
