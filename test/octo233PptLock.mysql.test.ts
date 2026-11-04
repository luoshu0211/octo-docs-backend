import './helpers/pptRelayEnv.js'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import { once } from 'node:events'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import mysql from 'mysql2/promise'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { config } from '../src/config/env.js'
import { closePool, query } from '../src/db/pool.js'
import { setOctoIdentity, type OctoIdentity } from '../src/auth/octoIdentity.js'
import { createPptDraftRouter } from '../src/api/ppt/draft.js'
import { pptErrorHandler } from '../src/api/ppt/envelope.js'
import { preparePptCollab } from '../src/ppt/collabSession.js'
import { DbPptRelayStore } from '../src/ppt/relay/dbStore.js'
import type { AppendOpResult } from '../src/ppt/relay/store.js'
import type { BentoDoc } from '../src/ppt/bentoDoc.js'
import { legacyPptDeck } from './fixtures/pptLegacyDeck.js'

type LockWaitRow = { thread_id: number }
type DraftHttpResult = { status: number; body: { error?: { code?: string }; data?: unknown } }

const DRAFT_WAITING_ON_DOC_META = `
  SELECT waiting_thread.THREAD_ID AS thread_id
    FROM performance_schema.data_lock_waits AS waits
    JOIN performance_schema.threads AS waiting_thread
      ON waiting_thread.THREAD_ID = waits.REQUESTING_THREAD_ID
    JOIN performance_schema.threads AS blocking_thread
      ON blocking_thread.THREAD_ID = waits.BLOCKING_THREAD_ID
    JOIN performance_schema.data_locks AS requested_lock
      ON requested_lock.ENGINE = waits.ENGINE
     AND requested_lock.ENGINE_LOCK_ID = waits.REQUESTING_ENGINE_LOCK_ID
   WHERE blocking_thread.PROCESSLIST_ID = ?
     AND requested_lock.OBJECT_SCHEMA = DATABASE()
     AND requested_lock.OBJECT_NAME = 'doc_meta'
     AND requested_lock.LOCK_STATUS = 'WAITING'
`

const BOTH_WAITING_ON_DOC_META = `
  SELECT COUNT(DISTINCT waiting_thread.THREAD_ID) AS waiting_transactions
    FROM performance_schema.data_lock_waits AS waits
    JOIN performance_schema.threads AS waiting_thread
      ON waiting_thread.THREAD_ID = waits.REQUESTING_THREAD_ID
    JOIN performance_schema.threads AS blocking_thread
      ON blocking_thread.THREAD_ID = waits.BLOCKING_THREAD_ID
    JOIN performance_schema.data_locks AS requested_lock
      ON requested_lock.ENGINE = waits.ENGINE
     AND requested_lock.ENGINE_LOCK_ID = waits.REQUESTING_ENGINE_LOCK_ID
   WHERE blocking_thread.PROCESSLIST_ID = ?
     AND requested_lock.OBJECT_SCHEMA = DATABASE()
     AND requested_lock.OBJECT_NAME = 'doc_meta'
     AND requested_lock.LOCK_STATUS = 'WAITING'
   HAVING COUNT(DISTINCT waiting_thread.THREAD_ID) >= 2
`

let server: Server | undefined
let base = ''
let ownedDocId: string | undefined

async function removeOwnedDocument(docId: string): Promise<void> {
  for (const table of [
    'ppt_collab_actor_seq',
    'ppt_collab_frame',
    'ppt_collab_op',
    'ppt_collab_seq',
    'ppt_live_snapshot',
    'ppt_doc_state',
    'doc_meta',
  ]) {
    await query(`DELETE FROM ${table} WHERE doc_id = ?`, [docId])
  }
}

async function waitForLockState(
  observer: mysql.Connection,
  sql: string,
  parameters: unknown[],
  description: string,
): Promise<void> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const [rows] = await observer.query(sql, parameters)
    if ((rows as LockWaitRow[]).length > 0) return
    if (Date.now() >= deadline) throw new Error(`MySQL synchronization barrier timed out: ${description}`)
    // The database query itself yields between checks. Only the observed InnoDB
    // lock state opens this barrier; no timer duration determines the interleaving.
  }
}

async function makeDraftRequest(docId: string, deck: BentoDoc): Promise<DraftHttpResult> {
  const response = await fetch(`${base}/docs/${docId}/draft`, {
    method: 'PUT',
    headers: { token: 'octo233-owner', 'X-Space-Id': 'space', 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: 0, deck }),
  })
  return { status: response.status, body: await response.json() as DraftHttpResult['body'] }
}

describe.skipIf(process.env.OCTO233_PPT_LOCK_MYSQL_TEST !== '1')('OCTO-233 PPT lock ordering with isolated MySQL', () => {
  beforeAll(async () => {
    if (config.mysql.database !== 'octo233_ppt_lock_test') {
      throw new Error('requires the dedicated octo233_ppt_lock_test database')
    }
    const connection = await mysql.createConnection({ ...config.mysql, multipleStatements: true })
    try {
      const [tables] = await connection.query('SHOW TABLES')
      const tableNames = new Set((tables as Array<Record<string, unknown>>)
        .map(row => String(Object.values(row)[0] ?? '')))
      if (tableNames.size === 0) {
        await connection.query(readFileSync(new URL('../migrations/schema.sql', import.meta.url), 'utf8'))
      } else {
        const required = [
          'doc_meta',
          'ppt_doc_state',
          'ppt_live_snapshot',
          'ppt_collab_seq',
          'ppt_collab_frame',
          'ppt_collab_op',
          'ppt_collab_actor_seq',
        ]
        const missing = required.filter(table => !tableNames.has(table))
        if (missing.length) throw new Error(`dedicated octo233 database is missing schema tables: ${missing.join(', ')}`)
      }
    } finally {
      await connection.end()
    }

    const identity: OctoIdentity = {
      verifyToken: async token => token === 'octo233-owner' ? { uid: 'owner' } : null,
      verifyApiKey: async () => null,
      verifyBot: async () => null,
      getUser: async () => null,
      getUserAsBot: async () => null,
      lookupSpacePrincipalAsBot: async () => ({ status: 'not_found' }),
      getUsers: async () => [],
      getUsersBatch: async () => null,
      getUsersAsBotBatch: async () => null,
      isSpaceMember: async () => true,
      ownedBotsInSpace: async () => [],
      listCallerBots: async () => null,
      spaceBots: async () => null,
      spaceMembers: async () => null,
    }
    setOctoIdentity(identity)
    const app = express()
    app.use(express.json({ limit: '1mb' }), createPptDraftRouter(), pptErrorHandler)
    server = app.listen(0, '127.0.0.1')
    await once(server, 'listening')
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }, 30_000)

  afterEach(async () => {
    const docId = ownedDocId
    ownedDocId = undefined
    if (docId) await removeOwnedDocument(docId)
  })

  afterAll(async () => {
    if (server) {
      const closed = once(server, 'close')
      server.close()
      await closed
    }
    await closePool()
  })

  it('returns the live-handoff 409 while a concurrent relay edit persists and its resend leaves edit time unchanged', async () => {
    const docId = `octo233-${randomUUID()}`
    ownedDocId = docId
    const documentName = `octo:space:f_default:${docId}`
    const deck = legacyPptDeck()
    deck.docId = docId
    await query(
      `INSERT INTO doc_meta
         (doc_id, document_name, title, owner_id, owner_space_id, space_id, folder_id, doc_type,
          status, permission_epoch, share_scope, share_role, created_by, updated_by)
       VALUES (?, ?, ?, 'owner', 'space', 'space', 'f_default', 'html_ppt', 1, 0, 0, 1, 'owner', 'owner')`,
      [docId, documentName, deck.title],
    )
    await query(
      `INSERT INTO ppt_doc_state (doc_id, template_id, draft_revision, draft_doc)
       VALUES (?, 'blank', 0, ?)`,
      [docId, JSON.stringify(deck)],
    )

    // Use the real draft-to-live handoff to create a valid snapshot and SyncState,
    // then a real persisted seed op to establish the relay actor watermark.
    await preparePptCollab(docId, 0)
    const store = new DbPptRelayStore(true)
    const actor = 'octo233-relay-actor'
    const seedFrame = { t: 'ops', ops: [{ op: 'set', a: actor, s: 1, l: 1, k: 'notes', v: 'seed' }] }
    await store.appendOp(docId, randomUUID(), seedFrame, 'octo233-seed-editor')

    const frameId = randomUUID()
    const liveFrame = { t: 'ops', ops: [{ op: 'set', a: actor, s: 2, l: 2, k: 'notes', v: 'concurrent relay edit' }] }
    const observer = await mysql.createConnection({ ...config.mysql })
    let blockerOpen = false
    let draftPending: Promise<DraftHttpResult> | undefined
    let relayPending: Promise<{ ok: true; value: AppendOpResult } | { ok: false; error: unknown }> | undefined
    let blockerConnectionId = 0
    try {
      const [idRows] = await observer.query('SELECT CONNECTION_ID() AS id')
      blockerConnectionId = Number((idRows as Array<{ id: number }>)[0]?.id)
      await observer.beginTransaction()
      blockerOpen = true
      await observer.execute('SELECT doc_id FROM doc_meta WHERE doc_id = ? FOR UPDATE', [docId])

      // Queue the draft's doc_meta lock first, then wait until both the draft and
      // real relay transaction are blocked on the same externally held doc_meta row.
      // No assumption is made about whether the relay already acquired its snapshot.
      draftPending = makeDraftRequest(docId, structuredClone(deck))
      await waitForLockState(observer, DRAFT_WAITING_ON_DOC_META, [blockerConnectionId], 'draft queued on doc_meta')

      relayPending = Promise.resolve()
        .then(() => store.appendOp(docId, frameId, liveFrame, 'octo233-relay-editor'))
        .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
      await waitForLockState(observer, BOTH_WAITING_ON_DOC_META, [blockerConnectionId], 'draft and relay queued on doc_meta')

      // Releasing the external lock deterministically opens the queued transactions.
      // The old relay order can deadlock after the draft acquires doc_meta; consistent
      // ordering lets the draft observe the live snapshot and the relay finish.
      await observer.commit()
      blockerOpen = false

      const [draftResult, relayResult] = await Promise.all([draftPending, relayPending])
      expect(draftResult.status).toBe(409)
      expect(draftResult.body.error?.code).toBe('CONFLICT')
      expect(relayResult.ok).toBe(true)
      if (!relayResult.ok) throw relayResult.error
      expect(relayResult.value).toMatchObject({ seq: 2, duplicate: false })

      const persistedOps = await query<{ seq: number; frame_id: string; frame_json: string }>(
        'SELECT seq, frame_id, frame_json FROM ppt_collab_op WHERE doc_id = ? AND frame_id = ?',
        [docId, frameId],
      )
      expect(persistedOps).toHaveLength(1)
      expect(persistedOps[0]).toMatchObject({ seq: 2, frame_id: frameId })
      expect(JSON.parse(persistedOps[0]!.frame_json)).toEqual(liveFrame)
      const afterRelay = await query<{ updated_by: string }>(
        'SELECT updated_by FROM doc_meta WHERE doc_id = ?', [docId],
      )
      expect(afterRelay[0]?.updated_by).toBe('octo233-relay-editor')

      // Pin a distinct pre-resend timestamp so the assertion is deterministic even
      // when both store calls happen in the same millisecond.
      await query("UPDATE doc_meta SET updated_at = '2000-01-01 00:00:00.000' WHERE doc_id = ?", [docId])
      const beforeResend = await query<{ updated_at: string }>(
        "SELECT DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s.%f') AS updated_at FROM doc_meta WHERE doc_id = ?",
        [docId],
      )
      const duplicate = await store.appendOp(docId, frameId, liveFrame, 'octo233-duplicate-editor')
      const afterResend = await query<{ updated_at: string }>(
        "SELECT DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s.%f') AS updated_at FROM doc_meta WHERE doc_id = ?",
        [docId],
      )
      expect(duplicate).toMatchObject({ seq: 2, duplicate: true })
      expect(afterResend[0]?.updated_at).toBe(beforeResend[0]?.updated_at)
    } finally {
      if (blockerOpen) await observer.rollback()
      if (draftPending || relayPending) {
        await Promise.allSettled([draftPending, relayPending].filter((pending): pending is Promise<unknown> => pending !== undefined))
      }
      await observer.end()
    }
  }, 30_000)
})
