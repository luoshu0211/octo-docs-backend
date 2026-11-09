import '../src/config/loadEnv.ts'

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import mysql from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { config } from '../src/config/env.js'
import { createApp } from '../src/api/app.js'
import { closePool, query } from '../src/db/pool.js'
import { setOctoIdentity, type OctoIdentity } from '../src/auth/octoIdentity.js'

const enabled = process.env.RUN_OCTO233_REVIEW_MYSQL_TESTS === '1'
const mysqlDescribe = enabled ? describe.sequential : describe.skip
const fixtureSuffix = randomUUID().replaceAll('-', '')
const fixtureSpace = `review_${fixtureSuffix}`
const fixtureOwner = `review_owner_${fixtureSuffix}`
const fixtureCreator = `review_creator_${fixtureSuffix}`
const fixtureEditor = `review_editor_${fixtureSuffix}`
const fixtureDocId = `Octo233${fixtureSuffix}`
const unauthorizedDocId = `private${fixtureSuffix}`
const fixtureToken = `octo233-review-${fixtureSuffix}`
const fixtureDocIds = [fixtureDocId, unauthorizedDocId]

let appServer: Server
let baseUrl: string
let fixtureDatabaseReady = false

async function stopServer(server: Server): Promise<void> {
  server.closeAllConnections()
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  server.close(error => error ? reject(error) : resolve())
  await promise
}

mysqlDescribe('OCTO-233 metadata alias IDs on MySQL', () => {
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
      const [columns] = await bootstrap.query("SHOW FULL COLUMNS FROM doc_meta LIKE 'doc_id'")
      const docIdColumn = (columns as Array<{ Collation?: string | null }>)[0]
      if (!docIdColumn?.Collation || !/_ci$/i.test(docIdColumn.Collation)) {
        throw new Error('requires a case-insensitive doc_meta.doc_id collation')
      }
    } finally {
      await bootstrap.end()
    }
    fixtureDatabaseReady = true

    setOctoIdentity({
      verifyToken: async token => token === fixtureToken ? { uid: fixtureOwner } : null,
      verifyApiKey: async () => null,
      verifyBot: async () => null,
      isSpaceMember: async (_uid, spaceId) => spaceId === fixtureSpace,
    } as unknown as OctoIdentity)
    appServer = createServer(createApp({
      rateLimit: { max: 1000, windowMs: 60_000 },
      trustProxy: false,
    }))
    const { promise, resolve } = Promise.withResolvers<void>()
    appServer.listen(0, '127.0.0.1', resolve)
    await promise
    baseUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`

    const updatedAt = new Date('2025-02-03T04:05:06.000Z')
    for (const [docId, ownerId, creator, editor] of [
      [fixtureDocId, fixtureOwner, fixtureCreator, fixtureEditor],
      [unauthorizedDocId, 'another_fixture_owner', 'private_creator', 'private_editor'],
    ]) {
      await query(
        `INSERT INTO doc_meta
           (doc_id, document_name, title, owner_id, owner_space_id, space_id, folder_id,
            doc_type, status, share_scope, share_role, created_by, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'f_default', 'doc', 1, 0, 1, ?, ?, ?)`,
        [docId, `octo:${fixtureSpace}:f_default:${docId}`, 'OCTO-233 alias fixture', ownerId,
          fixtureSpace, fixtureSpace, creator, editor, updatedAt],
      )
    }
  }, 30_000)

  afterAll(async () => {
    if (appServer) await stopServer(appServer)
    if (fixtureDatabaseReady) {
      await query('DELETE FROM doc_meta WHERE doc_id IN (?, ?)', fixtureDocIds)
    }
    await closePool()
  })

  it('returns each authorized case alias as requested and omits an unauthorized existing ID', async () => {
    const alias = fixtureDocId.toLowerCase()
    const response = await fetch(`${baseUrl}/api/v1/docs/metadata`, {
      method: 'POST',
      headers: {
        token: fixtureToken,
        'X-Space-Id': fixtureSpace,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ docIds: [fixtureDocId, alias, unauthorizedDocId] }),
      signal: AbortSignal.timeout(5000),
    })
    expect(response.status).toBe(200)
    const items = (await response.json() as {
      items: Array<{ docId: string; createdBy: string; updatedBy: string; updatedAt: string }>
    }).items

    expect(items.map(item => item.docId)).toEqual([fixtureDocId, alias])
    expect(items[0]).toMatchObject({ createdBy: fixtureCreator, updatedBy: fixtureEditor })
    expect(items[1]).toMatchObject({ createdBy: fixtureCreator, updatedBy: fixtureEditor })
    expect(items[0]?.updatedAt).toBeTruthy()
    expect(items[1]?.updatedAt).toBe(items[0]?.updatedAt)
  })
})
