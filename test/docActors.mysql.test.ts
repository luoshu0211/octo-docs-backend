import '../src/config/loadEnv.ts'

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import mysql from 'mysql2/promise'
import type { Server as CollabServer } from '@hocuspocus/server'
import { WebSocket } from 'ws'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../src/collab/autoCompact.js', () => ({ maybeCompactOnUnload: async () => undefined }))
vi.mock('../src/collab/autoSnapshot.js', () => ({ handleAfterStore: async () => undefined, handleBeforeUnload: async () => undefined }))
vi.mock('../src/collab/compactionCluster.js', () => ({ markLoaded: async () => undefined, markUnloaded: async () => undefined }))
vi.mock('../src/collab/compactionNotice.js', () => ({
  clearOverCapShared: async () => undefined,
  noticeStaleCacheOnJoin: async () => undefined,
  resolveUnrestoredOverCap: async () => undefined,
}))
vi.mock('../src/collab/oversizeGuard.js', () => ({
  applyOversizeDecision: async () => undefined,
  clearOverCapResolved: async () => undefined,
  clearOversized: async () => undefined,
  markOversized: async () => undefined,
  noticeOversizeOnJoin: async () => undefined,
  resolveDurableUnrestored: async () => undefined,
  resolvePendingUnrestored: async () => undefined,
  setOversizeAnnouncer: () => undefined,
}))

import { config } from '../src/config/env.js'
import { createApp } from '../src/api/app.js'
import { closePool, query } from '../src/db/pool.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import { setOctoIdentity, type OctoIdentity } from '../src/auth/octoIdentity.js'
import { setDriveDerivedAccess } from '../src/drive/derivedAccessClient.js'
import { createServer as createCollabServer } from '../src/collab/server.js'
import { PptRelay } from '../src/ppt/relay/pptRelay.js'
import { DbPptRelayStore } from '../src/ppt/relay/dbStore.js'
import { issuePptCollabToken } from '../src/auth/pptCollabToken.js'

const enabled = process.env.RUN_OCTO233_DOC_ACTORS_MYSQL_TESTS === '1'
const mysqlDescribe = enabled ? describe.sequential : describe.skip

type RequestOptions = {
  method?: string
  token: string
  spaceId?: string
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
}

let appServer: HttpServer
let baseUrl: string
let collabServer: CollabServer | undefined
const driveDerivedDocs = new Set<string>()

async function request(path: string, options: RequestOptions) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      token: options.token,
      ...(options.spaceId ? { 'X-Space-Id': options.spaceId } : {}),
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: options.signal,
  })
  return { status: response.status, body: await response.json().catch(() => null) as unknown }
}

async function seedDoc(input: {
  docId?: string
  spaceId: string
  ownerId: string
  createdBy: string
  updatedBy?: string
  status?: number
  shareScope?: number
  shareRole?: number
  docType?: string
  updatedAt?: Date
}) {
  const docId = input.docId ?? `d_${randomUUID().replaceAll('-', '')}`
  const docType = input.docType ?? 'doc'
  const documentName = docType === 'html_ppt'
    ? `octo:${input.spaceId}:f_default:ppt:${docId}`
    : `octo:${input.spaceId}:f_default:${docId}`
  await query(
    `INSERT INTO doc_meta
       (doc_id, document_name, title, owner_id, owner_space_id, space_id, doc_type, status,
        share_scope, share_role, created_by, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [docId, documentName, 'Actor fixture', input.ownerId, input.spaceId, input.spaceId, docType,
      input.status ?? 1, input.shareScope ?? 0, input.shareRole ?? 1,
      input.createdBy, input.updatedBy ?? '', input.updatedAt ?? new Date('2020-01-02T03:04:05.000Z')],
  )
  return { docId, documentName }
}

async function createHumanDoc(title: string) {
  const result = await request('/api/v1/docs', {
    method: 'POST', token: 'human-token', spaceId: 'space-a', body: { title, docType: 'doc' },
  })
  expect(result.status).toBe(201)
  return result.body as { docId: string; documentName: string }
}

function receiveUntil(ws: WebSocket, predicate: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage)
      reject(new Error('timed out waiting for PPT relay frame'))
    }, 3000)
    const onMessage = (data: Buffer) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>
      if (!predicate(frame)) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolve(frame)
    }
    ws.on('message', onMessage)
  })
}

mysqlDescribe('OCTO-233 Docs actor wire and authenticated write behavior', () => {
  beforeAll(async () => {
    if (!/^octo233_docs(?:_test)?$/.test(config.mysql.database)) {
      throw new Error('requires the dedicated octo233_docs test database')
    }
    const bootstrap = await mysql.createConnection({ ...config.mysql, multipleStatements: true })
    try {
      const [tables] = await bootstrap.query('SHOW TABLES')
      if ((tables as unknown[]).length === 0) {
        await bootstrap.query(readFileSync(new URL('../migrations/schema.sql', import.meta.url), 'utf8'))
      }
    } finally {
      await bootstrap.end()
    }

    setOctoIdentity({
      verifyToken: async (token: string) => {
        const identitiesByToken: Record<string, { uid: string; ownedBots?: string[] }> = {
          'human-token': { uid: 'human_uid' },
          'reader-token': { uid: 'reader_uid' },
          'owner-token': { uid: 'owner_uid', ownedBots: ['owned_bot_uid'] },
        }
        return identitiesByToken[token] ?? null
      },
      verifyApiKey: async (apiKey: string) => apiKey === 'uk_reader'
        ? { uid: 'reader_uid', spaceId: 'space-a' }
        : null,
      verifyBot: async (token: string) => token === 'bot-token' ? { uid: 'bot_uid', spaceId: 'space-a' } : null,
      isSpaceMember: async (_uid: string, spaceId: string) => spaceId === 'space-a' || spaceId === 'space-b',
    } as unknown as OctoIdentity)
    setDriveDerivedAccess({
      derivedRole: async (docId, uid, principalSpaceId) =>
        driveDerivedDocs.has(docId) && uid === 'reader_uid' && principalSpaceId === 'space-a' ? 'reader' : 'none',
    })
    collabServer = createCollabServer({} as never)

    appServer = createApp({ rateLimit: { max: 1000, windowMs: 60_000 } }).listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => appServer.once('listening', resolve))
    baseUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`
  }, 30_000)

  afterAll(async () => {
    if (appServer) await new Promise<void>((resolve) => appServer.close(() => resolve()))
    await collabServer?.destroy()
    setDriveDerivedAccess({ derivedRole: async () => 'none' })
    await closePool()
  })

  it('returns human and Bot creator IDs plus empty editor IDs on create, GET and list', async () => {
    const human = await createHumanDoc('Human-created actor document')
    const humanGet = await request(`/api/v1/docs/${human.docId}`, { token: 'human-token', spaceId: 'space-a' })
    expect(humanGet.status).toBe(200)
    expect(humanGet.body).toMatchObject({ createdBy: 'human_uid', updatedBy: '' })
    expect((humanGet.body as Record<string, unknown>).updatedAt).toBeTruthy()

    const humanList = await request('/api/v1/docs?owner=me', { token: 'human-token', spaceId: 'space-a' })
    expect(humanList.status).toBe(200)
    expect((humanList.body as { items: Array<Record<string, unknown>> }).items).toContainEqual(
      expect.objectContaining({ docId: human.docId, createdBy: 'human_uid', updatedBy: '' }),
    )

    const botCreate = await request('/v1/bot/docs', {
      method: 'POST', token: 'bot-token', body: { title: 'Bot-created actor document', docType: 'doc' },
    })
    expect(botCreate.status).toBe(201)
    const botDocId = (botCreate.body as { docId: string }).docId
    const botGet = await request(`/v1/bot/docs/${botDocId}`, { token: 'bot-token' })
    expect(botGet.status).toBe(200)
    expect(botGet.body).toMatchObject({ createdBy: 'bot_uid', updatedBy: '' })

    const botList = await request('/v1/bot/docs?owner=me', { token: 'bot-token' })
    expect(botList.status).toBe(200)
    expect((botList.body as { items: Array<Record<string, unknown>> }).items).toContainEqual(
      expect.objectContaining({ docId: botDocId, createdBy: 'bot_uid', updatedBy: '' }),
    )
  })

  it('keeps owner=me list membership and roles while withholding actors for synthetic and archived access', async () => {
    const authorized = await seedDoc({
      spaceId: 'space-a',
      ownerId: 'owner_uid',
      createdBy: 'visible_creator',
      updatedBy: 'visible_editor',
      updatedAt: new Date(),
    })
    const restrictedBot = await seedDoc({
      spaceId: 'space-a',
      ownerId: 'owned_bot_uid',
      createdBy: 'secret_bot_creator',
      updatedBy: 'secret_bot_editor',
      updatedAt: new Date(),
    })
    const archived = await seedDoc({
      spaceId: 'space-a',
      ownerId: 'owner_uid',
      createdBy: 'secret_archived_creator',
      updatedBy: 'secret_archived_editor',
      status: 2,
      updatedAt: new Date(),
    })

    const listed = await request('/api/v1/docs?owner=me&pageSize=100', {
      token: 'owner-token',
      spaceId: 'space-a',
    })
    expect(listed.status).toBe(200)
    const items = (listed.body as { items: Array<Record<string, unknown>> }).items
    const authorizedItem = items.find((item) => item.docId === authorized.docId)
    const restrictedBotItem = items.find((item) => item.docId === restrictedBot.docId)
    const archivedItem = items.find((item) => item.docId === archived.docId)

    expect(authorizedItem).toMatchObject({
      docId: authorized.docId,
      title: 'Actor fixture',
      role: 'admin',
      createdBy: 'visible_creator',
      updatedBy: 'visible_editor',
    })
    expect(restrictedBotItem).toMatchObject({
      docId: restrictedBot.docId,
      title: 'Actor fixture',
      role: 'admin',
    })
    expect(restrictedBotItem).not.toHaveProperty('createdBy')
    expect(restrictedBotItem).not.toHaveProperty('updatedBy')
    expect(archivedItem).toMatchObject({
      docId: archived.docId,
      title: 'Actor fixture',
      role: 'admin',
    })
    expect(archivedItem).not.toHaveProperty('createdBy')
    expect(archivedItem).not.toHaveProperty('updatedBy')

    expect((await request(`/api/v1/docs/${restrictedBot.docId}`, {
      token: 'owner-token',
      spaceId: 'space-a',
    })).status).toBe(403)
    expect((await request(`/api/v1/docs/${archived.docId}`, {
      token: 'owner-token',
      spaceId: 'space-a',
    })).status).toBe(409)
  })

  it('authenticates only metadata requests with native API keys and applies canonical document ACLs', async () => {
    const readable = await seedDoc({
      spaceId: 'space-a',
      ownerId: 'reader_uid',
      createdBy: 'key_visible_creator',
      updatedBy: 'key_visible_editor',
    })
    const inaccessible = await seedDoc({
      spaceId: 'space-a',
      ownerId: 'owner_uid',
      createdBy: 'key_secret_creator',
    })
    const spaceShared = await seedDoc({
      spaceId: 'space-a',
      ownerId: 'owner_uid',
      createdBy: 'key_visible_space_share',
      shareScope: 1,
      shareRole: 1,
    })
    const crossSpace = await seedDoc({
      spaceId: 'space-b',
      ownerId: 'owner_uid',
      createdBy: 'key_cross_space_secret',
    })
    const crossSpaceGranted = await seedDoc({
      spaceId: 'space-b',
      ownerId: 'owner_uid',
      createdBy: 'key_cross_space_visible',
    })
    await docMemberRepo.upsertDirect({
      docId: crossSpaceGranted.docId,
      uid: 'reader_uid',
      principalSpaceId: 'space-a',
      roleNum: 1,
      grantedBy: 'owner_uid',
    })

    const metadata = await request('/api/v1/docs/metadata', {
      method: 'POST',
      token: 'uk_reader',
      body: { docIds: [readable.docId, inaccessible.docId, spaceShared.docId, crossSpace.docId, crossSpaceGranted.docId] },
    })
    expect(metadata.status).toBe(200)
    expect((metadata.body as { items: Array<Record<string, unknown>> }).items).toEqual([
      expect.objectContaining({
        docId: readable.docId,
        createdBy: 'key_visible_creator',
        updatedBy: 'key_visible_editor',
      }),
      expect.objectContaining({
        docId: spaceShared.docId,
        createdBy: 'key_visible_space_share',
      }),
      expect.objectContaining({
        docId: crossSpaceGranted.docId,
        createdBy: 'key_cross_space_visible',
      }),
    ])

    expect((await request(`/api/v1/docs/${readable.docId}`, {
      token: 'uk_reader',
      spaceId: 'space-a',
    })).status).toBe(401)
  })

  it('rejects invalid and client-space-spoofed native API keys on metadata', async () => {
    const invalid = await request('/api/v1/docs/metadata', {
      method: 'POST',
      token: 'uk_rejected',
      spaceId: 'space-a',
      body: { docIds: [] },
    })
    expect(invalid.status).toBe(401)

    const spoofedSpace = await request('/api/v1/docs/metadata', {
      method: 'POST',
      token: 'uk_reader',
      spaceId: 'space-b',
      body: { docIds: [] },
    })
    expect(spoofedSpace.status).toBe(401)
  })

  it('batch metadata returns only active documents readable through the shared Docs role rules', async () => {
    const owned = await seedDoc({ spaceId: 'space-a', ownerId: 'reader_uid', createdBy: 'creator_owned', updatedBy: 'editor_owned' })
    const direct = await seedDoc({ spaceId: 'space-a', ownerId: 'owner_uid', createdBy: 'creator_direct' })
    await docMemberRepo.upsertDirect({ docId: direct.docId, uid: 'reader_uid', principalSpaceId: 'space-a', roleNum: 1, grantedBy: 'owner_uid' })
    const spaceShared = await seedDoc({ spaceId: 'space-a', ownerId: 'owner_uid', createdBy: 'creator_space', shareScope: 1, shareRole: 1 })
    const driveDerived = await seedDoc({ spaceId: 'space-a', ownerId: 'owner_uid', createdBy: 'creator_drive' })
    driveDerivedDocs.add(driveDerived.docId)
    const inaccessible = await seedDoc({ spaceId: 'space-a', ownerId: 'owner_uid', createdBy: 'secret_inaccessible' })
    const crossSpace = await seedDoc({ spaceId: 'space-b', ownerId: 'owner_uid', createdBy: 'secret_cross_space' })
    const archived = await seedDoc({ spaceId: 'space-a', ownerId: 'reader_uid', createdBy: 'secret_archived', status: 2 })
    const unknownId = `d_${randomUUID().replaceAll('-', '')}`

    const batch = await request('/api/v1/docs/metadata', {
      method: 'POST', token: 'reader-token', spaceId: 'space-a',
      body: { docIds: [owned.docId, direct.docId, spaceShared.docId, driveDerived.docId, inaccessible.docId, crossSpace.docId, archived.docId, unknownId, ''] },
    })
    expect(batch.status).toBe(200)
    const items = (batch.body as { items: Array<Record<string, unknown>> }).items
    const returned = items.map((item) => item.docId).sort()
    expect(returned).toEqual([owned.docId, direct.docId, spaceShared.docId, driveDerived.docId].sort())
    expect(items.find((item) => item.docId === owned.docId)).toMatchObject({
      docId: owned.docId, createdBy: 'creator_owned', updatedBy: 'editor_owned',
    })
    expect(items.find((item) => item.docId === owned.docId)?.updatedAt).toBeTruthy()
    expect(items.find((item) => item.docId === direct.docId)).toMatchObject({
      createdBy: 'creator_direct', updatedBy: '',
    })

    expect((await request(`/api/v1/docs/${inaccessible.docId}`, { token: 'reader-token', spaceId: 'space-a' })).status).toBe(403)
    expect((await request(`/api/v1/docs/${archived.docId}`, { token: 'reader-token', spaceId: 'space-a' })).status).toBe(409)
  })

  it('returns a large derived-only metadata batch within the Drive five-second request timeout', async () => {
    const docs = await Promise.all(Array.from({ length: 201 }, (_, index) => seedDoc({
      spaceId: 'space-a',
      ownerId: 'owner_uid',
      createdBy: `derived_creator_${index}`,
      updatedBy: `derived_editor_${index}`,
    })))
    for (const doc of docs) driveDerivedDocs.add(doc.docId)

    setDriveDerivedAccess({
      derivedRole: async (docId, uid, principalSpaceId) => {
        // This integration regression deliberately measures the real HTTP deadline
        // against an external-style provider; fake timers cannot exercise fetch abort.
        const { promise, resolve } = Promise.withResolvers<void>()
        setTimeout(resolve, 400)
        await promise
        return driveDerivedDocs.has(docId) && uid === 'reader_uid' && principalSpaceId === 'space-a'
          ? 'reader'
          : 'none'
      },
    })
    try {
      const batch = await request('/api/v1/docs/metadata', {
        method: 'POST',
        token: 'reader-token',
        spaceId: 'space-a',
        body: { docIds: docs.map((doc) => doc.docId) },
        signal: AbortSignal.timeout(5000),
      })
      expect(batch.status).toBe(200)
      expect((batch.body as { items: Array<Record<string, unknown>> }).items).toEqual(
        docs.map((doc, index) => expect.objectContaining({
          docId: doc.docId,
          createdBy: `derived_creator_${index}`,
          updatedBy: `derived_editor_${index}`,
        })),
      )
    } finally {
      setDriveDerivedAccess({
        derivedRole: async (docId, uid, principalSpaceId) =>
          driveDerivedDocs.has(docId) && uid === 'reader_uid' && principalSpaceId === 'space-a'
            ? 'reader'
            : 'none',
      })
    }
  }, 10_000)

  it('Bot batch metadata honors the server-resolved Space and exact cross-Space direct grants', async () => {
    const owned = await seedDoc({ spaceId: 'space-a', ownerId: 'bot_uid', createdBy: 'creator_bot' })
    const exactCrossSpace = await seedDoc({ spaceId: 'space-b', ownerId: 'owner_uid', createdBy: 'creator_exact' })
    await docMemberRepo.upsertDirect({ docId: exactCrossSpace.docId, uid: 'bot_uid', principalSpaceId: 'space-a', roleNum: 1, grantedBy: 'owner_uid' })
    const wrongPrincipal = await seedDoc({ spaceId: 'space-b', ownerId: 'owner_uid', createdBy: 'secret_wrong_principal' })
    await docMemberRepo.upsertDirect({ docId: wrongPrincipal.docId, uid: 'bot_uid', principalSpaceId: 'space-b', roleNum: 1, grantedBy: 'owner_uid' })
    const noGrant = await seedDoc({ spaceId: 'space-b', ownerId: 'owner_uid', createdBy: 'secret_no_grant' })

    const batch = await request('/v1/bot/docs/metadata', {
      method: 'POST', token: 'bot-token',
      body: { docIds: [owned.docId, exactCrossSpace.docId, wrongPrincipal.docId, noGrant.docId] },
    })
    expect(batch.status).toBe(200)
    const items = (batch.body as { items: Array<Record<string, unknown>> }).items
    expect(items.map((item) => item.docId).sort()).toEqual([owned.docId, exactCrossSpace.docId].sort())
  })

  it('REST content save publishes the authenticated editor through existing Docs metadata', async () => {
    const doc = await createHumanDoc('REST editor propagation')
    await query('UPDATE doc_meta SET updated_at = ? WHERE doc_id = ?', [new Date('2020-01-02T03:04:05.000Z'), doc.docId])
    const before = await docMetaRepo.getByDocId(doc.docId)
    expect(before?.updated_by).toBe('')
    const content = await request(`/api/v1/docs/${doc.docId}/content`, { token: 'human-token', spaceId: 'space-a' })
    expect(content.status).toBe(200)
    const baseVersion = (content.body as { baseVersion: string }).baseVersion

    const saved = await request(`/api/v1/docs/${doc.docId}/content`, {
      method: 'PATCH', token: 'human-token', spaceId: 'space-a',
      headers: { 'If-Match': `"${baseVersion}"` },
      body: { ops: [{ type: 'insert', at: { path: [], position: 'inside_start' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'saved by human' }] }] }] },
    })
    expect(saved.status).toBe(200)
    const after = await docMetaRepo.getByDocId(doc.docId)
    expect(after?.updated_by).toBe('human_uid')
    expect(after?.updated_at.getTime()).toBeGreaterThan(before!.updated_at.getTime())
    const wire = await request(`/api/v1/docs/${doc.docId}`, { token: 'human-token', spaceId: 'space-a' })
    expect(wire.body).toMatchObject({ createdBy: 'human_uid', updatedBy: 'human_uid' })
    expect((wire.body as { updatedAt: string }).updatedAt).toBe(after!.updated_at.toISOString())
  })

  it('PPT relay persists the authenticated principal as Docs updatedBy', async () => {
    const docId = `d_${randomUUID().replaceAll('-', '')}`
    const documentName = `octo:space-a:f_default:ppt:${docId}`
    await seedDoc({
      docId, spaceId: 'space-a', ownerId: 'ppt_owner', createdBy: 'ppt_owner', docType: 'html_ppt',
      updatedAt: new Date('2020-01-02T03:04:05.000Z'),
    })

    const relay = new PptRelay({
      requireBoundActors: true,
      store: new DbPptRelayStore(),
      epochProvider: async () => 0,
      roleProvider: async () => 'writer',
      docStatusProvider: async () => 'live',
    })
    const httpServer = createHttpServer()
    relay.attach(httpServer)
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject)
      httpServer.listen(0, '127.0.0.1', resolve)
    })
    let ws: WebSocket | undefined
    try {
      const port = (httpServer.address() as AddressInfo).port
      const auth = issuePptCollabToken({
        uid: 'ppt_editor_uid', docId, documentName, role: 'writer', permission_epoch: 0,
        principalSpaceId: 'space-a', snapshotVersion: 0, homeSpaceVerified: true,
        currentSpaceVerified: true, clientSessionId: randomUUID(),
      })
      ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ppt/collab`, ['ppt-relay', auth.ticket])
      await new Promise<void>((resolve, reject) => {
        ws!.once('open', resolve)
        ws!.once('error', reject)
      })
      const ready = receiveUntil(ws, (frame) => frame.ctl === 'ready')
      ws.send(JSON.stringify({ t: 'hello', pv: 2, since: 0 }))
      await ready

      const ack = receiveUntil(ws, (frame) => frame.ctl === 'ack' || frame.ctl === 'refused')
      ws.send(JSON.stringify({
        t: 'ops', pv: 2, k: 1, frameId: randomUUID(), epoch: 0,
        ops: [{ op: 'set', a: auth.actor, s: 1, l: 1, k: 'notes', v: 'relay content' }],
      }))
      expect(await ack).toMatchObject({ ctl: 'ack' })
      const after = await docMetaRepo.getByDocId(docId)
      expect(after?.updated_by).toBe('ppt_editor_uid')
      expect(after?.updated_at.getTime()).toBeGreaterThan(new Date('2020-01-02T03:04:05.000Z').getTime())
    } finally {
      ws?.close()
      relay.close()
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    }
  })
})
