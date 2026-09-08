import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as Y from 'yjs'
import {
  SHEET_YMAP_FIELD,
  SHEET_DIMS_FIELD,
  SHEET_LIST_FIELD,
  SHEET_FREEZE_FIELD,
  SHEET_FILTERS_FIELD,
  SHEET_DATA_VALIDATIONS_FIELD,
  type SheetCell,
  type StoredDataValidation,
  type StoredSheetMeta,
} from '../src/agent/sheetConversion.js'

// Offline unit test (mirrors docContent.test.ts): mock the auth guard and the
// live-document boundary. The route's decode + payload-guard runs for real
// against a mocked live read built from a genuine Y.Doc.
vi.mock('../src/api/guard.js', () => ({ requireDocRole: vi.fn() }))
vi.mock('../src/collab/liveSheetWrite.js', () => ({ readLiveSheet: vi.fn() }))

import { getDocSheetHandler } from '../src/api/routes/docSheet.js'
import { requireDocRole } from '../src/api/guard.js'
import { readLiveSheet } from '../src/collab/liveSheetWrite.js'
import { encodeBaseVersion } from '../src/collab/docBodyEdit.js'
import { encodeSheetCursor } from '../src/api/services/sheetPagination.js'
import { config } from '../src/config/env.js'

// ── mock req/res ────────────────────────────────────────────────────────────
interface MockRes {
  statusCode: number
  body: unknown
  status(c: number): MockRes
  json(b: unknown): MockRes
}
function mockRes(): MockRes {
  return {
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
  }
}
function req(params: Record<string, string>, query: Record<string, string> = {}) {
  return { uid: 'u_1', spaceId: 's1', params, query, headers: {} } as never
}

const sheetGuard = {
  meta: { doc_id: 'd_1', document_name: 'octo:s1:f_default:d_1', doc_type: 'sheet', permission_epoch: 3 },
  role: 'reader',
} as never

/** Build a live-read view ({state, baseSV}) from raw cell + dims maps. */
function liveSheet(
  cells: Record<string, unknown> = {},
  dims: Record<string, number> = {},
  resources: {
    freeze?: Record<string, unknown>
    filters?: Record<string, unknown>
    dataValidations?: Record<string, unknown>
  } = {},
) {
  const doc = new Y.Doc()
  const cellMap = doc.getMap<unknown>(SHEET_YMAP_FIELD)
  const dimMap = doc.getMap<number>(SHEET_DIMS_FIELD)
  doc.transact(() => {
    for (const [k, v] of Object.entries(cells)) cellMap.set(k, v)
    for (const [k, v] of Object.entries(dims)) dimMap.set(k, v)
    for (const [k, v] of Object.entries(resources.freeze ?? {})) doc.getMap(SHEET_FREEZE_FIELD).set(k, v)
    for (const [k, v] of Object.entries(resources.filters ?? {})) doc.getMap(SHEET_FILTERS_FIELD).set(k, v)
    for (const [k, v] of Object.entries(resources.dataValidations ?? {})) {
      doc.getMap(SHEET_DATA_VALIDATIONS_FIELD).set(k, v)
    }
  })
  return { state: Y.encodeStateAsUpdate(doc), baseSV: Y.encodeStateVector(doc) }
}

beforeEach(() => {
  vi.mocked(requireDocRole).mockReset()
  vi.mocked(readLiveSheet).mockReset()
})

// ── role gating ───────────────────────────────────────────────────────────────
describe('role gating (server authority)', () => {
  it('GET /sheet requires reader in the caller space', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(null)
    await getDocSheetHandler(req({ docId: 'd_1' }), mockRes() as never)
    expect(vi.mocked(requireDocRole).mock.calls[0]![3]).toBe('reader')
    // A blocked guard short-circuits before touching the live document.
    expect(vi.mocked(readLiveSheet)).not.toHaveBeenCalled()
  })
})

// ── GET /sheet ────────────────────────────────────────────────────────────────
describe('GET /sheet — live cells + dims + base version', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(sheetGuard))

  it('returns cells, dims, docId, and the matching base version', async () => {
    const view = liveSheet(
      { 'default!0:0': { v: 'A1' }, 'default!1:2': { v: 42, f: '=1+41' } },
      { c0: 120, r3: 40 },
    )
    vi.mocked(readLiveSheet).mockResolvedValue(view)

    const res = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }), res as never)

    expect(res.statusCode).toBe(200)
    const body = res.body as {
      docId: string
      sheetCells: Record<string, SheetCell>
      sheetDims: Record<string, number>
      baseVersion: string
    }
    expect(body.docId).toBe('d_1')
    expect(body.sheetCells).toEqual({ 'default!0:0': { v: 'A1' }, 'default!1:2': { v: 42, f: '=1+41' } })
    expect(body.sheetDims).toEqual({ c0: 120, r3: 40 })
    expect(body.baseVersion).toBe(encodeBaseVersion(view.baseSV))
    // Reads the live doc by its canonical name.
    expect(vi.mocked(readLiveSheet).mock.calls[0]![0]).toBe('octo:s1:f_default:d_1')
  })

  it('returns empty maps for a blank sheet', async () => {
    vi.mocked(readLiveSheet).mockResolvedValue(liveSheet({}, {}))

    const res = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }), res as never)

    expect(res.statusCode).toBe(200)
    const body = res.body as {
      sheetCells: object
      sheetDims: object
      sheetFreeze: object
      sheetFilters: object
      sheetDataValidations: object
    }
    expect(body.sheetCells).toEqual({})
    expect(body.sheetDims).toEqual({})
    expect(body.sheetFreeze).toEqual({})
    expect(body.sheetFilters).toEqual({})
    expect(body.sheetDataValidations).toEqual({})
  })

  it('returns freeze, filter, and dropdown/data-validation resources', async () => {
    const range = { startRow: 0, startColumn: 0, endRow: 9, endColumn: 1 }
    vi.mocked(readLiveSheet).mockResolvedValue(liveSheet({}, {}, {
      freeze: { default: { startRow: 1, startColumn: 0, xSplit: 0, ySplit: 1 } },
      filters: {
        default: {
          ref: range,
          filterColumns: [{ colId: 1, filters: { filters: ['open'] } }],
          enabledColumns: [0, 1],
        },
      },
      dataValidations: {
        'default!bot-status': {
          uid: 'bot-status',
          type: 'listMultiple',
          formula1: '["待处理","处理中"]',
          formula2: '#9ec5fe,#ffd8a8',
          showDropDown: true,
          renderMode: 2,
          ranges: [range],
        },
      },
    }))

    const res = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }), res as never)

    expect(res.statusCode).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.sheetFreeze).toEqual({ default: { startRow: 1, startColumn: -1, xSplit: 0, ySplit: 1 } })
    expect(body.sheetFilters).toEqual({
      default: {
        ref: range,
        filterColumns: [{ colId: 1, filters: { filters: ['open'] } }],
        enabledColumns: [0, 1],
      },
    })
    expect(body.sheetDataValidations).toEqual({
      default: [{
        uid: 'bot-status', type: 'listMultiple', formula1: '["待处理","处理中"]',
        formula2: '#9ec5fe,#ffd8a8', showDropDown: true, renderMode: 2, ranges: [range],
      }],
    })
  })

  it('returns checkbox validation rules with the live sheet state', async () => {
    const doc = new Y.Doc()
    doc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD).set('default', { name: 'Sheet1', order: 0 })
    doc.getMap<StoredDataValidation>(SHEET_DATA_VALIDATIONS_FIELD).set('default!checkbox-a1', {
      uid: 'checkbox-a1',
      type: 'checkbox',
      formula1: '1',
      formula2: '0',
      allowBlank: true,
      ranges: [{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 }],
    })
    const state = Y.encodeStateAsUpdate(doc)
    const view = { state, baseSV: Y.encodeStateVector(doc) }
    vi.mocked(readLiveSheet).mockResolvedValue(view)

    const res = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }), res as never)

    expect(res.statusCode).toBe(200)
    expect((res.body as { sheetDataValidations: Record<string, StoredDataValidation[]> }).sheetDataValidations)
      .toEqual({
        default: [{
          uid: 'checkbox-a1',
          type: 'checkbox',
          formula1: '1',
          formula2: '0',
          allowBlank: true,
          ranges: [{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 }],
        }],
      })
  })

  it('ignores checkbox rules orphaned by a removed sheet', async () => {
    const doc = new Y.Doc()
    doc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD).set('default', { name: 'Sheet1', order: 0 })
    doc.getMap<StoredDataValidation>(SHEET_DATA_VALIDATIONS_FIELD).set('deleted!checkbox-a1', {
      uid: 'checkbox-a1',
      type: 'checkbox',
      ranges: [{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 }],
    })
    const state = Y.encodeStateAsUpdate(doc)
    vi.mocked(readLiveSheet).mockResolvedValue({ state, baseSV: Y.encodeStateVector(doc) })

    const res = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }), res as never)

    expect(res.statusCode).toBe(200)
    expect((res.body as { sheetDataValidations: Record<string, unknown> }).sheetDataValidations).toEqual({})
  })

  it('fails closed with 409 when a cell violates the {v,f,s} contract', async () => {
    // A hostile cell carrying an unexpected field must not be serialized to the
    // client — decodeSheetSnapshot throws SheetSnapshotInvalidError -> 409.
    vi.mocked(readLiveSheet).mockResolvedValue(liveSheet({ 'default!0:0': { evil: 1 } }))

    const res = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }), res as never)

    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ error: 'sheet_snapshot_invalid' })
  })

  it('returns 500 when the live read fails', async () => {
    vi.mocked(readLiveSheet).mockRejectedValue(new Error('boom'))

    const res = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }), res as never)

    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({ error: 'internal_error' })
  })
})

// ── non-sheet doc_type ──────────────────────────────────────────────────────────
describe('doc_type gate', () => {
  it('rejects a non-sheet target with 409 unsupported_doc_type', async () => {
    vi.mocked(requireDocRole).mockResolvedValue({
      meta: { doc_id: 'd_1', document_name: 'octo:s1:f_default:d_1', doc_type: 'doc', permission_epoch: 1 },
      role: 'reader',
    } as never)

    const res = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }), res as never)

    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ error: 'unsupported_doc_type' })
    // The doc_type gate short-circuits before any live read.
    expect(vi.mocked(readLiveSheet)).not.toHaveBeenCalled()
  })
})

// ── large-sheet guard (1MB) ─────────────────────────────────────────────────────
describe('large-sheet read guard', () => {
  const original = config.sheetRead.maxCellBytes
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(sheetGuard))
  afterEach(() => {
    config.sheetRead.maxCellBytes = original
  })

  it('returns 413 sheet_too_large when the decoded payload exceeds the cap', async () => {
    // Lower the cap so the test stays fast and deterministic instead of building
    // a real >1MB grid; the guard logic is identical.
    config.sheetRead.maxCellBytes = 200
    const cells: Record<string, SheetCell> = {}
    for (let r = 0; r < 40; r++) cells[`default!${r}:0`] = { v: `row-${r}-value` }
    vi.mocked(readLiveSheet).mockResolvedValue(liveSheet(cells))

    const res = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }), res as never)

    expect(res.statusCode).toBe(413)
    const body = res.body as { error: string; payloadBytes: number; limit: number }
    expect(body.error).toBe('sheet_too_large')
    expect(body.limit).toBe(200)
    expect(body.payloadBytes).toBeGreaterThan(200)
  })

  it('returns a repair key and base version when checkbox inspection exceeds its work budget', async () => {
    const doc = new Y.Doc()
    doc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD).set('default', { name: 'Sheet1', order: 0 })
    const repeatedColumn = { startRow: 0, startColumn: 0, endRow: 999, endColumn: 0 }
    for (const [index, suffix] of ['a', 'b', 'c'].entries()) {
      doc.getMap<StoredDataValidation>(SHEET_DATA_VALIDATIONS_FIELD).set(`default!${suffix}`, {
        uid: suffix,
        type: 'checkbox',
        ranges: Array.from({ length: 1000 }, () => ({
          ...repeatedColumn,
          startColumn: index,
          endColumn: index,
        })),
      })
    }
    const view = { state: Y.encodeStateAsUpdate(doc), baseSV: Y.encodeStateVector(doc) }
    vi.mocked(readLiveSheet).mockResolvedValue(view)

    const res = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }), res as never)

    expect(res.statusCode).toBe(413)
    expect(res.body).toEqual({
      error: 'sheet_too_large',
      baseVersion: encodeBaseVersion(view.baseSV),
      repairDataValidationKey: 'default!c',
      hint: 'delete the returned checkbox validation key with PATCH, then retry the read',
    })
    expect(vi.mocked(readLiveSheet)).toHaveBeenCalledOnce()
  })

  it('serves a sheet that sits just under the cap', async () => {
    config.sheetRead.maxCellBytes = 1024 * 1024
    vi.mocked(readLiveSheet).mockResolvedValue(liveSheet({ 'default!0:0': { v: 'ok' } }))

    const res = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }), res as never)

    expect(res.statusCode).toBe(200)
  })
})

// ── paginated read (?limit / ?cursor) ────────────────────────────────────────
describe('paginated sheet read', () => {
  const originalBytes = config.sheetRead.maxCellBytes
  const originalDefault = config.sheetRead.defaultPageLimit
  const originalMax = config.sheetRead.maxPageLimit
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(sheetGuard))
  afterEach(() => {
    config.sheetRead.maxCellBytes = originalBytes
    config.sheetRead.defaultPageLimit = originalDefault
    config.sheetRead.maxPageLimit = originalMax
  })

  /** A 10-row single-column sheet, cells default!0:0 .. default!9:0. */
  function tenRowSheet() {
    const cells: Record<string, SheetCell> = {}
    for (let r = 0; r < 10; r++) cells[`default!${r}:0`] = { v: `row-${r}` }
    return cells
  }

  it('?limit=N returns the first page, dims, baseVersion, hasMore, and a nextCursor', async () => {
    const view = liveSheet(tenRowSheet(), { c0: 120 })
    vi.mocked(readLiveSheet).mockResolvedValue(view)

    const res = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }, { limit: '3' }), res as never)

    expect(res.statusCode).toBe(200)
    const body = res.body as {
      docId: string
      sheetCells: Record<string, SheetCell>
      sheetDims: Record<string, number>
      baseVersion: string
      hasMore: boolean
      nextCursor: string | null
    }
    expect(Object.keys(body.sheetCells)).toEqual(['default!0:0', 'default!1:0', 'default!2:0'])
    // dims come back on the first page.
    expect(body.sheetDims).toEqual({ c0: 120 })
    expect(body.baseVersion).toBe(encodeBaseVersion(view.baseSV))
    expect(body.hasMore).toBe(true)
    expect(typeof body.nextCursor).toBe('string')
  })

  it('following nextCursor returns the next page and omits dims', async () => {
    const view = liveSheet(tenRowSheet(), { c0: 120 })
    vi.mocked(readLiveSheet).mockResolvedValue(view)

    const first = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }, { limit: '3' }), first as never)
    const nextCursor = (first.body as { nextCursor: string }).nextCursor

    const second = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }, { limit: '3', cursor: nextCursor }), second as never)

    expect(second.statusCode).toBe(200)
    const body = second.body as { sheetCells: Record<string, SheetCell>; sheetDims?: object }
    expect(Object.keys(body.sheetCells)).toEqual(['default!3:0', 'default!4:0', 'default!5:0'])
    // dims are first-page-only.
    expect(body.sheetDims).toBeUndefined()
  })

  it('walks the whole sheet across pages with no gap or overlap', async () => {
    vi.mocked(readLiveSheet).mockResolvedValue(liveSheet(tenRowSheet()))

    const seen: string[] = []
    let cursor: string | null = null
    let guard = 0
    for (;;) {
      const res = mockRes()
      const query: Record<string, string> = { limit: '4' }
      if (cursor) query.cursor = cursor
      await getDocSheetHandler(req({ docId: 'd_1' }, query), res as never)
      const body = res.body as { sheetCells: Record<string, SheetCell>; hasMore: boolean; nextCursor: string | null }
      seen.push(...Object.keys(body.sheetCells))
      if (!body.hasMore) break
      cursor = body.nextCursor
      if (++guard > 50) throw new Error('did not terminate')
    }
    expect(seen.length).toBe(10)
    expect(new Set(seen).size).toBe(10)
  })

  it('a large sheet is paginated instead of 413 (the read wall is lifted)', async () => {
    // Same oversized grid that the whole-sheet read rejects with 413 — under a
    // small cap, paginated mode serves it a page at a time with a 200.
    config.sheetRead.maxCellBytes = 400
    const cells: Record<string, SheetCell> = {}
    for (let r = 0; r < 40; r++) cells[`default!${r}:0`] = { v: `row-${r}-value` }
    vi.mocked(readLiveSheet).mockResolvedValue(liveSheet(cells))

    const res = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }, { limit: '100' }), res as never)

    expect(res.statusCode).toBe(200)
    const body = res.body as { sheetCells: Record<string, SheetCell>; hasMore: boolean }
    // The byte cap bounded the page well below the full 40 cells.
    expect(Object.keys(body.sheetCells).length).toBeLessThan(40)
    expect(body.hasMore).toBe(true)
  })

  it('rejects a cursor whose snapshot moved with 409 sheet_changed', async () => {
    vi.mocked(readLiveSheet).mockResolvedValue(liveSheet(tenRowSheet()))
    // A well-formed cursor pinned to a baseVersion that is not the live one.
    const staleCursor = encodeSheetCursor({ v: 'STALE_BASE_VERSION==', k: 'default!2:0' })

    const res = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }, { limit: '3', cursor: staleCursor }), res as never)

    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ error: 'sheet_changed' })
  })

  it('rejects a malformed cursor with 400 invalid_cursor', async () => {
    vi.mocked(readLiveSheet).mockResolvedValue(liveSheet(tenRowSheet()))

    const res = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }, { cursor: '!!!not-a-cursor!!!' }), res as never)

    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_cursor' })
  })

  it('rejects a non-integer / non-positive limit with 400 invalid_limit', async () => {
    vi.mocked(readLiveSheet).mockResolvedValue(liveSheet(tenRowSheet()))

    for (const bad of ['0', '-1', 'abc', '1.5']) {
      const res = mockRes()
      await getDocSheetHandler(req({ docId: 'd_1' }, { limit: bad }), res as never)
      expect(res.statusCode).toBe(400)
      expect(res.body).toEqual({ error: 'invalid_limit' })
    }
  })

  it('clamps a limit above the max down to maxPageLimit', async () => {
    config.sheetRead.maxPageLimit = 5
    vi.mocked(readLiveSheet).mockResolvedValue(liveSheet(tenRowSheet()))

    const res = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }, { limit: '1000' }), res as never)

    expect(res.statusCode).toBe(200)
    const body = res.body as { sheetCells: Record<string, SheetCell>; hasMore: boolean }
    expect(Object.keys(body.sheetCells).length).toBe(5)
    expect(body.hasMore).toBe(true)
  })

  it('first page counts sheetDims against the byte cap so cells+dims stay within it (P1-b)', async () => {
    // Small cap; a chunky dims map eats most of it. Before the fix the cells
    // budget ignored dims, so the first page (cells + dims) could exceed the cap.
    config.sheetRead.maxCellBytes = 500
    const dims: Record<string, number> = {}
    for (let c = 0; c < 20; c++) dims[`c${c}`] = 120 + c
    vi.mocked(readLiveSheet).mockResolvedValue(liveSheet(tenRowSheet(), dims))

    const res = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }, { limit: '100' }), res as never)

    expect(res.statusCode).toBe(200)
    const body = res.body as {
      sheetCells: Record<string, SheetCell>
      sheetDims: Record<string, number>
      hasMore: boolean
    }
    // The complete first-page response (not only cells + dims) must stay within the cap.
    const firstPageBytes = Buffer.byteLength(JSON.stringify(res.body))
    expect(firstPageBytes).toBeLessThanOrEqual(config.sheetRead.maxCellBytes)
    // Dims still returned on the first page, and the walk still makes progress.
    expect(body.sheetDims).toEqual(dims)
    expect(body.hasMore).toBe(true)
  })

  it('returns 413 when first-page worksheet metadata alone exceeds the byte cap', async () => {
    config.sheetRead.maxCellBytes = 200
    vi.mocked(readLiveSheet).mockResolvedValue(liveSheet({}, {}, {
      dataValidations: {
        'default!large': {
          uid: 'large',
          type: 'list',
          formula1: JSON.stringify(['x'.repeat(300)]),
          ranges: [{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 }],
        },
      },
    }))

    const res = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }, { limit: '10' }), res as never)

    expect(res.statusCode).toBe(413)
    expect(res.body).toMatchObject({ error: 'sheet_too_large', limit: 200 })
  })

  it('returns 413 rather than forcing one oversized cell into a paginated response', async () => {
    config.sheetRead.maxCellBytes = 200
    vi.mocked(readLiveSheet).mockResolvedValue(liveSheet({
      'default!0:0': { v: 'x'.repeat(500) },
    }))

    const res = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }, { limit: '10' }), res as never)

    expect(res.statusCode).toBe(413)
    expect(res.body).toMatchObject({ error: 'sheet_too_large', limit: 200 })
  })

  it('fits the complete first-page response under the cap without checkbox rules', async () => {
    const cells = {
      'default!0:0': { v: 'a'.repeat(100) },
      'default!1:0': { v: 'b'.repeat(100) },
      'default!2:0': { v: 'c'.repeat(100) },
    }
    const view = liveSheet(cells)
    const baseVersion = encodeBaseVersion(view.baseSV)
    const firstKey = 'default!0:0'
    const oneCellPage = {
      docId: 'd_1',
      sheetCells: { [firstKey]: cells[firstKey] },
      baseVersion,
      hasMore: true,
      nextCursor: encodeSheetCursor({ v: baseVersion, k: firstKey }),
      sheetDims: {},
      sheetHyperLinks: {},
      sheetMerges: {},
      sheetList: {},
      sheetFreeze: {},
      sheetFilters: {},
      sheetDataValidations: {},
    }
    config.sheetRead.maxCellBytes = Buffer.byteLength(JSON.stringify(oneCellPage))
    expect(Buffer.byteLength(JSON.stringify({
      ...oneCellPage,
      sheetCells: {
        [firstKey]: cells[firstKey],
        'default!1:0': cells['default!1:0'],
      },
      nextCursor: encodeSheetCursor({ v: baseVersion, k: 'default!1:0' }),
    }))).toBeGreaterThan(config.sheetRead.maxCellBytes)
    vi.mocked(readLiveSheet).mockResolvedValue(view)

    const res = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }, { limit: '3' }), res as never)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual(oneCellPage)
    expect(Buffer.byteLength(JSON.stringify(res.body))).toBeLessThanOrEqual(config.sheetRead.maxCellBytes)
  })

  it('fits the complete continuation-page response under the cap', async () => {
    const cells = {
      'default!0:0': { v: 'a'.repeat(100) },
      'default!1:0': { v: 'b'.repeat(100) },
      'default!2:0': { v: 'c'.repeat(100) },
    }
    const view = liveSheet(cells)
    const baseVersion = encodeBaseVersion(view.baseSV)
    const firstKey = 'default!0:0'
    const secondKey = 'default!1:0'
    const oneCellPage = {
      docId: 'd_1',
      sheetCells: { [secondKey]: cells[secondKey] },
      baseVersion,
      hasMore: true,
      nextCursor: encodeSheetCursor({ v: baseVersion, k: secondKey }),
    }
    config.sheetRead.maxCellBytes = Buffer.byteLength(JSON.stringify(oneCellPage))
    expect(Buffer.byteLength(JSON.stringify({
      ...oneCellPage,
      sheetCells: {
        [secondKey]: cells[secondKey],
        'default!2:0': cells['default!2:0'],
      },
      hasMore: false,
      nextCursor: null,
    }))).toBeGreaterThan(config.sheetRead.maxCellBytes)
    vi.mocked(readLiveSheet).mockResolvedValue(view)

    const res = mockRes()
    await getDocSheetHandler(
      req({ docId: 'd_1' }, { limit: '3', cursor: encodeSheetCursor({ v: baseVersion, k: firstKey }) }),
      res as never,
    )

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual(oneCellPage)
    expect(Buffer.byteLength(JSON.stringify(res.body))).toBeLessThanOrEqual(config.sheetRead.maxCellBytes)
  })

  it('returns a repairable 413 when checkbox metadata makes the final first page exceed the cap', async () => {
    config.sheetRead.maxCellBytes = 300
    const doc = new Y.Doc()
    doc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD).set('default', { name: 'Sheet1', order: 0 })
    doc.getMap<StoredDataValidation>(SHEET_DATA_VALIDATIONS_FIELD).set('default!checkbox-a1', {
      uid: 'checkbox-a1',
      type: 'checkbox',
      allowBlank: true,
      error: 'x'.repeat(250),
      ranges: [{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 }],
    })
    const view = { state: Y.encodeStateAsUpdate(doc), baseSV: Y.encodeStateVector(doc) }
    vi.mocked(readLiveSheet).mockResolvedValue(view)

    const res = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }, { limit: '100' }), res as never)

    expect(res.statusCode).toBe(413)
    expect(res.body).toMatchObject({
      error: 'sheet_too_large',
      limit: 300,
      baseVersion: encodeBaseVersion(view.baseSV),
      repairDataValidationKey: 'default!checkbox-a1',
    })
    expect((res.body as { payloadBytes: number }).payloadBytes).toBeGreaterThan(300)
  })

  it('does not offer checkbox repair when the first cell still cannot fit after deletion', async () => {
    const doc = new Y.Doc()
    const firstKey = 'default!0:0'
    const cells = { [firstKey]: { v: 'x'.repeat(500) } }
    const sheetList = { default: { name: 'Sheet1', order: 0 } }
    const validationKey = 'default!checkbox-a1'
    const rule: StoredDataValidation = {
      uid: 'checkbox-a1',
      type: 'checkbox',
      allowBlank: true,
      ranges: [{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 }],
    }
    doc.getMap(SHEET_YMAP_FIELD).set(firstKey, cells[firstKey])
    doc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD).set('default', sheetList.default)
    doc.getMap<StoredDataValidation>(SHEET_DATA_VALIDATIONS_FIELD).set(validationKey, rule)
    const view = { state: Y.encodeStateAsUpdate(doc), baseSV: Y.encodeStateVector(doc) }
    const baseVersion = encodeBaseVersion(view.baseSV)
    const metadataWithoutValidations = {
      docId: 'd_1',
      sheetCells: {},
      baseVersion,
      hasMore: false,
      nextCursor: null,
      sheetDims: {},
      sheetHyperLinks: {},
      sheetMerges: {},
      sheetList,
      sheetFreeze: {},
      sheetFilters: {},
      sheetDataValidations: {},
    }
    config.sheetRead.maxCellBytes = Buffer.byteLength(JSON.stringify(metadataWithoutValidations)) + 10
    expect(Buffer.byteLength(JSON.stringify({
      ...metadataWithoutValidations,
      sheetDataValidations: { default: [rule] },
    }))).toBeGreaterThan(config.sheetRead.maxCellBytes)
    expect(Buffer.byteLength(JSON.stringify({
      ...metadataWithoutValidations,
      sheetCells: cells,
    }))).toBeGreaterThan(config.sheetRead.maxCellBytes)
    vi.mocked(readLiveSheet).mockResolvedValue(view)

    const res = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }, { limit: '1' }), res as never)

    expect(res.statusCode).toBe(413)
    expect(res.body).toMatchObject({
      error: 'sheet_too_large',
      hint: 'the next sheet cell exceeds the paginated read limit',
    })
    expect(res.body).not.toHaveProperty('repairDataValidationKey')
    expect(res.body).not.toHaveProperty('baseVersion')
  })

  it('shrinks a checkbox first page before asking the caller to delete valid metadata', async () => {
    config.sheetRead.maxCellBytes = 500
    const doc = new Y.Doc()
    for (let row = 0; row < 20; row++) {
      doc.getMap<unknown>(SHEET_YMAP_FIELD).set(`default!${row}:0`, { v: `row-${row}` })
    }
    doc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD).set('default', { name: 'Sheet1', order: 0 })
    doc.getMap<StoredDataValidation>(SHEET_DATA_VALIDATIONS_FIELD).set('default!checkbox-a1', {
      uid: 'checkbox-a1',
      type: 'checkbox',
      allowBlank: true,
      ranges: [{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 }],
    })
    vi.mocked(readLiveSheet).mockResolvedValue({
      state: Y.encodeStateAsUpdate(doc),
      baseSV: Y.encodeStateVector(doc),
    })

    const res = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }, { limit: '100' }), res as never)

    expect(res.statusCode).toBe(200)
    expect(Object.keys((res.body as { sheetCells: object }).sheetCells).length).toBeGreaterThan(0)
    expect(Object.keys((res.body as { sheetCells: object }).sheetCells).length).toBeLessThan(20)
    expect(res.body).toMatchObject({
      hasMore: true,
      nextCursor: expect.any(String),
      sheetDataValidations: { default: [expect.any(Object)] },
    })
    expect(Buffer.byteLength(JSON.stringify(res.body))).toBeLessThanOrEqual(500)
  })

  it('does not offer checkbox deletion when other first-page metadata already exceeds the cap', async () => {
    config.sheetRead.maxCellBytes = 300
    const doc = new Y.Doc()
    doc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD).set('default', {
      name: 'x'.repeat(400),
      order: 0,
    })
    doc.getMap<StoredDataValidation>(SHEET_DATA_VALIDATIONS_FIELD).set('default!checkbox-a1', {
      uid: 'checkbox-a1',
      type: 'checkbox',
      allowBlank: true,
      ranges: [{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 }],
    })
    vi.mocked(readLiveSheet).mockResolvedValue({
      state: Y.encodeStateAsUpdate(doc),
      baseSV: Y.encodeStateVector(doc),
    })

    const res = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }, { limit: '100' }), res as never)

    expect(res.statusCode).toBe(413)
    expect(res.body).toMatchObject({
      error: 'sheet_too_large',
      hint: 'sheet metadata exceeds the paginated read limit',
    })
    expect(res.body).not.toHaveProperty('repairDataValidationKey')
    expect(res.body).not.toHaveProperty('baseVersion')
  })

  it('reports first-page metadata overflow when there are no checkbox rules or cells', async () => {
    config.sheetRead.maxCellBytes = 300
    const doc = new Y.Doc()
    doc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD).set('default', {
      name: 'x'.repeat(400),
      order: 0,
    })
    vi.mocked(readLiveSheet).mockResolvedValue({
      state: Y.encodeStateAsUpdate(doc),
      baseSV: Y.encodeStateVector(doc),
    })

    const res = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }, { limit: '100' }), res as never)

    expect(res.statusCode).toBe(413)
    expect(res.body).toMatchObject({
      error: 'sheet_too_large',
      hint: 'sheet metadata exceeds the paginated read limit',
    })
    expect(res.body).not.toHaveProperty('repairDataValidationKey')
  })

  it('offers checkbox repair when metadata blocks a one-cell terminal page with a long state vector', async () => {
    const doc = new Y.Doc()
    const firstKey = 'default!0:0'
    const cells = { [firstKey]: { v: 'x'.repeat(500) } }
    const sheetList = { default: { name: 'Sheet1', order: 0 } }
    const validationKey = 'default!checkbox-a1'
    const rule: StoredDataValidation = {
      uid: 'checkbox-a1',
      type: 'checkbox',
      allowBlank: true,
      ranges: [{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 }],
    }
    for (let index = 0; index < 30; index++) {
      const client = new Y.Doc()
      client.getMap('state-vector-padding').set(String(index), index)
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(client))
    }
    for (const [key, cell] of Object.entries(cells)) doc.getMap(SHEET_YMAP_FIELD).set(key, cell)
    doc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD).set('default', sheetList.default)
    doc.getMap<StoredDataValidation>(SHEET_DATA_VALIDATIONS_FIELD).set(validationKey, rule)
    const view = { state: Y.encodeStateAsUpdate(doc), baseSV: Y.encodeStateVector(doc) }
    const baseVersion = encodeBaseVersion(view.baseSV)
    const minimalPageWithoutValidations = {
      docId: 'd_1',
      sheetCells: { [firstKey]: cells[firstKey] },
      baseVersion,
      hasMore: false,
      nextCursor: null,
      sheetDims: {},
      sheetHyperLinks: {},
      sheetMerges: {},
      sheetList,
      sheetFreeze: {},
      sheetFilters: {},
      sheetDataValidations: {},
    }
    config.sheetRead.maxCellBytes = Buffer.byteLength(JSON.stringify(minimalPageWithoutValidations))
    expect(Buffer.byteLength(JSON.stringify({
      ...minimalPageWithoutValidations,
      sheetCells: {},
      sheetDataValidations: { default: [rule] },
    }))).toBeLessThanOrEqual(config.sheetRead.maxCellBytes)
    vi.mocked(readLiveSheet).mockResolvedValue(view)

    const res = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }, { limit: '1' }), res as never)

    expect(res.statusCode).toBe(413)
    expect(res.body).toMatchObject({
      error: 'sheet_too_large',
      baseVersion,
      repairDataValidationKey: validationKey,
    })
  })

  it('re-paginates without checkbox metadata before deciding whether repair can restore the page', async () => {
    const doc = new Y.Doc()
    const logicalId = 's'.repeat(64)
    const firstKey = `${logicalId}!0:0`
    const secondKey = `${logicalId}!1:0`
    const cells = { [firstKey]: { v: 'a' }, [secondKey]: { v: 'b' } }
    const sheetList = { [logicalId]: { name: 'Sheet1', order: 0 } }
    const validationKey = `${logicalId}!c`
    const rule: StoredDataValidation = {
      uid: 'c',
      type: 'checkbox',
      allowBlank: true,
      ranges: [{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 }],
    }
    for (const [key, cell] of Object.entries(cells)) doc.getMap(SHEET_YMAP_FIELD).set(key, cell)
    doc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD).set(logicalId, sheetList[logicalId])
    doc.getMap<StoredDataValidation>(SHEET_DATA_VALIDATIONS_FIELD).set(validationKey, rule)
    const view = { state: Y.encodeStateAsUpdate(doc), baseSV: Y.encodeStateVector(doc) }
    const baseVersion = encodeBaseVersion(view.baseSV)
    const repairedTerminalPage = {
      docId: 'd_1',
      sheetCells: cells,
      baseVersion,
      hasMore: false,
      nextCursor: null,
      sheetDims: {},
      sheetHyperLinks: {},
      sheetMerges: {},
      sheetList,
      sheetFreeze: {},
      sheetFilters: {},
      sheetDataValidations: {},
    }
    config.sheetRead.maxCellBytes = Buffer.byteLength(JSON.stringify(repairedTerminalPage))
    const staleOneCellProbe = {
      ...repairedTerminalPage,
      sheetCells: { [firstKey]: cells[firstKey] },
      hasMore: true,
      nextCursor: encodeSheetCursor({ v: baseVersion, k: firstKey }),
    }
    expect(Buffer.byteLength(JSON.stringify(staleOneCellProbe))).toBeGreaterThan(
      config.sheetRead.maxCellBytes,
    )
    vi.mocked(readLiveSheet).mockResolvedValue(view)

    const res = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }, { limit: '2' }), res as never)

    expect(res.statusCode).toBe(413)
    expect(res.body).toMatchObject({
      error: 'sheet_too_large',
      baseVersion,
      repairDataValidationKey: validationKey,
    })
  })

  it('offers checkbox repair when only a smaller post-delete prefix fits', async () => {
    const doc = new Y.Doc()
    const cells = {
      'default!0:0': { v: 'a'.repeat(100) },
      'default!1:0': { v: 'b'.repeat(100) },
      'default!2:0': { v: 'c'.repeat(100) },
    }
    const sheetList = { default: { name: 'Sheet1', order: 0 } }
    const validationKey = 'default!checkbox-a1'
    const rule: StoredDataValidation = {
      uid: 'checkbox-a1',
      type: 'checkbox',
      allowBlank: true,
      ranges: [{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 }],
    }
    for (const [key, cell] of Object.entries(cells)) doc.getMap(SHEET_YMAP_FIELD).set(key, cell)
    doc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD).set('default', sheetList.default)
    doc.getMap<StoredDataValidation>(SHEET_DATA_VALIDATIONS_FIELD).set(validationKey, rule)
    const view = { state: Y.encodeStateAsUpdate(doc), baseSV: Y.encodeStateVector(doc) }
    const baseVersion = encodeBaseVersion(view.baseSV)
    const firstKey = 'default!0:0'
    const oneCellPageWithoutValidations = {
      docId: 'd_1',
      sheetCells: { [firstKey]: cells[firstKey] },
      baseVersion,
      hasMore: true,
      nextCursor: encodeSheetCursor({ v: baseVersion, k: firstKey }),
      sheetDims: {},
      sheetHyperLinks: {},
      sheetMerges: {},
      sheetList,
      sheetFreeze: {},
      sheetFilters: {},
      sheetDataValidations: {},
    }
    config.sheetRead.maxCellBytes = Buffer.byteLength(JSON.stringify(oneCellPageWithoutValidations))
    expect(Buffer.byteLength(JSON.stringify({
      ...oneCellPageWithoutValidations,
      sheetCells: {
        [firstKey]: cells[firstKey],
        'default!1:0': cells['default!1:0'],
      },
      nextCursor: encodeSheetCursor({ v: baseVersion, k: 'default!1:0' }),
    }))).toBeGreaterThan(config.sheetRead.maxCellBytes)
    expect(Buffer.byteLength(JSON.stringify({
      ...oneCellPageWithoutValidations,
      sheetCells: {},
      hasMore: false,
      nextCursor: null,
      sheetDataValidations: { default: [rule] },
    }))).toBeLessThanOrEqual(config.sheetRead.maxCellBytes)
    vi.mocked(readLiveSheet).mockResolvedValue(view)

    const res = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }, { limit: '3' }), res as never)

    expect(res.statusCode).toBe(413)
    expect(res.body).toMatchObject({
      error: 'sheet_too_large',
      baseVersion,
      repairDataValidationKey: validationKey,
    })
  })

  it('subsequent pages keep the full byte budget (dims omitted, not reserved)', async () => {
    // With dims charged only to the first page, page two must NOT keep reserving
    // their bytes — it gets the whole cap for cells. Use a sheet large enough that
    // the byte budget (not the cell supply) bounds BOTH pages, so the comparison
    // reflects the budget difference rather than the sheet running out.
    config.sheetRead.maxCellBytes = 500
    const cells: Record<string, SheetCell> = {}
    for (let r = 0; r < 40; r++) cells[`default!${r}:0`] = { v: `row-${r}` }
    const dims: Record<string, number> = {}
    for (let c = 0; c < 20; c++) dims[`c${c}`] = 120 + c
    vi.mocked(readLiveSheet).mockResolvedValue(liveSheet(cells, dims))

    const first = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }, { limit: '100' }), first as never)
    const firstBody = first.body as { sheetCells: Record<string, SheetCell>; nextCursor: string | null }
    expect(firstBody.nextCursor).not.toBeNull()

    const second = mockRes()
    await getDocSheetHandler(
      req({ docId: 'd_1' }, { limit: '100', cursor: firstBody.nextCursor! }),
      second as never,
    )
    const secondBody = second.body as { sheetCells: Record<string, SheetCell>; sheetDims?: object }
    expect(secondBody.sheetDims).toBeUndefined()
    // Page two, freed of the dims reservation, fits more cells than the first page.
    expect(Object.keys(secondBody.sheetCells).length).toBeGreaterThan(
      Object.keys(firstBody.sheetCells).length,
    )
  })
})

// ── write-gate-bypass oversized sheet: whole-read 413 but fully paginable ──────
//
// The core regression for this surface. A sheet whose READ PAYLOAD genuinely
// exceeds maxCellBytes is not reachable through editDocSheet's PATCH write gate
// (it aligns the write cap to the read cap so every written sheet stays
// whole-read-readable). It IS reachable by seeding the live Y.Doc directly —
// exactly what a version-restore of a historic oversized snapshot or a bulk
// import does. liveSheet() builds the Y.Doc straight from raw cell maps, so it
// stands in for those write-gate-bypass paths.
//
// The guarantee under test: such a sheet whole-reads 413 sheet_too_large (RED),
// yet a paginated read walks every one of its cells page by page (GREEN). No
// cell is stranded behind the whole-read wall. Uses the REAL default 1 MB cap
// (not a lowered one) so the payload is TRULY over maxCellBytes.
describe('write-gate-bypass oversized sheet is whole-read 413 but fully paginable', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(sheetGuard))

  const CELL_COUNT = 1200
  /**
   * A single-column sheet whose decoded {sheetCells, sheetDims} JSON is > 1 MB.
   * Each value is ~1 KB, so 1200 cells clears the default maxCellBytes (1 MB)
   * with headroom — a genuinely oversized read payload, measured for real.
   */
  function oversizedSheet(): Record<string, SheetCell> {
    const cells: Record<string, SheetCell> = {}
    for (let r = 0; r < CELL_COUNT; r++) {
      cells[`default!${r}:0`] = { v: `${r}-${'x'.repeat(1000)}` }
    }
    return cells
  }

  it('whole-read (no params) returns 413 sheet_too_large reporting payloadBytes over the 1 MB cap', async () => {
    const cells = oversizedSheet()
    // Sanity: the payload is truly over the default read cap before we assert.
    const realBytes = Buffer.byteLength(JSON.stringify({ sheetCells: cells, sheetDims: {} }))
    expect(realBytes).toBeGreaterThan(config.sheetRead.maxCellBytes)

    vi.mocked(readLiveSheet).mockResolvedValue(liveSheet(cells))

    const res = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }), res as never)

    expect(res.statusCode).toBe(413)
    const body = res.body as { error: string; payloadBytes: number; limit: number; hint: string }
    expect(body.error).toBe('sheet_too_large')
    expect(body.limit).toBe(config.sheetRead.maxCellBytes)
    expect(body.payloadBytes).toBeGreaterThan(config.sheetRead.maxCellBytes)
    // The 413 tells the caller how to retrieve it.
    expect(body.hint).toContain('?limit=')
  })

  it('paginated read walks the whole oversized sheet page by page (every cell, no gap/overlap, each page under the cap)', async () => {
    const cells = oversizedSheet()
    vi.mocked(readLiveSheet).mockResolvedValue(liveSheet(cells))

    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    let sawMultiplePages = false
    for (;;) {
      const res = mockRes()
      // A limit far above maxPageLimit is clamped; the byte cap governs regardless.
      const query: Record<string, string> = { limit: '100000' }
      if (cursor) query.cursor = cursor
      await getDocSheetHandler(req({ docId: 'd_1' }, query), res as never)

      expect(res.statusCode).toBe(200)
      const body = res.body as {
        sheetCells: Record<string, SheetCell>
        sheetDims?: Record<string, number>
        hasMore: boolean
        nextCursor: string | null
      }
      // No page may exceed the whole-read cap (cells + dims on page one).
      const pageBytes = Buffer.byteLength(
        JSON.stringify({ sheetCells: body.sheetCells, sheetDims: body.sheetDims ?? {} }),
      )
      expect(pageBytes).toBeLessThanOrEqual(config.sheetRead.maxCellBytes)

      seen.push(...Object.keys(body.sheetCells))
      if (!body.hasMore) break
      sawMultiplePages = true
      cursor = body.nextCursor
      if (++pages > 100) throw new Error('pagination did not terminate')
    }

    // Every cell of the oversized sheet came back, exactly once — the whole-read
    // 413 wall did not strand any cell.
    expect(seen.length).toBe(CELL_COUNT)
    expect(new Set(seen).size).toBe(CELL_COUNT)
    // A >1 MB sheet under a 1 MB per-page cap must span more than one page.
    expect(sawMultiplePages).toBe(true)
  })
})
