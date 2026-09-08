import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Y from 'yjs'
import {
  SHEET_YMAP_FIELD,
  SHEET_DIMS_FIELD,
  SHEET_LIST_FIELD,
  SHEET_DATA_VALIDATIONS_FIELD,
  type SheetCell,
  type StoredDataValidation,
  type StoredSheetMeta,
} from '../src/agent/sheetConversion.js'

// Offline unit test (mirrors docContent.test.ts): mock the auth guard, the MySQL
// pool, and the live-document boundary. editDocSheet's batch validation + the
// safety-snapshot orchestration run for real against the mocked live read.
vi.mock('../src/api/guard.js', () => ({ requireDocRole: vi.fn() }))
vi.mock('../src/db/pool.js', () => ({ query: vi.fn(async () => []), transaction: vi.fn() }))
vi.mock('../src/collab/liveSheetWrite.js', () => ({
  readLiveSheet: vi.fn(),
  commitLiveSheetEdit: vi.fn(),
}))

import { patchDocSheetHandler } from '../src/api/routes/docSheet.js'
import { requireDocRole } from '../src/api/guard.js'
import { transaction } from '../src/db/pool.js'
import { readLiveSheet, commitLiveSheetEdit } from '../src/collab/liveSheetWrite.js'
import { docVersionRepo, KIND_RESTORE_MARKER } from '../src/db/repos/docVersionRepo.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import { encodeBaseVersion, parseBaseVersion, BaseVersionStaleError } from '../src/collab/docBodyEdit.js'
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
function req(
  params: Record<string, string>,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
) {
  return { uid: 'u_1', spaceId: 's1', params, body: opts.body, headers: opts.headers ?? {} } as never
}

const writerGuard = {
  meta: { doc_id: 'd_1', document_name: 'octo:s1:f_default:d_1', doc_type: 'sheet', permission_epoch: 7 },
  role: 'writer',
} as never

/** A live sheet ({state, baseSV}) built from raw cell + dims maps. */
function liveSheet(
  cells: Record<string, unknown> = {},
  dims: Record<string, number> = {},
  withDefaultTab = false,
  dataValidations: Record<string, StoredDataValidation> = {},
) {
  const doc = new Y.Doc()
  const cellMap = doc.getMap<unknown>(SHEET_YMAP_FIELD)
  const dimMap = doc.getMap<number>(SHEET_DIMS_FIELD)
  doc.transact(() => {
    for (const [k, v] of Object.entries(cells)) cellMap.set(k, v)
    for (const [k, v] of Object.entries(dims)) dimMap.set(k, v)
    if (withDefaultTab) {
      doc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD).set('default', { name: 'Sheet1', order: 0 })
    }
    for (const [k, v] of Object.entries(dataValidations)) {
      doc.getMap<StoredDataValidation>(SHEET_DATA_VALIDATIONS_FIELD).set(k, v)
    }
  })
  return { state: Y.encodeStateAsUpdate(doc), baseSV: Y.encodeStateVector(doc) }
}

/** transaction() mock routing SQL to a metaRow; role recheck spied separately. */
function mockTx(metaRow: { owner_id: string; permission_epoch: number; status: number } | null) {
  vi.mocked(transaction).mockImplementation(async (fn: never) => {
    const tx = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM yjs_document')) return []
        if (sql.includes('FROM doc_meta')) return metaRow ? [metaRow] : []
        return []
      }),
    }
    return (fn as unknown as (t: typeof tx) => Promise<unknown>)(tx)
  })
}

const okMeta = { owner_id: 'u_1', permission_epoch: 7, status: 1 }
/** A body whose baseVersion matches the given live view's state vector. */
function bodyFor(view: { baseSV: Uint8Array }, cells: Record<string, SheetCell | null>) {
  return { baseVersion: encodeBaseVersion(view.baseSV), cells }
}

beforeEach(() => {
  vi.mocked(requireDocRole).mockReset()
  vi.mocked(transaction).mockReset()
  vi.mocked(readLiveSheet).mockReset()
  vi.mocked(commitLiveSheetEdit).mockReset()
})

// ── role gating ───────────────────────────────────────────────────────────────
describe('role gating (server authority)', () => {
  it('PATCH /sheet requires writer in the caller space', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(null)
    await patchDocSheetHandler(req({ docId: 'd_1' }), mockRes() as never)
    expect(vi.mocked(requireDocRole).mock.calls[0]![3]).toBe('writer')
    // A blocked guard short-circuits before touching the live document.
    expect(vi.mocked(readLiveSheet)).not.toHaveBeenCalled()
  })
})

// ── doc_type gate (gate b: sheet allowed here, non-sheet rejected) ──────────────
describe('doc_type gate', () => {
  it('rejects a non-sheet target with 409 unsupported_doc_type', async () => {
    vi.mocked(requireDocRole).mockResolvedValue({
      meta: { doc_id: 'd_1', document_name: 'octo:s1:f_default:d_1', doc_type: 'doc', permission_epoch: 1 },
      role: 'writer',
    } as never)

    const res = mockRes()
    await patchDocSheetHandler(
      req({ docId: 'd_1' }, { body: { baseVersion: 'x', cells: { 'default!0:0': { v: 1 } } } }),
      res as never,
    )

    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ error: 'unsupported_doc_type' })
    expect(vi.mocked(readLiveSheet)).not.toHaveBeenCalled()
  })
})

// ── request-shape validation ────────────────────────────────────────────────────
describe('request shape', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(writerGuard))

  it('400 when baseVersion (If-Match / body) is absent', async () => {
    const res = mockRes()
    await patchDocSheetHandler(req({ docId: 'd_1' }, { body: { cells: { 'default!0:0': { v: 1 } } } }), res as never)
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_body' })
    expect(vi.mocked(readLiveSheet)).not.toHaveBeenCalled()
  })

  it('400 when cells is missing, empty, or not an object', async () => {
    for (const cells of [undefined, {}, [], 'x']) {
      const res = mockRes()
      await patchDocSheetHandler(req({ docId: 'd_1' }, { body: { baseVersion: 'v', cells } }), res as never)
      expect(res.statusCode).toBe(400)
      expect(res.body).toEqual({ error: 'invalid_body' })
    }
    expect(vi.mocked(readLiveSheet)).not.toHaveBeenCalled()
  })

  it('accepts the base version from the If-Match header', async () => {
    const view = liveSheet()
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    vi.mocked(commitLiveSheetEdit).mockResolvedValue({ newSV: Y.encodeStateVector(new Y.Doc()), bytes: 12 })
    vi.spyOn(docVersionRepo, 'createTx').mockResolvedValue(5)
    mockTx(okMeta)

    const token = encodeBaseVersion(view.baseSV)
    const res = mockRes()
    await patchDocSheetHandler(
      req({ docId: 'd_1' }, { body: { cells: { 'default!0:0': { v: 1 } } }, headers: { 'if-match': `"${token}"` } }),
      res as never,
    )

    expect(res.statusCode).toBe(200)
    // The guard compared the CLIENT token, quotes stripped.
    expect(vi.mocked(commitLiveSheetEdit).mock.calls[0]![2]).toEqual(parseBaseVersion(token))
  })

  it('413 too_many_cells when the batch exceeds the cap', async () => {
    const original = config.sheetWrite.maxCells
    config.sheetWrite.maxCells = 2
    try {
      const res = mockRes()
      const cells = { 'default!0:0': { v: 1 }, 'default!0:1': { v: 2 }, 'default!0:2': { v: 3 } }
      await patchDocSheetHandler(req({ docId: 'd_1' }, { body: { baseVersion: 'v', cells } }), res as never)
      expect(res.statusCode).toBe(413)
      expect(res.body).toEqual({ error: 'too_many_cells' })
      expect(vi.mocked(readLiveSheet)).not.toHaveBeenCalled()
    } finally {
      config.sheetWrite.maxCells = original
    }
  })

  it('413 too_many_data_validations when the checkbox-rule batch exceeds its cap', async () => {
    const original = config.sheetWrite.maxDataValidations
    config.sheetWrite.maxDataValidations = 2
    try {
      const res = mockRes()
      const dataValidations = {
        'default!checkbox-1': null,
        'default!checkbox-2': null,
        'default!checkbox-3': null,
      }
      await patchDocSheetHandler(req({ docId: 'd_1' }, {
        body: { baseVersion: 'v', dataValidations },
      }), res as never)
      expect(res.statusCode).toBe(413)
      expect(res.body).toEqual({ error: 'too_many_data_validations' })
      expect(vi.mocked(readLiveSheet)).not.toHaveBeenCalled()
    } finally {
      config.sheetWrite.maxDataValidations = original
    }
  })

  it('413 cell_too_large when a single cell payload exceeds the cap', async () => {
    const original = config.sheetWrite.maxCellContentBytes
    config.sheetWrite.maxCellContentBytes = 20
    try {
      const res = mockRes()
      const cells = { 'default!0:0': { v: 'x'.repeat(100) } }
      await patchDocSheetHandler(req({ docId: 'd_1' }, { body: { baseVersion: 'v', cells } }), res as never)
      expect(res.statusCode).toBe(413)
      expect(res.body).toEqual({ error: 'cell_too_large' })
    } finally {
      config.sheetWrite.maxCellContentBytes = original
    }
  })
})

// ── happy path: batch write + safety snapshot ────────────────────────────────────
describe('PATCH /sheet — batch write', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(writerGuard))

  it('writes a batch, records a KIND_RESTORE_MARKER safety snapshot, returns the new base version', async () => {
    const view = liveSheet({ 'default!0:0': { v: 'old' } })
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    const newSV = Y.encodeStateVector((() => { const d = new Y.Doc(); d.getMap('x').set('a', 1); return d })())
    vi.mocked(commitLiveSheetEdit).mockResolvedValue({ newSV, bytes: 321 })
    const createSpy = vi.spyOn(docVersionRepo, 'createTx').mockResolvedValue(42)
    mockTx(okMeta)

    const res = mockRes()
    const cells = { 'default!0:0': { v: 'new', f: '=1', s: { bold: true } }, 'default!1:1': { v: 7 } }
    await patchDocSheetHandler(req({ docId: 'd_1' }, { body: bodyFor(view, cells) }), res as never)

    expect(res.statusCode).toBe(200)
    const body = res.body as { docId: string; bytes: number; baseVersion: string; newDocVersionSeq: number }
    expect(body.docId).toBe('d_1')
    expect(body.bytes).toBe(321)
    expect(body.baseVersion).toBe(encodeBaseVersion(newSV))
    expect(body.newDocVersionSeq).toBe(42)

    // Safety snapshot is a KIND_RESTORE_MARKER of the PRE-edit state.
    expect(createSpy).toHaveBeenCalledTimes(1)
    const snap = createSpy.mock.calls[0]![1]
    expect(snap.kind).toBe(KIND_RESTORE_MARKER)
    expect(snap.state).toBe(view.state)
    // commitLiveSheetEdit got the acting uid + the whole batch.
    expect(vi.mocked(commitLiveSheetEdit).mock.calls[0]![1]).toBe('u_1')
    expect(vi.mocked(commitLiveSheetEdit).mock.calls[0]![3]).toEqual(cells)
  })

  it('supports deleting a cell with a null value', async () => {
    const view = liveSheet({ 'default!0:0': { v: 'gone' } })
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    vi.mocked(commitLiveSheetEdit).mockResolvedValue({ newSV: Y.encodeStateVector(new Y.Doc()), bytes: 10 })
    vi.spyOn(docVersionRepo, 'createTx').mockResolvedValue(1)
    mockTx(okMeta)

    const res = mockRes()
    const cells = { 'default!0:0': null }
    await patchDocSheetHandler(req({ docId: 'd_1' }, { body: bodyFor(view, cells) }), res as never)

    expect(res.statusCode).toBe(200)
    expect(vi.mocked(commitLiveSheetEdit).mock.calls[0]![3]).toEqual(cells)
  })

  it('creates a checkbox rule and forwards its normalized batch to the live commit', async () => {
    const view = liveSheet({}, {}, true)
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    vi.mocked(commitLiveSheetEdit).mockResolvedValue({ newSV: Y.encodeStateVector(new Y.Doc()), bytes: 10 })
    vi.spyOn(docVersionRepo, 'createTx').mockResolvedValue(2)
    mockTx(okMeta)

    const dataValidations = {
      'default!checkbox-a1': {
        uid: 'checkbox-a1',
        type: 'checkbox',
        formula1: '1',
        formula2: '0',
        allowBlank: true,
        ranges: [{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 }],
      },
    }
    const res = mockRes()
    await patchDocSheetHandler(req({ docId: 'd_1' }, {
      body: { baseVersion: encodeBaseVersion(view.baseSV), dataValidations },
    }), res as never)

    expect(res.statusCode).toBe(200)
    expect(vi.mocked(commitLiveSheetEdit).mock.calls[0]![11]).toEqual(dataValidations)
  })

  it('accepts a resources-only batch and forwards freeze, filters, and dropdown rules atomically', async () => {
    const view = liveSheet()
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    vi.mocked(commitLiveSheetEdit).mockResolvedValue({ newSV: Y.encodeStateVector(new Y.Doc()), bytes: 64 })
    vi.spyOn(docVersionRepo, 'createTx').mockResolvedValue(2)
    mockTx(okMeta)

    const range = { startRow: 0, startColumn: 0, endRow: 10, endColumn: 1 }
    const freeze = { default: { startRow: 1, startColumn: -1, xSplit: 0, ySplit: 1 } }
    const filters = {
      default: {
        ref: range,
        filterColumns: [{ colId: 1, filters: { filters: ['open'] } }],
        enabledColumns: [0, 1],
      },
    }
    const dataValidations = {
      default: [{
        uid: 'bot-status',
        type: 'listMultiple',
        formula1: '["待处理","处理中"]',
        formula2: '#9ec5fe,#ffd8a8',
        showDropDown: true,
        renderMode: 2,
        ranges: [range],
      }],
    }
    const res = mockRes()
    await patchDocSheetHandler(req({ docId: 'd_1' }, { body: {
      baseVersion: encodeBaseVersion(view.baseSV),
      freeze,
      filters,
      dataValidations,
    } }), res as never)

    expect(res.statusCode).toBe(200)
    const call = vi.mocked(commitLiveSheetEdit).mock.calls[0]!
    expect(call[3]).toEqual({})
    expect(call[9]).toEqual(freeze)
    expect(call[10]).toEqual(filters)
    expect(call[11]).toEqual(dataValidations)
  })

  it('rejects malformed P0 resource ranges before taking a safety snapshot', async () => {
    const view = liveSheet()
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    const createSpy = vi.spyOn(docVersionRepo, 'createTx')
    const res = mockRes()
    await patchDocSheetHandler(req({ docId: 'd_1' }, { body: {
      baseVersion: encodeBaseVersion(view.baseSV),
      filters: {
        default: { ref: { startRow: 0, startColumn: 0, endRow: 1000, endColumn: 1 } },
      },
    } }), res as never)

    expect(res.statusCode).toBe(422)
    expect(res.body).toEqual({ error: 'sheet_cell_invalid' })
    expect(createSpy).not.toHaveBeenCalled()
    expect(vi.mocked(commitLiveSheetEdit)).not.toHaveBeenCalled()
  })

  it('rejects allowBlank=false instead of silently changing the requested checkbox rule', async () => {
    const view = liveSheet({}, {}, true)
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    mockTx(okMeta)

    const res = mockRes()
    await patchDocSheetHandler(req({ docId: 'd_1' }, {
      body: {
        baseVersion: encodeBaseVersion(view.baseSV),
        dataValidations: {
          'default!checkbox-a1': {
            uid: 'checkbox-a1',
            type: 'checkbox',
            allowBlank: false,
            ranges: [{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 }],
          },
        },
      },
    }), res as never)

    expect(res.statusCode).toBe(422)
    expect(commitLiveSheetEdit).not.toHaveBeenCalled()
  })

  it('allows a cell edit when stored checkbox rules reference a deleted sheet', async () => {
    const view = liveSheet({}, {}, true, {
      'deleted!checkbox-a1': {
        uid: 'checkbox-a1',
        type: 'checkbox',
        ranges: [{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 }],
      },
    })
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    vi.mocked(commitLiveSheetEdit).mockResolvedValue({ newSV: Y.encodeStateVector(new Y.Doc()), bytes: 10 })
    vi.spyOn(docVersionRepo, 'createTx').mockResolvedValue(3)
    mockTx(okMeta)

    const res = mockRes()
    await patchDocSheetHandler(req({ docId: 'd_1' }, {
      body: bodyFor(view, { 'default!0:0': { v: 'still writable' } }),
    }), res as never)

    expect(res.statusCode).toBe(200)
    expect(vi.mocked(commitLiveSheetEdit)).toHaveBeenCalledOnce()
  })

  it('rejects a non-checkbox validation before taking a snapshot or writing live state', async () => {
    const view = liveSheet({}, {}, true)
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    const createSpy = vi.spyOn(docVersionRepo, 'createTx')
    const res = mockRes()
    await patchDocSheetHandler(req({ docId: 'd_1' }, {
      body: {
        baseVersion: encodeBaseVersion(view.baseSV),
        dataValidations: {
          'default!list-a1': {
            uid: 'list-a1',
            type: 'list',
            ranges: [{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 }],
          },
        },
      },
    }), res as never)

    expect(res.statusCode).toBe(422)
    expect(res.body).toEqual({ error: 'sheet_cell_invalid' })
    expect(createSpy).not.toHaveBeenCalled()
    expect(vi.mocked(commitLiveSheetEdit)).not.toHaveBeenCalled()
  })
})

// ── optimistic concurrency + safety contract ─────────────────────────────────────
describe('optimistic concurrency & safety contract', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(writerGuard))

  it('412 base_version_stale in the pre-flight when the token no longer matches', async () => {
    const view = liveSheet({ 'default!0:0': { v: 1 } })
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    const createSpy = vi.spyOn(docVersionRepo, 'createTx')
    mockTx(okMeta)

    // A stale token (empty-doc SV) != the live view's SV.
    const stale = encodeBaseVersion(Y.encodeStateVector(new Y.Doc()))
    const res = mockRes()
    await patchDocSheetHandler(
      req({ docId: 'd_1' }, { body: { baseVersion: stale, cells: { 'default!0:0': { v: 2 } } } }),
      res as never,
    )

    expect(res.statusCode).toBe(412)
    expect(res.body).toEqual({ error: 'base_version_stale' })
    // No snapshot row and no live write on a pre-flight conflict.
    expect(createSpy).not.toHaveBeenCalled()
    expect(vi.mocked(commitLiveSheetEdit)).not.toHaveBeenCalled()
  })

  it('412 base_version_stale from the live guard compensates the safety snapshot', async () => {
    const view = liveSheet({ 'default!0:0': { v: 1 } })
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    // Pre-flight passes; the authoritative in-transact guard rejects a drift.
    vi.mocked(commitLiveSheetEdit).mockRejectedValue(new BaseVersionStaleError())
    vi.spyOn(docVersionRepo, 'createTx').mockResolvedValue(77)
    const delSpy = vi.spyOn(docVersionRepo, 'deleteById').mockResolvedValue(undefined)
    mockTx(okMeta)

    const res = mockRes()
    await patchDocSheetHandler(
      req({ docId: 'd_1' }, { body: bodyFor(view, { 'default!0:0': { v: 2 } }) }),
      res as never,
    )

    expect(res.statusCode).toBe(412)
    expect(res.body).toEqual({ error: 'base_version_stale' })
    // The orphan safety snapshot is compensating-deleted.
    expect(delSpy).toHaveBeenCalledWith(77)
  })

  it('409 epoch_changed when permission_epoch moved under the lock', async () => {
    const view = liveSheet()
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    const createSpy = vi.spyOn(docVersionRepo, 'createTx')
    mockTx({ owner_id: 'u_1', permission_epoch: 8, status: 1 }) // 8 != authorizedEpoch 7

    const res = mockRes()
    await patchDocSheetHandler(
      req({ docId: 'd_1' }, { body: bodyFor(view, { 'default!0:0': { v: 1 } }) }),
      res as never,
    )

    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ error: 'epoch_changed' })
    expect(createSpy).not.toHaveBeenCalled()
    expect(vi.mocked(commitLiveSheetEdit)).not.toHaveBeenCalled()
  })

  it('403 forbidden when the re-checked role is below writer', async () => {
    const view = liveSheet()
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    mockTx({ owner_id: 'someone_else', permission_epoch: 7, status: 1 })
    vi.spyOn(docMemberRepo, 'getRoleTx').mockResolvedValue('reader')

    const res = mockRes()
    await patchDocSheetHandler(
      req({ docId: 'd_1' }, { body: bodyFor(view, { 'default!0:0': { v: 1 } }) }),
      res as never,
    )

    expect(res.statusCode).toBe(403)
    expect(res.body).toEqual({ error: 'forbidden' })
    expect(vi.mocked(commitLiveSheetEdit)).not.toHaveBeenCalled()
  })

  it('404 not_found when the row is missing/deleted under the lock', async () => {
    const view = liveSheet()
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    mockTx({ owner_id: 'u_1', permission_epoch: 7, status: 0 })

    const res = mockRes()
    await patchDocSheetHandler(req({ docId: 'd_1' }, { body: bodyFor(view, { 'default!0:0': { v: 1 } }) }), res as never)
    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
  })
})

// ── cumulative size gate (P1-A): reject an oversized result BEFORE the live commit ─
describe('cumulative size gate', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(writerGuard))

  it('413 doc_too_large when the post-edit Y.Doc would exceed maxDocBytes, before any snapshot/commit', async () => {
    const view = liveSheet({ 'default!0:0': { v: 'seed' } })
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    const createSpy = vi.spyOn(docVersionRepo, 'createTx')
    mockTx(okMeta)

    // A tiny persistence cap: the encoded scratch Y.Doc (seed + new cells) is a
    // few hundred bytes, so the pre-flight size gate must reject the batch as a
    // 413 rather than let commitLiveSheetEdit broadcast then fail on store.
    const original = config.maxDocBytes
    config.maxDocBytes = 40
    try {
      const res = mockRes()
      const cells = { 'default!0:0': { v: 'a much larger replacement value' }, 'default!1:1': { v: 'more' } }
      await patchDocSheetHandler(req({ docId: 'd_1' }, { body: bodyFor(view, cells) }), res as never)

      expect(res.statusCode).toBe(413)
      const body = res.body as { error: string; docBytes: number; limit: number }
      expect(body.error).toBe('doc_too_large')
      // Storage-dimension observability: docBytes over the maxDocBytes limit.
      expect(body.limit).toBe(40)
      expect(body.docBytes).toBeGreaterThan(40)
      // Gated in the no-lock pre-flight: no safety snapshot, no live write/broadcast.
      expect(createSpy).not.toHaveBeenCalled()
      expect(vi.mocked(commitLiveSheetEdit)).not.toHaveBeenCalled()
    } finally {
      config.maxDocBytes = original
    }
  })

  it('413 sheet_too_large when the post-edit payload would exceed the read cap (write-but-not-readable)', async () => {
    const view = liveSheet({ 'default!0:0': { v: 'seed' } })
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    const createSpy = vi.spyOn(docVersionRepo, 'createTx')
    mockTx(okMeta)

    // Align the write cap to the read cap: a batch that would push the decoded
    // {sheetCells,sheetDims} payload past sheetRead.maxCellBytes must 413 here so
    // the written sheet stays GET-readable (no chainable PATCH past the read cap).
    const original = config.sheetRead.maxCellBytes
    config.sheetRead.maxCellBytes = 20
    try {
      const res = mockRes()
      const cells = { 'default!0:0': { v: 'a value well past the tiny read cap' } }
      await patchDocSheetHandler(req({ docId: 'd_1' }, { body: bodyFor(view, cells) }), res as never)

      expect(res.statusCode).toBe(413)
      const body = res.body as { error: string; payloadBytes: number; limit: number }
      expect(body.error).toBe('sheet_too_large')
      // Read-payload-dimension observability, the SAME field name the read gate
      // (GET /:docId/sheet) emits — write/read 413 bodies are consistent.
      expect(body.limit).toBe(20)
      expect(body.payloadBytes).toBeGreaterThan(20)
      expect(createSpy).not.toHaveBeenCalled()
      expect(vi.mocked(commitLiveSheetEdit)).not.toHaveBeenCalled()
    } finally {
      config.sheetRead.maxCellBytes = original
    }
  })

  it('allows a real validation-only delete that shrinks an already oversized payload', async () => {
    const key = 'default!checkbox-large-a'
    const view = liveSheet({}, {}, true, {
      [key]: {
        uid: 'checkbox-large-a',
        type: 'checkbox',
        allowBlank: true,
        error: 'x'.repeat(1_000),
        ranges: [{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 }],
      },
      'default!checkbox-large-b': {
        uid: 'checkbox-large-b',
        type: 'checkbox',
        allowBlank: true,
        error: 'y'.repeat(1_000),
        ranges: [{ startRow: 1, startColumn: 0, endRow: 1, endColumn: 0 }],
      },
    })
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    vi.mocked(commitLiveSheetEdit).mockResolvedValue({ newSV: Y.encodeStateVector(new Y.Doc()), bytes: 50 })
    vi.spyOn(docVersionRepo, 'createTx').mockResolvedValue(9)
    mockTx(okMeta)

    const original = config.sheetRead.maxCellBytes
    config.sheetRead.maxCellBytes = 400
    try {
      const res = mockRes()
      await patchDocSheetHandler(req({ docId: 'd_1' }, { body: {
        baseVersion: encodeBaseVersion(view.baseSV),
        cells: {},
        dataValidations: { [key]: null },
      } }), res as never)

      expect(res.statusCode).toBe(200)
      expect(vi.mocked(commitLiveSheetEdit)).toHaveBeenCalledOnce()
    } finally {
      config.sheetRead.maxCellBytes = original
    }
  })

  it('allows a validation-only repair even when one deletion leaves inspection over budget', async () => {
    const repeatedColumn = { startRow: 0, startColumn: 0, endRow: 999, endColumn: 0 }
    const validations: Record<string, StoredDataValidation> = {}
    for (const [index, suffix] of ['a', 'b', 'c', 'd'].entries()) {
      validations[`default!${suffix}`] = {
        uid: suffix,
        type: 'checkbox',
        ranges: Array.from({ length: 1000 }, () => ({
          ...repeatedColumn,
          startColumn: index,
          endColumn: index,
        })),
      }
    }
    const view = liveSheet({}, {}, true, validations)
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    vi.mocked(commitLiveSheetEdit).mockResolvedValue({ newSV: Y.encodeStateVector(new Y.Doc()), bytes: 50 })
    vi.spyOn(docVersionRepo, 'createTx').mockResolvedValue(9)
    mockTx(okMeta)

    const res = mockRes()
    await patchDocSheetHandler(req({ docId: 'd_1' }, { body: {
      baseVersion: encodeBaseVersion(view.baseSV),
      cells: {},
      dataValidations: { 'default!c': null },
    } }), res as never)

    expect(res.statusCode).toBe(200)
    expect(vi.mocked(commitLiveSheetEdit)).toHaveBeenCalledOnce()
  })

  it('does not let a validation deletion mixed with a cell edit bypass inspection', async () => {
    const repeatedColumn = { startRow: 0, startColumn: 0, endRow: 999, endColumn: 0 }
    const validations: Record<string, StoredDataValidation> = {}
    for (const [index, suffix] of ['a', 'b', 'c'].entries()) {
      validations[`default!${suffix}`] = {
        uid: suffix,
        type: 'checkbox',
        ranges: Array.from({ length: 1000 }, () => ({
          ...repeatedColumn,
          startColumn: index,
          endColumn: index,
        })),
      }
    }
    const view = liveSheet({}, {}, true, validations)
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    const createSpy = vi.spyOn(docVersionRepo, 'createTx')
    mockTx(okMeta)

    const res = mockRes()
    await patchDocSheetHandler(req({ docId: 'd_1' }, { body: {
      baseVersion: encodeBaseVersion(view.baseSV),
      cells: { 'default!0:0': { v: 'mixed' } },
      dataValidations: { 'default!c': null },
    } }), res as never)

    expect(res.statusCode).toBe(413)
    expect(res.body).toEqual({
      error: 'sheet_too_large',
      baseVersion: encodeBaseVersion(view.baseSV),
      repairDataValidationKey: 'default!c',
      hint: 'delete the returned checkbox validation key with PATCH, then retry the write',
    })
    expect(createSpy).not.toHaveBeenCalled()
    expect(vi.mocked(commitLiveSheetEdit)).not.toHaveBeenCalled()
  })

  it('does not offer a persisted-rule repair for request-induced inspection overflow', async () => {
    const repeatedColumn = { startRow: 0, startColumn: 0, endRow: 999, endColumn: 0 }
    const validations: Record<string, StoredDataValidation> = {}
    for (const [index, suffix] of ['a', 'b'].entries()) {
      validations[`default!${suffix}`] = {
        uid: suffix,
        type: 'checkbox',
        ranges: Array.from({ length: 1000 }, () => ({
          ...repeatedColumn,
          startColumn: index,
          endColumn: index,
        })),
      }
    }
    const view = liveSheet({}, {}, true, validations)
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    const createSpy = vi.spyOn(docVersionRepo, 'createTx')
    mockTx(okMeta)

    const res = mockRes()
    await patchDocSheetHandler(req({ docId: 'd_1' }, { body: {
      baseVersion: encodeBaseVersion(view.baseSV),
      cells: {},
      dataValidations: {
        'default!c': {
          uid: 'c',
          type: 'checkbox',
          ranges: [repeatedColumn],
        },
      },
    } }), res as never)

    expect(res.statusCode).toBe(413)
    expect(res.body).toEqual({
      error: 'sheet_too_large',
      hint: 'reduce or split the checkbox validation changes, then retry',
    })
    expect(createSpy).not.toHaveBeenCalled()
    expect(vi.mocked(commitLiveSheetEdit)).not.toHaveBeenCalled()
  })

  it('does not blame an existing rule when a lexical-earlier request makes a healthy snapshot overflow', async () => {
    const repeatedColumn = (column: number) => ({
      startRow: 0,
      startColumn: column,
      endRow: 999,
      endColumn: column,
    })
    const existing: Record<string, StoredDataValidation> = {}
    for (const [column, uid] of ['b', 'c'].entries()) {
      existing[`default!${uid}`] = {
        uid,
        type: 'checkbox',
        ranges: Array.from({ length: 600 }, () => repeatedColumn(column + 1)),
      }
    }
    const view = liveSheet({}, {}, true, existing)
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    const createSpy = vi.spyOn(docVersionRepo, 'createTx')
    mockTx(okMeta)

    const res = mockRes()
    await patchDocSheetHandler(req({ docId: 'd_1' }, { body: {
      baseVersion: encodeBaseVersion(view.baseSV),
      cells: {},
      dataValidations: {
        'default!a': {
          uid: 'a',
          type: 'checkbox',
          ranges: Array.from({ length: 900 }, () => repeatedColumn(0)),
        },
      },
    } }), res as never)

    expect(res.statusCode).toBe(413)
    expect(res.body).toEqual({
      error: 'sheet_too_large',
      hint: 'reduce or split the checkbox validation changes, then retry',
    })
    expect(createSpy).not.toHaveBeenCalled()
    expect(vi.mocked(commitLiveSheetEdit)).not.toHaveBeenCalled()
  })

  it('rejects a no-op validation delete when the oversized payload does not shrink', async () => {
    const view = liveSheet({}, {}, true, {
      'default!checkbox-large': {
        uid: 'checkbox-large',
        type: 'checkbox',
        allowBlank: true,
        error: 'x'.repeat(1_000),
        ranges: [{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 }],
      },
    })
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    const createSpy = vi.spyOn(docVersionRepo, 'createTx')
    mockTx(okMeta)

    const original = config.sheetRead.maxCellBytes
    config.sheetRead.maxCellBytes = 400
    try {
      const res = mockRes()
      await patchDocSheetHandler(req({ docId: 'd_1' }, { body: {
        baseVersion: encodeBaseVersion(view.baseSV),
        cells: {},
        dataValidations: { 'default!missing': null },
      } }), res as never)

      expect(res.statusCode).toBe(413)
      expect(createSpy).not.toHaveBeenCalled()
      expect(vi.mocked(commitLiveSheetEdit)).not.toHaveBeenCalled()
    } finally {
      config.sheetRead.maxCellBytes = original
    }
  })

  it.each([
    ['an empty validation map', {} as Record<string, StoredDataValidation | null>, {}, 400],
    ['a validation delete mixed with a cell edit', { 'default!checkbox-large': null }, { 'default!0:0': { v: 'changed' } }, 413],
  ])('does not bypass the size gate for %s', async (_label, dataValidations, cells, expectedStatus) => {
    const view = liveSheet({}, {}, true, {
      'default!checkbox-large': {
        uid: 'checkbox-large',
        type: 'checkbox',
        allowBlank: true,
        error: 'x'.repeat(1_000),
        ranges: [{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 }],
      },
    })
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    const createSpy = vi.spyOn(docVersionRepo, 'createTx')
    mockTx(okMeta)

    const original = config.sheetRead.maxCellBytes
    config.sheetRead.maxCellBytes = 100
    try {
      const res = mockRes()
      await patchDocSheetHandler(req({ docId: 'd_1' }, { body: {
        baseVersion: encodeBaseVersion(view.baseSV),
        cells,
        dataValidations,
      } }), res as never)

      expect(res.statusCode).toBe(expectedStatus)
      expect(createSpy).not.toHaveBeenCalled()
      expect(vi.mocked(commitLiveSheetEdit)).not.toHaveBeenCalled()
    } finally {
      config.sheetRead.maxCellBytes = original
    }
  })

  it('accepts a batch that stays within both caps', async () => {
    const view = liveSheet({ 'default!0:0': { v: 'seed' } })
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    vi.mocked(commitLiveSheetEdit).mockResolvedValue({ newSV: Y.encodeStateVector(new Y.Doc()), bytes: 50 })
    vi.spyOn(docVersionRepo, 'createTx').mockResolvedValue(9)
    mockTx(okMeta)

    const res = mockRes()
    await patchDocSheetHandler(
      req({ docId: 'd_1' }, { body: bodyFor(view, { 'default!0:0': { v: 'small' } }) }),
      res as never,
    )

    expect(res.statusCode).toBe(200)
    expect(vi.mocked(commitLiveSheetEdit)).toHaveBeenCalledTimes(1)
  })
})

// ── non-finite cell value (P1-B): reject fail-closed instead of silent null ────────
describe('non-finite cell value', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(writerGuard))

  it('422 sheet_cell_invalid on a non-finite numeric v (Infinity/-Infinity/NaN), before any lock/write', async () => {
    for (const bad of [Infinity, -Infinity, NaN]) {
      const view = liveSheet()
      vi.mocked(readLiveSheet).mockResolvedValue(view)
      const createSpy = vi.spyOn(docVersionRepo, 'createTx')
      mockTx(okMeta)

      const res = mockRes()
      await patchDocSheetHandler(
        req({ docId: 'd_1' }, { body: bodyFor(view, { 'default!0:0': { v: bad } }) }),
        res as never,
      )

      expect(res.statusCode).toBe(422)
      expect(res.body).toEqual({ error: 'sheet_cell_invalid' })
      expect(createSpy).not.toHaveBeenCalled()
      expect(vi.mocked(commitLiveSheetEdit)).not.toHaveBeenCalled()
      createSpy.mockRestore()
    }
  })
})

// ── store-time failure preserves the safety snapshot (P2) ──────────────────────────
describe('compensation delete is scoped to pre-mutation guard errors', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(writerGuard))

  it('keeps the safety snapshot (no compensating delete) + 500 when the live commit fails AFTER the mutation/broadcast', async () => {
    const view = liveSheet({ 'default!0:0': { v: 1 } })
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    // A store-time failure (e.g. persistence.store maxDocBytes overflow / DB error)
    // is thrown AFTER the cell already applied to the shared Y.Doc + broadcast to
    // peers — NOT a mapped pre-mutation guard error.
    vi.mocked(commitLiveSheetEdit).mockRejectedValue(new Error('store overflow after broadcast'))
    vi.spyOn(docVersionRepo, 'createTx').mockResolvedValue(88)
    const delSpy = vi.spyOn(docVersionRepo, 'deleteById').mockResolvedValue(undefined)
    mockTx(okMeta)

    const res = mockRes()
    await patchDocSheetHandler(
      req({ docId: 'd_1' }, { body: bodyFor(view, { 'default!0:0': { v: 2 } }) }),
      res as never,
    )

    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({ error: 'internal_error' })
    // The snapshot is the only undo record for an edit peers have already seen —
    // it MUST be preserved, so no compensating delete on a store-time failure.
    expect(delSpy).not.toHaveBeenCalled()
  })
})

// ── cell contract (fail-closed) ──────────────────────────────────────────────────
describe('cell contract validation', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(writerGuard))

  it('422 sheet_cell_invalid on a cell with an unexpected field, before any lock/write', async () => {
    const view = liveSheet()
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    const createSpy = vi.spyOn(docVersionRepo, 'createTx')
    mockTx(okMeta)

    const res = mockRes()
    await patchDocSheetHandler(
      req({ docId: 'd_1' }, { body: bodyFor(view, { 'default!0:0': { evil: 1 } as never }) }),
      res as never,
    )

    expect(res.statusCode).toBe(422)
    expect(res.body).toEqual({ error: 'sheet_cell_invalid' })
    expect(createSpy).not.toHaveBeenCalled()
    expect(vi.mocked(commitLiveSheetEdit)).not.toHaveBeenCalled()
  })

  it('422 sheet_cell_invalid on a delete keyed by a malformed cell key', async () => {
    const view = liveSheet()
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    mockTx(okMeta)

    const res = mockRes()
    await patchDocSheetHandler(
      req({ docId: 'd_1' }, { body: bodyFor(view, { 'not a cell key': null }) }),
      res as never,
    )

    expect(res.statusCode).toBe(422)
    expect(res.body).toEqual({ error: 'sheet_cell_invalid' })
  })
})
