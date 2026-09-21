import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// Integration test for POST /api/v1/docs (R2-B1). The real app + PPT router
// + auth/space guards + envelope run; only the persistence layer is mocked, so no
// MySQL/Redis is needed.
//
// The mock models the DB with REAL transactional semantics: `transaction()`
// snapshots the in-memory store before running the callback and RESTORES it if
// the callback throws (rollback). The repo `*Tx` methods write into that store.
// This lets the tests exercise atomicity — a mid-write failure must leave no
// orphan rows and must not strand the idempotency reservation — exactly as the
// real transaction would.

interface Rec {
  requestHash: string
  responseStatus: number
  responseData: unknown
  docId: string | null
  completed: boolean
}
// In-memory DB model.
const db = {
  docMeta: new Map<string, Record<string, unknown>>(),
  members: [] as Array<{ docId: string; uid: string; roleNum: number; grantedBy: string }>,
  pptState: new Map<string, Record<string, unknown>>(),
  idem: new Map<string, Rec>(),
}
interface Snap {
  docMeta: Map<string, Record<string, unknown>>
  members: Array<{ docId: string; uid: string; roleNum: number; grantedBy: string }>
  pptState: Map<string, Record<string, unknown>>
  idem: Map<string, Rec>
}
function snapshot(): Snap {
  return {
    docMeta: new Map(db.docMeta),
    members: db.members.slice(),
    pptState: new Map(db.pptState),
    idem: new Map(Array.from(db.idem, ([kk, v]) => [kk, { ...v }] as const)),
  }
}
function restore(s: Snap): void {
  db.docMeta = s.docMeta
  db.members = s.members
  db.pptState = s.pptState
  db.idem = s.idem
}
function clearDb(): void {
  db.docMeta = new Map()
  db.members = []
  db.pptState = new Map()
  db.idem = new Map()
}

// Fault injection: when true, the member write inside the transaction throws,
// simulating a mid-create failure after the doc_meta insert.
let failMemberWrite = false
let failHumanGrant = false
// Incrementing doc ids so concurrent users get distinct decks (mirrors the real
// random newDocId); reset per test.
let docSeq = 0

vi.mock('../src/util/ids.js', () => ({
  newDocId: vi.fn(() => `d_ppt${++docSeq}`),
}))

// Transaction mock with snapshot/rollback (models MySQL BEGIN/COMMIT/ROLLBACK).
vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(async () => []),
  getPool: vi.fn(),
  closePool: vi.fn(async () => undefined),
  transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    const snap = snapshot()
    try {
      return await fn({ __tx: true })
    } catch (err) {
      restore(snap) // rollback: discard every write the callback made
      throw err
    }
  }),
}))

const idemK = (s: string, sc: string, uid: string, key: string) => `${s}|${sc}|${uid}|${key}`
vi.mock('../src/db/repos/pptIdempotencyRepo.js', () => ({
  PPT_IDEMPOTENCY_SCOPE_CREATE: 'create',
  pptIdempotencyRepo: {
    get: vi.fn(async (s: string, sc: string, uid: string, key: string) => db.idem.get(idemK(s, sc, uid, key)) ?? null),
    reserveTx: vi.fn(async (_tx: unknown, s: string, sc: string, uid: string, key: string, hash: string) => {
      const kk = idemK(s, sc, uid, key)
      if (db.idem.has(kk)) return { reserved: false }
      db.idem.set(kk, { requestHash: hash, responseStatus: 0, responseData: null, docId: null, completed: false })
      return { reserved: true }
    }),
    completeTx: vi.fn(
      async (_tx: unknown, s: string, sc: string, uid: string, key: string, status: number, data: unknown, docId: string | null) => {
        const kk = idemK(s, sc, uid, key)
        db.idem.set(kk, { requestHash: db.idem.get(kk)!.requestHash, responseStatus: status, responseData: data, docId, completed: true })
      },
    ),
  },
}))

vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  DocOwnershipError: class DocOwnershipError extends Error {},
  docMetaRepo: {
    createTx: vi.fn(async (_tx: unknown, input: { docId: string }) => {
      db.docMeta.set(input.docId, { ...input, created_at: new Date(0) })
    }),
    getByDocIdTx: vi.fn(async (_tx: unknown, docId: string) => db.docMeta.get(docId) ?? null),
  },
}))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  docMemberRepo: {
    upsertDirectTx: vi.fn(async (_tx: unknown, params: { docId: string; uid: string; roleNum: number; grantedBy: string }) => {
      if (failMemberWrite) throw new Error('injected member write failure')
      if (failHumanGrant && params.uid === 'u_creator') throw new Error('injected human grant failure')
      db.members.push(params)
    }),
  },
}))
vi.mock('../src/db/repos/pptDocStateRepo.js', () => ({
  pptDocStateRepo: {
    createTx: vi.fn(async (_tx: unknown, input: { docId: string }) => {
      db.pptState.set(input.docId, input)
    }),
  },
}))

import { createApp } from '../src/api/app.js'
import { setOctoIdentity, type OctoIdentity, type OctoUser } from '../src/auth/octoIdentity.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import { pptDocStateRepo } from '../src/db/repos/pptDocStateRepo.js'
import { transaction } from '../src/db/pool.js'
import { ROLE_ADMIN } from '../src/permission/role.js'
import { hashCanonicalPayload } from '../src/ppt/idempotency.js'

const createTx = vi.mocked(docMetaRepo.createTx)
const upsertDirectTx = vi.mocked(docMemberRepo.upsertDirectTx)
const stateCreateTx = vi.mocked(pptDocStateRepo.createTx)
const transactionMock = vi.mocked(transaction)

function stub(overrides: Partial<OctoIdentity>): OctoIdentity {
  return {
    verifyToken: async () => null,
    verifyBot: async () => null,
    getUser: async (): Promise<OctoUser | null> => null,
    getUserAsBot: async (): Promise<OctoUser | null> => null,
    getUsers: async (): Promise<OctoUser[]> => [],
    // pptSpaceContextMiddleware now gates X-Space-Id on a confirmed space
    // membership. These cases all exercise a caller acting inside their OWN
    // space, so default to member; the non-member refusal is asserted
    // explicitly below.
    isSpaceMember: async () => true,
    ...overrides,
  }
}

let server: Server
let base: string

/** POST to the create endpoint with a human session + space header. */
function post(body: unknown, opts: { key?: string | null; space?: string; token?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.token !== undefined) headers['token'] = opts.token
  else headers['token'] = 'user-tok'
  if (opts.space !== undefined) headers['X-Space-Id'] = opts.space
  else headers['X-Space-Id'] = 's_1'
  if (opts.key) headers['Idempotency-Key'] = opts.key
  return fetch(`${base}/api/v1/docs`, { method: 'POST', headers, body: JSON.stringify({ docType: 'html_ppt', ...(body as Record<string, unknown>) }) })
}

beforeAll(async () => {
  const app = createApp()
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
})

beforeEach(() => {
  clearDb()
  docSeq = 0
  failMemberWrite = false
  failHumanGrant = false
  createTx.mockClear()
  upsertDirectTx.mockClear()
  stateCreateTx.mockClear()
  transactionMock.mockClear()
  setOctoIdentity(stub({ verifyToken: async () => ({ uid: 'u_1' }) }))
})

describe('shared document creation', () => {
  it.each(['pitch', 'report', 'lesson'])('rejects retired Human template %s without writes', async templateId => {
    const response = await post({ title: 'Retired template', templateId }, { key: `retired-${templateId}` })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(transactionMock).not.toHaveBeenCalled()
    expect(db.docMeta.size).toBe(0)
    expect(db.pptState.size).toBe(0)
    expect(db.members).toEqual([])
    expect(db.idem.size).toBe(0)
  })
  it.each(['signal', 'terra', 'orbital', 'picnic'])('creates %s with its assets and page family intact', async templateId => {
    const response = await post({ title: 'Gallery deck', templateId }, { key: `gallery-${templateId}` })
    expect(response.status).toBe(201)
    const state = stateCreateTx.mock.calls[0]![1] as { templateId: string; draftDoc: Record<string, unknown> }
    expect(state.templateId).toBe(templateId)
    expect((state.draftDoc.layouts as Array<{ id: string }>).every(layout => layout.id.startsWith(`layout-${templateId}-`))).toBe(true)
    expect((state.draftDoc.layouts as unknown[]).length).toBeGreaterThanOrEqual(5)
    expect(Object.keys(state.draftDoc.assets as object).length).toBeGreaterThan(0)
    expect(state.draftDoc.template).toBeUndefined()
    expect(state.draftDoc.collab).toBeUndefined()
  })
  it('creates a PPT through docs with the common flat response', async () => {
    const response = await fetch(`${base}/api/v1/docs`, {
      method: 'POST', headers: { token: 'user-tok', 'X-Space-Id': 's_1',
        'Content-Type': 'application/json', 'Idempotency-Key': 'common-create' },
      body: JSON.stringify({ docType: 'html_ppt', title: 'Shared deck', templateId: 'blank' }),
    })
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ docType: 'html_ppt', title: 'Shared deck', role: 'admin' })
    expect(transactionMock).toHaveBeenCalledTimes(1)
    expect(stateCreateTx).toHaveBeenCalledTimes(1)
  })
})

describe('PPT-HUMAN-001 — human creates a PPT from a template', () => {
  it('returns 201 with the common create payload and makes the caller owner/admin', async () => {
    const res = await post({ title: 'My Deck', templateId: 'blank' }, { key: 'idem-1' })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    // The public Docs endpoint returns the common flat document payload.
    expect(body).toMatchObject({
      docId: 'd_ppt1',
      documentName: 'octo:s_1:f_default:ppt:d_ppt1',
      title: 'My Deck',
      spaceId: 's_1',
      folderId: 'f_default',
      ownerId: 'u_1',
      docType: 'html_ppt',
      role: 'admin',
      templateId: 'blank',
      draftRevision: 0,
      snapshotVersion: 0,
    })
    // shareUrl is the canonical type-agnostic bare link. The client obtains the
    // deck's canonical home Space from /:docId/open-context when opening it.
    expect(body.shareUrl).toBe('/d/d_ppt1')
    expect(String(body.shareUrl)).not.toContain('sp=')
    expect(String(body.shareUrl)).not.toContain('sid=')
    // The old PPT editor transport remains compatible during migration; unlike
    // shareUrl it may still carry the create mount's Space.
    expect(body.editorUrl).toBe('/d/d_ppt1')

    // Persisted inside ONE transaction (atomic create).
    expect(transactionMock).toHaveBeenCalledTimes(1)
    // doc_meta row created as html_ppt with slug NULL and the PPT documentName.
    expect(createTx).toHaveBeenCalledTimes(1)
    const metaInput = createTx.mock.calls[0]![1]
    expect(metaInput).toMatchObject({
      docId: 'd_ppt1',
      documentName: 'octo:s_1:f_default:ppt:d_ppt1',
      title: 'My Deck',
      ownerId: 'u_1',
      spaceId: 's_1',
      folderId: 'f_default',
      docType: 'html_ppt',
    })
    expect(metaInput.octoDocSlug).toBeUndefined()
    // Creator stored as admin member (2nd arg is the params object).
    expect(upsertDirectTx).toHaveBeenCalledWith(expect.anything(), {
      docId: 'd_ppt1',
      uid: 'u_1',
      principalSpaceId: 's_1',
      roleNum: ROLE_ADMIN,
      grantedBy: 'u_1',
    })
    // PPT state row + materialized starter deck persisted.
    expect(stateCreateTx).toHaveBeenCalledTimes(1)
    const stateArg = stateCreateTx.mock.calls[0]![1] as { templateId: string; draftDoc: Record<string, unknown> }
    expect(stateArg.templateId).toBe('blank')
    expect(stateArg.draftDoc.template).toBeUndefined()
    expect(stateArg.draftDoc.collab).toBeUndefined()
    expect(stateArg.draftDoc.format).toBe('bento/slides')
  })

  it('honors a caller-supplied folderId in the documentName', async () => {
    const res = await post({ title: 'Foldered', templateId: 'blank', folderId: 'f_team' }, { key: 'idem-f' })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { documentName: string; folderId: string }
    expect(body.documentName).toBe('octo:s_1:f_team:ppt:d_ppt1')
    expect(body.folderId).toBe('f_team')
  })
})

describe('PPT-HUMAN-002 — human create validation', () => {
  const cases: Array<[string, unknown]> = [
    ['empty title', { title: '', templateId: 'blank' }],
    ['whitespace title', { title: '   ', templateId: 'blank' }],
    ['illegal folder segment', { title: 'ok', templateId: 'blank', folderId: 'bad folder!' }],
    ['unsupported templateId', { title: 'ok', templateId: 'not-a-template' }],
  ]
  it.each(cases)('rejects %s with 400 VALIDATION_ERROR and no side effect', async (_label, body) => {
    const res = await post(body, { key: 'idem-bad' })
    expect(res.status).toBe(400)
    expect((await res.json())).toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(transactionMock).not.toHaveBeenCalled()
    expect(createTx).not.toHaveBeenCalled()
    expect(upsertDirectTx).not.toHaveBeenCalled()
    expect(stateCreateTx).not.toHaveBeenCalled()
  })

  it('attributes an invalid X-Space-Id segment to the X-Space-Id field (not folderId)', async () => {
    const res = await post({ title: 'ok', templateId: 'blank' }, { key: 'idem-badspace', space: 'bad space!' })
    expect(res.status).toBe(400)
    const j = (await res.json()) as { code: string; details?: { field?: string } }
    expect(j.code).toBe('VALIDATION_ERROR')
    expect(j.details?.field).toBe('X-Space-Id')
    expect(createTx).not.toHaveBeenCalled()
  })
})

describe('PPT-API-004 — human create cannot spoof server-owned fields', () => {
  it.each([['ownerId', 'u_evil'], ['spaceId', 's_evil'], ['mountType', 'group'], ['octoDocSlug', 'slug'], ['botToken', 'tok']])(
    'rejects a body-supplied %s with 400 VALIDATION_ERROR and no create',
    async (field, value) => {
      const res = await post({ title: 'ok', templateId: 'blank', [field]: value }, { key: 'idem-spoof' })
      expect(res.status).toBe(400)
      const j = (await res.json()) as { code: string; details?: { fields?: string[] } }
      expect(j.code).toBe('VALIDATION_ERROR')
      expect(j.details?.fields).toContain(field)
      expect(createTx).not.toHaveBeenCalled()
    },
  )
})

describe('PPT-IDEMP-001 — same key + same payload replays', () => {
  it('returns the original response and does not create a second doc', async () => {
    const first = await post({ title: 'Once', templateId: 'blank' }, { key: 'idem-r' })
    const firstBody = (await first.json()) as { docId: string }
    expect(first.status).toBe(201)

    const second = await post({ title: 'Once', templateId: 'blank' }, { key: 'idem-r' })
    const secondBody = (await second.json()) as { docId: string }
    expect(second.status).toBe(201)
    // Byte-identical replay, and the create side effect ran EXACTLY once.
    expect(secondBody).toEqual(firstBody)
    expect(createTx).toHaveBeenCalledTimes(1)
    expect(stateCreateTx).toHaveBeenCalledTimes(1)
    // The replay short-circuits BEFORE opening a transaction.
    expect(transactionMock).toHaveBeenCalledTimes(1)
  })
})

describe.each(['Human', 'Bot'] as const)('retired template receipts — %s', actor => {
  it.each(['pitch', 'report', 'lesson'])('replays a committed %s receipt without enabling new creation', async templateId => {
    const uid = actor === 'Human' ? 'u_1' : 'b_bot'
    const spaceId = actor === 'Human' ? 's_1' : 's_bot'
    if (actor === 'Bot') setOctoIdentity(stub({ verifyBot: async () => ({ uid, spaceId, ownerUid: 'u_creator' }) }))
    const body = { docType: 'html_ppt', title: 'Created before retirement', templateId }
    const key = `committed-${templateId}`
    const receipt = {
      docId: 'd_saved', documentName: `octo:${spaceId}:f_default:ppt:d_saved`,
      title: body.title, spaceId, folderId: 'f_default', ownerId: uid,
      docType: 'html_ppt', role: 'admin', templateId, draftRevision: 0,
      snapshotVersion: 0, editorUrl: '/docs?doc=d_saved', shareUrl: '/d/d_saved',
    }
    const record: Rec = { requestHash: hashCanonicalPayload({ title: body.title, folderId: 'f_default', templateId }),
      responseStatus: 201, responseData: receipt, docId: receipt.docId, completed: true }
    db.idem.set(idemK(spaceId, 'create', uid, key), record)
    const send = (payload = body, requestKey = key) => actor === 'Human'
      ? post(payload, { key: requestKey })
      : fetch(`${base}/v1/bot/docs`, { method: 'POST', headers: {
        authorization: 'Bearer bot-token', 'X-Space-Id': 'spoofed',
        'content-type': 'application/json', 'Idempotency-Key': requestKey,
      }, body: JSON.stringify(payload) })
    const replay = await send()
    expect(replay.status).toBe(201)
    expect(await replay.json()).toEqual(receipt)
    const conflict = await send({ ...body, title: 'Different request' })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ code: 'CONFLICT' })
    expect((await send(body, 'new-key')).status).toBe(400)
    // A receipt for another caller or Space must not authorize a replay.
    db.idem.delete(idemK(spaceId, 'create', uid, key))
    for (const [savedSpace, savedUid] of [[spaceId, 'someone_else'], ['another_space', uid]]) {
      db.idem.clear()
      db.idem.set(idemK(savedSpace!, 'create', savedUid!, key), record)
      expect((await send()).status).toBe(400)
    }
    expect(transactionMock).not.toHaveBeenCalled()
    expect(createTx).not.toHaveBeenCalled()
    expect(upsertDirectTx).not.toHaveBeenCalled()
    expect(stateCreateTx).not.toHaveBeenCalled()
    expect(db.docMeta.size).toBe(0)
    expect(db.pptState.size).toBe(0)
    expect(db.members).toEqual([])
    expect(db.idem.size).toBe(1)
  })
})

describe('PPT-IDEMP-002 — same key + different payload conflicts', () => {
  it('returns 409 CONFLICT with details.idempotencyKey and no second create', async () => {
    const first = await post({ title: 'Original', templateId: 'blank' }, { key: 'idem-c' })
    expect(first.status).toBe(201)
    expect(createTx).toHaveBeenCalledTimes(1)

    const second = await post({ title: 'Changed', templateId: 'blank' }, { key: 'idem-c' })
    expect(second.status).toBe(409)
    const j = (await second.json()) as { code: string; details?: { idempotencyKey?: string } }
    expect(j.code).toBe('CONFLICT')
    expect(j.details?.idempotencyKey).toBe('idem-c')
    // No duplicate side effect.
    expect(createTx).toHaveBeenCalledTimes(1)
  })
})

describe('cross-user idempotency isolation — same key, different user (XIN-1515)', () => {
  it('a second user reusing the same key + payload gets their OWN deck, never the first user\'s response', async () => {
    // User A creates with key K.
    setOctoIdentity(stub({ verifyToken: async () => ({ uid: 'u_A' }) }))
    const a = await post({ title: 'Shared', templateId: 'blank' }, { key: 'shared-key' })
    expect(a.status).toBe(201)
    const aBody = (await a.json()) as { docId: string; ownerId: string; role: string }
    expect(aBody.ownerId).toBe('u_A')
    expect(aBody.role).toBe('admin')
    expect(createTx).toHaveBeenCalledTimes(1)

    // User B (same space) reuses the SAME key + SAME payload. The idempotency row
    // is scoped by uid, so B has no prior record and mints their OWN deck — B must
    // never receive A's response (the cross-user leak this test guards).
    setOctoIdentity(stub({ verifyToken: async () => ({ uid: 'u_B' }) }))
    const b = await post({ title: 'Shared', templateId: 'blank' }, { key: 'shared-key' })
    expect(b.status).toBe(201)
    const bBody = (await b.json()) as { docId: string; ownerId: string }
    expect(bBody.ownerId).toBe('u_B')
    expect(bBody.ownerId).not.toBe('u_A')
    expect(bBody.docId).not.toBe(aBody.docId)
    // A real second create ran for B (not a replay of A's doc); B is admin of B's deck.
    expect(createTx).toHaveBeenCalledTimes(2)
    expect(createTx.mock.calls[1]![1]).toMatchObject({ ownerId: 'u_B' })
    expect(upsertDirectTx.mock.calls.at(-1)![1]).toMatchObject({ uid: 'u_B', roleNum: ROLE_ADMIN, grantedBy: 'u_B' })

    // A's replay still returns A's original response byte-identically, with no new create.
    setOctoIdentity(stub({ verifyToken: async () => ({ uid: 'u_A' }) }))
    const aReplay = await post({ title: 'Shared', templateId: 'blank' }, { key: 'shared-key' })
    expect(aReplay.status).toBe(201)
    expect(await aReplay.json()).toEqual(aBody)
    expect(createTx).toHaveBeenCalledTimes(2)
  })
})

describe('atomic create — partial write failure rolls back cleanly (GitHub RC #160)', () => {
  it('a mid-transaction failure leaves NO orphan rows and does NOT strand the idempotency key', async () => {
    // Force the member write (2nd write, after doc_meta insert) to throw.
    failMemberWrite = true
    const r1 = await post({ title: 'Atomic', templateId: 'blank' }, { key: 'atomic-key' })
    expect(r1.status).toBe(500)
    expect((await r1.json())).toMatchObject({ error: 'internal_error' })

    // Rollback: the doc_meta insert AND the idempotency reservation were both
    // undone — no orphan document, and the key is NOT permanently stranded.
    expect(db.docMeta.size).toBe(0)
    expect(db.pptState.size).toBe(0)
    expect(db.members.length).toBe(0)
    expect(db.idem.size).toBe(0)

    // A retry with the SAME key succeeds (no permanent "in progress" 409) and
    // creates exactly ONE deck — no duplicate.
    failMemberWrite = false
    const r2 = await post({ title: 'Atomic', templateId: 'blank' }, { key: 'atomic-key' })
    expect(r2.status).toBe(201)
    const r2Body = (await r2.json()) as { ownerId: string }
    expect(r2Body.ownerId).toBe('u_1')
    expect(db.docMeta.size).toBe(1)
    expect(db.members.length).toBe(1)
    expect(db.pptState.size).toBe(1)
    expect(db.idem.size).toBe(1)
  })
})

describe('PPT-IDEMP-003 — body idempotencyKey is invalid', () => {
  it('returns 400 VALIDATION_ERROR and creates nothing', async () => {
    const res = await post({ title: 'ok', templateId: 'blank', idempotencyKey: 'in-body' }, { key: 'idem-h' })
    expect(res.status).toBe(400)
    const j = (await res.json()) as { code: string; details?: { fields?: string[] } }
    expect(j.code).toBe('VALIDATION_ERROR')
    expect(j.details?.fields).toContain('idempotencyKey')
    expect(createTx).not.toHaveBeenCalled()
  })
})

describe('create requires the Idempotency-Key header (§4.1)', () => {
  it('returns 400 VALIDATION_ERROR when the header is absent', async () => {
    const res = await post({ title: 'ok', templateId: 'blank' }) // no key
    expect(res.status).toBe(400)
    expect((await res.json())).toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(createTx).not.toHaveBeenCalled()
  })
})

describe('PPT create uses shared Docs auth and Space errors', () => {
  it('returns enveloped 401 AUTH_REQUIRED when the session is missing/invalid', async () => {
    setOctoIdentity(stub({ verifyToken: async () => null }))
    const res = await post({ title: 'ok', templateId: 'blank' }, { key: 'idem-a', token: 'bad' })
    expect(res.status).toBe(401)
    expect((await res.json())).toMatchObject({ error: 'unauthorized' })
  })

  it('returns enveloped 404 NOT_FOUND for a space the caller is NOT a member of', async () => {
    // A spoofed X-Space-Id: valid session token, arbitrary space. The header is
    // client-supplied, so shape validity must not be mistaken for authority —
    // otherwise the deck would be minted INTO another space.
    setOctoIdentity(stub({ verifyToken: async () => ({ uid: 'u_1' }), isSpaceMember: async () => false }))
    const res = await post({ title: 'ok', templateId: 'blank' }, { key: 'idem-nm', space: 's_someone_elses' })
    expect(res.status).toBe(404)
    // NOT_FOUND, never FORBIDDEN: a permission-style error would confirm the
    // space exists and turn this into a space-existence oracle.
    expect((await res.json())).toMatchObject({ error: 'not_found' })
  })

  it('fails CLOSED (404) when the membership lookup itself throws', async () => {
    setOctoIdentity(
      stub({
        verifyToken: async () => ({ uid: 'u_1' }),
        isSpaceMember: async () => {
          throw new Error('octo-server unreachable')
        },
      }),
    )
    const res = await post({ title: 'ok', templateId: 'blank' }, { key: 'idem-fc', space: 's_1' })
    // A transient identity outage must not open the boundary, nor surface as 500.
    expect(res.status).toBe(404)
    expect((await res.json())).toMatchObject({ error: 'not_found' })
  })

  it('fails CLOSED (404) when the membership lookup throws SYNCHRONOUSLY', async () => {
    // Distinct from the case above: that stub is `async`, so it fails via a
    // REJECTED PROMISE, which `.catch()` alone would already contain. Here the
    // throw happens BEFORE any promise exists — the shape an injected identity
    // missing the method produces (a TypeError on call). Express `^4.19.2` does
    // not adopt a rejected promise from an async middleware, so if this were
    // uncontained the request would HANG rather than refuse — the one failure
    // mode a fail-closed authz gate must never have.
    setOctoIdentity(
      stub({
        verifyToken: async () => ({ uid: 'u_1' }),
        isSpaceMember: (() => {
          throw new TypeError('isSpaceMember is not a function')
        }) as never,
      }),
    )
    const res = await post({ title: 'ok', templateId: 'blank' }, { key: 'idem-fc-sync', space: 's_1' })
    expect(res.status).toBe(404)
    expect((await res.json())).toMatchObject({ error: 'not_found' })
  })

  it('returns enveloped 400 VALIDATION_ERROR when X-Space-Id is missing', async () => {
    const res = await fetch(`${base}/api/v1/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', token: 'user-tok', 'Idempotency-Key': 'idem-s' },
      body: JSON.stringify({ title: 'ok', templateId: 'blank' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json())).toMatchObject({ error: 'space_required' })
  })

  it('returns enveloped VALIDATION_ERROR on a malformed JSON body', async () => {
    const res = await fetch(`${base}/api/v1/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', token: 'user-tok', 'X-Space-Id': 's_1', 'Idempotency-Key': 'idem-m' },
      body: '{bad json',
    })
    expect(res.status).toBe(400)
    expect((await res.json())).toMatchObject({ error: 'invalid_body' })
  })
})

describe('Bot PPT creation uses verified authority and atomic owner grants', () => {
  const body = { docType: 'html_ppt', title: 'Bot deck', templateId: 'blank' }
  function botPost(payload: unknown = body, key = 'bot-create') {
    return fetch(`${base}/v1/bot/docs`, {
      method: 'POST', headers: { authorization: 'Bearer bot-token', 'X-Space-Id': 'spoofed',
        'content-type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(payload),
    })
  }
  beforeEach(() => setOctoIdentity(stub({ verifyBot: async () => ({ uid: 'b_bot', spaceId: 's_bot', ownerUid: 'u_creator' }) })))
  it.each(['pitch', 'report', 'lesson'])('rejects retired Bot template %s without writes', async templateId => {
    const response = await botPost({ ...body, templateId }, `retired-bot-${templateId}`)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(transactionMock).not.toHaveBeenCalled()
    expect(db.docMeta.size).toBe(0)
    expect(db.pptState.size).toBe(0)
    expect(db.members).toEqual([])
    expect(db.idem.size).toBe(0)
  })
  it('creates a canonical PPT in the verified Space and grants the human creator admin', async () => {
    const response = await botPost()
    expect(response.status).toBe(201)
    const data = await response.json() as Record<string, unknown>
    expect(data).toMatchObject({ ownerId: 'b_bot', spaceId: 's_bot', docType: 'html_ppt', role: 'admin' })
    expect(data.documentName).toBe(`octo:s_bot:f_default:ppt:${data.docId}`)
    expect(db.members).toEqual([
      { docId: data.docId, uid: 'b_bot', principalSpaceId: 's_bot', roleNum: ROLE_ADMIN, grantedBy: 'b_bot' },
      { docId: data.docId, uid: 'u_creator', principalSpaceId: 's_bot', roleNum: ROLE_ADMIN, grantedBy: 'b_bot' },
    ])
    const replay = await botPost()
    expect(replay.status).toBe(201)
    expect(await replay.json()).toEqual(data)
    expect(db.docMeta.size).toBe(1)
    expect(db.members).toHaveLength(2)
    expect((await botPost({ ...body, title: 'changed' })).status).toBe(409)
  })
  it('rolls back the entire deck and receipt if the human grant fails, allowing retry', async () => {
    failHumanGrant = true
    expect((await botPost()).status).toBe(500)
    expect(db.docMeta.size).toBe(0)
    expect(db.pptState.size).toBe(0)
    expect(db.members).toEqual([])
    expect(db.idem.size).toBe(0)
    failHumanGrant = false
    expect((await botPost()).status).toBe(201)
  })
  it('does not accept Human sessions on the Bot mount', async () => {
    setOctoIdentity(stub({ verifyToken: async () => ({ uid: 'u_1' }) }))
    expect((await botPost()).status).toBe(401)
    expect(db.docMeta.size).toBe(0)
  })
  it.each(['spaceId', 'ownerId', 'botToken', 'idempotencyKey'])('rejects body authority %s', async field => {
    expect((await botPost({ ...body, [field]: 'spoofed' })).status).toBe(400)
    expect(db.docMeta.size).toBe(0)
  })
  it('supports Bots without a human creator without inventing a grant', async () => {
    setOctoIdentity(stub({ verifyBot: async () => ({ uid: 'app_bot', spaceId: 's_bot' }) }))
    expect((await botPost()).status).toBe(201)
    expect(db.members).toHaveLength(1)
    expect(db.members[0]?.uid).toBe('app_bot')
  })
  it('isolates the same replay key between two Bots', async () => {
    const first = await (await botPost()).json() as { docId: string }
    setOctoIdentity(stub({ verifyBot: async () => ({ uid: 'other_bot', spaceId: 's_bot' }) }))
    const second = await (await botPost()).json() as { docId: string }
    expect(second.docId).not.toBe(first.docId)
    expect(db.docMeta.size).toBe(2)
  })
})
