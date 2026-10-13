import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import {
  SHEET_YMAP_FIELD, SHEET_LIST_FIELD, SHEET_DIMS_FIELD, SHEET_MERGES_FIELD,
  SHEET_HYPERLINKS_FIELD, SHEET_FREEZE_FIELD, SHEET_FILTERS_FIELD, SHEET_DATA_VALIDATIONS_FIELD,
} from '../src/agent/sheetConversion.js'
import { SHEET_CONDITIONAL_FORMATS_FIELD } from '../src/agent/sheetConditionalFormatting.js'

vi.mock('../src/api/guard.js', () => ({ requireDocRole: vi.fn() }))
vi.mock('../src/collab/liveSheetWrite.js', () => ({ readLiveSheet: vi.fn() }))

import { getDocSheetHandler, listDocSheetsHandler } from '../src/api/routes/docSheet.js'
import { requireDocRole } from '../src/api/guard.js'
import { readLiveSheet } from '../src/collab/liveSheetWrite.js'
import { config } from '../src/config/env.js'
import { encodeBaseVersion } from '../src/collab/docBodyEdit.js'
import { decodeSheetCursor, encodeSheetCursor, sheetVersionFingerprint } from '../src/api/services/sheetPagination.js'

interface ReadBody {
  docId: string
  sheetId?: string
  sheetCells: Record<string, unknown>
  sheetDims?: Record<string, unknown>
  sheetMerges?: Record<string, unknown>
  sheetHyperLinks?: Record<string, unknown>
  sheetList?: Record<string, unknown>
  sheetFreeze?: Record<string, unknown>
  sheetFilters?: Record<string, unknown>
  sheetDataValidations?: Record<string, unknown>
  sheetConditionalFormats?: Record<string, unknown>
  baseVersion: string
  nextCursor: string | null
  hasMore: boolean
  error?: string
  candidates?: Array<{ sheetId: string; name: string }>
  items?: Array<{ sheetId: string; name: string; order: number; rowCount: number; columnCount: number }>
}

function response() {
  return {
    statusCode: 0,
    body: {} as ReadBody,
    status(code: number) { this.statusCode = code; return this },
    json(body: ReadBody) { this.body = body; return this },
  }
}

async function read(query: Record<string, unknown> = {}, docId = 'doc-1', list = false) {
  const result = response()
  await (list ? listDocSheetsHandler : getDocSheetHandler)(
    { uid: 'user-1', params: { docId }, query } as never,
    result as never,
  )
  return result
}

function snapshot(doc: Y.Doc) {
  return { state: Y.encodeStateAsUpdate(doc), baseSV: Y.encodeStateVector(doc) }
}

function workbook(): Y.Doc {
  const doc = new Y.Doc()
  for (const [sheetId, name, order] of [['default', '汇总', 0], ['sales', '新剧榜单', 1], ['sales2', '历史记录', 2]] as const) {
    doc.getMap(SHEET_LIST_FIELD).set(sheetId, { name, order, rowCount: 200, columnCount: 20 })
    for (let row = 0; row < 4; row++) doc.getMap(SHEET_YMAP_FIELD).set(`${sheetId}!${row}:0`, { v: `${name}-${row}` })
    doc.getMap(SHEET_DIMS_FIELD).set(`${sheetId}:c0`, 120)
    doc.getMap(SHEET_MERGES_FIELD).set(`${sheetId}:0:1:0:2`, true)
    doc.getMap(SHEET_HYPERLINKS_FIELD).set(`${sheetId}!link`, { id: 'link', row: 1, column: 0, payload: 'https://example.com' })
    doc.getMap(SHEET_FREEZE_FIELD).set(sheetId, { startRow: 1, startColumn: 1, xSplit: 1, ySplit: 1 })
    doc.getMap(SHEET_FILTERS_FIELD).set(sheetId, { ref: { startRow: 0, endRow: 3, startColumn: 0, endColumn: 1 }, filterColumns: [] })
    doc.getMap(SHEET_DATA_VALIDATIONS_FIELD).set(`${sheetId}!check`, {
      uid: 'check', type: 'checkbox', allowBlank: true,
      ranges: [{ startRow: 0, endRow: 0, startColumn: 3, endColumn: 3 }],
    })
    doc.getMap(SHEET_CONDITIONAL_FORMATS_FIELD).set(`${sheetId}!cf`, {
      priority: 0, rule: { cfId: 'cf', stopIfTrue: false,
        ranges: [{ startRow: 0, endRow: 3, startColumn: 0, endColumn: 0 }],
        rule: { type: 'highlightCell', subType: 'duplicateValues', style: { bg: { rgb: '#ff0000' } } },
      },
    })
  }
  doc.getMap(SHEET_DIMS_FIELD).set('r0', 30)
  return doc
}

const originalByteCap = config.sheetRead.maxCellBytes
let doc: Y.Doc

beforeEach(() => {
  vi.resetAllMocks()
  doc = workbook()
  vi.mocked(requireDocRole).mockImplementation(async (_req, _res, docId) => ({
    meta: { doc_id: docId, document_name: `octo:space:folder:${docId}`, doc_type: 'sheet' }, role: 'reader',
  }) as never)
  vi.mocked(readLiveSheet).mockImplementation(async () => snapshot(doc))
})

afterEach(() => {
  doc.destroy()
  config.sheetRead.maxCellBytes = originalByteCap
})

describe('worksheet directory and scoped reads', () => {
  it('lists ordered ids and names without cells, other resources or a version vector', async () => {
    doc.getMap(SHEET_YMAP_FIELD).set('sales!4:0', { v: 'x'.repeat(100000) })
    doc.getMap(SHEET_DATA_VALIDATIONS_FIELD).set('sales!broken', { type: 'checkbox' })
    config.sheetRead.maxCellBytes = 600
    const result = await read({}, 'doc-1', true)
    expect(result.statusCode).toBe(200)
    expect(result.body.items?.map((item) => [item.sheetId, item.name])).toEqual([
      ['default', '汇总'], ['sales', '新剧榜单'], ['sales2', '历史记录'],
    ])
    expect(Object.keys(result.body)).toEqual(['docId', 'items'])
    expect(result.body.items?.[1]).toMatchObject({ rowCount: 200, columnCount: 20 })
  })

  it('bounds a directory response rather than returning unbounded metadata', async () => {
    config.sheetRead.maxCellBytes = 10
    expect((await read({}, 'doc-1', true)).statusCode).toBe(413)
  })

  it.each([false, true])('applies the reader gate before touching state (list=%s)', async (list) => {
    vi.mocked(requireDocRole).mockResolvedValue(null)
    await read({}, 'doc-1', list)
    expect(requireDocRole).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'doc-1', 'reader')
    expect(readLiveSheet).not.toHaveBeenCalled()
  })

  it.each([false, true])('rejects non-spreadsheet documents (list=%s)', async (list) => {
    vi.mocked(requireDocRole).mockResolvedValue({ meta: { doc_type: 'doc' } } as never)
    expect((await read({}, 'doc-1', list)).body.error).toBe('unsupported_doc_type')
    expect(readLiveSheet).not.toHaveBeenCalled()
  })

  it('reads only exact sheet-qualified cells and every associated metadata kind', async () => {
    const result = await read({ sheetId: 'sales' })
    expect(result.statusCode).toBe(200)
    expect(result.body.sheetId).toBe('sales')
    expect(Object.keys(result.body.sheetCells)).toEqual(['sales!0:0', 'sales!1:0', 'sales!2:0', 'sales!3:0'])
    expect(Object.keys(result.body.sheetDims!)).toEqual(['sales:c0'])
    expect(Object.keys(result.body.sheetMerges!)).toEqual(['sales:0:1:0:2'])
    expect(Object.keys(result.body.sheetHyperLinks!)).toEqual(['sales!link'])
    for (const field of ['sheetList', 'sheetFreeze', 'sheetFilters', 'sheetDataValidations'] as const) {
      expect(Object.keys(result.body[field]!)).toEqual(['sales'])
    }
    expect(Object.keys(result.body.sheetConditionalFormats!)).toEqual(['sales!cf'])
    expect(result.body.baseVersion).toBe(encodeBaseVersion(Y.encodeStateVector(doc)))
  })

  it('resolves an exact Unicode worksheet name to the same result as its id', async () => {
    expect((await read({ sheetName: '新剧榜单' })).body).toEqual((await read({ sheetId: 'sales' })).body)
    expect((await read({ sheetName: '新剧' })).body.error).toBe('sheet_not_found')
  })

  it('returns candidate ids for ambiguous names without guessing', async () => {
    doc.getMap(SHEET_LIST_FIELD).set('sales2', { name: '新剧榜单', order: 2 })
    const result = await read({ sheetName: '新剧榜单' })
    expect(result.statusCode).toBe(409)
    expect(result.body.error).toBe('ambiguous_sheet_name')
    expect(result.body.candidates).toEqual([
      { sheetId: 'sales', name: '新剧榜单' }, { sheetId: 'sales2', name: '新剧榜单' },
    ])
  })

  it.each([
    { sheetId: '' }, { sheetName: '  ' }, { sheetId: 'sales', sheetName: '新剧榜单' },
    { sheetId: ['sales', 'default'] }, { sheetName: { name: '新剧榜单' } },
    { sheetId: '__proto__' }, { sheetId: 'a!b' },
  ])('rejects invalid selection before the live read: %j', async (query) => {
    expect((await read(query)).body.error).toBe('invalid_sheet_selector')
    expect(readLiveSheet).not.toHaveBeenCalled()
  })

  it('does not silently fall back to all sheets for a missing id', async () => {
    const result = await read({ sheetId: 'missing' })
    expect(result.statusCode).toBe(404)
    expect(result.body.error).toBe('sheet_not_found')
  })

  it('preserves bare legacy dimensions only for default', async () => {
    expect((await read({ sheetId: 'default' })).body.sheetDims).toEqual({ 'default:c0': 120, r0: 30 })
  })

  it('exposes the implicit legacy tab without mutating stored state', async () => {
    doc.destroy()
    doc = new Y.Doc()
    doc.getMap(SHEET_YMAP_FIELD).set('default!0:0', { v: 'legacy' })
    const before = Y.encodeStateAsUpdate(doc)
    expect((await read({}, 'doc-1', true)).body.items).toEqual([
      { sheetId: 'default', name: 'Sheet1', order: 0, rowCount: 1000, columnCount: 100 },
    ])
    expect((await read({ sheetName: 'Sheet1' })).body.sheetCells).toEqual({ 'default!0:0': { v: 'legacy' } })
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
    expect((await read()).body.sheetList).toEqual({})
  })

  it('filters before validating foreign cells and before charging the response budget', async () => {
    doc.getMap(SHEET_YMAP_FIELD).set('sales2!0:0', { unsupported: true })
    doc.getMap(SHEET_CONDITIONAL_FORMATS_FIELD).set('sales2!bad', {})
    doc.getMap(SHEET_DIMS_FIELD).set('sales2:r1', -1)
    const result = await read({ sheetId: 'sales', limit: '1' })
    expect(result.statusCode).toBe(200)
    config.sheetRead.maxCellBytes = Buffer.byteLength(JSON.stringify(result.body))
    expect((await read({ sheetId: 'sales', limit: '1' })).statusCode).toBe(200)
    expect((await read({ limit: '1' })).statusCode).toBe(409)
  })

  it('still validates selected cells instead of treating filtering as validation', async () => {
    doc.getMap(SHEET_YMAP_FIELD).set('sales!0:0', { unsupported: true })
    expect((await read({ sheetId: 'sales' })).body.error).toBe('sheet_snapshot_invalid')
  })
})

describe('compact, scope-bound pagination', () => {
  it('walks one sheet without gaps or duplicates and inherits its scope from the cursor', async () => {
    let result = await read({ sheetName: '新剧榜单', limit: '1' })
    const cells: string[] = []
    for (let page = 0; page < 10; page++) {
      expect(result.statusCode).toBe(200)
      expect(result.body.sheetId).toBe('sales')
      cells.push(...Object.keys(result.body.sheetCells))
      if (!result.body.hasMore) break
      expect(result.body.nextCursor!.length).toBeLessThan(512)
      result = await read({ cursor: result.body.nextCursor, limit: '1' })
      expect(result.body.sheetList).toBeUndefined()
    }
    expect(cells).toEqual(['sales!0:0', 'sales!1:0', 'sales!2:0', 'sales!3:0'])
    expect(result.body.nextCursor).toBeNull()
  })

  it('can continue with cursor alone and can repeat an equivalent name or id', async () => {
    const first = await read({ sheetId: 'sales', limit: '1' })
    for (const query of [{}, { sheetId: 'sales' }, { sheetName: '新剧榜单' }]) {
      const next = await read({ ...query, cursor: first.body.nextCursor })
      expect(next.statusCode).toBe(200)
      expect(Object.keys(next.body.sheetCells)).toHaveLength(3)
    }
  })

  it('rejects cross-document and cross-sheet reuse even when the state vector is equal', async () => {
    const scoped = (await read({ sheetId: 'sales', limit: '1' })).body.nextCursor
    expect((await read({ cursor: scoped }, 'doc-2')).body.error).toBe('invalid_cursor')
    expect((await read({ cursor: scoped, sheetId: 'default' })).body.error).toBe('invalid_cursor')
    const whole = (await read({ limit: '1' })).body.nextCursor
    expect((await read({ cursor: whole, sheetId: 'sales' })).body.error).toBe('invalid_cursor')
  })

  it('rejects snapshot changes, including changes to another sheet', async () => {
    const first = await read({ sheetId: 'sales', limit: '1' })
    doc.getMap(SHEET_YMAP_FIELD).set('default!10:0', { v: 'new version' })
    const next = await read({ cursor: first.body.nextCursor })
    expect(next.statusCode).toBe(409)
    expect(next.body.error).toBe('sheet_changed')
  })

  it('accepts a legacy workbook cursor but upgrades its next cursor and refuses scoping it', async () => {
    const baseVersion = encodeBaseVersion(Y.encodeStateVector(doc))
    const cursor = encodeSheetCursor({ v: baseVersion, k: 'default!0:0' })
    const result = await read({ cursor, limit: '1' })
    expect(result.statusCode).toBe(200)
    expect(Object.keys(result.body.sheetCells)).toEqual(['default!1:0'])
    expect(decodeSheetCursor(result.body.nextCursor!)).toMatchObject({ t: 2, d: 'doc-1', s: null })
    expect((await read({ cursor, sheetId: 'sales' })).body.error).toBe('invalid_cursor')
  })

  it.each(['garbage!', ['one', 'two'], { value: 'x' },
    Buffer.from(JSON.stringify({ t: 3, v: 'x', k: 'sales!0:0' })).toString('base64url'),
  ])('rejects malformed cursors before the live read: %j', async (cursor) => {
    expect((await read({ cursor })).body.error).toBe('invalid_cursor')
    expect(readLiveSheet).not.toHaveBeenCalled()
  })

  it('keeps cursor length bounded with 1,200 historical Yjs clients, preserving the write token', async () => {
    for (let index = 0; index < 1200; index++) {
      const writer = new Y.Doc()
      writer.clientID = 1000000000 + index
      writer.getMap(SHEET_YMAP_FIELD).set(`sales!${index + 10}:0`, { v: index })
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(writer))
      writer.destroy()
    }
    const first = await read({ sheetId: 'sales', limit: '1' })
    expect(first.statusCode).toBe(200)
    expect(first.body.baseVersion.length).toBeGreaterThan(8000)
    expect(first.body.nextCursor!.length).toBeLessThan(512)
    expect(first.body.baseVersion).toBe(encodeBaseVersion(Y.encodeStateVector(doc)))
    expect(decodeSheetCursor(first.body.nextCursor!)).toMatchObject({ v: sheetVersionFingerprint(first.body.baseVersion) })
    expect((await read({ cursor: first.body.nextCursor, limit: '1' })).statusCode).toBe(200)
  })

  it('fits an exact scoped response budget including the actual encoded cursor', async () => {
    const first = await read({ sheetId: 'sales', limit: '1' })
    config.sheetRead.maxCellBytes = Buffer.byteLength(JSON.stringify(first.body))
    const result = await read({ sheetId: 'sales', limit: '2' })
    expect(result.statusCode).toBe(200)
    expect(result.body).toEqual(first.body)
  })
})
