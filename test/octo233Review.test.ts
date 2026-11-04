import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DocMeta } from '../src/db/repos/docMetaRepo.js'
import type { OctoIdentity } from '../src/auth/octoIdentity.js'

const database = vi.hoisted(() => {
  const state = {
    rowsById: new Map<string, Record<string, unknown>>(),
    listItems: [] as Array<Record<string, unknown>>,
    permissionError: undefined as Error | undefined,
    memberRoles: new Map<string, number>(),
  }
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()
    if (state.permissionError && normalized.startsWith('select role from doc_member where doc_id = ?')) {
      throw state.permissionError
    }
    if (normalized.includes('select count(*) as cnt') && normalized.includes('from doc_meta m')) {
      return [{ cnt: state.listItems.length }]
    }
    if (normalized.startsWith('select m.*,') && normalized.includes('from doc_meta m')) {
      return [...state.listItems]
    }
    if (normalized.startsWith('select * from doc_meta where doc_id = ?')) {
      const row = state.rowsById.get(String(params[0] ?? '').toLowerCase())
      return row ? [row] : []
    }
    if (normalized.startsWith('select role from doc_member where doc_id = ?')) {
      const key = [params[0], params[1], params[2]].map(value => String(value ?? '')).join('\0')
      const role = state.memberRoles.get(key)
      return role === undefined ? [] : [{ role }]
    }
    return []
  })
  return { state, query }
})

vi.mock('../src/db/pool.js', () => ({
  query: (sql: string, params?: unknown[]) => database.query(sql, params),
  getPool: () => ({
    execute: async (sql: string, params?: unknown[]) => [await database.query(sql, params), []],
  }),
  transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation({
    query: (sql: string, params?: unknown[]) => database.query(sql, params),
    execute: async (sql: string, params?: unknown[]) => {
      await database.query(sql, params)
      return { affectedRows: 1 }
    },
  }),
  closePool: async () => undefined,
}))

import { createApp } from '../src/api/app.js'
import { HttpOctoIdentity, setOctoIdentity } from '../src/auth/octoIdentity.js'
import { setDriveDerivedAccess } from '../src/drive/derivedAccessClient.js'

const NULL_DRIVE_ACCESS = {
  derivedAccess: async () => null,
  versions: async () => null,
}

function makeMeta(
  docId: string,
  ownerId: string,
  overrides: Partial<DocMeta> = {},
): DocMeta {
  return {
    doc_id: docId,
    document_name: `octo:space-a:f_default:${docId}`,
    title: docId,
    owner_id: ownerId,
    owner_space_id: 'space-a',
    space_id: 'space-a',
    folder_id: 'f_default',
    doc_type: 'doc',
    octo_doc_slug: null,
    html_idempotency_key_hash: null,
    status: 1,
    permission_epoch: 0,
    share_scope: 0,
    share_role: 1,
    discoverability_scope: 1,
    created_at: new Date('2024-01-02T03:04:05.000Z'),
    updated_at: new Date('2025-02-03T04:05:06.000Z'),
    created_by: 'creator_uid',
    updated_by: 'editor_uid',
    ...overrides,
  }
}

function seedMeta(meta: DocMeta): void {
  database.state.rowsById.set(meta.doc_id.toLowerCase(), meta as unknown as Record<string, unknown>)
}

function installSessionIdentity(tokens: Record<string, string>): void {
  setOctoIdentity({
    verifyToken: async token => tokens[token] ? { uid: tokens[token] } : null,
    verifyApiKey: async () => null,
    verifyBot: async () => null,
    isSpaceMember: async (_uid, spaceId) => spaceId === 'space-a',
  } as unknown as OctoIdentity)
}

async function startApp(max = 100): Promise<{ server: Server; base: string }> {
  const server = createServer(createApp({
    rateLimit: { windowMs: 60_000, max },
    trustProxy: false,
  }))
  const { promise, resolve } = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', resolve)
  await promise
  return {
    server,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  }
}

async function stopServer(server: Server): Promise<void> {
  server.closeAllConnections()
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  server.close(error => error ? reject(error) : resolve())
  await promise
}

async function request(
  base: string,
  path: string,
  options: { method?: string; token: string; spaceId?: string; body?: unknown },
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      token: options.token,
      ...(options.spaceId ? { 'X-Space-Id': options.spaceId } : {}),
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(3000),
  })
}

async function requestStatus(
  base: string,
  path: string,
  options: { method?: string; token: string; spaceId?: string; body?: unknown },
): Promise<number> {
  const response = await request(base, path, options)
  await response.arrayBuffer()
  return response.status
}

afterEach(() => {
  vi.restoreAllMocks()
  database.state.rowsById.clear()
  database.state.listItems.length = 0
  database.state.permissionError = undefined
  database.state.memberRoles.clear()
  database.query.mockClear()
  setDriveDerivedAccess(NULL_DRIVE_ACCESS)
})

describe('OCTO-233 docs list and API-key identity behavior', () => {
  it('forwards a list permission-query failure to Express and completes with HTTP 500', async () => {
    installSessionIdentity({ 'session:reader': 'reader_uid' })
    const doc = makeMeta('permission_failure_doc', 'another_owner_uid')
    seedMeta(doc)
    database.state.listItems.push({ ...doc, role: 1 })
    database.state.permissionError = new Error('fixture permission lookup failure')
    const { server, base } = await startApp()
    try {
      const response = await request(base, '/api/v1/docs?q=fixture&discoverable=true', {
        token: 'session:reader',
        spaceId: 'space-a',
      })
      expect(response.status).toBe(500)
    } finally {
      await stopServer(server)
    }
  })

  it('includes actors for a Drive-derived reader row and withholds them from an unreadable discoverable row', async () => {
    installSessionIdentity({ 'session:reader': 'reader_uid' })
    const driveDoc = makeMeta('drive_derived_doc', 'owner_uid', {
      created_by: 'drive_creator_uid',
      updated_by: 'drive_editor_uid',
    })
    const hiddenDoc = makeMeta('unreadable_doc', 'other_owner_uid', {
      created_by: 'private_creator_uid',
      updated_by: 'private_editor_uid',
    })
    seedMeta(driveDoc)
    seedMeta(hiddenDoc)
    database.state.listItems.push(
      { ...driveDoc, role: null },
      { ...hiddenDoc, role: null },
    )
    setDriveDerivedAccess({
      derivedAccess: async (docId, uid, principalSpaceId) =>
        docId === driveDoc.doc_id && uid === 'reader_uid' && principalSpaceId === 'space-a'
          ? {
              docId,
              uid,
              principalSpaceId,
              role: 'reader',
              sourceRevision: 'test-revision',
              validForMs: 30_000,
              expiresAt: performance.now() + 30_000,
            }
          : null,
      versions: async () => null,
    })
    const { server, base } = await startApp()
    try {
      const listed = await request(base, '/api/v1/docs?q=fixture&discoverable=true', {
        token: 'session:reader',
        spaceId: 'space-a',
      })
      expect(listed.status).toBe(200)
      const listItems = (await listed.json() as { items: Array<Record<string, unknown>> }).items
      const driveItem = listItems.find(item => item.docId === driveDoc.doc_id)
      const hiddenItem = listItems.find(item => item.docId === hiddenDoc.doc_id)
      expect(driveItem).toMatchObject({
        docId: driveDoc.doc_id,
        createdBy: 'drive_creator_uid',
        updatedBy: 'drive_editor_uid',
      })
      expect(hiddenItem).toBeDefined()
      expect(hiddenItem).not.toHaveProperty('createdBy')
      expect(hiddenItem).not.toHaveProperty('updatedBy')

      const metadataResponse = await request(base, '/api/v1/docs/metadata', {
        method: 'POST',
        token: 'session:reader',
        spaceId: 'space-a',
        body: { docIds: [driveDoc.doc_id] },
      })
      expect(metadataResponse.status).toBe(200)
      const metadataItem = (await metadataResponse.json() as { items: Array<Record<string, unknown>> }).items[0]
      const getResponse = await request(base, `/api/v1/docs/${driveDoc.doc_id}`, {
        token: 'session:reader',
        spaceId: 'space-a',
      })
      expect(getResponse.status).toBe(200)
      const getItem = await getResponse.json() as Record<string, unknown>
      expect(driveItem).toMatchObject({
        createdBy: metadataItem?.createdBy,
        updatedBy: metadataItem?.updatedBy,
      })
      expect(driveItem).toMatchObject({
        createdBy: getItem.createdBy,
        updatedBy: getItem.updatedBy,
      })
    } finally {
      await stopServer(server)
    }
  })
})

type ApiKeyAuthorityMode = 'malformed' | 'read_failure' | 'invalid'
const authorityOrigin = 'http://identity-authority.fixture.test'
let authorityMode: ApiKeyAuthorityMode = 'malformed'

async function requestApiKey(): Promise<{
  status: number
  body: unknown
  authorityCalls: Array<{ url: string; method: string | undefined }>
}> {
  const authorityUrl = `${authorityOrigin}/v1/auth/verify-api-key`
  const authorityCalls: Array<{ url: string; method: string | undefined }> = []
  const realFetch = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url !== authorityUrl || init?.method !== 'POST') return realFetch(input, init)
    authorityCalls.push({ url, method: init.method })

    if (authorityMode === 'invalid') {
      return Promise.resolve(new Response('{"error":"invalid_key"}', {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }))
    }
    if (authorityMode === 'read_failure') {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"uid":"reader_uid"'))
          controller.error(new Error('fixture body read failure'))
        },
      })
      return Promise.resolve(new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    }
    return Promise.resolve(new Response('{', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
  })

  setOctoIdentity(new HttpOctoIdentity(authorityOrigin))
  const { server, base } = await startApp()
  try {
    const response = await request(base, '/api/v1/docs/metadata', {
      method: 'POST',
      token: 'uk_fixture_key',
      body: { docIds: [] },
    })
    return {
      status: response.status,
      body: await response.json().catch(() => null) as unknown,
      authorityCalls,
    }
  } finally {
    await stopServer(server)
  }
}

describe('OCTO-233 API-key authority failures', () => {
  it('returns 503 when the API-key authority responds 200 with malformed JSON', async () => {
    authorityMode = 'malformed'
    const response = await requestApiKey()
    expect(response.status).toBe(503)
    expect(response.body).toEqual({ error: 'identity_unavailable' })
    expect(response.authorityCalls).toEqual([
      { url: `${authorityOrigin}/v1/auth/verify-api-key`, method: 'POST' },
    ])
  })

  it('returns 503 when reading a successful API-key authority response fails', async () => {
    authorityMode = 'read_failure'
    const response = await requestApiKey()
    expect(response.status).toBe(503)
    expect(response.body).toEqual({ error: 'identity_unavailable' })
    expect(response.authorityCalls).toEqual([
      { url: `${authorityOrigin}/v1/auth/verify-api-key`, method: 'POST' },
    ])
  })

  it('keeps an authority-confirmed invalid API key at 401', async () => {
    authorityMode = 'invalid'
    const response = await requestApiKey()
    expect(response.status).toBe(401)
    expect(response.authorityCalls).toEqual([
      { url: `${authorityOrigin}/v1/auth/verify-api-key`, method: 'POST' },
    ])
  })

  it('keeps valid and invalid session-token authentication on the existing session path', async () => {
    installSessionIdentity({ 'session:reader': 'reader_uid' })
    seedMeta(makeMeta('session_metadata_doc', 'reader_uid'))
    const { server, base } = await startApp()
    try {
      const valid = await request(base, '/api/v1/docs/metadata', {
        method: 'POST',
        token: 'session:reader',
        spaceId: 'space-a',
        body: { docIds: ['session_metadata_doc'] },
      })
      expect(valid.status).toBe(200)
      const body = await valid.json() as { items: Array<{ docId: string }> }
      expect(body.items.map(item => item.docId)).toEqual(['session_metadata_doc'])

      const invalid = await request(base, '/api/v1/docs/metadata', {
        method: 'POST',
        token: 'invalid-session',
        spaceId: 'space-a',
        body: { docIds: [] },
      })
      expect(invalid.status).toBe(401)
    } finally {
      await stopServer(server)
    }
  })
})

describe('Docs existing source-IP rate limits', () => {

  it('keeps unauthenticated metadata attempts in the shared source-IP quota', async () => {
    installSessionIdentity({})
    const { server, base } = await startApp(2)
    const invalidStatus = (token: string) => requestStatus(base, '/api/v1/docs/metadata', {
      method: 'POST', token, spaceId: 'space-a', body: { docIds: [] },
    })
    try {
      expect(await invalidStatus('uk_invalid_key_a')).toBe(401)
      expect(await invalidStatus('uk_invalid_key_b')).toBe(401)
      expect(await invalidStatus('uk_invalid_key_c')).toBe(429)
    } finally {
      await stopServer(server)
    }
  })

  it('keeps ordinary document GET requests limited by source IP', async () => {
    installSessionIdentity({ 'session:user-a': 'user_a' })
    seedMeta(makeMeta('ordinary_ip_limited_doc', 'user_a'))
    const { server, base } = await startApp(2)
    const getStatus = () => requestStatus(base, '/api/v1/docs/ordinary_ip_limited_doc', {
      token: 'session:user-a', spaceId: 'space-a',
    })
    try {
      expect(await getStatus()).toBe(200)
      expect(await getStatus()).toBe(200)
      expect(await getStatus()).toBe(429)
    } finally {
      await stopServer(server)
    }
  })
})
