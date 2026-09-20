import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'

const writes = vi.hoisted(() => vi.fn(async () => ({ revision: 1, changed: true })))
const guard = vi.hoisted(() => ({ meta: { doc_id: 'doc', doc_type: 'html_ppt', permission_epoch: 1 }, role: 'writer' }))
vi.mock('../src/api/ppt/pptDocGuard.js', () => ({ loadPptDocForRead: async () => guard }))
vi.mock('../src/api/guard.js', () => ({ requireDocRole: async () => guard }))
vi.mock('../src/ppt/liveEdit.js', async original => ({ ...await original<object>(), editPptLive: writes }))
vi.mock('../src/ppt/draft.js', async original => ({ ...await original<object>(), savePptDraft: writes }))

import { createApp } from '../src/api/app.js'
import { setOctoIdentity } from '../src/auth/octoIdentity.js'
import { validatePptDraft } from '../src/ppt/draft.js'
import { config } from '../src/config/env.js'
import { instantiateTemplate, type BentoDoc } from '../src/ppt/bentoDoc.js'
import { getPptTemplate } from '../src/ppt/templates.js'

let server: Server
let base: string
beforeAll(async () => {
  setOctoIdentity({
    verifyToken: async token => token === 'human' ? { uid: 'writer' } : null,
    verifyBot: async token => token === 'bot' ? { uid: 'bot', spaceId: 'space' } : null,
    getUser: async () => null, getUserAsBot: async () => null, getUsers: async () => [],
    isSpaceMember: async () => true, ownedBotsInSpace: async () => [],
  })
  server = await new Promise<Server>(resolve => {
    const s = createApp({ rateLimit: { max: 1000, windowMs: 60_000 } }).listen(0, '127.0.0.1', () => resolve(s))
  })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())) })
beforeEach(() => { writes.mockClear() })
const fresh = () => instantiateTemplate(getPptTemplate('blank')!, new Date().toISOString())
const send = (path: string, body: string, method = 'PATCH', token = path.startsWith('/v1/') ? 'bot' : 'human') =>
  fetch(base + path, { method, headers: { 'Content-Type': 'application/json', token, 'X-Space-Id': 'space' }, body })

function sizedDeck(bytes: number) {
  const deck = fresh()
  deck.slides[0]!.notes = ''
  deck.slides[0]!.notes = 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(deck)))
  return deck
}

it('accepts exactly 32 MiB, rejects one byte more, and counts UTF-8 bytes', () => {
  const deck = sizedDeck(config.ppt.write.maxDocumentBytes)
  expect(validatePptDraft({ revision: 0, deck }).deck).toBe(deck)
  deck.slides[0]!.notes += 'x'
  expect(() => validatePptDraft({ revision: 0, deck })).toThrow(expect.objectContaining({
    code: 'PAYLOAD_TOO_LARGE', details: { dimension: 'document', documentBytes: config.ppt.write.maxDocumentBytes + 1, limit: config.ppt.write.maxDocumentBytes },
  }))
  deck.slides[0]!.notes = deck.slides[0]!.notes!.slice(0, -2) + '中'
  expect(() => validatePptDraft({ revision: 0, deck })).toThrow(expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE' }))
  expect(config.ppt.relay.maxSingleBlobBytes).toBe(8 * 1024 * 1024)
})

it.each([
  ['/api/v1/ppt/docs/doc/live', 'PATCH'],
  ['/API/V1/PPT/docs/doc/live/', 'PATCH'],
  ['/api/v1/ppt/docs/doc/draft', 'PUT'],
  ['/v1/bot/docs/doc/ppt', 'PATCH'],
  ['/V1/BOT/DOCS/doc/PPT/', 'PATCH'],
])('accepts a 9 MiB document through the real app parser: %s', async (path, method) => {
  const body = JSON.stringify({ [method === 'PUT' ? 'revision' : 'baseRevision']: 0, deck: sizedDeck(9 * 1024 * 1024) })
  const response = await send(path!, body, method, path!.toLowerCase().startsWith('/v1/') ? 'bot' : 'human')
  expect(await response.json()).toMatchObject({ data: { revision: 1 } })
  expect(response.status).toBe(200)
  expect(writes).toHaveBeenCalledOnce()
})

it.each(['/api/v1/ppt/docs/doc/live', '/v1/bot/docs/doc/ppt'])('separates request and document boundaries: %s', async path => {
  const envelope = JSON.stringify({ baseRevision: 0, deck: fresh() })
  const exactly = envelope + ' '.repeat(config.ppt.write.maxRequestBytes - Buffer.byteLength(envelope))
  expect((await send(path, exactly)).status).toBe(200)
  writes.mockClear()
  const tooLarge = await send(path, exactly + ' ')
  expect(tooLarge.status).toBe(413)
  expect(await tooLarge.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE', details: { dimension: 'request', limit: config.ppt.write.maxRequestBytes } } })
  expect(writes).not.toHaveBeenCalled()
  const oversizedDeck = await send(path, JSON.stringify({ baseRevision: 0, deck: sizedDeck(config.ppt.write.maxDocumentBytes + 1) }))
  expect(oversizedDeck.status).toBe(413)
  expect(await oversizedDeck.json()).toMatchObject({ error: { details: { dimension: 'document', limit: config.ppt.write.maxDocumentBytes } } })
  expect(writes).not.toHaveBeenCalled()
}, 30_000)

it.each(['signal', 'picnic'])('accepts the actual bundled %s template through both edit routes', async name => {
  const source = JSON.parse(readFileSync(new URL(`../src/ppt/gallery/${name}.json`, import.meta.url), 'utf8')) as BentoDoc
  const deck = instantiateTemplate(source, new Date().toISOString())
  const body = JSON.stringify({ baseRevision: 0, deck })
  for (const path of ['/api/v1/ppt/docs/doc/live', '/v1/bot/docs/doc/ppt']) {
    const response = await send(path, body)
    expect(response.status).toBe(200)
  }
})

it('retains the small cap for unrelated routes and rejects malformed PPT JSON', async () => {
  const large = JSON.stringify({ body: 'x'.repeat(1024 * 1024) })
  for (const path of ['/api/v1/ppt/docs/collab-token', '/v1/bot/docs/doc/content', '/api/v1/docs/doc/content']) {
    expect((await send(path, large, 'POST')).status).toBe(413)
  }
  for (const path of ['/api/v1/ppt/docs/doc/live', '/v1/bot/docs/doc/ppt']) {
    const response = await send(path, '{broken')
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
  }
  expect(writes).not.toHaveBeenCalled()
})

it('does not allow large writes without authentication', async () => {
  for (const path of ['/api/v1/ppt/docs/doc/live', '/v1/bot/docs/doc/ppt']) {
    expect((await send(path, JSON.stringify({ baseRevision: 0, deck: sizedDeck(2 * 1024 * 1024) }), 'PATCH', 'invalid')).status).toBe(401)
  }
  expect(writes).not.toHaveBeenCalled()
})
