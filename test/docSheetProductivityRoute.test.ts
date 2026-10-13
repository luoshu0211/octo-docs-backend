import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import * as Y from 'yjs'

vi.mock('../src/api/guard.js', () => ({ requireDocRole: vi.fn() }))
vi.mock('../src/collab/liveSheetWrite.js', () => ({ readLiveSheet: vi.fn(), commitLiveSheetEdit: vi.fn() }))
vi.mock('../src/api/services/editDocSheet.js', () => ({ editDocSheet: vi.fn() }))

import { requireDocRole } from '../src/api/guard.js'
import { readLiveSheet } from '../src/collab/liveSheetWrite.js'
import { editDocSheet } from '../src/api/services/editDocSheet.js'
import { docSheetRouter } from '../src/api/routes/docSheet.js'
import { encodeBaseVersion } from '../src/collab/docBodyEdit.js'

let server: Server
let origin: string
let doc: Y.Doc
const range = { startRow: 0, endRow: 1, startColumn: 0, endColumn: 0 }
const rule = { priority: 0, rule: { cfId: 'one', stopIfTrue: false, ranges: [range], rule: { type: 'highlightCell', subType: 'duplicateValues', style: {} } } }

beforeAll(async () => {
  const app = express()
  app.use(express.json(), (req, _res, next) => { req.uid = 'writer'; req.principalSpaceId = 'space'; next() }, docSheetRouter)
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})
beforeEach(() => {
  vi.clearAllMocks()
  doc = new Y.Doc()
  doc.getMap('sheet').set('default!0:0', { v: '001,=text' })
  vi.mocked(requireDocRole).mockResolvedValue({ meta: { doc_id: 'doc', document_name: 'doc', doc_type: 'sheet', permission_epoch: 7 }, role: 'writer' } as never)
  vi.mocked(readLiveSheet).mockImplementation(async () => ({ state: Y.encodeStateAsUpdate(doc), baseSV: Y.encodeStateVector(doc) }))
  vi.mocked(editDocSheet).mockResolvedValue({ ok: true, bytes: 1, baseVersion: 'next', newDocVersionSeq: 1 })
})

function post(operation: string, body: unknown, token = encodeBaseVersion(Y.encodeStateVector(doc))) {
  return fetch(`${origin}/doc/sheet/${operation}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': token }, body: JSON.stringify(body) })
}

describe('productivity HTTP routes', () => {
  it.each(['split', 'deduplicate'])('rejects rich-text %s apply before calling the write or snapshot path', async (operation) => {
    const rich = { v: 'fallback', t: 1, p: { body: { dataStream: 'Rich,text\r\n', textRuns: [{ st: 0, ed: 4, ts: { bl: 1 } }] } } }
    doc.getMap('sheet').set('default!0:0', rich)
    const before = Y.encodeStateAsUpdate(doc)
    const response = await post(operation, { logicalId: 'default', range, delimiter: ',', preview: false, overwrite: true })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ error: 'cleaning_complex_sheet' })
    expect(editDocSheet).not.toHaveBeenCalled()
    expect(doc.getMap('sheet').get('default!0:0')).toEqual(rich)
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
  })

  it('reads conditional formats on whole and first-page reads, but not continuation pages', async () => {
    doc.getMap('sheetConditionalFormats').set('default!one', rule)
    doc.getMap('sheet').set('default!1:0', { v: 'next' })
    const whole = await (await fetch(`${origin}/doc/sheet`)).json()
    expect(whole.sheetConditionalFormats).toEqual({ 'default!one': rule })
    const first = await (await fetch(`${origin}/doc/sheet?limit=1`)).json()
    expect(first.sheetConditionalFormats).toEqual(whole.sheetConditionalFormats)
    const second = await (await fetch(`${origin}/doc/sheet?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`)).json()
    expect(second.sheetConditionalFormats).toBeUndefined()
  })

  it('accepts sparse conditional-format updates without a cells batch', async () => {
    const response = await fetch(`${origin}/doc/sheet`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'If-Match': encodeBaseVersion(Y.encodeStateVector(doc)) }, body: JSON.stringify({ conditionalFormats: { 'default!one': rule } }) })
    expect(response.status).toBe(200)
    expect(editDocSheet).toHaveBeenCalledWith(expect.objectContaining({ conditionalFormats: { 'default!one': rule }, authorizedEpoch: 7 }))
  })

  it.each(['split', 'deduplicate'])('%s defaults to a read-only preview, and applies only explicitly', async (operation) => {
    const body = { logicalId: 'default', range, delimiter: ',' }
    const preview = await post(operation, body)
    expect(preview.status).toBe(200)
    expect(await preview.json()).toMatchObject({ preview: true })
    expect(editDocSheet).not.toHaveBeenCalled()
    const applied = await post(operation, { ...body, preview: false })
    expect(applied.status).toBe(200)
    expect(await applied.json()).toMatchObject({ preview: false, baseVersion: 'next' })
    expect(editDocSheet).toHaveBeenCalledTimes(1)
    expect(vi.mocked(requireDocRole).mock.calls.every((call) => call[3] === 'writer')).toBe(true)
  })

  it.each([
    { logicalId: 'default', range, delimiter: ',', preview: 'false' },
    { logicalId: 'default', range, delimiter: '' },
    { logicalId: '__proto__', range, delimiter: ',' },
    { logicalId: 'default', delimiter: ',' },
  ])('rejects malformed cleaning input', async (body) => {
    expect((await post('split', body)).status).toBe(400)
    expect(readLiveSheet).not.toHaveBeenCalled()
  })

  it('does not trust caller-supplied admin status to bypass protected cells', async () => {
    doc.getMap('sheetProtection').set('default!lock', { permissionId: 'lock', ranges: [range] })
    const response = await post('split', { logicalId: 'default', range, delimiter: ',', preview: false, isAdmin: true })
    expect(response.status).toBe(403)
    expect(editDocSheet).not.toHaveBeenCalled()
  })

  it('rejects a stale version before invoking the edit service', async () => {
    const token = encodeBaseVersion(Y.encodeStateVector(doc))
    doc.getMap('sheet').set('default!0:1', { v: 'changed' })
    const response = await post('split', { logicalId: 'default', range, delimiter: ',', preview: false, overwrite: true }, token)
    expect(response.status).toBe(412)
    expect(editDocSheet).not.toHaveBeenCalled()
  })

  it('rejects a missing version before reading or writing any sheet data', async () => {
    const response = await fetch(`${origin}/doc/sheet/split`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ logicalId: 'default', range, delimiter: ',' }) })
    expect(response.status).toBe(400)
    expect(readLiveSheet).not.toHaveBeenCalled()
    expect(editDocSheet).not.toHaveBeenCalled()
  })
})
