import { EventEmitter } from 'node:events'
import * as isolatedParser from '../src/import/xlsx/parseIsolated.js'
import { beforeEach, describe, it, expect, vi } from 'vitest'
import type { Request, Response } from 'express'
import ExcelJS from 'exceljs'

// Offline route test: mock the auth guard, the live-sheet read, and the sheet-write service so
// importXlsxHandler runs without live infra (mirrors importDocxRoute.test.ts). We assert the
// handler maps guard/body/parse/write outcomes to the right status codes and forwards warnings.
vi.mock('../src/api/guard.js', () => ({
  requireDocRole: vi.fn(),
}))
vi.mock('../src/collab/liveSheetWrite.js', () => ({
  readLiveSheet: vi.fn(async () => ({
    state: new Uint8Array(),
    baseSV: new Uint8Array([1, 2, 3]),
  })),
}))
vi.mock('../src/collab/versionRestore.js', () => ({
  decodeSheetSnapshot: vi.fn(() => ({})),
  decodeSheetDimsSnapshot: vi.fn(() => ({})),
  decodeSheetDrawingsSnapshot: vi.fn(() => ({})),
  decodeSheetHyperLinksSnapshot: vi.fn(() => ({})),
  decodeSheetMergesSnapshot: vi.fn(() => ({})),
  decodeSheetListSnapshot: vi.fn(() => ({})),
  decodeOwnedSheetDataValidationKeysSnapshot: vi.fn(() => ['default!checkbox-old']),
}))
vi.mock('../src/api/services/editDocSheet.js', () => ({
  editDocSheet: vi.fn(),
}))

vi.mock('../src/storage/objectStore.js', () => ({ getObjectStore: () => ({
  upload: uploadMock, delete: deleteMock, presignGet: () => 'https://objects.test/image.png',
}) }))
vi.mock('../src/db/repos/docAttachmentRepo.js', () => ({ docAttachmentRepo: {
  register: registerMock, getById: getAttachmentMock, deleteById: deleteAttachmentMock,
} }))
const { uploadMock, deleteMock, registerMock, getAttachmentMock, deleteAttachmentMock } = vi.hoisted(() => ({
  uploadMock: vi.fn(async (_key: string, _mime: string, _bytes: Uint8Array, _options?: unknown) => {}), deleteMock: vi.fn(async (_key: string) => {}),
  registerMock: vi.fn(async (_value: unknown) => {}),
  getAttachmentMock: vi.fn(async (_id: string): Promise<unknown> => undefined),
  deleteAttachmentMock: vi.fn(async () => {}),
}))

import { importXlsxHandler } from '../src/api/routes/import.js'
import { requireDocRole } from '../src/api/guard.js'
import { editDocSheet } from '../src/api/services/editDocSheet.js'
import { decodeOwnedSheetDataValidationKeysSnapshot } from '../src/collab/versionRestore.js'

const guard = vi.mocked(requireDocRole)
const edit = vi.mocked(editDocSheet)

interface MockRes {
  statusCode: number
  body: unknown
  status(c: number): MockRes
  json(b: unknown): MockRes
}
function mockRes(): MockRes {
  return Object.assign(new EventEmitter(), {
    statusCode: 0,
    body: undefined,
    status(c: number) {
      this.statusCode = c
      return this
    },
    json(b: unknown) {
      this.body = b
      return this
    },
  })
}
function req(body: unknown): Request {
  return Object.assign(new EventEmitter(), {
    uid: 'u1',
    spaceId: 's1',
    principalSpaceId: 's1',
    params: { docId: 'd1' },
    body,
  }) as unknown as Request
}
function field(res: MockRes, key: string): unknown {
  return (res.body as Record<string, unknown> | undefined)?.[key]
}
async function run(res: MockRes, body: unknown): Promise<void> {
  await importXlsxHandler(req(body), res as unknown as Response)
}

/** A guard success for a sheet doc. */
function sheetGuard() {
  return {
    meta: {
      doc_id: 'd1',
      document_name: 'doc-d1',
      doc_type: 'sheet',
      permission_epoch: 1,
    },
  } as unknown as Awaited<ReturnType<typeof requireDocRole>>
}

/** Build a tiny .xlsx buffer with one cell. */
async function xlsxBuffer(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('S')
  ws.getCell('A1').value = 'hi'
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer)
}

describe('importXlsxHandler — status mapping', () => {
  it('400 when the guard denies access', async () => {
    guard.mockResolvedValueOnce(undefined as unknown as Awaited<ReturnType<typeof requireDocRole>>)
    const res = mockRes()
    await run(res, await xlsxBuffer())
    // guard already wrote its own response; handler just returns. statusCode stays 0 here
    // because the mocked guard doesn't call res. Assert editDocSheet was never reached.
    expect(edit).not.toHaveBeenCalled()
  })

  it('409 unsupported_doc_type for a non-sheet target', async () => {
    guard.mockResolvedValueOnce({
      meta: {
        doc_id: 'd1',
        document_name: 'doc-d1',
        doc_type: 'doc',
        permission_epoch: 1,
      },
    } as unknown as Awaited<ReturnType<typeof requireDocRole>>)
    const res = mockRes()
    await run(res, await xlsxBuffer())
    expect(res.statusCode).toBe(409)
    expect(field(res, 'error')).toBe('unsupported_doc_type')
  })

  it('400 invalid_body when the body is not a Buffer', async () => {
    guard.mockResolvedValueOnce(sheetGuard())
    const res = mockRes()
    await run(res, {})
    expect(res.statusCode).toBe(400)
    expect(field(res, 'error')).toBe('invalid_body')
  })

  it('400 empty_upload on a zero-length buffer', async () => {
    guard.mockResolvedValueOnce(sheetGuard())
    const res = mockRes()
    await run(res, Buffer.alloc(0))
    expect(res.statusCode).toBe(400)
    expect(field(res, 'error')).toBe('empty_upload')
  })

  it('422 import_failed on unreadable bytes', async () => {
    guard.mockResolvedValueOnce(sheetGuard())
    const res = mockRes()
    await run(res, Buffer.from('not a workbook', 'utf8'))
    expect(res.statusCode).toBe(422)
    expect(field(res, 'error')).toBe('import_failed')
  })

  it('200 with baseVersion + warnings on a successful import', async () => {
    guard.mockResolvedValueOnce(sheetGuard())
    edit.mockResolvedValueOnce({
      ok: true,
      bytes: 10,
      baseVersion: 'bv2',
      newDocVersionSeq: 2,
    })
    const res = mockRes()
    await run(res, await xlsxBuffer())
    expect(res.statusCode).toBe(200)
    expect(field(res, 'baseVersion')).toBe('bv2')
    expect(Array.isArray(field(res, 'warnings'))).toBe(true)
    // the parsed cell was handed to editDocSheet under the read base version
    expect(edit).toHaveBeenCalledOnce()
    const arg = edit.mock.calls[0]![0]
    expect(arg.cells['default!0:0']).toEqual({ v: 'hi' })
    expect(arg.dataValidations).toEqual({ 'default!checkbox-old': null })
  })

  it('includes malformed and overlap-loser checkbox keys in replace cleanup', async () => {
    vi.mocked(decodeOwnedSheetDataValidationKeysSnapshot).mockReturnValueOnce([
      'malformed-checkbox-key',
      'default!overlap-loser',
    ])
    guard.mockResolvedValueOnce(sheetGuard())
    edit.mockResolvedValueOnce({ ok: true, bytes: 10, baseVersion: 'bv2', newDocVersionSeq: 2 })

    const res = mockRes()
    await run(res, await xlsxBuffer())

    expect(res.statusCode).toBe(200)
    const dataValidations = edit.mock.calls.at(-1)![0].dataValidations!
    expect(Object.hasOwn(dataValidations, 'malformed-checkbox-key')).toBe(true)
    expect(dataValidations['malformed-checkbox-key']).toBeNull()
    expect(dataValidations['default!overlap-loser']).toBeNull()
  })

  it('forwards editDocSheet failure status/body', async () => {
    guard.mockResolvedValueOnce(sheetGuard())
    edit.mockResolvedValueOnce({
      ok: false,
      status: 413,
      error: 'sheet_too_large',
      baseVersion: 'repair-bv',
      repairDataValidationKey: 'default!checkbox-old',
      hint: 'delete the returned checkbox validation key with PATCH, then retry the write',
    })
    const res = mockRes()
    await run(res, await xlsxBuffer())
    expect(res.statusCode).toBe(413)
    expect(res.body).toEqual({
      error: 'sheet_too_large',
      baseVersion: 'repair-bv',
      repairDataValidationKey: 'default!checkbox-old',
      hint: 'delete the returned checkbox validation key with PATCH, then retry the write',
    })
  })
})

describe('XLSX image storage', () => {
  async function imageWorkbook() {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Images')
    const image = wb.addImage({ buffer: Buffer.from('png-payload'), extension: 'png' })
    ws.addImage(image, { tl: { col: 199, row: 19999 }, ext: { width: 20, height: 20 } })
    return Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer)
  }
  it('uploads bytes to object storage and saves only the durable attachment reference', async () => {
    guard.mockResolvedValueOnce(sheetGuard())
    edit.mockResolvedValueOnce({ ok: true, bytes: 10, baseVersion: 'bv', newDocVersionSeq: 2 })
    const res = mockRes()
    await run(res, await imageWorkbook())
    expect(res.statusCode).toBe(200)
    expect(uploadMock).toHaveBeenCalledOnce()
    expect(Buffer.from(uploadMock.mock.calls[0]![2])).toEqual(Buffer.from('png-payload'))
    const attachment = registerMock.mock.calls[0]![0] as { attachId: string }
    const batch = edit.mock.calls.at(-1)![0]
    expect(batch.sheets?.default).toMatchObject({ rowCount: 20000, columnCount: 200 })
    const drawing = Object.values(batch.drawings!)[0]
    expect(drawing).toMatchObject({ drawingId: attachment.attachId, octoAttachId: attachment.attachId, imageSourceType: 'URL', source: 'https://objects.test/image.png' })
    expect(JSON.stringify(batch)).not.toContain('base64')
    expect(deleteMock).not.toHaveBeenCalled()
  })
  it('cleans up the uploaded image when the document write is refused', async () => {
    guard.mockResolvedValueOnce(sheetGuard())
    edit.mockResolvedValueOnce({ ok: false, status: 413, error: 'sheet_too_large' })
    getAttachmentMock.mockResolvedValueOnce({ objectKey: 'd1/uploaded/image.png' })
    const res = mockRes()
    await run(res, await imageWorkbook())
    expect(res.statusCode).toBe(413)
    expect(deleteMock).toHaveBeenCalledWith('d1/uploaded/image.png')
    expect(deleteAttachmentMock).toHaveBeenCalledOnce()
  })
})

describe('XLSX parser process boundary', () => {
  beforeEach(() => { edit.mockClear(); uploadMock.mockClear() })
  it('routes admitted uploads through the isolated parser before writing', async () => {
    const parse = vi.spyOn(isolatedParser, 'parseXlsxIsolated')
    try {
      guard.mockResolvedValueOnce(sheetGuard())
      edit.mockResolvedValueOnce({ ok: true, bytes: 10, baseVersion: 'bv', newDocVersionSeq: 2 })
      const res = mockRes()
      await run(res, await xlsxBuffer())
      expect(parse).toHaveBeenCalledOnce()
      expect(res.statusCode).toBe(200)
    } finally { parse.mockRestore() }
  })
  it.each([
    ['resource-limit', 413, 'xlsx_expansion_limit'], ['busy', 503, 'import_busy'],
  ] as const)('returns a controlled %s without uploading or writing', async (reason, status, error) => {
    const { XlsxParseError } = await import('../src/import/xlsx/parse.js')
    const parse = vi.spyOn(isolatedParser, 'parseXlsxIsolated').mockRejectedValue(new XlsxParseError(reason))
    try {
      guard.mockResolvedValueOnce(sheetGuard())
      const res = mockRes()
      await run(res, await xlsxBuffer())
      expect(res.statusCode).toBe(status)
      expect(res.body).toEqual({ error })
      expect(edit).not.toHaveBeenCalled()
      expect(uploadMock).not.toHaveBeenCalled()
    } finally { parse.mockRestore() }
  })
})
