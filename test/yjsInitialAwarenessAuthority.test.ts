import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate } from 'y-protocols/awareness'
import { Connection, MessageType, type WebSocketLike } from '@hocuspocus/server'
import { createDecoder, readVarString, readVarUint, readVarUint8Array } from 'lib0/decoding'
import { createEncoder, toUint8Array, writeVarString, writeVarUint, writeVarUint8Array } from 'lib0/encoding'
import { signCollabToken } from '../src/auth/collabToken.js'
import { createServer } from '../src/collab/server.js'
import { config } from '../src/config/env.js'
import { persistence } from '../src/collab/persistence.js'
import type { AuthContext } from '../src/collab/authenticate.js'
import { stateGenerationRepo } from '../src/db/repos/stateGenerationRepo.js'
import { invalidateActiveAccess } from '../src/permission/activeAccess.js'
import { recheckCurrentAccess, type CurrentAccess } from '../src/permission/resolveRole.js'
import type * as LoadAdmissionModule from '../src/collab/loadAdmission.js'

vi.mock('../src/permission/epoch.js', () => ({ currentEpoch: vi.fn(async () => 0) }))
vi.mock('../src/collab/loadAdmission.js', async original => {
  const actual = await original<typeof LoadAdmissionModule>()
  return {
    ...actual,
    loadAdmission: new actual.LoadAdmission(() => ({
      heapUsed: 64 * 1024 ** 2, heapLimit: 512 * 1024 ** 2,
      available: 3 * 1024 ** 3, capacity: 4 * 1024 ** 3,
    })),
  }
})
vi.mock('../src/db/repos/stateGenerationRepo.js', () => ({ stateGenerationRepo: { ensureSheet: vi.fn() } }))
vi.mock('../src/permission/resolveRole.js', async original => ({
  ...await original<typeof import('../src/permission/resolveRole.js')>(),
  recheckCurrentAccess: vi.fn(),
}))
vi.mock('../src/permission/connectionRegistry.js', () => ({
  connectionRegistry: { register: vi.fn(async () => {}), unregister: vi.fn(async () => {}) },
}))
vi.mock('../src/collab/compactionNotice.js', async original => ({
  ...await original<typeof import('../src/collab/compactionNotice.js')>(),
  noticeStaleCacheOnJoin: vi.fn(async () => false),
}))

vi.mock('../src/collab/compactionCluster.js', async original => ({
  ...await original<typeof import('../src/collab/compactionCluster.js')>(),
  markLoaded: vi.fn(async () => {}),
}))

const cleanups: Array<() => Promise<void>> = []
const SOURCE_REVISION = `sha256:${'b'.repeat(64)}`
const SPACE = 'initial-awareness'
const UID = 'u_native_reader'
let now = 1_000

beforeEach(() => {
  now = 1_000
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.mocked(stateGenerationRepo.ensureSheet).mockReset().mockResolvedValue(null)
  vi.mocked(recheckCurrentAccess).mockReset()
  vi.spyOn(persistence, 'fetch').mockResolvedValue(null)
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

function access(source = true, role: CurrentAccess['role'] = 'reader'): CurrentAccess {
  return { role, permissionEpoch: 0, sourceRevision: source ? SOURCE_REVISION : null,
    proofExpiresAt: source ? 2_000 : null, sourceConfirmed: true }
}

function socketCapture() {
  const sent: Uint8Array[] = []
  let closed = false
  const socket: WebSocketLike = {
    get readyState() { return closed ? 3 : 1 },
    send(message) {
      if (!(message instanceof Uint8Array)) throw new TypeError('Expected a native binary collaboration frame')
      sent.push(message.slice())
    },
    close() { closed = true },
  }
  return { socket, sent, isOpen: () => !closed }
}

function frame(address: string, type: MessageType, payload: (encoder: ReturnType<typeof createEncoder>) => void) {
  const encoder = createEncoder()
  writeVarString(encoder, address)
  writeVarUint(encoder, type)
  payload(encoder)
  return toUint8Array(encoder)
}

function awarenessStates(frames: Uint8Array[], address: string): unknown[] {
  const document = new Y.Doc()
  const awareness = new Awareness(document)
  awareness.setLocalState(null)
  try {
    for (const message of frames) {
      const decoder = createDecoder(message)
      if (readVarString(decoder) !== address || readVarUint(decoder) !== MessageType.Awareness) continue
      applyAwarenessUpdate(awareness, readVarUint8Array(decoder), 'server')
    }
    return [...awareness.getStates().values()]
  } finally {
    awareness.destroy()
    document.destroy()
  }
}

function addressedFrames(frames: Uint8Array[], address: string, type: MessageType): Uint8Array[] {
  return frames.filter(message => {
    const decoder = createDecoder(message)
    return readVarString(decoder) === address && readVarUint(decoder) === type
  })
}

async function fixture(options: { sourceBytes?: number } = {}) {
  const server = createServer({} as NonNullable<Parameters<typeof createServer>[0]>)
  const docId = `d_${crypto.randomUUID()}`
  const independentId = `d_${crypto.randomUUID()}`
  const name = `octo:${SPACE}:f_default:${docId}`
  const independentName = `octo:${SPACE}:f_default:${independentId}`
  const completed = new Set<string>()
  server.hocuspocus.configuration.extensions.push({
    async connected({ connection }) { completed.add(connection.messageAddress) },
    async onLoadDocument({ document }) {
      document.getMap('content').set('text', document.name === name ? 'source document' : 'independent document')
      if (document.name === name && options.sourceBytes) {
        document.getText('bulk').insert(0, 'x'.repeat(options.sourceBytes))
      }
      document.awareness.setLocalState({ user: { id: 'existing-writer', name: document.name === name ? 'source presence' : 'independent presence' } })
    },
  })
  const peers: ReturnType<typeof server.hocuspocus.handleConnection>[] = []
  const keepers: Connection[] = []
  // Run the real load/afterLoad hooks as well as ClientConnection authentication and construction.
  const documents = await Promise.all([name, independentName].map(documentName =>
    server.hocuspocus.createDocument(documentName, new Request('http://localhost/collaboration'),
      'existing-publisher', { readOnly: false, isAuthenticated: true }),
  ))
  for (const document of documents) {
    // A real existing publisher keeps the shared room alive if the joining reader is denied.
    keepers.push(new Connection(socketCapture().socket, new Request('http://localhost/collaboration'), document,
      `publisher-${document.name}`, {}))
  }
  cleanups.push(async () => {
    server.hocuspocus.documents.clear()
    for (const document of documents) {
      for (const connection of document.getConnections()) {
        const context = connection.context as AuthContext | undefined
        context?.activeAccessRegistration?.release()
        context?.activeAccessDisposer?.()
      }
    }
    for (const peer of peers) peer.handleClose()
    for (const keeper of keepers) keeper.close()
    for (const document of documents) {
      await server.hocuspocus.hooks('beforeUnloadDocument', {
        instance: server.hocuspocus, document, documentName: document.name,
      })
      document.destroy()
    }
    await server.destroy()
  })
  function peer(uid = UID) {
    const capture = socketCapture()
    const client = server.hocuspocus.handleConnection(capture.socket, new Request('http://localhost/collaboration'))
    peers.push(client)
    function authenticate(address: string) {
      const documentName = address.split('\0', 1)[0]!
      const token = signCollabToken({ uid, documentName, role: 'reader', permission_epoch: 0,
        principal_space_id: SPACE, current_space_verified: true, current_space_id: SPACE }).token
      client.handleMessage(frame(address, MessageType.Auth, encoder => {
        writeVarUint(encoder, 0)
        writeVarString(encoder, token)
      }))
    }
    async function settled(address: string) {
      await vi.waitFor(() => {
        const refused = capture.sent.some(message => {
          const decoder = createDecoder(message)
          if (readVarString(decoder) !== address) return false
          const type = readVarUint(decoder)
          return type === MessageType.CLOSE || (type === MessageType.Auth && readVarUint(decoder) === 1)
        })
        expect(completed.has(address) || refused).toBe(true)
      })
    }
    return { ...capture, client, authenticate, settled }
  }
  async function assertDocumentSync(p: ReturnType<typeof peer>, address: string, expectedText: string) {
    const replica = new Y.Doc()
    try {
      p.client.handleMessage(frame(address, MessageType.Sync, encoder => {
        writeVarUint(encoder, 0)
        writeVarUint8Array(encoder, Y.encodeStateVector(replica))
      }))
      await vi.waitFor(() => {
        for (const message of p.sent) {
          const decoder = createDecoder(message)
          if (readVarString(decoder) !== address || readVarUint(decoder) !== MessageType.Sync) continue
          const type = readVarUint(decoder)
          if (type === 1 || type === 2) Y.applyUpdate(replica, readVarUint8Array(decoder))
        }
        expect(replica.getMap('content').get('text')).toBe(expectedText)
      })
      expect(p.isOpen()).toBe(true)
    } finally { replica.destroy() }
  }
  async function assertIndependentSync(p: ReturnType<typeof peer>) {
    await assertDocumentSync(p, independentName, 'independent document')
  }
  return { server, name, docId, independentName, peer, assertDocumentSync, assertIndependentSync }
}

describe('native Hocuspocus initial-awareness source authority', () => {
  it('delivers existing awareness when the source proof is current (positive control)', async () => {
    const f = await fixture()
    vi.mocked(recheckCurrentAccess).mockResolvedValue(access())
    const p = f.peer()
    p.authenticate(f.name)
    await p.settled(f.name)
    expect(awarenessStates(p.sent, f.name)).toEqual([{ user: { id: 'existing-writer', name: 'source presence' } }])
  })

  it.each(['expired-during-authentication', 'invalidated-during-authentication', 'new-tab-during-frozen-binding'] as const)(
    'does not leak constructor awareness for %s and preserves an independent logical document', async scenario => {
      const f = await fixture()
      const sourceResult = deferred<CurrentAccess>()
      const sourceStarted = deferred<void>()
      const ensureEntered = deferred<void>()
      const ensureResult = deferred<null>()
      let checkingSource = false
      vi.mocked(recheckCurrentAccess).mockImplementation(async documentName => {
        if (documentName === f.independentName) return access(false)
        if (checkingSource) {
          checkingSource = false
          sourceStarted.resolve()
          return sourceResult.promise
        }
        return access()
      })
      const p = f.peer()
      p.authenticate(f.independentName)
      await p.settled(f.independentName)
      expect(awarenessStates(p.sent, f.independentName))
        .toEqual([{ user: { id: 'existing-writer', name: 'independent presence' } }])
      if (scenario !== 'expired-during-authentication') {
        const existing = f.peer()
        existing.authenticate(f.name)
        await existing.settled(f.name)
      }
      const address = `${f.name}\0new-tab`
      try {
        if (scenario === 'new-tab-during-frozen-binding') {
          checkingSource = true
          invalidateActiveAccess(f.docId, SPACE, UID)
          await sourceStarted.promise
          p.authenticate(address)
        } else {
          vi.mocked(stateGenerationRepo.ensureSheet).mockImplementationOnce(async () => {
            ensureEntered.resolve()
            return ensureResult.promise
          })
          p.authenticate(address)
          await ensureEntered.promise
          if (scenario === 'expired-during-authentication') now = 2_001
          else {
            checkingSource = true
            invalidateActiveAccess(f.docId, SPACE, UID)
            await sourceStarted.promise
          }
          ensureResult.resolve(null)
        }
        await p.settled(address)
        // Decode the native constructor frame at the receiving client, not a hook spy.
        const receivedPresence = awarenessStates(p.sent, address)
        await f.assertIndependentSync(p)
        expect(receivedPresence).toEqual([])
        if (scenario === 'expired-during-authentication') {
          // Reusing the exact logical address must establish a fresh connection, not dispatch
          // authentication into a constructor-closed Connection left in the native routing map.
          vi.mocked(recheckCurrentAccess).mockResolvedValue(access(false))
          const afterExpiry = p.sent.length
          p.authenticate(address)
          await vi.waitFor(() => {
            expect(awarenessStates(p.sent.slice(afterExpiry), address))
              .toEqual([{ user: { id: 'existing-writer', name: 'source presence' } }])
          })
        }
      } finally {
        ensureResult.resolve(null)
        sourceResult.resolve(access(false, 'none'))
        await new Promise<void>(resolve => setImmediate(resolve))
      }
    },
  )
  it('rechecks a source handshake invalidated before binding while preserving an independent same-document reader', async () => {
    const f = await fixture()
    const sourceResult = deferred<CurrentAccess>()
    const sourceStarted = deferred<void>()
    let sourceChecks = 0
    vi.mocked(recheckCurrentAccess).mockImplementation(async (documentName, uid) => {
      if (documentName !== f.name) return access(false)
      if (uid !== UID) return access(false)
      if (++sourceChecks === 1) return access()
      sourceStarted.resolve()
      return sourceResult.promise
    })

    const independent = f.peer('u_independent')
    independent.authenticate(f.name)
    await independent.settled(f.name)

    const ensureEntered = deferred<void>()
    const ensureResult = deferred<null>()
    vi.mocked(stateGenerationRepo.ensureSheet).mockImplementationOnce(async () => {
      ensureEntered.resolve()
      return ensureResult.promise
    })
    const joining = f.peer()
    const address = `${f.name}\0late-source-reader`
    try {
      joining.authenticate(address)
      await ensureEntered.promise
      // No source binding exists for this uid yet: the notification lands after
      // authenticate's proof lookup but before afterLoadDocument registers it.
      invalidateActiveAccess(f.docId, SPACE)
      ensureResult.resolve(null)
      await joining.settled(address)
      expect(awarenessStates(joining.sent, address)).toEqual([])
      await vi.waitFor(() => expect(sourceChecks).toBe(2), { timeout: 1_000 })
      await sourceStarted.promise
      const replica = new Y.Doc()
      try {
        joining.client.handleMessage(frame(address, MessageType.Sync, encoder => {
          writeVarUint(encoder, 0)
          writeVarUint8Array(encoder, Y.encodeStateVector(replica))
        }))
        const { promise, resolve } = Promise.withResolvers<void>()
        setImmediate(resolve)
        await promise
        for (const message of joining.sent) {
          const decoder = createDecoder(message)
          if (readVarString(decoder) !== address || readVarUint(decoder) !== MessageType.Sync) continue
          const type = readVarUint(decoder)
          if (type === 1 || type === 2) Y.applyUpdate(replica, readVarUint8Array(decoder))
        }
        expect(replica.getMap('content').get('text')).toBeUndefined()
      } finally {
        replica.destroy()
      }
      await f.assertDocumentSync(independent, f.name, 'source document')

      sourceResult.resolve(access(false, 'none'))
      await vi.waitFor(() => {
        expect(addressedFrames(joining.sent, address, MessageType.CLOSE)).not.toHaveLength(0)
      })
      await f.assertDocumentSync(independent, f.name, 'source document')
    } finally {
      ensureResult.resolve(null)
      sourceResult.resolve(access(false, 'none'))
    }
  })

})

describe('frozen logical-connection send queue bounds', () => {
  const originalCaps = {
    frames: config.ppt.relay.maxLiveBufferFrames,
    bytes: config.ppt.relay.maxLiveBufferBytes,
  }
  afterEach(() => {
    config.ppt.relay.maxLiveBufferFrames = originalCaps.frames
    config.ppt.relay.maxLiveBufferBytes = originalCaps.bytes
  })

  it.each([
    ['frame', { frames: 3, bytes: 1_000_000, sourceBytes: 0, sends: 8 }],
    ['byte', { frames: 4096, bytes: 12_000, sourceBytes: 8_192, sends: 6 }],
  ] as const)('closes only the frozen logical connection once its pending send %s cap is exceeded', async (_cap, limits) => {
    config.ppt.relay.maxLiveBufferFrames = limits.frames
    config.ppt.relay.maxLiveBufferBytes = limits.bytes
    const f = await fixture({ sourceBytes: limits.sourceBytes })
    const stuck = deferred<CurrentAccess>()
    const stuckStarted = deferred<void>()
    let checkingSource = false
    vi.mocked(recheckCurrentAccess).mockImplementation(async documentName => {
      if (documentName !== f.name) return access(false)
      if (checkingSource) { stuckStarted.resolve(); return stuck.promise }
      return access()
    })
    const p = f.peer()
    p.authenticate(f.independentName)
    await p.settled(f.independentName)
    p.authenticate(f.name)
    await p.settled(f.name)
    const sourceDocument = f.server.hocuspocus.documents.get(f.name)!
    const peerConnection = sourceDocument.getConnections()
      .find(connection => (connection.context as Partial<AuthContext> | undefined)?.user?.id === UID)
    expect(peerConnection).toBeDefined()
    const sourceStart = p.sent.length
    const stateVector = Y.encodeStateVector(new Y.Doc())
    const requestSourceSync = () => p.client.handleMessage(frame(f.name, MessageType.Sync, encoder => {
      writeVarUint(encoder, 0)
      writeVarUint8Array(encoder, stateVector)
    }))
    try {
      checkingSource = true
      invalidateActiveAccess(f.docId, SPACE, UID)
      await stuckStarted.promise
      // The full refresh froze delivery: a SyncStep1 reply is retained, not sent.
      requestSourceSync()
      await peerConnection!.waitForPendingMessages()
      expect(addressedFrames(p.sent.slice(sourceStart), f.name, MessageType.Sync)).toHaveLength(0)
      expect(addressedFrames(p.sent, f.name, MessageType.CLOSE)).toHaveLength(0)

      for (let i = 0; i < limits.sends; i++) requestSourceSync()
      await vi.waitFor(() => {
        expect(addressedFrames(p.sent, f.name, MessageType.CLOSE)).toHaveLength(1)
      })
      expect(addressedFrames(p.sent, f.independentName, MessageType.CLOSE)).toHaveLength(0)
      // The same physical socket's other document connection still syncs.
      await f.assertIndependentSync(p)
    } finally {
      stuck.resolve(access())
    }
  })
})
