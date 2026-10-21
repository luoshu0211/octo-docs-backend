import { describe, expect, it } from 'vitest'
import { extractDocx } from '../src/import/docx/extract.js'
import { assertSafeXlsxArchive } from '../src/import/xlsx/parse.js'
import { buildZip } from './helpers/capacityZip.js'
const limit = 20 * 1024 * 1024

describe('import content excludes binary images', () => {
  it('extracts a real DOCX archive over 20 MiB when only images cross the limit', async () => {
    const bytes = buildZip([
      { name:'word/document.xml',content:Buffer.from('<w:document/>'),store:true },
      { name:'word/media/image1.png',content:Buffer.alloc(limit + 1),store:true },
    ])
    const parsed=await extractDocx(bytes)
    expect(parsed.media[0]?.data.length).toBe(limit+1)
    expect(parsed.parts.get('word/document.xml')?.data.toString()).toBe('<w:document/>')
  })
  it('refuses DOCX non-image content above 20 MiB', async () => {
    const bytes=buildZip([{name:'word/document.xml',content:Buffer.alloc(limit+1),store:true}])
    await expect(extractDocx(bytes)).rejects.toMatchObject({reason:'content-too-large'})
  })
  it('accepts XLSX content at 20 MiB with extra images and rejects one extra content byte', async () => {
    const bytes=buildZip([
      {name:'xl/worksheets/sheet1.xml',content:Buffer.alloc(limit),store:true},
      {name:'xl/media/image.png',content:Buffer.alloc(1024),store:true},
    ])
    await expect(assertSafeXlsxArchive(bytes)).resolves.toBeUndefined()
    await expect(assertSafeXlsxArchive(buildZip([{name:'xl/worksheets/sheet1.xml',content:Buffer.alloc(limit+1),store:true}]))).rejects.toMatchObject({reason:'content-too-large'})
  })
})
