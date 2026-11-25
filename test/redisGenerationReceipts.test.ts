import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { Redis as HocuspocusRedis } from '@hocuspocus/extension-redis'
import { Connection, Document, MessageType, OutgoingMessage, type Hocuspocus } from '@hocuspocus/server'
import { createDecoder, readVarString, readVarUint } from 'lib0/decoding'
import { fenceRedisGenerations } from '../src/collab/generationRedis.js'
import { bindStateGeneration } from '../src/collab/stateGeneration.js'
import { captureDurableSnapshot, durableReceipt, recordDurableReceipt } from '../src/collab/durableReceipt.js'
import { createServer } from '../src/collab/server.js'
import { trackDocumentBodyEdits } from '../src/collab/documentActivity.js'
import { COLLAB_FIELD } from '../src/schema/index.js'

// The real connected hook also updates presence and emits an advisory cache notice.
// Isolate those external services; keep receipt retention and delivery real.
vi.mock('../src/permission/connectionRegistry.js', () => ({ connectionRegistry: { register: vi.fn(), unregister: vi.fn() } }))
vi.mock('../src/collab/compactionNotice.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/collab/compactionNotice.js')>(), noticeStaleCacheOnJoin: vi.fn(),
}))

vi.mock('../src/collab/compactionCluster.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/collab/compactionCluster.js')>(), markLoaded: vi.fn(async () => undefined),
}))

const generation = '00000000-0000-4000-8000-000000000001'
const otherGeneration = '00000000-0000-4000-8000-000000000002'
const name = 'octo:receipt-test:f_default:d_sheet'
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

class RedisTransport extends EventEmitter {
  publish = vi.fn(async () => 0)
  pubsub = vi.fn(async () => ['channel', 1])
  subscribe(_channel: string, done: (error: null) => void) { done(null) }
  unsubscribe(_channel: string, done: (error: null) => void) { done(null) }
  quit = vi.fn(async () => 'OK')
  disconnect = vi.fn()
}

function frame(doc: Y.Doc, g = generation) {
  return JSON.stringify({ type: 'doc.persisted', generation: g, snapshot: Buffer.from(captureDurableSnapshot(doc)).toString('base64') })
}
function snapshot(doc: Y.Doc) {
  const receipt = durableReceipt(doc)
  expect(receipt, 'a later connection needs retained committed coverage').toBeDefined()
  return Y.decodeSnapshot(Buffer.from(JSON.parse(receipt!).snapshot, 'base64'))
}
function makeDoc() { const doc = new Y.Doc(); cleanups.push(() => doc.destroy()); return doc }

async function fixture(beforeLoad?: (send: (payload: string) => void) => void) {
  const clients: RedisTransport[] = []
  const extension = new HocuspocusRedis({
    prefix: 'receipt-test', identifier: 'node-B',
    createClient: () => {
      const client = new RedisTransport(); clients.push(client)
      return client as unknown as ReturnType<NonNullable<HocuspocusRedis['configuration']['createClient']>>
    },
  })
  cleanups.push(() => extension.onDestroy())
  const document = new Document(name); bindStateGeneration(document, generation)
  cleanups.push(() => document.destroy())
  const documents = new Map([[name, document]])
  const instance = { documents } as unknown as Hocuspocus
  extension.instance = instance
  const sendStateless = vi.fn()
  vi.spyOn(document, 'getConnections').mockReturnValue([{ sendStateless, messageAddress: name, send: vi.fn() }] as unknown as ReturnType<Document['getConnections']>)
  fenceRedisGenerations(extension)
  function sendMessage(message: OutgoingMessage, channelGeneration = generation, identifier = 'node-A') {
    const peer = Buffer.from(identifier)
    clients[1]!.emit('messageBuffer', Buffer.from(`receipt-test:generation:${channelGeneration}:${name}`),
      Buffer.concat([Buffer.from([peer.length]), peer, Buffer.from(message.toUint8Array())]))
  }
  function send(payload: string, channelGeneration = generation, identifier = 'node-A') {
    sendMessage(new OutgoingMessage(name).writeBroadcastStateless(payload), channelGeneration, identifier)
  }
  if (beforeLoad) {
    documents.delete(name)
    clients[0]!.publish.mockImplementationOnce(async () => { beforeLoad(send); return 0 })
  }
  await extension.afterLoadDocument({ documentName: name, document, instance } as Parameters<HocuspocusRedis['afterLoadDocument']>[0])
  return { extension, document, documents, instance, sendStateless, send, sendMessage, publish: clients[0]!.publish }
}

describe('Redis generation receipts retained for later connections', () => {
  it('holds a peer sync response until the local edit author is staged', async () => {
    const f = await fixture()
    const peer = new Document(name)
    cleanups.push(() => peer.destroy())
    let release!: () => void
    const promise = new Promise<void>(resolve => { release = resolve })
    const stage = vi.fn(() => promise)
    trackDocumentBodyEdits(f.document, stage)
    f.document.transact(() => {
      f.document.getXmlFragment(COLLAB_FIELD).push([new Y.XmlText('edit')])
    }, { source: 'local', context: { documentEditActor: { actorUid: 'alice', principalSpaceId: 'space' } } })
    expect(stage).toHaveBeenCalledOnce()

    f.publish.mockClear()
    f.sendMessage(new OutgoingMessage(name).createSyncMessage().writeFirstSyncStepFor(peer))
    await new Promise(resolve => setImmediate(resolve))
    expect(f.publish).not.toHaveBeenCalled()
    release()
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalled())
  })

  it('forwards a peer receipt and retains exactly its saved snapshot, excluding live unsaved edits', async () => {
    const f = await fixture(), peer = makeDoc()
    recordDurableReceipt(f.document, captureDurableSnapshot(f.document))
    peer.getMap('sheet').set('saved', 1)
    Y.applyUpdateV2(f.document, Y.encodeStateAsUpdateV2(peer))
    f.document.getMap('sheet').set('not-yet-saved', 2)
    const payload = frame(peer)
    f.send(payload)
    await vi.waitFor(() => expect(f.sendStateless).toHaveBeenCalledWith(payload))
    expect(Y.equalSnapshots(snapshot(f.document), Y.snapshot(peer))).toBe(true)
    expect(Y.equalSnapshots(snapshot(f.document), Y.snapshot(f.document))).toBe(false)
  })

  it('retains a peer receipt even without a local receipt or a currently connected client', async () => {
    const f = await fixture(), peer = makeDoc()
    vi.mocked(f.document.getConnections).mockReturnValue([])
    peer.getMap('sheet').set('saved-before-join', 1)
    f.send(frame(peer))
    await vi.waitFor(() => expect(Y.equalSnapshots(snapshot(f.document), Y.snapshot(peer))).toBe(true))
  })

  it('retains a valid large receipt for a document below the default decoded-state budget', async () => {
    const f = await fixture(), peer = makeDoc(), sheet = peer.getMap('sheet')
    // All IDs use three varint bytes. This crosses BOTH former receiver-only caps.
    // These are CRDT identities, not a claimed count of people or live connections.
    const identities = 375_256
    peer.transact(() => {
      for (let i = 0; i < identities; i++) { peer.clientID = 100_000 + i; sheet.set(String(i), { v: i }) }
    })
    expect(Y.encodeStateAsUpdateV2(peer).length).toBeLessThan(10 * 1024 * 1024)
    const saved = captureDurableSnapshot(peer)
    expect(Buffer.from(Y.encodeSnapshot(Y.decodeSnapshot(saved))).equals(Buffer.from(saved))).toBe(true)
    bindStateGeneration(peer, generation)
    recordDurableReceipt(peer, saved)
    const payload = durableReceipt(peer)!
    expect(JSON.parse(payload).snapshot.length).toBeGreaterThan(2_000_000)
    expect(payload.length).toBeGreaterThan(2_001_000)
    f.send(payload)
    // Avoid multi-megabyte assertion diffs when deliberately restoring a size cap.
    expect(durableReceipt(f.document) === payload).toBe(true)
    expect(f.sendStateless.mock.calls.some(([value]) => value === payload)).toBe(true)
    expect(snapshot(f.document).sv.size).toBe(identities)
  }, 15_000)

  it('the real connected hook replays retained peer coverage including deletes, excluding later live edits', async () => {
    const f = await fixture(), peer = makeDoc()
    peer.transact(() => { for (let i = 0; i < 4; i++) peer.getMap('sheet').set(String(i), i) })
    peer.transact(() => { peer.getMap('sheet').delete('0'); peer.getMap('sheet').delete('1') })
    vi.mocked(f.document.getConnections).mockReturnValue([])
    Y.applyUpdateV2(f.document, Y.encodeStateAsUpdateV2(peer))
    f.send(frame(peer))
    f.document.getMap('sheet').set('not-yet-committed', 99)
    const server = createServer(f.extension)
    cleanups.push(() => server.destroy())
    const context = { user: { id: 'later-user' }, permission_epoch: 1, cacheGeneration: generation, role: 'writer' }
    const request = new Request('http://localhost/collaboration')
    const loadHook = server.configuration.afterLoadDocument!
    await loadHook({
      instance: server.hocuspocus, document: f.document, documentName: name, context,
      socketId: 'later-socket', requestHeaders: request.headers, requestParameters: new URLSearchParams(),
      connectionConfig: { readOnly: false, isAuthenticated: true },
    })
    const received: string[] = []
    const connection = new Connection({
      readyState: 1,
      close() {},
      send(message) {
        if (!(message instanceof Uint8Array)) throw new TypeError('Expected a binary collaboration frame')
        const decoder = createDecoder(message)
        const address = readVarString(decoder)
        const type = readVarUint(decoder)
        if (type === MessageType.Stateless) {
          expect(address).toBe(name)
          received.push(readVarString(decoder))
        }
      },
    }, request, f.document, 'later-socket', context)
    cleanups.push(async () => {
      connection.close()
      await server.configuration.beforeUnloadDocument!({
        instance: server.hocuspocus, document: f.document, documentName: name,
      })
    })
    expect(f.document.hasConnection(connection)).toBe(true)
    const replay = vi.spyOn(connection, 'sendStateless')
    const hook = server.configuration.connected!
    const data = { documentName: name, socketId: 'later-socket', context, connection,
    } as Parameters<typeof hook>[0]
    await hook(data)
    expect(replay).toHaveBeenCalledTimes(1)
    expect(replay).toHaveBeenCalledWith(frame(peer))
    expect(received).toEqual([frame(peer)])
    const delivered = Y.decodeSnapshot(Buffer.from(JSON.parse(received[0]!).snapshot, 'base64'))
    expect(delivered.ds.clients.get(peer.clientID)).toEqual([{ clock: 0, len: 2 }])
    expect(delivered.sv.get(f.document.clientID) ?? 0).toBe(0)
  })

  it('retains receipts during afterLoadDocument, before instance.documents registration', async () => {
    const peer = makeDoc(); peer.getMap('sheet').set('during-load', 1)
    const f = await fixture(send => send(frame(peer)))
    expect(f.documents.has(name)).toBe(false)
    expect(Y.equalSnapshots(snapshot(f.document), Y.snapshot(peer))).toBe(true)
  })

  it('unions independent local and peer commits, preserves deletion ranges and ignores late older receipts', async () => {
    const f = await fixture(), a = makeDoc(), b = makeDoc(), union = makeDoc()
    a.transact(() => { for (let i = 0; i < 4; i++) a.getMap('sheet').set(String(i), i) })
    const old = frame(a)
    a.transact(() => { a.getMap('sheet').delete('0'); a.getMap('sheet').delete('1') })
    b.getMap('sheet').set('independent', 1)
    Y.applyUpdateV2(union, Y.encodeStateAsUpdateV2(a)); Y.applyUpdateV2(union, Y.encodeStateAsUpdateV2(b))
    f.send(frame(a)); recordDurableReceipt(f.document, captureDurableSnapshot(b)); f.send(old)
    await vi.waitFor(() => expect(f.sendStateless).toHaveBeenCalledTimes(2))
    const saved = snapshot(f.document)
    expect(Y.equalSnapshots(saved, Y.snapshot(union))).toBe(true)
    expect(saved.ds.clients.get(a.clientID)).toEqual([{ clock: 0, len: 2 }])
    recordDurableReceipt(f.document, captureDurableSnapshot(b))
    expect(Y.equalSnapshots(snapshot(f.document), saved)).toBe(true)
    recordDurableReceipt(f.document, new Uint8Array([0, 0]))
    expect(Y.equalSnapshots(snapshot(f.document), saved)).toBe(true)
  })

  it('does not retain wrong-generation, malformed, unrelated or old-channel data', async () => {
    const f = await fixture(), peer = makeDoc()
    recordDurableReceipt(f.document, captureDurableSnapshot(f.document))
    const before = durableReceipt(f.document)
    peer.getMap('sheet').set('untrusted', 1)
    f.send(frame(peer, otherGeneration))
    f.send('{broken-json')
    f.send(JSON.stringify({ type: 'doc.persisted', generation, snapshot: '%%%bad' }))
    f.send(JSON.stringify({ type: 'doc.persisted', generation, snapshot: Buffer.concat([Buffer.from(captureDurableSnapshot(peer)), Buffer.from([0])]).toString('base64') }))
    f.send(JSON.stringify({ type: 'doc.persisted', generation, snapshot: 'A'.repeat(2_000_004) }))
    f.send(JSON.stringify({ type: 'doc.cache-stale', compactedAt: 123 }))
    f.send(frame(peer), otherGeneration)
    f.send(frame(peer), generation, 'node-B')
    await vi.waitFor(() => expect(f.sendStateless).toHaveBeenCalledTimes(6))
    expect(durableReceipt(f.document)).toBe(before)
  })

  it('does not apply queued receipts after unload or let an old generation cover a new document', async () => {
    const f = await fixture(), peer = makeDoc()
    f.documents.delete(name)
    await f.extension.afterUnloadDocument({ instance: f.instance, documentName: name } as Parameters<HocuspocusRedis['afterUnloadDocument']>[0])
    peer.getMap('sheet').set('old', 1); f.send(frame(peer))
    expect(durableReceipt(f.document)).toBeUndefined()
    const next = new Document(name); cleanups.push(() => next.destroy())
    bindStateGeneration(next, otherGeneration); f.documents.set(name, next)
    await f.extension.afterLoadDocument({ instance: f.instance, documentName: name, document: next } as Parameters<HocuspocusRedis['afterLoadDocument']>[0])
    f.send(frame(peer))
    expect(durableReceipt(next)).toBeUndefined()
  })
})
