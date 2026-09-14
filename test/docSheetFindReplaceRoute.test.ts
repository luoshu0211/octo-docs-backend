import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/api/guard.js', () => ({ requireDocRole: vi.fn() }))
vi.mock('../src/api/services/replaceDocSheet.js', () => ({ replaceDocSheet: vi.fn() }))

import { requireDocRole } from '../src/api/guard.js'
import { replaceDocSheet } from '../src/api/services/replaceDocSheet.js'
import { replaceDocSheetHandler } from '../src/api/routes/docSheet.js'

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
  vi.mocked(replaceDocSheet).mockReset()
})

describe('POST /:docId/sheet/replace', () => {
  it('requires writer access before reading the live sheet', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(null)
    await replaceDocSheetHandler(req({}), mockRes() as never)
    expect(vi.mocked(requireDocRole).mock.calls[0]![3]).toBe('writer')
    expect(replaceDocSheet).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'missing base version', body: { findString: 'a', replaceString: 'b' }, headers: {} },
    { name: 'blank find string', body: { findString: '   ', replaceString: 'b' }, headers: { 'if-match': 'BV' } },
    { name: 'missing replacement', body: { findString: 'a' }, headers: { 'if-match': 'BV' } },
    { name: 'bad findBy', body: { findString: 'a', replaceString: 'b', findBy: 'style' }, headers: { 'if-match': 'BV' } },
    { name: 'range without logicalId', body: { findString: 'a', replaceString: 'b', range: { startRow: 0, startColumn: 0, endRow: 1, endColumn: 1 } }, headers: { 'if-match': 'BV' } },
  ])('returns 400 invalid_body for $name', async ({ body, headers }) => {
    vi.mocked(requireDocRole).mockResolvedValue(writerGuard)
    const res = mockRes()
    await replaceDocSheetHandler(req(body, headers), res as never)
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_body' })
    expect(replaceDocSheet).not.toHaveBeenCalled()
  })

  it('parses scope and options, accepts an empty replacement, and returns counts', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(writerGuard)
    vi.mocked(replaceDocSheet).mockResolvedValue({
      ok: true,
      matchedCells: 2,
      replacedCells: 2,
      replacements: 3,
      bytes: 100,
      baseVersion: 'NEXT',
      newDocVersionSeq: 4,
    })
    const res = mockRes()
    await replaceDocSheetHandler(req({
      findString: ' old ',
      replaceString: '',
      findBy: 'formula',
      caseSensitive: true,
      matchesTheWholeCell: true,
      logicalId: 'default',
      range: { startRow: 1, startColumn: 2, endRow: 3, endColumn: 4 },
    }, { 'if-match': '"BV"' }), res as never)

    expect(replaceDocSheet).toHaveBeenCalledWith(expect.objectContaining({
      findString: 'old',
      replaceString: '',
      findBy: 'formula',
      caseSensitive: true,
      matchesTheWholeCell: true,
      logicalId: 'default',
      range: { startRow: 1, startColumn: 2, endRow: 3, endColumn: 4 },
      authorizedEpoch: 7,
    }))
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      docId: 'd_1',
      matchedCells: 2,
      replacedCells: 2,
      replacements: 3,
      bytes: 100,
      baseVersion: 'NEXT',
      newDocVersionSeq: 4,
    })
  })

  it('forwards a protected-range refusal', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(writerGuard)
    vi.mocked(replaceDocSheet).mockResolvedValue({ ok: false, status: 403, error: 'protected_range' })
    const res = mockRes()
    await replaceDocSheetHandler(req({ findString: 'a', replaceString: 'b' }, { 'if-match': 'BV' }), res as never)
    expect(res.statusCode).toBe(403)
    expect(res.body).toEqual({ error: 'protected_range' })
  })
})
