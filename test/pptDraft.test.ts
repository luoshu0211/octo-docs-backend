import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Tx } from '../src/db/pool.js'
import type { ResolvedRole } from '../src/permission/role.js'

let meta: Record<string, unknown>
let role: ResolvedRole = 'writer'
let member = true
let epochAtLock: number | undefined
let current: { draft_revision: number; draft_doc: string }
let live = false
const writes = vi.fn()

vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  DocOwnershipError: class extends Error {}, docMetaRepo: { getByDocId: async () => meta },
}))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({ docMemberRepo: {
  getRole: async () => role, getRoleTx: async () => role,
} }))
vi.mock('../src/db/pool.js', () => ({
  query: async () => [],
  transaction: async (fn: (tx: Tx) => Promise<unknown>) => fn({
    query: async <T>(sql: string): Promise<T[]> => (
      sql.includes('doc_meta') ? [{ ...meta, permission_epoch: epochAtLock ?? meta.permission_epoch }] : sql.includes('ppt_live_snapshot') ? (live ? [{}] : []) : [current]
    ) as T[],
    execute: async (sql: string, params?: unknown[]) => {
      writes(sql, params)
      if (sql.includes('ppt_doc_state')) {
        current.draft_doc = String(params![0])
        current.draft_revision++
      }
      return { affectedRows: 1 }
    },
  }),
}))

import { createPptDraftRouter } from '../src/api/ppt/draft.js'
import { pptErrorHandler } from '../src/api/ppt/envelope.js'
import { validatePptDraft, savePptDraft } from '../src/ppt/draft.js'
import { legacyPptDeck } from './fixtures/pptLegacyDeck.js'
import { setOctoIdentity } from '../src/auth/octoIdentity.js'
import { config } from '../src/config/env.js'

function deck() {
  const source = legacyPptDeck()
  source.docId = 'bento-existing'
  return source
}
let server: Server
let base: string
beforeAll(async () => {
  setOctoIdentity({
    verifyToken: async token => token === 'test-session' ? { uid: 'writer' } : null,
    verifyBot: async () => null, getUser: async () => null, getUserAsBot: async () => null,
    getUsers: async () => [], isSpaceMember: async () => member, ownedBotsInSpace: async () => [],
  })
  const app = express()
  app.use(express.json({ limit: '1mb' }), createPptDraftRouter(), pptErrorHandler)
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())) })
beforeEach(() => {
  role = 'writer'; member = true; live = false; epochAtLock = undefined; writes.mockClear()
  meta = { doc_id: 'd_1', doc_type: 'html_ppt', space_id: 's_1', owner_id: 'owner', owner_space_id: 's_1',
    status: 1, permission_epoch: 4, share_scope: 0, share_role: 1 }
  current = { draft_revision: 0, draft_doc: JSON.stringify(deck()) }
})
function put(body: unknown, space = 's_1', token = 'test-session') {
  return fetch(`${base}/docs/d_1/draft`, { method: 'PUT', headers: { 'Content-Type': 'application/json', token, 'X-Space-Id': space }, body: JSON.stringify(body) })
}

describe('PPT draft save', () => {
  it('rejects timestamp growth after validation without changing draft or metadata', async () => {
    const value = { ...deck(), modified: '' }
    const previousLimit = config.ppt.write.maxDocumentBytes
    const previous = structuredClone(current)
    try {
      config.ppt.write.maxDocumentBytes = Buffer.byteLength(JSON.stringify(value))
      expect(validatePptDraft({ revision: 0, deck: value }).deck).toBe(value)
      await expect(savePptDraft({ docId: 'd_1', uid: 'writer', spaceId: 's_1', authorizedEpoch: 4, revision: 0, deck: value }))
        .rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE', details: {
          dimension: 'document', documentBytes: config.ppt.write.maxDocumentBytes + 24, limit: config.ppt.write.maxDocumentBytes,
        } })
      expect(writes).not.toHaveBeenCalled()
      expect(current).toEqual(previous)
    } finally { config.ppt.write.maxDocumentBytes = previousLimit }
  })
  it.each(['pitch', 'report', 'lesson'] as const)('saves an existing retired %s deck without its template source', async id => {
    const value = legacyPptDeck(id)
    current = { draft_revision: 0, draft_doc: JSON.stringify(value) }
    value.slides[0]!.notes = 'Still editable after template retirement'
    expect((await put({ revision: 0, deck: value })).status).toBe(200)
    expect(JSON.parse(current.draft_doc)).toMatchObject({ docId: value.docId, slides: value.slides })
  })
  it('refuses whole-deck saves after the live collaboration handoff', async () => {
    live = true
    expect((await put({ revision: 0, deck: deck() })).status).toBe(409)
    expect(writes).not.toHaveBeenCalled()
  })
  it('persists renderable Bento with additive fields and advances the revision', async () => {
    role = 'admin'
    const payload = { ...deck(), title: 'Saved deck', customFutureField: { value: 1 } }
    const response = await put({ revision: 0, deck: payload })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toMatchObject({ data: { revision: 1 } })
    expect(JSON.parse(current.draft_doc)).toMatchObject({ ...payload, modified: expect.any(String) })
    expect(JSON.parse(current.draft_doc).modified).not.toBe(payload.modified)
    expect(writes.mock.calls.map(call => call[0]).join(' ')).not.toMatch(/snapshot|op_log|published/)
  })

  it('rejects stale revisions without touching the saved draft', async () => {
    expect((await put({ revision: 0, deck: deck() })).status).toBe(200)
    writes.mockClear()
    expect((await put({ revision: 0, deck: deck() })).status).toBe(409)
    expect(writes).not.toHaveBeenCalled()
  })

  it('a writer can edit content but cannot rename through the legacy draft API', async () => {
    expect((await put({ revision: 0, deck: { ...deck(), title: 'Forbidden rename' } })).status).toBe(403)
    expect(writes).not.toHaveBeenCalled()
  })

  it.each(['reader', 'commenter', 'none'] as const)('rejects %s writes', async denied => {
    role = denied
    expect((await put({ revision: 0, deck: deck() })).status).toBe(403)
    expect(writes).not.toHaveBeenCalled()
  })

  it('enforces authentication, current Space and active membership', async () => {
    expect((await put({}, 's_1', 'invalid')).status).toBe(401)
    expect((await put({}, '')).status).toBe(400)
    expect((await put({ revision: 0, deck: deck() }, 's_other')).status).toBe(200)
    writes.mockClear()
    member = false
    expect((await put({ revision: 0, deck: deck() })).status).toBe(403)
    expect(writes).not.toHaveBeenCalled()
  })

  it('rechecks permission epoch under lock before any writes', async () => {
    epochAtLock = 5
    expect((await put({ revision: 0, deck: deck() })).status).toBe(403)
    expect(writes).not.toHaveBeenCalled()
  })

  it('rechecks direct role and document status under lock', async () => {
    role = 'reader'
    await expect(savePptDraft({ docId: 'd_1', uid: 'writer', spaceId: 's_1', authorizedEpoch: 4, revision: 0, deck: deck() })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    role = 'writer'; meta.status = 2
    expect((await put({ revision: 0, deck: deck() })).status).toBe(409)
    expect(writes).not.toHaveBeenCalled()
  })

  it('rejects changing the Bento identity', async () => {
    expect((await put({ revision: 0, deck: { ...deck(), docId: 'replacement' } })).status).toBe(400)
    expect(writes).not.toHaveBeenCalled()
  })

  it('retains the qualified owner and space-share writer rules', async () => {
    role = 'none'; meta.share_scope = 1; meta.share_role = 2
    expect((await put({ revision: 0, deck: deck() })).status).toBe(200)
    meta.share_scope = 0; meta.owner_id = 'writer'
    expect((await put({ revision: 1, deck: deck() })).status).toBe(200)
  })
})

describe('draft validation', () => {
  it.each([null, [], {}, { revision: -1, deck: deck() }, { revision: 0.5, deck: deck() },
    { revision: 0, deck: { ...deck(), slides: [] } }, { revision: 0, deck: { ...deck(), collab: { room: 'external' } } },
    { revision: 0, deck: { ...deck(), title: '' } }, { revision: 0, deck: { ...deck(), slides: [deck().slides[0], deck().slides[0]] } },
  ])('rejects malformed envelopes %#', body => {
    expect(() => validatePptDraft(body)).toThrow()
  })
  it('rejects prototype fields at any depth', () => {
    const payload = JSON.parse(JSON.stringify({ revision: 0, deck: deck() }))
    payload.deck.extra = JSON.parse('{"__proto__":{"admin":true}}')
    expect(() => validatePptDraft(payload)).toThrow('unsafe document property')
  })
})
