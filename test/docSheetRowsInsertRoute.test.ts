import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/api/guard.js', () => ({ requireDocRole: vi.fn() }))
vi.mock('../src/api/services/editDocSheet.js', () => ({ editDocSheet: vi.fn() }))

import { requireDocRole } from '../src/api/guard.js'
import { editDocSheet } from '../src/api/services/editDocSheet.js'
import {
  deleteDocSheetColumnsHandler,
  deleteDocSheetRowsHandler,
  insertDocSheetColumnsHandler,
  insertDocSheetRowsHandler,
} from '../src/api/routes/docSheet.js'

interface MockRes {
  statusCode: number
  body: unknown
  status(code: number): MockRes
  json(body: unknown): MockRes
}

function mockRes(): MockRes {
  return {
    statusCode: 0,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

function req(body: unknown, headers: Record<string, string> = {}) {
  return {
    uid: 'u_1',
    principalSpaceId: 's1',
    botToken: 'bot',
    params: { docId: 'd_1' },
    body,
    headers,
  } as never
}

const writerGuard = {
  meta: {
    doc_id: 'd_1',
    document_name: 'octo:s1:f_default:d_1',
    doc_type: 'sheet',
    permission_epoch: 7,
  },
  role: 'writer',
} as never

beforeEach(() => {
  vi.mocked(requireDocRole).mockReset()
  vi.mocked(editDocSheet).mockReset()
})

describe('POST /:docId/sheet/rows/insert', () => {
  it('requires writer access before touching the sheet', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(null)
    await insertDocSheetRowsHandler(req({}), mockRes() as never)
    expect(vi.mocked(requireDocRole).mock.calls[0]![3]).toBe('writer')
    expect(editDocSheet).not.toHaveBeenCalled()
  })

  it.each([
    { body: { logicalId: 'default', afterRow: 9, count: 5 }, headers: {} },
    { body: { logicalId: 'default', afterRow: -1, count: 5 }, headers: { 'if-match': 'BV' } },
    { body: { logicalId: 'default', afterRow: 9, count: 0 }, headers: { 'if-match': 'BV' } },
    { body: { logicalId: 'default', afterRow: 9, count: 10_000 }, headers: { 'if-match': 'BV' } },
    { body: { logicalId: 'bad:id', afterRow: 9, count: 5 }, headers: { 'if-match': 'BV' } },
  ])('returns 400 for a malformed request', async ({ body, headers }) => {
    vi.mocked(requireDocRole).mockResolvedValue(writerGuard)
    const res = mockRes()
    await insertDocSheetRowsHandler(req(body, headers), res as never)
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_body' })
    expect(editDocSheet).not.toHaveBeenCalled()
  })

  it('passes the zero-based insertion request through the guarded sheet edit', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(writerGuard)
    vi.mocked(editDocSheet).mockResolvedValue({
      ok: true,
      bytes: 123,
      baseVersion: 'NEXT',
      newDocVersionSeq: 8,
      rowCount: 25,
    })
    const res = mockRes()
    await insertDocSheetRowsHandler(req(
      { logicalId: 'default', afterRow: 9, count: 5 },
      { 'if-match': '"BV"' },
    ), res as never)

    expect(editDocSheet).toHaveBeenCalledWith(expect.objectContaining({
      structuralEdit: {
        kind: 'rows.insert', logicalId: 'default', afterRow: 9, count: 5,
      },
      authorizedEpoch: 7,
    }))
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      docId: 'd_1',
      logicalId: 'default',
      afterRow: 9,
      insertedRows: 5,
      rowCount: 25,
      bytes: 123,
      baseVersion: 'NEXT',
      newDocVersionSeq: 8,
    })
  })

  it.each([
    {
      handler: deleteDocSheetRowsHandler,
      body: { logicalId: 'default', startRow: 4, count: 2 },
      edit: { kind: 'rows.delete', logicalId: 'default', startRow: 4, count: 2 },
      result: { rowCount: 18 },
      response: { startRow: 4, deletedRows: 2, rowCount: 18 },
    },
    {
      handler: insertDocSheetColumnsHandler,
      body: { logicalId: 'default', afterColumn: 3, count: 2 },
      edit: { kind: 'columns.insert', logicalId: 'default', afterColumn: 3, count: 2 },
      result: { columnCount: 22 },
      response: { afterColumn: 3, insertedColumns: 2, columnCount: 22 },
    },
    {
      handler: deleteDocSheetColumnsHandler,
      body: { logicalId: 'default', startColumn: 3, count: 2 },
      edit: { kind: 'columns.delete', logicalId: 'default', startColumn: 3, count: 2 },
      result: { columnCount: 18 },
      response: { startColumn: 3, deletedColumns: 2, columnCount: 18 },
    },
  ])('routes $edit.kind through the guarded structural edit', async ({
    handler, body, edit, result, response,
  }) => {
    vi.mocked(requireDocRole).mockResolvedValue(writerGuard)
    vi.mocked(editDocSheet).mockResolvedValue({
      ok: true,
      bytes: 123,
      baseVersion: 'NEXT',
      newDocVersionSeq: 8,
      ...result,
    })
    const res = mockRes()
    await handler(req(body, { 'if-match': 'BV' }), res as never)

    expect(editDocSheet).toHaveBeenCalledWith(expect.objectContaining({
      structuralEdit: edit,
      authorizedEpoch: 7,
    }))
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      docId: 'd_1', logicalId: 'default', ...response,
      bytes: 123, baseVersion: 'NEXT', newDocVersionSeq: 8,
    })
  })

  it.each([
    [deleteDocSheetRowsHandler, { logicalId: 'default', startRow: -1, count: 1 }],
    [insertDocSheetColumnsHandler, { logicalId: 'default', afterColumn: 1, count: 100 }],
    [deleteDocSheetColumnsHandler, { logicalId: 'default', startColumn: 1, count: 0 }],
  ])('rejects malformed structural edit bodies', async (handler, body) => {
    vi.mocked(requireDocRole).mockResolvedValue(writerGuard)
    const res = mockRes()
    await handler(req(body, { 'if-match': 'BV' }), res as never)
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_body' })
    expect(editDocSheet).not.toHaveBeenCalled()
  })

  it('forwards a formula-safety refusal', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(writerGuard)
    vi.mocked(editDocSheet).mockResolvedValue({
      ok: false, status: 409, error: 'sheet_formula_unsupported',
    })
    const res = mockRes()
    await insertDocSheetRowsHandler(req(
      { logicalId: 'default', afterRow: 9, count: 5 },
      { 'if-match': 'BV' },
    ), res as never)
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ error: 'sheet_formula_unsupported' })
  })
})
