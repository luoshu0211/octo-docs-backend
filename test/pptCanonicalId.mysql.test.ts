import './helpers/pptRelayEnv.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import mysql from 'mysql2/promise'
import { config } from '../src/config/env.js'
import { closePool, query } from '../src/db/pool.js'
import { setOctoIdentity } from '../src/auth/octoIdentity.js'
import { docsRouter } from '../src/api/routes/docs.js'
import { commentsRouter } from '../src/api/routes/comments.js'
import { versionsRouter } from '../src/api/routes/versions.js'
import { createPptLiveRouter, createBotPptRouter } from '../src/api/ppt/live.js'
import { createPptExportRouter } from '../src/api/ppt/export.js'
import { createPptSourceRouter } from '../src/api/ppt/source.js'
import { createPptDraftRouter } from '../src/api/ppt/draft.js'
import { createPptCollabTokenRouter } from '../src/api/ppt/collabToken.js'
import { pptErrorHandler } from '../src/api/ppt/envelope.js'
import { issuePptCollabToken, verifyPptRelayTicket } from '../src/auth/pptCollabToken.js'
import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { closeRedis, getRedis, rkey } from '../src/db/redis.js'
import { connectionRegistry } from '../src/permission/connectionRegistry.js'
import { startPptRoomPublishing } from '../src/ppt/clusterEvents.js'
import { SyncState } from '../src/ppt/sync/slidesSync.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import type { BentoDoc } from '../src/ppt/bentoDoc.js'
import type { ServerFrame, OpsFrame } from '../src/ppt/relay/frames.js'
import type { Role } from '../src/permission/role.js'
import { PptSnapshotter } from '../src/ppt/relay/snapshotter.js'
import { DbPptRelayStore } from '../src/ppt/relay/dbStore.js'

// Explicit opt-in against an EMPTY throwaway database. No tables or databases
// are deleted: the runner owns the temporary MySQL service lifecycle.
describe.skipIf(process.env.PPT_CANONICAL_MYSQL_TEST !== '1')('PPT canonical identity with real MySQL collations', () => {
  let server: Server, base: string
  beforeAll(async () => {
    if (!/^ppt_case_test_[a-z0-9_]+$/.test(config.mysql.database)) throw new Error('requires a dedicated ppt_case_test_* database')
    const conn = await mysql.createConnection({ host: config.mysql.host, port: config.mysql.port, user: config.mysql.user, password: config.mysql.password, database: config.mysql.database, multipleStatements: true })
    try {
      const [tables] = await conn.query('SHOW TABLES')
      if ((tables as unknown[]).length) throw new Error('requires an empty database')
      await conn.query(readFileSync(new URL('../migrations/schema.sql', import.meta.url), 'utf8'))
      // Upgrade old installations twice: widening labels is idempotent and keeps rows.
      await conn.query("ALTER TABLE ppt_version MODIFY COLUMN label VARCHAR(200) NOT NULL DEFAULT ''")
      const upgrade = readFileSync(new URL('../migrations/upgrades/2026-09-10-ppt-common-version-label.sql', import.meta.url), 'utf8')
      await conn.query(upgrade)
      await conn.query(upgrade)
    } finally { await conn.end() }
    setOctoIdentity({ verifyToken: async token => token === 'test-owner' ? { uid: 'owner' } : null,
      verifyBot: async () => null, getUser: async uid => ({ uid, name: 'Owner', avatar: '' }),
      getUserAsBot: async () => null, getUsers: async () => [], isSpaceMember: async () => true, ownedBotsInSpace: async () => [] })
    const app = express(); app.use(express.json({ limit: '5mb' }))
    app.use(createPptLiveRouter(), createPptExportRouter(), createPptSourceRouter(), createPptDraftRouter(), createPptCollabTokenRouter())
    // Authentication transport is controlled; Bot document authorization below
    // remains the real shared guard and real MySQL-backed owner/Space lookup.
    app.use('/common/docs', (req, _res, next) => { req.uid = 'owner'; req.spaceId = 'space'; req.viewerSpaceId = 'space'; req.principalSpaceId = 'space'; req.octoToken = 'test-owner'; req.docSpaceScope = { mode: 'human' }; next() }, docsRouter, commentsRouter, versionsRouter)
    app.use('/bot', (req, _res, next) => { req.uid = 'owner'; req.spaceId = 'space'; req.principalSpaceId = 'space'; req.docSpaceScope = { mode: 'bot', spaceId: 'space' }; next() }, createBotPptRouter(), commentsRouter, versionsRouter)
    app.use(pptErrorHandler)
    server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); await closeRedis(); await closePool() })
  it.skipIf(process.env.PPT_CLUSTER_MYSQL_TEST !== '1')('expires abandoned awareness without reads and preserves legacy registrations', async () => {
    const documentName = `lease-${randomUUID()}`
    const entry = { documentName, uid: 'owner', node: 'node-a', connectionId: 'legacy', role: 'writer' as const, permission_epoch: 1 }
    const leasedKey = rkey('conn', documentName, 'leased')
    try {
      await connectionRegistry.register(entry)
      await connectionRegistry.register({ ...entry, connectionId: 'long', expiresAt: Date.now() + 1200 })
      await connectionRegistry.register({ ...entry, connectionId: 'short', expiresAt: Date.now() + 100 })
      await new Promise(resolve => setTimeout(resolve, 250))
      expect((await connectionRegistry.list(documentName)).map(item => item.connectionId).sort()).toEqual(['legacy', 'long'])
      expect(await getRedis().pttl(leasedKey)).toBeGreaterThan(0)
      // No registry list/heartbeat runs while the final node is absent.
      await new Promise(resolve => setTimeout(resolve, 1100))
      expect(await getRedis().exists(leasedKey)).toBe(0)
      expect(await getRedis().hget(rkey('conn', documentName), 'legacy')).not.toBeNull()
    } finally {
      await Promise.all(['legacy', 'long', 'short'].map(id => connectionRegistry.unregister(documentName, id)))
    }
  })
  async function request(path: string, method = 'GET', body?: unknown, key = randomUUID()) {
    const r = await fetch(base + path, { method, headers: { token: 'test-owner', 'X-Space-Id': 'space', 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const payload = await r.json()
    expect(r.ok, JSON.stringify(payload)).toBe(true)
    return { data: payload.data ?? payload, status: r.status }
  }
  it('aliases share common creation, comments, versions, restore and PPT actor watermarks', async () => {
    const created = await request('/common/docs', 'POST', { docType: 'html_ppt', title: 'Case regression', templateId: 'blank' })
    const id = created.data.docId as string, alias = id.toUpperCase()
    expect(alias).not.toBe(id)
    const path = (docId: string) => `/docs/${docId}`
    const draft = await request(path(alias) + '/source?mode=draft&format=bootstrap')
    expect(draft.data.docId).toBe(id)
    await request(path(alias) + '/draft', 'PUT', { revision: 0, deck: draft.data.deck })
    const live = await request(path(alias) + '/live')
    expect(live.data.docId).toBe(id)
    const comment = { body: 'Canonical root', anchor: { kind: 'document', versionSeq: null, baseRevision: live.data.baseRevision } }
    const root = await request('/common' + path(alias) + '/comments', 'POST', comment)
    const replyKey = randomUUID(), reply = { body: 'Confirmed', parentId: root.data.id }
    const first = await request(`/bot/${alias}/comments`, 'POST', reply, replyKey)
    const replay = await request(`/bot/${id}/comments`, 'POST', reply, replyKey)
    expect(first.status).toBe(201); expect(replay.status).toBe(201); expect(replay.data.id).toBe(first.data.id)
    const detail = await request('/common' + path(id) + `/comments/${root.data.id}`)
    expect(detail.data.root.docId).toBe(id); expect(detail.data.root.resolved).toBe(false)
    const published = await request('/common' + path(alias) + '/versions', 'POST', { baseRevision: live.data.baseRevision, label: 'x'.repeat(256) })
    expect((await request(path(id) + '/source?mode=published&format=bootstrap')).data.docId).toBe(id)
    const listed = (await request('/common' + path(alias) + '/versions?kind=manual&limit=1')).data
    expect(listed.items).toHaveLength(1)
    expect(listed.items[0]).toMatchObject({ docVersionSeq: published.data.docVersionSeq, label: 'x'.repeat(256), kind: 2 })
    expect(listed.counts).toMatchObject({ manual: 1, total: 1 })
    expect((await request('/common' + path(id) + '/versions?kind=auto')).data.items).toEqual([])
    const snapshot = (await request('/common' + path(alias) + `/versions/${published.data.docVersionSeq}/state`)).data
    expect(snapshot).toMatchObject({ kind: 'ppt', deck: live.data.deck })
    const threads = (await request('/common' + path(alias) + '/comments')).data
    expect(threads.items[0]).toMatchObject({ id: root.data.id, replies: [{ id: first.data.id }] })
    const replies = (await request('/common' + path(alias) + `/comments/${root.data.id}/replies`)).data
    expect(replies.items).toHaveLength(1)
    for (const [url, method] of [[path(id) + '/publish', 'POST'], [path(id) + '/versions', 'GET'], [path(id) + '/comments', 'GET'], ['/docs', 'POST']]) {
      expect((await fetch(base + url, { method })).status).toBe(404)
    }
    const edited = structuredClone(live.data.deck); edited.slides[0].notes = 'Edit via alias'
    await request(`/bot/${alias}/ppt`, 'PATCH', { baseRevision: live.data.baseRevision, deck: edited })
    const after = await request(path(id) + '/live')
    expect(after.data.deck.slides[0].notes).toBe('Edit via alias')
    await request('/common' + path(alias) + `/versions/${published.data.docVersionSeq}/restore`, 'POST', { baseRevision: after.data.baseRevision })
    expect((await request(path(id) + '/live')).data.deck).toEqual(live.data.deck)
    const session = randomUUID()
    const lower = await request('/docs/collab-token', 'POST', { docId: id, clientSessionId: session })
    const upper = await request('/docs/collab-token', 'POST', { docId: alias, clientSessionId: session })
    const claims = verifyPptRelayTicket(upper.data.ticket)
    expect(claims.docId).toBe(id); expect(upper.data.actor).toBe(lower.data.actor)
    const store = new DbPptRelayStore(true)
    const frame = { t: 'ops', ops: [{ op: 'set', a: claims.actor!, s: 1, l: 10000, k: 'caseTest', v: true }] }
    await store.appendOp(claims.docId, randomUUID(), frame)
    const reconnect = verifyPptRelayTicket(lower.data.ticket)
    await store.appendOp(reconnect.docId, randomUUID(), { t: 'ops', ops: [{ ...frame.ops[0], s: 2, l: 10001, v: false }] })
    const watermarks = await query<{ doc_id: string; last_s: number }>('SELECT doc_id,last_s FROM ppt_collab_actor_seq WHERE doc_id = ?', [id])
    expect(watermarks).toEqual([{ doc_id: id, last_s: 2 }])
    for (const table of ['ppt_version', 'ppt_comment', 'ppt_collab_actor_seq']) {
      expect(await query(`SELECT doc_id FROM ${table} WHERE BINARY doc_id = BINARY ?`, [alias])).toEqual([])
    }
    // This pins the mixed-collation production premise, not a JS string mock.
    const columns = await query<{ COLLATION_NAME: string }>('SELECT COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?', [config.mysql.database, 'doc_meta', 'doc_id'])
    expect(columns[0]?.COLLATION_NAME).toMatch(/_ci$/)
  }, 30000)
  it('enforces the room byte cap across concurrent database writers without partial commits', async () => {
    const id = (await request('/common/docs', 'POST', { docType: 'html_ppt', title: 'Capacity', templateId: 'blank' })).data.docId
    const a = (await request('/docs/collab-token', 'POST', { docId: id, clientSessionId: randomUUID() })).data
    const b = (await request('/docs/collab-token', 'POST', { docId: id, clientSessionId: randomUUID() })).data
    const frames = [a, b].map(token => ({ t: 'ops', ops: [{ op: 'set', a: token.actor, s: 1, l: 10, k: 'capacityTest', v: 'value' }] }))
    const cap = Math.max(...frames.map(frame => Buffer.byteLength(JSON.stringify(frame))))
    const original = config.ppt.relay.maxRoomFrameBytes
    config.ppt.relay.maxRoomFrameBytes = cap
    try {
      const results = await Promise.allSettled(frames.map(frame => new DbPptRelayStore(true).appendOp(id, randomUUID(), frame)))
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
      const store = new DbPptRelayStore(true)
      expect(await store.roomBytes(id)).toBeLessThanOrEqual(cap)
      expect(await store.currentSeq(id)).toBe(1)
      expect(await query('SELECT actor FROM ppt_collab_actor_seq WHERE doc_id = ?', [id])).toHaveLength(1)
    } finally { config.ppt.relay.maxRoomFrameBytes = original }
  })

  it.skipIf(process.env.PPT_CLUSTER_MYSQL_TEST !== '1')('converges across two processes, REST edits, restore, lost pubsub and a killed node', async () => {
    const children: ChildProcess[] = [], clients: WebSocket[] = []
    const stopPublishing = startPptRoomPublishing()
    type Replica = { port: number; child: ChildProcess }
    const start = async (): Promise<Replica> => {
      const child = fork(fileURLToPath(new URL('./helpers/pptClusterNode.ts', import.meta.url)), [], {
        execArgv: ['--import', 'tsx'], env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      })
      children.push(child)
      let errors = ''
      child.stderr?.on('data', data => { errors += String(data) })
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('node startup timeout: ' + errors)), 10000)
        child.once('message', message => { clearTimeout(timer); resolve((message as { port: number }).port) })
        child.once('exit', code => { clearTimeout(timer); reject(new Error('node exited ' + code + ': ' + errors)) })
      })
      return { port, child }
    }
    const wait = async (check: () => boolean | Promise<boolean>, timeout = 7000): Promise<void> => {
      const deadline = Date.now() + timeout
      while (!(await check())) {
        if (Date.now() > deadline) throw new Error('cluster expectation timed out')
        await new Promise(resolve => setTimeout(resolve, 30))
      }
    }
    const connect = async (node: Replica, docId: string, uid = 'owner', role: Role = 'admin', presence = true) => {
      let token = (await request('/docs/collab-token', 'POST', { docId, clientSessionId: randomUUID() })).data
      if (uid !== 'owner') {
        await docMemberRepo.upsertDirect({ docId, uid, principalSpaceId: 'space', roleNum: role === 'writer' ? 2 : 1, grantedBy: 'owner' })
        token = issuePptCollabToken({ uid, docId, role, documentName: token.documentName,
          permission_epoch: token.epoch, principalSpaceId: 'space', snapshotVersion: token.snapshotVersion,
          homeSpaceVerified: true, currentSpaceVerified: true, clientSessionId: randomUUID(), name: uid })
      }
      const ws = new WebSocket(`ws://127.0.0.1:${node.port}/api/v1/ppt/collab`, ['ppt-relay', token.ticket],
        { origin: 'https://ppt-web.example.test' })
      clients.push(ws)
      const messages: ServerFrame[] = []
      let deck: BentoDoc, sync: SyncState
      ws.on('message', raw => {
        const frame = JSON.parse(String(raw)) as ServerFrame; messages.push(frame)
        if (frame.ctl === 'snapshot') { deck = frame.doc as BentoDoc; sync = SyncState.fromJSON('@test-reader', frame.state!) }
        else if (frame.ctl === 'op') sync.apply(deck, (frame.frame as OpsFrame).ops as Parameters<SyncState['apply']>[1])
      })
      await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
      ws.send(JSON.stringify({ t: 'hello', pv: 2, presence, since: 0 }))
      await wait(() => messages.some(frame => frame.ctl === 'ready'))
      return { ws, token, messages, deck: () => deck }
    }
    try {
      const id = (await request('/common/docs', 'POST', { docType: 'html_ppt', templateId: 'blank', title: 'Cluster' })).data.docId
      const aNode = await start(), bNode = await start()
      const a = await connect(aNode, id, 'owner', 'admin', false), b = await connect(bNode, id, 'writer', 'writer')
      await wait(() => b.messages.some(frame => frame.ctl === 'peers' && frame.total === 2))
      expect(a.messages.some(frame => frame.ctl === 'peers')).toBe(false)
      const slide = a.deck().slides[0].id
      const send = (client: typeof a, key: string, value: string) => client.ws.send(JSON.stringify({
        t: 'ops', pv: 2, k: 1, frameId: randomUUID(), epoch: client.token.epoch,
        ops: [{ op: 'set', a: client.token.actor, s: 1, l: 100, sl: slide, k: key, v: value }],
      }))
      send(a, 'notes', 'node-a'); send(b, 'background', '#ff0000')
      await wait(() => [a, b].every(client => client.messages.some(frame => frame.ctl === 'ack')))
      await wait(() => [a, b].every(client => client.deck().slides[0].notes === 'node-a' && client.deck().slides[0].background === '#ff0000'))
      expect(a.deck()).toEqual(b.deck())
      for (const client of [a, b]) {
        const seqs = client.messages.filter(frame => frame.ctl === 'op').map(frame => frame.q)
        expect(seqs).toEqual([...new Set(seqs)].sort((x, y) => x - y))
      }
      const live = (await request(`/docs/${id}/live`)).data
      const version = (await request(`/common/docs/${id}/versions`, 'POST', { baseRevision: live.baseRevision, label: 'Before Bot' })).data
      // Stop only B's subscription: no process-local emitter can help it recover.
      await new Promise<void>(resolve => { bNode.child.once('message', () => resolve()); bNode.child.send('miss-notifications') })
      const edit = structuredClone(live.deck); edit.slides[0].notes = 'Bot on REST process'
      await request(`/bot/${id}/ppt`, 'PATCH', { baseRevision: live.baseRevision, deck: edit })
      await wait(() => [a, b].every(client => client.deck().slides[0].notes === 'Bot on REST process'))
      const after = (await request(`/docs/${id}/live`)).data
      await request(`/common/docs/${id}/versions/${version.docVersionSeq}/restore`, 'POST', { baseRevision: after.baseRevision })
      await wait(() => [a, b].every(client => client.deck().slides[0].notes === 'node-a'))
      const store = new DbPptRelayStore(true)
      const beforeSnapshot = (await store.getSnapshot(id))!
      await new PptSnapshotter(store).advance(id, undefined)
      // An older reducer cannot overwrite a newer snapshot even with equal coverage.
      await expect(store.saveSnapshot({ docId: id, doc: beforeSnapshot.doc, state: beforeSnapshot.state,
        coveredSeq: beforeSnapshot.coveredSeq, expectedSnapshotVersion: beforeSnapshot.snapshotVersion })).rejects.toThrow('snapshot base changed')
      const reader = await connect(bNode, id, 'reader', 'reader')
      send(reader, 'notes', 'forbidden')
      await wait(() => reader.messages.some(frame => frame.ctl === 'refused' && frame.code === 'forbidden-role'))
      expect((await request(`/docs/${id}/live`)).data.deck.slides[0].notes).toBe('node-a')
      reader.ws.close()
      aNode.child.kill('SIGKILL')
      // The shared roster expires the dead node's owner, without a disconnect callback.
      await wait(() => b.messages.some(frame => frame.ctl === 'peers' && frame.total === 1 && frame.users[0]?.uid === 'writer'), 15000)
      const replacement = await start(), rejoined = await connect(replacement, id)
      expect(rejoined.deck()).toEqual((await request(`/docs/${id}/live`)).data.deck)
      expect(b.deck()).toEqual(rejoined.deck())
    } finally {
      stopPublishing()
      for (const ws of clients) ws.terminate()
      await Promise.all(children.map(child => new Promise<void>(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve()
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 3000)
        child.once('exit', () => { clearTimeout(timer); resolve() }); child.kill('SIGTERM')
      })))
    }
  }, 40000)

})
