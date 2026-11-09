import './helpers/pptRelayEnv.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import mysql from 'mysql2/promise'
import { config } from '../src/config/env.js'
import { query, closePool } from '../src/db/pool.js'
import { splitSqlStatements } from '../src/db/migrate.js'
import { closeRedis } from '../src/db/redis.js'
import { createApp } from '../src/api/app.js'
import { setOctoIdentity } from '../src/auth/octoIdentity.js'
import { DbPptRelayStore } from '../src/ppt/relay/dbStore.js'
import { PptSnapshotter } from '../src/ppt/relay/snapshotter.js'
import { hashBentoDeck } from '../src/ppt/source.js'
import type { BentoDoc } from '../src/ppt/bentoDoc.js'

describe.skipIf(process.env.PPT_BUDGET_MYSQL_TEST !== '1')('PPT 32 MiB real persistence', () => {
  let server: Server | undefined, base: string
  beforeAll(async () => {
    if (!/^ppt_case_test_budget_[a-z0-9_]+$/.test(config.mysql.database)) throw new Error('requires an empty dedicated ppt_case_test_budget_* database')
    const conn = await mysql.createConnection({ ...config.mysql, multipleStatements: true })
    try {
      const [tables] = await conn.query('SHOW TABLES')
      if ((tables as unknown[]).length) throw new Error('requires an empty database')
      await conn.query(readFileSync(new URL('../migrations/schema.sql', import.meta.url), 'utf8'))
      // Simulate the previous schema, retain a sentinel row, then upgrade twice.
      await conn.query('ALTER TABLE ppt_doc_state MODIFY draft_doc MEDIUMTEXT NOT NULL')
      await conn.query('ALTER TABLE ppt_live_snapshot MODIFY doc_json MEDIUMTEXT NOT NULL, MODIFY state_json MEDIUMTEXT NULL DEFAULT NULL')
      await conn.query('ALTER TABLE ppt_version MODIFY deck_json MEDIUMTEXT NOT NULL')
      await conn.query("INSERT INTO ppt_live_snapshot (doc_id,snapshot_version,covered_seq,doc_json,doc_sha,doc_bytes) VALUES ('migration-sentinel',1,0,'{}',REPEAT('0',64),2)")
      const sql = readFileSync(new URL('../migrations/upgrades/2026-09-20-ppt-document-budget.sql', import.meta.url), 'utf8')
      for (let repeat = 0; repeat < 2; repeat++) for (const statement of splitSqlStatements(sql)) await conn.query(statement)
      const [sentinel] = await conn.query("SELECT doc_json FROM ppt_live_snapshot WHERE doc_id='migration-sentinel'")
      expect(sentinel).toEqual([{ doc_json: '{}' }])
      const [columns] = await conn.query("SELECT DATA_TYPE FROM information_schema.columns WHERE table_schema=DATABASE() AND ((table_name='ppt_doc_state' AND column_name='draft_doc') OR (table_name='ppt_live_snapshot' AND column_name IN ('doc_json','state_json')) OR (table_name='ppt_version' AND column_name='deck_json'))")
      expect(columns).toEqual(Array.from({ length: 4 }, () => ({ DATA_TYPE: 'longtext' })))
    } finally { await conn.end() }
    setOctoIdentity({ verifyToken: async token => token === 'owner' ? { uid: 'owner' } : null,
      verifyBot: async token => token === 'bot' ? { uid: 'owner', spaceId: 'space' } : null,
      getUser: async () => null, getUserAsBot: async () => null, getUsers: async () => [],
      isSpaceMember: async () => true, ownedBotsInSpace: async () => [] })
    server = await new Promise<Server>((resolve, reject) => {
      const s = createApp({ rateLimit: { max: 1000, windowMs: 60000 } }).listen(0, '127.0.0.1', () => resolve(s))
      s.once('error', reject)
    })
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }, 30000)
  afterAll(async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
    await closeRedis(); await closePool()
  })
  async function request(path: string, method = 'GET', body?: unknown, expected = 200) {
    const r = await fetch(base + path, { method, headers: { token: path.startsWith('/v1/') ? 'bot' : 'owner', 'X-Space-Id': 'space', 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const payload = await r.json()
    expect(r.status, JSON.stringify(payload.error ?? {}).slice(0, 500)).toBe(expected)
    return payload.data ?? payload
  }
  it('rejects an over-budget legacy genesis without persistence and allows draft repair', async () => {
    const created = await request('/api/v1/docs', 'POST', { docType: 'html_ppt', title: 'Legacy genesis', templateId: 'blank' }, 201)
    const id = created.docId as string, path = `/api/v1/ppt/docs/${id}`
    const initial = await request(path + '/source?mode=draft&format=bootstrap')
    const deck = initial.deck as BentoDoc
    deck.slides[0]!.elements = [{ id: 'legacy', type: 'text', text: '&<>'.repeat(8000) }]
    const limit = config.ppt.write.maxDocumentBytes
    try {
      config.ppt.write.maxDocumentBytes = 100_000
      expect(Buffer.byteLength(JSON.stringify(deck))).toBeLessThan(config.ppt.write.maxDocumentBytes)
      await request(path + '/draft', 'PUT', { revision: 0, deck })
      const before = await query('SELECT draft_doc, draft_revision FROM ppt_doc_state WHERE doc_id=?', [id])
      for (let attempt = 0; attempt < 2; attempt++) {
        const rejected = await request(path + '/live', 'GET', undefined, 413)
        expect(rejected.error).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', details: { dimension: 'document', limit: 100_000 } })
        expect(rejected.error.details.documentBytes).toBeGreaterThan(100_000)
        expect(await query('SELECT doc_id FROM ppt_live_snapshot WHERE doc_id=?', [id])).toEqual([])
        expect(await query('SELECT draft_doc, draft_revision FROM ppt_doc_state WHERE doc_id=?', [id])).toEqual(before)
      }
      deck.slides[0]!.elements = [{ id: 'legacy', type: 'text', text: '<repaired>' }]
      await request(path + '/draft', 'PUT', { revision: 1, deck })
      const repaired = await request(path + '/live')
      expect(repaired.deck.slides[0].elements[0].html).toBe('<p>&lt;repaired&gt;</p>')
      await request(`/api/v1/docs/${id}/versions`, 'POST', { baseRevision: repaired.baseRevision, label: 'Repaired' }, 201)
    } finally { config.ppt.write.maxDocumentBytes = limit }
  })
  it('saves, reopens, compacts, versions and exports a full 32 MiB deck; rejects overflow atomically', async () => {
    const created = await request('/api/v1/docs', 'POST', { docType: 'html_ppt', title: 'Budget acceptance', templateId: 'blank' }, 201)
    const id = created.docId as string, path = `/api/v1/ppt/docs/${id}`
    const initial = await request(path + '/source?mode=draft&format=bootstrap')
    const deck = initial.deck as BentoDoc
    // Small independent JSON values keep individual edit operations below the
    // unchanged frame budget. This is a document-size test, not a huge-op test.
    const slide = deck.slides[0]!
    deck.slides = Array.from({ length: 32 }, (_, n) => ({ ...structuredClone(slide), id: `capacity-${n}`, notes: 'x'.repeat(1024 * 1024 - 2048) }))
    deck.slides[31]!.notes += 'x'.repeat(config.ppt.write.maxDocumentBytes - Buffer.byteLength(JSON.stringify(deck)))
    await request(path + '/draft', 'PUT', { revision: 0, deck })
    expect((await query<{ bytes: number }>('SELECT OCTET_LENGTH(draft_doc) AS bytes FROM ppt_doc_state WHERE doc_id=?', [id]))[0]!.bytes).toBe(config.ppt.write.maxDocumentBytes)
    const current = await request(path + '/live')
    expect(hashBentoDeck(current.deck)).toBe(hashBentoDeck(deck))
    const edited = current.deck as BentoDoc
    edited.slides[0]!.notes = 'y' + edited.slides[0]!.notes.slice(1)
    const result = await request(`/v1/bot/docs/${id}/ppt`, 'PATCH', { baseRevision: current.baseRevision, deck: edited })
    expect(result.changed).toBe(true)
    const store = new DbPptRelayStore(true)
    expect(await new PptSnapshotter(store).advance(id, undefined)).not.toBeNull()
    const reopened = await request(path + '/live')
    expect(hashBentoDeck(reopened.deck)).toBe(hashBentoDeck(edited))
    expect(Buffer.byteLength(JSON.stringify(reopened.deck))).toBe(config.ppt.write.maxDocumentBytes)
    expect(await store.roomBytes(id)).toBe(0)
    const noOp = await request(`/v1/bot/docs/${id}/ppt`, 'PATCH', { baseRevision: reopened.baseRevision, deck: reopened.deck })
    expect(noOp).toMatchObject({ changed: false, revision: reopened.baseRevision })
    const version = await request(`/api/v1/docs/${id}/versions`, 'POST', { baseRevision: reopened.baseRevision, label: '32 MiB' }, 201)
    const state = await request(`/api/v1/docs/${id}/versions/${version.docVersionSeq}/state`)
    expect(hashBentoDeck(state.deck)).toBe(hashBentoDeck(edited))
    const exported = await fetch(base + path + '/export', { headers: { token: 'owner', 'X-Space-Id': 'space' } })
    expect(exported.status).toBe(200)
    expect((await exported.text()).length).toBeGreaterThan(config.ppt.write.maxDocumentBytes)
    edited.slides[31]!.notes += 'x'
    await request(`/v1/bot/docs/${id}/ppt`, 'PATCH', { baseRevision: reopened.baseRevision, deck: edited }, 413)
    const badFrame = randomUUID()
    await expect(store.appendOp(id, badFrame, { t: 'ops', ops: [{ op: 'set', a: 'capacity-writer', s: 1, l: 999999, k: 'overflow', v: true }] }, 'test-editor')).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' })
    expect(await store.frameSeq(id, badFrame)).toBeNull()
    const unchanged = await request(path + '/live')
    expect(unchanged.baseRevision).toBe(reopened.baseRevision)
    expect(hashBentoDeck(unchanged.deck)).toBe(hashBentoDeck(reopened.deck))
  }, 120000)
})
