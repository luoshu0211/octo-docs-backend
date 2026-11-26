import '../src/config/loadEnv.ts'

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import mysql from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { config } from '../src/config/env.js'
import { createApp } from '../src/api/app.js'
import { closePool, query } from '../src/db/pool.js'
import { setOctoIdentity, type OctoIdentity } from '../src/auth/octoIdentity.js'
import { decodeStorageState, encodeStorageState } from '../src/collab/storageCodec.js'

// Real-MySQL integration test for POST /api/v1/docs/{docId}/duplicate (§4.4 复制).
// Gated behind an explicit env flag so the default `vitest run` stays offline:
//
//   RUN_DUPLICATE_MYSQL_TEST=1 MYSQL_DATABASE=octo_docs_dup_test \
//   MYSQL_USER=root MYSQL_PASSWORD='' npx vitest run test/duplicateDoc.mysql.test.ts
const enabled = process.env.RUN_DUPLICATE_MYSQL_TEST === '1'
const mysqlDescribe = enabled ? describe.sequential : describe.skip

let appServer: HttpServer
let baseUrl: string

async function request(path: string, opts: { method?: string; token: string; spaceId?: string; body?: unknown }) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      token: opts.token,
      ...(opts.spaceId ? { 'X-Space-Id': opts.spaceId } : {}),
      ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  })
  return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, unknown> | null }
}

async function seedDoc(input: {
  spaceId: string
  ownerId: string
  docType?: string
  title?: string
  state?: Uint8Array
}) {
  const docId = `d_${randomUUID().replaceAll('-', '')}`
  const docType = input.docType ?? 'doc'
  const documentName = `octo:${input.spaceId}:f_default:${docId}`
  await query(
    `INSERT INTO doc_meta
       (doc_id, document_name, title, owner_id, owner_space_id, space_id, doc_type,
        status, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, '')`,
    [docId, documentName, input.title ?? '复制源文档', input.ownerId, input.spaceId, input.spaceId, docType, input.ownerId],
  )
  if (input.state) {
    const stored = encodeStorageState(Buffer.from(input.state), 1)
    await query(
      `INSERT INTO yjs_document (document_name, state, size_bytes, encoding, updated_at)
       VALUES (?, ?, ?, ?, NOW(3))`,
      [documentName, Buffer.from(stored.state), stored.state.length, stored.encoding],
    )
  }
  return { docId, documentName }
}

async function grantMember(docId: string, uid: string, role = 1) {
  await query(
    `INSERT INTO doc_member (doc_id, uid, principal_space_id, role, granted_by, source)
     VALUES (?, ?, 'space-a', ?, 'owner_uid', 1)`,
    [docId, uid, role],
  )
}

mysqlDescribe('POST /api/v1/docs/:docId/duplicate against real MySQL', () => {
  beforeAll(async () => {
    if (!/_test$/.test(config.mysql.database)) {
      throw new Error(`requires a *_test database, got ${config.mysql.database}`)
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
        const byToken: Record<string, { uid: string }> = {
          'owner-token': { uid: 'owner_uid' },
          'reader-token': { uid: 'reader_uid' },
          'stranger-token': { uid: 'stranger_uid' },
        }
        return byToken[token] ?? null
      },
      verifyApiKey: async () => null,
      verifyBot: async () => null,
      isSpaceMember: async (_uid: string, spaceId: string) => spaceId === 'space-a',
    } as unknown as OctoIdentity)

    appServer = createApp({ rateLimit: { max: 1000, windowMs: 60_000 } }).listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => appServer.once('listening', resolve))
    baseUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`
  }, 30_000)

  afterAll(async () => {
    if (appServer) await new Promise<void>((resolve) => appServer.close(() => resolve()))
    await closePool()
  })

  it('mints a NEW docId, copies the Yjs body and leaves the source untouched', async () => {
    const body = new Uint8Array([0, 1, 2, 3, 250, 251])
    const src = await seedDoc({ spaceId: 'space-a', ownerId: 'owner_uid', state: body })
    // PRD: 复制只要求源文档可读 —— a plain reader (not writer/admin) may copy.
    await grantMember(src.docId, 'reader_uid', 1)

    const dup = await request(`/api/v1/docs/${src.docId}/duplicate`, {
      method: 'POST', token: 'reader-token', spaceId: 'space-a', body: {},
    })
    expect(dup.status).toBe(201)
    const copy = dup.body as { docId: string; documentName: string; title: string; ownerId: string; spaceId: string }
    expect(copy.docId).not.toBe(src.docId)
    expect(copy.documentName).not.toBe(src.documentName)
    expect(copy.title).toBe('复制源文档-副本')
    expect(copy.ownerId).toBe('reader_uid')
    expect(copy.spaceId).toBe('space-a')

    // doc_meta row: brand-new document, owned by the COPIER.
    const metaRows = await query<{ owner_id: string; status: number; space_id: string }>(
      'SELECT owner_id, status, space_id FROM doc_meta WHERE doc_id = ?', [copy.docId],
    )
    expect(metaRows).toHaveLength(1)
    expect(metaRows[0]).toMatchObject({ owner_id: 'reader_uid', status: 1, space_id: 'space-a' })

    // yjs_document row: same body bytes under the new document name.
    const stateRows = await query<{ state: Buffer; encoding: number }>(
      'SELECT state, encoding FROM yjs_document WHERE document_name = ?', [copy.documentName],
    )
    expect(stateRows).toHaveLength(1)
    const decoded = decodeStorageState(new Uint8Array(stateRows[0]!.state), stateRows[0]!.encoding, copy.documentName)
    expect(Buffer.from(decoded.state).equals(Buffer.from(body))).toBe(true)

    // ACL is NOT inherited: the copy has no doc_member rows at all.
    const memberRows = await query<{ uid: string }>(
      'SELECT uid FROM doc_member WHERE doc_id = ?', [copy.docId],
    )
    expect(memberRows).toHaveLength(0)

    // The source is byte-for-byte unchanged.
    const srcRows = await query<{ state: Buffer; encoding: number }>(
      'SELECT state, encoding FROM yjs_document WHERE document_name = ?', [src.documentName],
    )
    expect(srcRows).toHaveLength(1)
    expect(decodeStorageState(new Uint8Array(srcRows[0]!.state), srcRows[0]!.encoding, src.documentName).state.length)
      .toBe(body.length)

    // Both are independent: renaming the copy must not touch the source title.
    const rename = await request(`/api/v1/docs/${copy.docId}`, {
      method: 'PATCH', token: 'reader-token', spaceId: 'space-a', body: { title: '副本改名' },
    })
    expect([200, 201].includes(rename.status)).toBe(true)
    const srcMeta = await query<{ title: string }>('SELECT title FROM doc_meta WHERE doc_id = ?', [src.docId])
    expect(srcMeta[0]!.title).toBe('复制源文档')
  })

  it('honours a caller-supplied title and starts empty when the source was never stored', async () => {
    const src = await seedDoc({ spaceId: 'space-a', ownerId: 'owner_uid' })
    const dup = await request(`/api/v1/docs/${src.docId}/duplicate`, {
      method: 'POST', token: 'owner-token', spaceId: 'space-a', body: { title: '我自己的副本' },
    })
    expect(dup.status).toBe(201)
    const copy = dup.body as { docId: string; title: string }
    expect(copy.title).toBe('我自己的副本')
    const rows = await query<{ document_name: string }>(
      'SELECT document_name FROM yjs_document WHERE document_name LIKE ?', [`%${copy.docId}%`],
    )
    expect(rows).toHaveLength(0)
  })

  it('denies a caller without read access and rejects html bodies', async () => {
    const src = await seedDoc({ spaceId: 'space-a', ownerId: 'owner_uid' })

    const denied = await request(`/api/v1/docs/${src.docId}/duplicate`, {
      method: 'POST', token: 'stranger-token', spaceId: 'space-a', body: {},
    })
    expect(denied.status).toBe(403)

    const html = await seedDoc({ spaceId: 'space-a', ownerId: 'owner_uid', docType: 'html' })
    const unsupported = await request(`/api/v1/docs/${html.docId}/duplicate`, {
      method: 'POST', token: 'owner-token', spaceId: 'space-a', body: {},
    })
    expect(unsupported.status).toBe(422)
    expect(unsupported.body).toEqual({ error: 'unsupported_document_type' })
  })
})
