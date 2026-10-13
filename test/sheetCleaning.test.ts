import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'

vi.mock('../src/collab/liveSheetWrite.js', () => ({ readLiveSheet: vi.fn(), commitLiveSheetEdit: vi.fn() }))
vi.mock('../src/api/services/editDocSheet.js', () => ({ editDocSheet: vi.fn() }))

import { planSheetCleaning, cleanDocSheet, type SheetCleaningOptions } from '../src/api/services/cleanDocSheet.js'
import { readLiveSheet } from '../src/collab/liveSheetWrite.js'
import { editDocSheet } from '../src/api/services/editDocSheet.js'

const range = { startRow: 0, startColumn: 0, endRow: 2, endColumn: 0 }
const split: SheetCleaningOptions = { logicalId: 'default', range, mode: 'split', delimiter: ',' }
let doc: Y.Doc
beforeEach(() => {
  vi.clearAllMocks()
  doc = new Y.Doc()
  doc.getMap('sheet').set('default!0:0', { v: '001,,=SUM(A1),12345678901234567890', s: { bg: { rgb: '#fff' } } })
  doc.getMap('sheet').set('default!1:0', { v: '2,3' })
  vi.mocked(readLiveSheet).mockImplementation(async () => ({ state: Y.encodeStateAsUpdate(doc), baseSV: Y.encodeStateVector(doc) }))
  vi.mocked(editDocSheet).mockResolvedValue({ ok: true, bytes: 42, baseVersion: 'next', newDocVersionSeq: 1 })
})

describe('sheet cleaning plans', () => {
  it('preserves leading zeros, empty fields, long numbers and formula-looking text', () => {
    const plan = planSheetCleaning(doc, split)
    expect(plan.cells['default!0:0']).toEqual({ v: '001', t: 2, s: { bg: { rgb: '#fff' }, n: { pattern: '@' } } })
    expect(plan.cells['default!0:1']?.v).toBe('')
    expect(plan.cells['default!0:2']).toEqual({ v: '=SUM(A1)', t: 2, s: { n: { pattern: '@' } } })
    expect(plan.cells['default!0:3']?.v).toBe('12345678901234567890')
    expect(plan.cells).not.toHaveProperty('default!2:3')
    expect(doc.getMap('sheet').get('default!0:0')).toHaveProperty('v', '001,,=SUM(A1),12345678901234567890')
  })

  it('keeps unused split padding absent, but preserves literal empty fields and clears occupied padding', () => {
    doc.getMap('sheet').set('default!1:0', { v: 'short,' })
    doc.getMap('sheet').set('default!1:3', { v: 'old', s: { bg: { rgb: 'red' } } })
    const plan = planSheetCleaning(doc, split)
    expect(plan.cells['default!1:1']).toEqual({ v: '', t: 2, s: { n: { pattern: '@' } } })
    expect(plan.cells).not.toHaveProperty('default!1:2')
    expect(plan.cells).not.toHaveProperty('default!2:0')
    expect(plan.cells['default!1:3']).toEqual({ v: null, s: { bg: { rgb: 'red' } } })
    expect(plan.overwrittenCells).toBe(1)
  })

  it('uses deterministic rather than host-locale case folding', () => {
    doc.getMap('sheet').set('default!0:0', { v: 'I' })
    doc.getMap('sheet').set('default!1:0', { v: 'i' })
    const localeLowerCase = String.prototype.toLocaleLowerCase
    const localeFold = vi.spyOn(String.prototype, 'toLocaleLowerCase').mockImplementation(function (this: string) {
      return localeLowerCase.call(this, 'tr')
    })
    try {
      expect(planSheetCleaning(doc, { ...split, mode: 'deduplicate' }).removedRows).toBe(1)
      expect(localeFold).not.toHaveBeenCalled()
    } finally {
      localeFold.mockRestore()
    }
  })

  it('compacts only selected values, keeps first records and blank rows, and leaves styles at coordinates', () => {
    doc.getMap('sheet').set('default!0:0', { v: 'Name' })
    doc.getMap('sheet').set('default!1:0', { v: 'Alice', s: { bg: { rgb: 'red' } } })
    doc.getMap('sheet').set('default!2:0', { v: 'alice', s: { bg: { rgb: 'blue' } } })
    doc.getMap('sheet').set('default!4:0', { v: 'Bob' })
    const plan = planSheetCleaning(doc, { ...split, range: { ...range, endRow: 4 }, mode: 'deduplicate', header: true })
    expect(plan.removedRows).toBe(1)
    expect(plan.cells['default!2:0']).toEqual({ v: null, s: { bg: { rgb: 'blue' } } })
    expect(plan.cells['default!3:0']?.v).toBe('Bob')
    expect(plan.cells['default!4:0']?.v).toBeNull()
    expect(planSheetCleaning(doc, { ...split, range: { ...range, endRow: 4 }, mode: 'deduplicate', caseSensitive: true }).removedRows).toBe(0)
  })

  it.each([
    ['sheetDrawings', 'default!image', {}],
    ['sheetHyperLinks', 'default!link', {}],
    ['sheetDataValidations', 'default!validation', {}],
    ['sheetCommentAnchors', 'thread', 'default!0:0'],
    ['sheetFilters', 'default', {}],
    ['sheetMerges', 'default:0:1:0:2', true],
  ])('refuses unsafe resources in %s', (field, key, value) => {
    doc.getMap(field as string).set(key as string, value)
    expect(() => planSheetCleaning(doc, split)).toThrow()
  })

  it('does not treat number formatting as a literal delimiter', () => {
    doc.getMap('sheet').set('default!0:0', { v: 1234, s: { n: { pattern: '#,##0' } } })
    expect(() => planSheetCleaning(doc, { ...split, range: { ...range, endRow: 0 } })).toThrow('cleaning_delimiter_not_found')
  })

  it('bounds input, split expansion, formula sources and worksheet coordinates', () => {
    expect(() => planSheetCleaning(doc, { ...split, range: { ...range, endRow: 9999, endColumn: 2 } })).toThrow('too_many_cells')
    doc.getMap('sheet').set('default!0:0', { v: ','.repeat(20_001) })
    expect(() => planSheetCleaning(doc, split)).toThrow('too_many_cells')
    doc.getMap('sheet').set('default!0:0', { v: 'a,b', f: '=A1' })
    expect(() => planSheetCleaning(doc, split)).toThrow('cleaning_formula_unsupported')
    expect(() => planSheetCleaning(doc, { ...split, logicalId: 'missing' })).toThrow('sheet_not_found')
  })
})

function input() {
  return { ...split, uid: 'writer', docId: 'doc', documentName: 'doc', principalSpaceId: 'space', authorizedEpoch: 7,
    clientBaseVersion: Y.encodeStateVector(doc), isAdmin: false, preview: true, overwrite: false }
}

describe('cleaning preview and application', () => {
  it.each(['split', 'deduplicate'] as const)('refuses rich-text %s preview and apply without changing the complete payload', async (mode) => {
    const rich = { v: 'fallback', t: 1, p: { body: { dataStream: 'Rich,text\r\n', textRuns: [{ st: 0, ed: 4, ts: { bl: 1 } }] } } }
    doc.getMap('sheet').set('default!0:0', rich)
    const before = Y.encodeStateAsUpdate(doc)
    for (const preview of [true, false]) {
      expect(await cleanDocSheet({ ...input(), mode, preview, overwrite: true })).toEqual({ ok: false, status: 422, error: 'cleaning_complex_sheet' })
      expect(editDocSheet).not.toHaveBeenCalled()
      expect(doc.getMap('sheet').get('default!0:0')).toEqual(rich)
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
    }
  })

  it('previews without writing and refuses stale source or destination versions', async () => {
    const original = input()
    expect(await cleanDocSheet(original)).toMatchObject({ ok: true, preview: true, columns: 4 })
    expect(editDocSheet).not.toHaveBeenCalled()
    doc.getMap('sheet').set('default!0:1', { v: 'concurrent' })
    expect(await cleanDocSheet({ ...original, preview: false, overwrite: true })).toMatchObject({ ok: false, error: 'base_version_stale' })
    expect(editDocSheet).not.toHaveBeenCalled()
  })

  it('requires explicit overwrite consent and routes one batch through the guarded edit service', async () => {
    doc.getMap('sheet').set('default!0:1', { v: 'keep' })
    expect(await cleanDocSheet(input())).toMatchObject({ ok: true, overwrittenCells: 1 })
    expect(await cleanDocSheet({ ...input(), preview: false })).toMatchObject({ error: 'cleaning_overwrite_required' })
    expect(editDocSheet).not.toHaveBeenCalled()
    expect(await cleanDocSheet({ ...input(), preview: false, overwrite: true })).toMatchObject({ ok: true, preview: false, baseVersion: 'next' })
    expect(editDocSheet).toHaveBeenCalledTimes(1)
    expect(editDocSheet).toHaveBeenCalledWith(expect.objectContaining({ authorizedEpoch: 7, clientBaseVersion: Y.encodeStateVector(doc) }))
  })

  it('preserves authoritative commit failures rather than claiming success', async () => {
    vi.mocked(editDocSheet).mockResolvedValue({ ok: false, status: 412, error: 'base_version_stale' })
    expect(await cleanDocSheet({ ...input(), preview: false })).toMatchObject({ ok: false, status: 412 })
  })

  it('rejects a protected destination even during preview', async () => {
    doc.getMap('sheetProtection').set('default!lock', { permissionId: 'lock', ranges: [{ ...range, endColumn: 3 }] })
    expect(await cleanDocSheet(input())).toMatchObject({ ok: false, error: 'protected_range' })
    expect(editDocSheet).not.toHaveBeenCalled()
  })
})
