import { randomUUID } from 'node:crypto'
import { messageYjsSyncStep2, messageYjsUpdate } from 'y-protocols/sync'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { markDocumentSyncFrame, trackDocumentBodyEdits, waitForDocumentEditEvidence } from '../src/collab/documentActivity.js'
import { persistence } from '../src/collab/persistence.js'
import { storeWorkerPool } from '../src/collab/storeWorkerPool.js'
import { config } from '../src/config/env.js'
import { closePool, query } from '../src/db/pool.js'
import { stageDocumentEdit, startDocumentActivityDelivery } from '../src/drive/documentActivity.js'
import { COLLAB_FIELD } from '../src/schema/index.js'

vi.mock('../src/collab/compactionNotice.js', () => ({ clearOverCapShared: vi.fn(), resolveUnrestoredOverCap: vi.fn() }))
vi.mock('../src/collab/oversizeGuard.js', () => ({
  markOversized: vi.fn(), clearOversized: vi.fn(), clearOverCapResolved: vi.fn(),
  resolvePendingUnrestored: vi.fn(), resolveDurableUnrestored: vi.fn(),
}))

const mysqlDescribe = process.env.RUN_DOCUMENT_ACTIVITY_MYSQL_TESTS === '1' ? describe.sequential : describe.skip

function origin(actor: string, frame = messageYjsUpdate) {
  const connection = { context: { user: { id: actor }, principal_space_id: 'activity-space', kind: 'document' } }
  markDocumentSyncFrame(connection, frame)
  return { source: 'connection', connection }
}

function append(doc: Y.Doc, actor: string) {
  doc.transact(() => {
    const text = new Y.XmlText()
    text.insert(0, actor)
    doc.getXmlFragment(COLLAB_FIELD).push([text])
  }, origin(actor))
}

mysqlDescribe('document edit outbox with MySQL', () => {
  const documents = new Set<Y.Doc>()
  const names: string[] = []
  const originalDriveConfig = { ...config.driveDerived }
  const originalBackgroundStore = config.yjsBackgroundStore

  beforeAll(() => {
    if (!['127.0.0.1', 'localhost', 'mysql'].includes(config.mysql.host) || !config.mysql.database.endsWith('_test')) {
      throw new Error('Document activity integration tests require a dedicated local/CI test database')
    }
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    Object.assign(config.driveDerived, originalDriveConfig)
    config.yjsBackgroundStore = originalBackgroundStore
    for (const doc of documents) doc.destroy()
    documents.clear()
    for (const name of names.splice(0)) {
      await query('DELETE FROM doc_body_edit_outbox WHERE document_name = ?', [name])
      await query('DELETE FROM yjs_document WHERE document_name = ?', [name])
      await query('DELETE FROM doc_meta WHERE document_name = ?', [name])
    }
  })

  afterAll(async () => {
    await storeWorkerPool.close()
    await closePool()
  })

  function liveDoc(name: string) {
    const doc = new Y.Doc()
    documents.add(doc)
    trackDocumentBodyEdits(doc, edit => stageDocumentEdit(name, edit))
    return doc
  }

  async function createDoc() {
    const id = randomUUID()
    const name = `octo:activity-space:f_default:${id}`
    await query(`INSERT INTO doc_meta (doc_id, document_name, owner_id, owner_space_id, space_id, created_by)
      VALUES (?, ?, 'alice', 'activity-space', 'activity-space', 'alice')`, [id, name])
    names.push(name)
    return { id, name }
  }

  function events(name: string) {
    return query<{ actor_uid: string; ready: number }>(
      'SELECT actor_uid, ready FROM doc_body_edit_outbox WHERE document_name = ? ORDER BY actor_uid', [name],
    )
  }

  it('confirms Alice when a different replica saves her edit after she disconnects', async () => {
    const { name } = await createDoc()
    const author = liveDoc(name)
    const peer = liveDoc(name)
    const peerContext = { user: { id: 'bob' } }
    append(author, 'alice')
    await waitForDocumentEditEvidence(author)
    await persistence.store(name, peer, peerContext)
    expect(await events(name)).toEqual([{ actor_uid: 'alice', ready: 0 }])

    const update = Y.encodeStateAsUpdate(author)
    author.destroy()
    documents.delete(author)
    Y.applyUpdate(peer, update, origin('bob', messageYjsSyncStep2))
    await persistence.store(name, peer, peerContext)
    await persistence.store(name, peer, peerContext)
    expect(await events(name)).toEqual([{ actor_uid: 'alice', ready: 1 }])
  })

  it('recaptures edits received while the worker is switching to a full snapshot', async () => {
    config.yjsBackgroundStore = true
    const { name } = await createDoc()
    const doc = liveDoc(name)
    append(doc, 'alice')
    await waitForDocumentEditEvidence(doc)

    const store = vi.spyOn(storeWorkerPool, 'run').mockImplementationOnce(async () => {
      append(doc, 'bob')
      return { kind: 'needs-full-state' }
    })
    await persistence.store(name, doc, { user: { id: 'alice' } })
    expect(store).toHaveBeenCalledTimes(2)
    await waitForDocumentEditEvidence(doc)
    expect(await events(name)).toEqual([{ actor_uid: 'alice', ready: 1 }, { actor_uid: 'bob', ready: 1 }])
  })

  it('sends the next batch immediately and preserves the proxy path', async () => {
    const { id, name } = await createDoc()
    const editIds = Array.from({ length: 17 }, () => randomUUID())
    await query(`INSERT INTO doc_body_edit_outbox
      (event_id, document_name, document_id, document_space_id, principal_space_id, actor_uid, occurred_at_ms, ready)
      VALUES ${editIds.map(() => '(?, ?, ?, ?, ?, ?, ?, 1)').join(', ')}`,
    editIds.flatMap(editId => [editId, name, id, 'activity-space', 'activity-space', 'alice', Date.now()]))
    config.driveDerived.internalBaseUrl = 'https://drive.example/proxy/drive/'
    config.driveDerived.outboundToken = 'local-test-token'
    const send = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', send)
    const stop = startDocumentActivityDelivery()
    try {
      // First poll is at five seconds, a throttled second poll would be at ten.
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(17), { timeout: 8_000 })
      expect(send.mock.calls.every(([url]) => url === 'https://drive.example/proxy/drive/internal/v1/docs/document-edits')).toBe(true)
    } finally {
      await stop()
    }
    const unsent = await query('SELECT event_id FROM doc_body_edit_outbox WHERE document_name = ? AND delivered_at IS NULL', [name])
    expect(unsent).toEqual([])
  }, 10_000)
})
