import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import {
  SHEET_YMAP_FIELD,
  type SheetCell,
} from '../src/agent/sheetConversion.js'

vi.mock('../src/collab/liveSheetWrite.js', () => ({
  readLiveSheet: vi.fn(),
}))
vi.mock('../src/api/services/editDocSheet.js', () => ({
  editDocSheet: vi.fn(),
}))

import { readLiveSheet } from '../src/collab/liveSheetWrite.js'
import { editDocSheet } from '../src/api/services/editDocSheet.js'
import { encodeBaseVersion } from '../src/collab/docBodyEdit.js'
import {
  buildSheetReplacementBatch,
  replaceDocSheet,
} from '../src/api/services/replaceDocSheet.js'
import { config } from '../src/config/env.js'

function liveSheet(cells: Record<string, SheetCell>) {
  const doc = new Y.Doc()
  const cellMap = doc.getMap<SheetCell>(SHEET_YMAP_FIELD)
  doc.transact(() => {
    for (const [key, cell] of Object.entries(cells)) cellMap.set(key, cell)
  })
  return { state: Y.encodeStateAsUpdate(doc), baseSV: Y.encodeStateVector(doc) }
}

const serviceInput = {
  uid: 'u_1',
  docId: 'd_1',
  documentName: 'octo:s1:f_default:d_1',
  principalSpaceId: 's1',
  clientBaseVersion: new Uint8Array(),
  findString: 'old',
  replaceString: 'new',
  findBy: 'value' as const,
  caseSensitive: false,
  matchesTheWholeCell: false,
  authorizedEpoch: 7,
  isBot: true,
}

beforeEach(() => {
  vi.mocked(readLiveSheet).mockReset()
  vi.mocked(editDocSheet).mockReset()
})

describe('buildSheetReplacementBatch', () => {
  it('replaces every matching value in workbook scope and preserves cell metadata', () => {
    const style = { bl: 1 }
    const result = buildSheetReplacementBatch({
      cells: {
        'default!0:0': { v: 'Old old', s: style, t: 1 },
        'detail!0:0': { v: 'old' },
        'detail!1:0': { v: 'other' },
      },
      findString: 'old',
      replaceString: 'new',
      findBy: 'value',
      caseSensitive: false,
      matchesTheWholeCell: false,
    })

    expect(result).toEqual({
      cells: {
        'default!0:0': { v: 'new new', s: style, t: 1 },
        'detail!0:0': { v: 'new' },
      },
      matchedCells: 2,
      replacedCells: 2,
      replacements: 3,
    })
  })

  it('limits replacement to a logical sheet and inclusive 0-based range', () => {
    const result = buildSheetReplacementBatch({
      cells: {
        'default!0:0': { v: 'old' },
        'default!1:1': { v: 'old' },
        'default!2:2': { v: 'old' },
        'detail!1:1': { v: 'old' },
      },
      findString: 'old',
      replaceString: 'new',
      findBy: 'value',
      caseSensitive: false,
      matchesTheWholeCell: false,
      logicalId: 'default',
      range: { startRow: 1, startColumn: 1, endRow: 2, endColumn: 2 },
    })

    expect(Object.keys(result.cells)).toEqual(['default!1:1', 'default!2:2'])
    expect(result.matchedCells).toBe(2)
    expect(result.replacedCells).toBe(2)
  })

  it('matches formula display values without replacing them in value mode', () => {
    const result = buildSheetReplacementBatch({
      cells: { 'default!0:0': { f: '=A1', v: 'old result', s: { bl: 1 } } },
      findString: 'old',
      replaceString: 'new',
      findBy: 'value',
      caseSensitive: false,
      matchesTheWholeCell: false,
    })

    expect(result).toEqual({ cells: {}, matchedCells: 1, replacedCells: 0, replacements: 0 })
  })

  it('replaces formulas and clears their cached value', () => {
    const result = buildSheetReplacementBatch({
      cells: { 'default!0:0': { f: '=SUM(A1,A1)', v: 2, s: { bl: 1 } } },
      findString: 'A1',
      replaceString: 'B2',
      findBy: 'formula',
      caseSensitive: true,
      matchesTheWholeCell: false,
    })

    expect(result.cells['default!0:0']).toEqual({ f: '=SUM(B2,B2)', v: null, s: { bl: 1 } })
    expect(result).toMatchObject({ matchedCells: 1, replacedCells: 1, replacements: 2 })
  })

  it('applies case-sensitive and whole-cell matching with Univer whitespace semantics', () => {
    const whole = buildSheetReplacementBatch({
      cells: {
        'default!0:0': { v: ' old ' },
        'default!1:0': { v: 'Old' },
        'default!2:0': { v: 'old value' },
      },
      findString: ' old ',
      replaceString: 'new',
      findBy: 'value',
      caseSensitive: true,
      matchesTheWholeCell: true,
    })
    expect(whole.cells).toEqual({ 'default!0:0': { v: ' new ' } })

    const insensitive = buildSheetReplacementBatch({
      cells: { 'default!0:0': { v: 'Old OLD' } },
      findString: 'old',
      replaceString: 'new',
      findBy: 'value',
      caseSensitive: false,
      matchesTheWholeCell: false,
    })
    expect(insensitive.cells['default!0:0']).toEqual({ v: 'new new' })
  })

  it('replaces only exact-case substring matches when case sensitivity is enabled', () => {
    const result = buildSheetReplacementBatch({
      cells: { 'default!0:0': { v: 'Old old OLD' } },
      findString: 'old',
      replaceString: 'new',
      findBy: 'value',
      caseSensitive: true,
      matchesTheWholeCell: false,
    })

    expect(result).toEqual({
      cells: { 'default!0:0': { v: 'Old new OLD' } },
      matchedCells: 1,
      replacedCells: 1,
      replacements: 1,
    })
  })

  it('uses Univer string values for numbers and booleans', () => {
    const result = buildSheetReplacementBatch({
      cells: {
        'default!0:0': { v: 10 },
        'default!1:0': { v: true },
        'default!2:0': { v: false },
      },
      findString: '1',
      replaceString: 'x',
      findBy: 'value',
      caseSensitive: false,
      matchesTheWholeCell: false,
    })
    expect(result.cells).toEqual({
      'default!0:0': { v: 'x0' },
      'default!1:0': { v: 'x' },
    })
  })

  it('treats dollar sequences in replacement text literally', () => {
    const result = buildSheetReplacementBatch({
      cells: { 'default!0:0': { v: 'old old' } },
      findString: 'old',
      replaceString: '$&-$1-$$',
      findBy: 'value',
      caseSensitive: false,
      matchesTheWholeCell: false,
    })
    expect(result.cells['default!0:0']).toEqual({ v: '$&-$1-$$ $&-$1-$$' })
  })

  it.each([
    {
      replacement: 'LONGER',
      dataStream: 'aaLONGERbb\r\n',
      textRuns: [
        { st: 0, ed: 2, ts: { bl: 1 } },
        { st: 2, ed: 8, ts: { it: 1 } },
        { st: 8, ed: 10, ts: { ul: { s: 1 } } },
      ],
      customRanges: [
        { startIndex: 2, endIndex: 7, rangeId: 'r1', rangeType: 0, properties: { url: 'x' } },
        { startIndex: 8, endIndex: 9, rangeId: 'r2', rangeType: 4 },
      ],
      customDecorations: [{ startIndex: 8, endIndex: 9, id: 'd2', type: 1 }],
      paragraphIndex: 10,
    },
    {
      replacement: 'X',
      dataStream: 'aaXbb\r\n',
      textRuns: [
        { st: 0, ed: 2, ts: { bl: 1 } },
        { st: 2, ed: 3, ts: { it: 1 } },
        { st: 3, ed: 5, ts: { ul: { s: 1 } } },
      ],
      customRanges: [
        { startIndex: 2, endIndex: 2, rangeId: 'r1', rangeType: 0, properties: { url: 'x' } },
        { startIndex: 3, endIndex: 4, rangeId: 'r2', rangeType: 4 },
      ],
      customDecorations: [{ startIndex: 3, endIndex: 4, id: 'd2', type: 1 }],
      paragraphIndex: 5,
    },
    {
      replacement: '',
      dataStream: 'aabb\r\n',
      textRuns: [
        { st: 0, ed: 2, ts: { bl: 1 } },
        { st: 2, ed: 4, ts: { ul: { s: 1 } } },
      ],
      customRanges: [{ startIndex: 2, endIndex: 3, rangeId: 'r2', rangeType: 4 }],
      customDecorations: [{ startIndex: 2, endIndex: 3, id: 'd2', type: 1 }],
      paragraphIndex: 4,
    },
  ])('keeps rich-text indexes aligned when replacing with $replacement', ({
    replacement,
    dataStream,
    textRuns,
    customRanges,
    customDecorations,
    paragraphIndex,
  }) => {
    const original: SheetCell = {
      p: {
        body: {
          dataStream: 'aaOLDbb\r\n',
          textRuns: [
            { st: 0, ed: 2, ts: { bl: 1 } },
            { st: 2, ed: 5, ts: { it: 1 } },
            { st: 5, ed: 7, ts: { ul: { s: 1 } } },
          ],
          customRanges: [
            { startIndex: 2, endIndex: 4, rangeId: 'r1', rangeType: 0, properties: { url: 'x' } },
            { startIndex: 5, endIndex: 6, rangeId: 'r2', rangeType: 4 },
          ],
          customDecorations: [
            { startIndex: 2, endIndex: 4, id: 'd1', type: 1 },
            { startIndex: 5, endIndex: 6, id: 'd2', type: 1 },
          ],
          paragraphs: [{ startIndex: 7, paragraphStyle: { horizontalAlign: 1 } }],
        },
      },
      t: 1,
    }
    const result = buildSheetReplacementBatch({
      cells: { 'default!0:0': original },
      findString: 'OLD',
      replaceString: replacement,
      findBy: 'value',
      caseSensitive: true,
      matchesTheWholeCell: false,
    })
    expect(result.cells['default!0:0']!.p!.body).toMatchObject({
      dataStream,
      textRuns,
      customRanges,
      customDecorations,
      paragraphs: [{ startIndex: paragraphIndex, paragraphStyle: { horizontalAlign: 1 } }],
    })
    expect((original.p!.body as { dataStream: string }).dataStream).toBe('aaOLDbb\r\n')
  })

  it('keeps Univer custom-range split semantics when a match is inside a larger range', () => {
    const result = buildSheetReplacementBatch({
      cells: {
        'default!0:0': {
          p: {
            body: {
              dataStream: 'aaOLDbb\r\n',
              customRanges: [{ startIndex: 1, endIndex: 5, rangeId: 'r1', rangeType: 4 }],
              paragraphs: [{ startIndex: 7 }],
            },
          },
          t: 1,
        },
      },
      findString: 'OLD',
      replaceString: 'new',
      findBy: 'value',
      caseSensitive: true,
      matchesTheWholeCell: false,
    })
    expect((result.cells['default!0:0']!.p!.body as Record<string, unknown>).customRanges).toEqual([
      { startIndex: 1, endIndex: 1, rangeId: 'r1', rangeType: 4, properties: {} },
      { startIndex: 2, endIndex: 4, rangeId: 'r1$1', rangeType: 4 },
      { startIndex: 5, endIndex: 5, rangeId: 'r1$2', rangeType: 4, properties: {} },
    ])
  })

  it('does not recursively replace text introduced by a rich-text replacement', () => {
    const result = buildSheetReplacementBatch({
      cells: { 'default!0:0': { p: { body: { dataStream: 'old\r\n' } }, t: 1 } },
      findString: 'old',
      replaceString: 'old-new',
      findBy: 'value',
      caseSensitive: false,
      matchesTheWholeCell: false,
    })
    expect((result.cells['default!0:0']!.p!.body as { dataStream: string }).dataStream).toBe('old-new\r\n')
    expect(result.replacements).toBe(1)
  })

  it('keeps original rich-text indexes when case folding changes string length', () => {
    const original: SheetCell = {
      p: {
        body: {
          dataStream: 'İoldOLD\r\n',
          textRuns: [
            { st: 0, ed: 1, ts: { bl: 1 } },
            { st: 1, ed: 4, ts: { it: 1 } },
            { st: 4, ed: 7, ts: { ul: { s: 1 } } },
          ],
          paragraphs: [{ startIndex: 7, paragraphStyle: { horizontalAlign: 1 } }],
        },
      },
      t: 1,
    }
    const before = structuredClone(original)

    const result = buildSheetReplacementBatch({
      cells: { 'default!0:0': original },
      findString: 'old',
      replaceString: 'new',
      findBy: 'value',
      caseSensitive: false,
      matchesTheWholeCell: false,
    })

    expect(result.cells['default!0:0']!.p!.body).toEqual({
      dataStream: 'İnewnew\r\n',
      textRuns: [
        { st: 0, ed: 1, ts: { bl: 1 } },
        { st: 1, ed: 4, ts: { it: 1 } },
        { st: 4, ed: 7, ts: { ul: { s: 1 } } },
      ],
      paragraphs: [{ startIndex: 7, paragraphStyle: { horizontalAlign: 1 } }],
    })
    expect(result).toMatchObject({ matchedCells: 1, replacedCells: 1, replacements: 2 })
    expect(original).toEqual(before)
  })

  it('rejects pathological rich-text metadata work before mutating the input', () => {
    const matchCount = 4_000
    const original: SheetCell = {
      p: {
        body: {
          dataStream: `${'x'.repeat(matchCount)}\r\n`,
          textRuns: Array.from({ length: 500 }, (_, index) => ({
            st: index * 8,
            ed: index * 8 + 8,
            ts: { bl: index % 2 },
          })),
          paragraphs: [{ startIndex: matchCount }],
        },
      },
      t: 1,
    }
    const before = structuredClone(original)

    expect(() => buildSheetReplacementBatch({
      cells: { 'default!0:0': original },
      findString: 'x',
      replaceString: 'y',
      findBy: 'value',
      caseSensitive: true,
      matchesTheWholeCell: false,
    })).toThrowError('cell_too_large')
    expect(original).toEqual(before)
  })
})

describe('replaceDocSheet', () => {
  it('returns the unchanged base version and does not write when nothing matches', async () => {
    const view = liveSheet({ 'default!0:0': { v: 'other' } })
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    const result = await replaceDocSheet({ ...serviceInput, clientBaseVersion: view.baseSV })

    expect(result).toEqual({
      ok: true,
      matchedCells: 0,
      replacedCells: 0,
      replacements: 0,
      baseVersion: encodeBaseVersion(view.baseSV),
    })
    expect(editDocSheet).not.toHaveBeenCalled()
  })

  it('rejects a stale base version before building or writing a batch', async () => {
    const view = liveSheet({ 'default!0:0': { v: 'old' } })
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    const result = await replaceDocSheet({ ...serviceInput, clientBaseVersion: new Uint8Array([99]) })
    expect(result).toEqual({ ok: false, status: 412, error: 'base_version_stale' })
    expect(editDocSheet).not.toHaveBeenCalled()
  })

  it('passes the generated batch through editDocSheet so auth and protection are rechecked', async () => {
    const view = liveSheet({ 'default!0:0': { v: 'old old' } })
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    vi.mocked(editDocSheet).mockResolvedValue({
      ok: true,
      bytes: 321,
      baseVersion: 'NEXT',
      newDocVersionSeq: 9,
    })
    const result = await replaceDocSheet({ ...serviceInput, clientBaseVersion: view.baseSV })

    expect(editDocSheet).toHaveBeenCalledWith(expect.objectContaining({
      uid: 'u_1',
      authorizedEpoch: 7,
      isBot: true,
      cells: { 'default!0:0': { v: 'new new' } },
      dims: {},
      drawings: {},
      hyperlinks: {},
      merges: {},
      sheets: {},
      freeze: {},
      filters: {},
      dataValidations: {},
    }))
    expect(result).toEqual({
      ok: true,
      matchedCells: 1,
      replacedCells: 1,
      replacements: 2,
      bytes: 321,
      baseVersion: 'NEXT',
      newDocVersionSeq: 9,
    })
  })

  it.each([
    { status: 403, error: 'forbidden' },
    { status: 403, error: 'protected_range' },
    { status: 409, error: 'epoch_changed' },
    { status: 412, error: 'base_version_stale' },
  ])('propagates edit refusal $error', async (refusal) => {
    const view = liveSheet({ 'default!0:0': { v: 'old' } })
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    vi.mocked(editDocSheet).mockResolvedValue({ ok: false, ...refusal })
    await expect(replaceDocSheet({ ...serviceInput, clientBaseVersion: view.baseSV })).resolves.toEqual({
      ok: false,
      ...refusal,
    })
  })

  it('rejects a generated batch over the cell-count limit before editDocSheet', async () => {
    const original = config.sheetWrite.maxCells
    config.sheetWrite.maxCells = 1
    try {
      const view = liveSheet({
        'default!0:0': { v: 'old' },
        'default!1:0': { v: 'old' },
      })
      vi.mocked(readLiveSheet).mockResolvedValue(view)
      await expect(replaceDocSheet({ ...serviceInput, clientBaseVersion: view.baseSV })).resolves.toEqual({
        ok: false,
        status: 413,
        error: 'too_many_cells',
      })
      expect(editDocSheet).not.toHaveBeenCalled()
    } finally {
      config.sheetWrite.maxCells = original
    }
  })

  it('rejects a generated cell over the content limit before editDocSheet', async () => {
    const original = config.sheetWrite.maxCellContentBytes
    config.sheetWrite.maxCellContentBytes = 20
    try {
      const view = liveSheet({ 'default!0:0': { v: 'old' } })
      vi.mocked(readLiveSheet).mockResolvedValue(view)
      await expect(replaceDocSheet({
        ...serviceInput,
        clientBaseVersion: view.baseSV,
        replaceString: 'x'.repeat(100),
      })).resolves.toEqual({ ok: false, status: 413, error: 'cell_too_large' })
      expect(editDocSheet).not.toHaveBeenCalled()
    } finally {
      config.sheetWrite.maxCellContentBytes = original
    }
  })
})
