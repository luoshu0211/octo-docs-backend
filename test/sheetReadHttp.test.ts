import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import * as Y from 'yjs'

vi.mock('../src/api/guard.js', () => ({ requireDocRole: vi.fn() }))
vi.mock('../src/collab/liveSheetWrite.js', () => ({ readLiveSheet: vi.fn() }))

import { requireDocRole } from '../src/api/guard.js'
import { readLiveSheet } from '../src/collab/liveSheetWrite.js'
import { docSheetRouter } from '../src/api/routes/docSheet.js'
import { SHEET_YMAP_FIELD, SHEET_LIST_FIELD } from '../src/agent/sheetConversion.js'
import { encodeBaseVersion } from '../src/collab/docBodyEdit.js'
import { encodeSheetCursor } from '../src/api/services/sheetPagination.js'

const doc = new Y.Doc()
const app = express()
app.use('/v1/bot/docs', docSheetRouter)
app.use('/api/v1/docs', docSheetRouter)
const server = createServer({ maxHeaderSize: 2048 }, app)
const execute = promisify(execFile)
const cliBinary = process.env.OCTO_SHEET_READ_CLI_BINARY
const fixtureToken = 'bf_sheet_read_http_fixture'
let origin: string
let cliConfigDir: string

beforeAll(async () => {
  cliConfigDir = await mkdtemp(join(tmpdir(), 'sheet-read-cli-'))
  for (const [sheetId, name, order] of [['default', '汇总', 0], ['sales', '新剧榜单', 1]] as const) {
    doc.getMap(SHEET_LIST_FIELD).set(sheetId, { name, order })
    doc.getMap(SHEET_YMAP_FIELD).set(`${sheetId}!0:0`, { v: name })
  }
  for (let index = 1; index <= 1200; index++) {
    const writer = new Y.Doc()
    writer.clientID = 1000000000 + index
    writer.getMap(SHEET_YMAP_FIELD).set(`sales!${index}:0`, { v: index })
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(writer))
    writer.destroy()
  }
  vi.mocked(requireDocRole).mockImplementation(async (request, response, docId) => {
    if (request.headers.authorization !== `Bearer ${fixtureToken}`) {
      response.status(403).json({ error: 'forbidden' })
      return null
    }
    return { meta: { doc_id: docId, document_name: 'fixture', doc_type: 'sheet' }, role: 'reader' } as never
  })
  vi.mocked(readLiveSheet).mockImplementation(async () => ({ state: Y.encodeStateAsUpdate(doc), baseSV: Y.encodeStateVector(doc) }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing test listener')
  origin = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  doc.destroy()
  await rm(cliConfigDir, { recursive: true, force: true })
})

describe('real HTTP routing with fixture authorization and Yjs state', () => {
  it.each(['/v1/bot/docs', '/api/v1/docs'])('mounts directory and scoped reads on %s', async (mount) => {
    const denied = await fetch(`${origin}${mount}/doc-1/sheets`)
    expect(denied.status).toBe(403)
    const headers = { Authorization: `Bearer ${fixtureToken}` }
    const directory = await fetch(`${origin}${mount}/doc-1/sheets`, { headers })
    expect(directory.status).toBe(200)
    expect((await directory.json()).items.map((item: { sheetId: string }) => item.sheetId)).toEqual(['default', 'sales'])
    const query = new URLSearchParams({ sheetName: '新剧榜单', limit: '1' })
    const response = await fetch(`${origin}${mount}/doc-1/sheet?${query}`, { headers })
    expect(response.status).toBe(200)
    expect((await response.json()).sheetId).toBe('sales')
  })

  it('passes a 2 KiB HTTP request-header budget with the compact cursor while the old cursor fails', async () => {
    const headers = { Authorization: `Bearer ${fixtureToken}` }
    const first = await fetch(`${origin}/v1/bot/docs/doc-1/sheet?sheetId=sales&limit=1`, { headers })
    const body = await first.json()
    expect(body.baseVersion.length).toBeGreaterThan(8000)
    expect(body.nextCursor.length).toBeLessThan(512)
    const second = await fetch(`${origin}/v1/bot/docs/doc-1/sheet?limit=1&cursor=${body.nextCursor}`, { headers })
    expect(second.status).toBe(200)
    expect(Object.keys((await second.json()).sheetCells)).toEqual(['sales!1:0'])
    const legacy = encodeSheetCursor({ v: encodeBaseVersion(Y.encodeStateVector(doc)), k: 'sales!0:0' })
    const oversized = await fetch(`${origin}/v1/bot/docs/doc-1/sheet?limit=1&cursor=${legacy}`, { headers })
    expect(oversized.status).toBe(431)
  })

  it.skipIf(!cliBinary)('runs the rebuilt CLI through directory, exact-name selection and every continuation page', async () => {
    async function cli(...args: string[]) {
      const result = await execute(cliBinary!, ['--no-retry', '--timeout', '10s', ...args], {
        env: {
          ...process.env,
          OCTO_API_BASE_URL: origin,
          OCTO_CONFIG_DIR: cliConfigDir,
          OCTO_TOKEN: '', OCTO_BOT_TOKEN: fixtureToken, OCTO_BOT_ID: '', OCTO_PROFILE: '',
        },
        maxBuffer: 2 * 1024 * 1024,
      })
      const envelope = JSON.parse(result.stdout)
      expect(envelope.ok).toBe(true)
      return envelope.data
    }
    const directory = await cli('docs', 'sheet', 'list', 'doc-1')
    const selected = directory.items.find((item: { name: string }) => item.name === '新剧榜单')
    expect(selected.sheetId).toBe('sales')
    let page = await cli('docs', 'sheet', 'get', 'doc-1', '--sheet-name', selected.name, '--limit', '500')
    const keys: string[] = []
    for (let index = 0; index < 5; index++) {
      expect(page.sheetId).toBe('sales')
      keys.push(...Object.keys(page.sheetCells))
      if (!page.hasMore) break
      expect(page.nextCursor.length).toBeLessThan(512)
      page = await cli('docs', 'sheet', 'get', 'doc-1', '--cursor', page.nextCursor, '--limit', '500')
    }
    expect(page.hasMore).toBe(false)
    expect(keys).toHaveLength(1201)
    expect(new Set(keys).size).toBe(1201)
    expect(keys.every((key) => key.startsWith('sales!'))).toBe(true)
  }, 30000)
})
