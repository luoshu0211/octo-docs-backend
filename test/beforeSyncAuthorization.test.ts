import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { Connection, Document, MessageType, type WebSocketLike } from '@hocuspocus/server'
import { createDecoder, readVarString, readVarUint, readVarUint8Array } from 'lib0/decoding'
import { createEncoder, toUint8Array, writeVarString, writeVarUint, writeVarUint8Array } from 'lib0/encoding'
import { createServer, setEpochWatermark } from '../src/collab/server.js'
import { bindStateGeneration } from '../src/collab/stateGeneration.js'
import { stateGenerationRepo } from '../src/db/repos/stateGenerationRepo.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { getDriveDerivedAccess, setDriveDerivedAccess, type DerivedAccessVersion, type DriveDerivedAccess } from '../src/drive/derivedAccessClient.js'
import { invalidateActiveAccess, pollActiveAccess } from '../src/permission/activeAccess.js'
import { recheckCurrentAccess, recheckCurrentRole, type CurrentAccess } from '../src/permission/resolveRole.js'
import { recheckCurrentRoleCached } from '../src/permission/recheck.js'
import type { AuthContext } from '../src/collab/authenticate.js'

vi.mock('../src/db/repos/stateGenerationRepo.js', () => ({ stateGenerationRepo: { current: vi.fn() } }))
vi.mock('../src/permission/resolveRole.js', async original => ({
  ...await original<typeof import('../src/permission/resolveRole.js')>(),
  recheckCurrentRole: vi.fn(),
  recheckCurrentAccess: vi.fn(),
}))
const yjsLifecycleMocks = vi.hoisted(() => ({
  register: vi.fn(async () => undefined),
  unregister: vi.fn(async () => undefined),
  list: vi.fn(async () => []),
  noticeStaleCacheOnJoin: vi.fn(async () => false),
}))
vi.mock('../src/permission/connectionRegistry.js', () => ({
  connectionRegistry: {
    register: yjsLifecycleMocks.register,
    unregister: yjsLifecycleMocks.unregister,
    list: yjsLifecycleMocks.list,
  },
}))
vi.mock('../src/collab/compactionNotice.js', async original => ({
  ...await original<typeof import('../src/collab/compactionNotice.js')>(),
  noticeStaleCacheOnJoin: yjsLifecycleMocks.noticeStaleCacheOnJoin,
}))

vi.mock('../src/collab/compactionCluster.js', async original => ({
  ...await original<typeof import('../src/collab/compactionCluster.js')>(),
  markLoaded: vi.fn(async () => undefined),
}))

const generation = '00000000-0000-4000-8000-000000000001'
const nextGeneration = '00000000-0000-4000-8000-000000000002'
const originalDriveAccess = getDriveDerivedAccess()
const cleanups: Array<() => void | Promise<void>> = []
beforeEach(() => {
  vi.mocked(stateGenerationRepo.current).mockReset().mockResolvedValue(generation)
  vi.mocked(recheckCurrentRole).mockReset().mockResolvedValue('writer')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.mocked(recheckCurrentAccess).mockReset()
  yjsLifecycleMocks.register.mockReset().mockResolvedValue(undefined)
  yjsLifecycleMocks.unregister.mockReset().mockResolvedValue(undefined)
  yjsLifecycleMocks.list.mockReset().mockResolvedValue([])
  yjsLifecycleMocks.noticeStaleCacheOnJoin.mockReset().mockResolvedValue(false)
  setDriveDerivedAccess(originalDriveAccess)
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  setDriveDerivedAccess(originalDriveAccess)
  vi.restoreAllMocks()
})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// Real Connection queue -> configured hook dispatcher -> MessageReceiver -> Yjs.
// Only SQL role/identity reads and socket IO are controlled, not either guard or apply.
function fixture() {
  const name = `octo:sync-authz:f_default:${crypto.randomUUID()}`
  const server = createServer({} as NonNullable<Parameters<typeof createServer>[0]>)
  cleanups.push(() => server.destroy())
  const document = new Document(name), client = new Y.Doc()
  bindStateGeneration(document, generation)
  document.getMap('sheet').set('existing', 'saved')
  Y.applyUpdate(client, Y.encodeStateAsUpdate(document))
  client.getMap('sheet').set('incoming', 'must be authorized')
  const context: AuthContext = { user: { id: 'test-writer' }, role: 'writer', permission_epoch: 8,
    principal_space_id: 'principal-space', space_member: false, kind: 'document', space: 'sync-authz',
    folder: 'f_default', doc: 'sheet', stateGeneration: generation, cacheGeneration: generation }
  const request = new Request('http://localhost/collaboration')
  const connection = new Connection({ readyState: 1, send: vi.fn() } as unknown as WebSocketLike,
    request, document, 'test-socket', context)
  const payload = { clientsCount: 1, context, document, documentName: name, connection }
  connection.beforeHandleMessage((_, update) => server.hocuspocus.hooks('beforeHandleMessage', {
    ...payload, instance: server.hocuspocus, socketId: connection.socketId,
    requestHeaders: request.headers, requestParameters: new URLSearchParams(), update,
  }))
  connection.beforeSync((_, sync) => server.hocuspocus.hooks('beforeSync', { ...payload, ...sync }))
  const notice = vi.spyOn(connection, 'sendStateless')
  cleanups.push(() => { connection.close(); client.destroy(); document.destroy() })
  setEpochWatermark(name, 8)
  const before = Y.encodeStateAsUpdateV2(document), changed = vi.fn()
  document.on('update', changed)
  function send(type = 2) { // y-protocols Update=2, SyncStep2=1
    const encoder = createEncoder()
    writeVarString(encoder, name); writeVarUint(encoder, MessageType.Sync); writeVarUint(encoder, type)
    writeVarUint8Array(encoder, Y.encodeStateAsUpdate(client))
    connection.handleMessage(toUint8Array(encoder))
    return connection.waitForPendingMessages()
  }
  function denied() {
    expect(Y.encodeStateAsUpdateV2(document)).toEqual(before)
    expect(document.getMap('sheet').has('incoming')).toBe(false)
    expect(changed).not.toHaveBeenCalled()
    expect(connection.readOnly).toBe(true)
  }
  return { name, document, context, connection, notice, changed, send, denied }
}

describe('pre-sync authorization remains current through awaited identity checks', () => {
  it.each([1, 2])('applies an authorized sync type %i without a role lookup on the hot path', async type => {
    const f = fixture()
    await f.send(type)
    expect(f.document.getMap('sheet').get('incoming')).toBe('must be authorized')
    expect(f.changed).toHaveBeenCalledOnce()
    expect(stateGenerationRepo.current).toHaveBeenCalledOnce()
    expect(recheckCurrentRole).not.toHaveBeenCalled()
  })

  it('refuses revocation already visible before dispatch (positive control for the permission gate)', async () => {
    const f = fixture()
    setEpochWatermark(f.name, 9); vi.mocked(recheckCurrentRole).mockResolvedValue('none')
    await f.send(); f.denied()
    expect(stateGenerationRepo.current).not.toHaveBeenCalled()
  })

  it.each(['none', 'reader', 'commenter'] as const)('does not apply an update when the role becomes %s during SQL lookup', async role => {
    const f = fixture(), lookup = deferred<string | null>()
    vi.mocked(stateGenerationRepo.current).mockReturnValueOnce(lookup.promise)
    const pending = f.send()
    await vi.waitFor(() => expect(stateGenerationRepo.current).toHaveBeenCalledOnce())
    setEpochWatermark(f.name, 9); vi.mocked(recheckCurrentRole).mockResolvedValue(role)
    lookup.resolve(generation)
    await pending; f.denied()
    expect(recheckCurrentRole).toHaveBeenCalledWith(f.name, 'test-writer', 'principal-space', false)
  })

  it('also refuses SyncStep2 when revocation arrives during SQL lookup', async () => {
    const f = fixture(), lookup = deferred<string | null>()
    vi.mocked(stateGenerationRepo.current).mockReturnValueOnce(lookup.promise)
    const pending = f.send(1)
    await vi.waitFor(() => expect(stateGenerationRepo.current).toHaveBeenCalledOnce())
    setEpochWatermark(f.name, 9); vi.mocked(recheckCurrentRole).mockResolvedValue('none')
    lookup.resolve(generation)
    await pending; f.denied()
  })

  it('revalidates again if a second revocation arrives during the role query', async () => {
    const f = fixture(), lookup = deferred<string | null>(), role = deferred<'writer'>()
    vi.mocked(stateGenerationRepo.current).mockReturnValueOnce(lookup.promise)
    const pending = f.send()
    await vi.waitFor(() => expect(stateGenerationRepo.current).toHaveBeenCalledOnce())
    setEpochWatermark(f.name, 9)
    vi.mocked(recheckCurrentRole).mockReturnValueOnce(role.promise).mockResolvedValue('none')
    lookup.resolve(generation)
    await vi.waitFor(() => expect(recheckCurrentRole).toHaveBeenCalledOnce())
    setEpochWatermark(f.name, 10); role.resolve('writer')
    await pending; f.denied()
    expect(recheckCurrentRole).toHaveBeenCalledTimes(2)
  })

  it('does not reuse a cached role from an earlier permission epoch', async () => {
    const f = fixture()
    // The real cache is warmed by a prior epoch's successful recheck.
    await recheckCurrentRoleCached(f.name, 'test-writer', 'principal-space', false, 9)
    f.context.permission_epoch = 9; setEpochWatermark(f.name, 9)
    const lookup = deferred<string | null>()
    vi.mocked(stateGenerationRepo.current).mockReturnValueOnce(lookup.promise)
    const pending = f.send()
    await vi.waitFor(() => expect(stateGenerationRepo.current).toHaveBeenCalledOnce())
    setEpochWatermark(f.name, 10); vi.mocked(recheckCurrentRole).mockResolvedValue('none')
    lookup.resolve(generation)
    await pending; f.denied()
    expect(recheckCurrentRole).toHaveBeenCalledTimes(2)
  })

  it('does not join an in-flight role read from an earlier epoch', async () => {
    const f = fixture(), oldRole = deferred<'writer'>()
    vi.mocked(recheckCurrentRole).mockReturnValueOnce(oldRole.promise).mockResolvedValue('none')
    const oldRead = recheckCurrentRoleCached(f.name, 'test-writer', 'principal-space', false, 9)
    const newRead = recheckCurrentRoleCached(f.name, 'test-writer', 'principal-space', false, 10)
    try {
      await vi.waitFor(() => expect(recheckCurrentRole).toHaveBeenCalledTimes(2))
    } finally { oldRole.resolve('writer') }
    expect(await newRead).toBe('none')
    expect(await oldRead).toBe('writer')
    // A late old result may replace the single cache slot, but may never authorize epoch 10.
    expect(await recheckCurrentRoleCached(f.name, 'test-writer', 'principal-space', false, 10)).toBe('none')
  })

  it('still shares concurrent role checks within the same epoch and principal scope', async () => {
    const f = fixture(), role = deferred<'writer'>()
    vi.mocked(recheckCurrentRole).mockReturnValueOnce(role.promise)
    const a = recheckCurrentRoleCached(f.name, 'test-writer', 'principal-space', false, 9)
    const b = recheckCurrentRoleCached(f.name, 'test-writer', 'principal-space', false, 9)
    role.resolve('writer')
    expect(await Promise.all([a, b])).toEqual(['writer', 'writer'])
    expect(recheckCurrentRole).toHaveBeenCalledOnce()
  })

  it('preserves authorized writes when an epoch bump affects somebody else', async () => {
    const f = fixture(), lookup = deferred<string | null>()
    vi.mocked(stateGenerationRepo.current).mockReturnValueOnce(lookup.promise)
    const pending = f.send()
    await vi.waitFor(() => expect(stateGenerationRepo.current).toHaveBeenCalledOnce())
    setEpochWatermark(f.name, 9); lookup.resolve(generation)
    await pending
    expect(recheckCurrentRole).toHaveBeenCalledOnce()
    expect(f.context.permission_epoch).toBe(9)
    expect(f.document.getMap('sheet').get('incoming')).toBe('must be authorized')
    expect(f.changed).toHaveBeenCalledOnce()
  })

  it('also closes the stale-connection role-query window before pre-sync', async () => {
    const f = fixture(), role = deferred<'writer'>()
    setEpochWatermark(f.name, 9)
    vi.mocked(recheckCurrentRole).mockReturnValueOnce(role.promise).mockResolvedValue('none')
    const pending = f.send()
    await vi.waitFor(() => expect(recheckCurrentRole).toHaveBeenCalledOnce())
    setEpochWatermark(f.name, 10); role.resolve('writer')
    await pending; f.denied()
  })

  it('revalidates a role lookup even for a non-sheet without a generation hook', async () => {
    const f = fixture(), role = deferred<'writer'>()
    bindStateGeneration(f.document, null)
    setEpochWatermark(f.name, 9)
    vi.mocked(recheckCurrentRole).mockReturnValueOnce(role.promise).mockResolvedValue('none')
    const pending = f.send()
    await vi.waitFor(() => expect(recheckCurrentRole).toHaveBeenCalledOnce())
    setEpochWatermark(f.name, 10); role.resolve('writer')
    await pending; f.denied()
    expect(stateGenerationRepo.current).not.toHaveBeenCalled()
  })

  it.each([nextGeneration, null])('rejects stale or missing SQL generation %s before applying the update', async current => {
    const f = fixture()
    vi.mocked(stateGenerationRepo.current).mockResolvedValue(current)
    await f.send(); f.denied()
    expect(f.notice).toHaveBeenCalledWith(JSON.stringify({ type: 'doc.generation-stale', generation }))
  })

  it('rejects a stale client generation without querying SQL', async () => {
    const f = fixture(); f.context.cacheGeneration = nextGeneration
    await f.send(); f.denied()
    expect(stateGenerationRepo.current).not.toHaveBeenCalled()
    expect(f.notice).toHaveBeenCalledWith(JSON.stringify({ type: 'doc.generation-stale', generation }))
  })

  it('rechecks generation after a delayed role lookup', async () => {
    const f = fixture(), lookup = deferred<string | null>(), role = deferred<'writer'>()
    vi.mocked(stateGenerationRepo.current).mockReturnValueOnce(lookup.promise).mockResolvedValue(nextGeneration)
    const pending = f.send()
    await vi.waitFor(() => expect(stateGenerationRepo.current).toHaveBeenCalledOnce())
    setEpochWatermark(f.name, 9); vi.mocked(recheckCurrentRole).mockReturnValueOnce(role.promise)
    lookup.resolve(generation)
    await vi.waitFor(() => expect(recheckCurrentRole).toHaveBeenCalledOnce())
    role.resolve('writer')
    await pending; f.denied()
    expect(f.notice).toHaveBeenCalledWith(JSON.stringify({ type: 'doc.generation-stale', generation }))
  })

  it('fails closed when the identity lookup fails', async () => {
    const f = fixture(); vi.mocked(stateGenerationRepo.current).mockRejectedValue(new Error('SQL unavailable'))
    await f.send(); f.denied()
  })

  it('fails closed when the role lookup fails after an invalidation', async () => {
    const f = fixture(), lookup = deferred<string | null>()
    vi.mocked(stateGenerationRepo.current).mockReturnValueOnce(lookup.promise)
    const pending = f.send()
    await vi.waitFor(() => expect(stateGenerationRepo.current).toHaveBeenCalledOnce())
    setEpochWatermark(f.name, 9); vi.mocked(recheckCurrentRole).mockRejectedValue(new Error('Role lookup unavailable'))
    lookup.resolve(generation)
    await pending; f.denied()
  })
})
const SOURCE_REVISION = `sha256:${'a'.repeat(64)}`
const CURRENT_EPOCH = 8

function currentAccess(
  role: CurrentAccess['role'],
  sourceRevision: string | null = null,
  proofExpiresAt: number | null = null,
  sourceConfirmed = true,
): CurrentAccess {
  return { role, permissionEpoch: CURRENT_EPOCH, sourceRevision, proofExpiresAt, sourceConfirmed }
}

function captureSocket() {
  let readyState = 1
  const sent: Uint8Array[] = []
  const send = vi.fn((message: Uint8Array) => {
    if (readyState === 1) sent.push(message)
  })
  const close = vi.fn((_code?: number, _reason?: string) => { readyState = 3 })
  const socket = {
    get readyState() { return readyState },
    send,
    close,
  } as unknown as WebSocketLike
  return { socket, sent, send, close, isOpen: () => readyState === 1 }
}

interface LiveYjsSession {
  connection: Connection<AuthContext>
  context: AuthContext
  document: Document
  documentName: string
  payload: Record<string, unknown>
}

async function createLiveYjsSession(
  server: ReturnType<typeof createServer>,
  document: Document,
  context: AuthContext,
  socket: WebSocketLike,
): Promise<LiveYjsSession> {
  const request = new Request('http://localhost/collaboration')
  if (document.getConnectionsCount() === 0) {
    await server.hocuspocus.hooks('afterLoadDocument', {
      instance: server.hocuspocus,
      document,
      documentName: document.name,
      context,
      socketId: 'load-session',
      requestHeaders: request.headers,
      requestParameters: new URLSearchParams(),
      connectionConfig: { readOnly: false, isAuthenticated: true },
    })
  }
  const connection = new Connection(
    socket,
    request,
    document,
    `${context.user.id}-${crypto.randomUUID()}`,
    context,
    context.role !== 'writer',
  )
  const payload = {
    clientsCount: document.getConnectionsCount(),
    context,
    document,
    documentName: document.name,
    connection,
  }
  connection.beforeHandleMessage((_, update) => server.hocuspocus.hooks('beforeHandleMessage', {
    ...payload,
    instance: server.hocuspocus,
    socketId: connection.socketId,
    requestHeaders: request.headers,
    requestParameters: new URLSearchParams(),
    update,
  }))
  connection.beforeSync((_, sync) => server.hocuspocus.hooks('beforeSync', { ...payload, ...sync }))
  return { connection, context, document, documentName: document.name, payload }
}

async function connectLiveYjsSession(
  server: ReturnType<typeof createServer>,
  session: LiveYjsSession,
): Promise<void> {
  const request = session.connection.request
  await server.hocuspocus.hooks('connected', {
    ...session.payload,
    instance: server.hocuspocus,
    socketId: session.connection.socketId,
    requestHeaders: request.headers,
    requestParameters: new URLSearchParams(),
  } as never)
}

function trackLiveYjsSessions(
  server: ReturnType<typeof createServer>,
  sessions: LiveYjsSession[],
  documents: Document[],
): void {
  cleanups.push(async () => {
    for (const session of sessions) session.context.activeAccessDisposer?.()
    for (const session of sessions) session.connection.close()
    for (const document of documents) {
      await server.hocuspocus.hooks('beforeUnloadDocument', {
        instance: server.hocuspocus, document, documentName: document.name,
      })
      document.destroy()
    }
    await server.destroy()
  })
}

function containsDocumentMessage(
  frames: readonly Uint8Array[],
  documentName: string,
  type: MessageType,
): boolean {
  return frames.some(frame => {
    const decoder = createDecoder(frame)
    const address = readVarString(decoder)
    return address.split('\0', 1)[0] === documentName && readVarUint(decoder) === type
  })
}

async function sendClientUpdate(session: LiveYjsSession, client: Y.Doc): Promise<void> {
  const encoder = createEncoder()
  writeVarString(encoder, session.documentName)
  writeVarUint(encoder, MessageType.Sync)
  writeVarUint(encoder, 2) // y-protocols Update
  writeVarUint8Array(encoder, Y.encodeStateAsUpdate(client))
  session.connection.handleMessage(toUint8Array(encoder))
  await session.connection.waitForPendingMessages()
}

function makeCurrentContext(uid: string, docId: string, state: CurrentAccess): AuthContext {
  return {
    user: { id: uid },
    role: state.role as AuthContext['role'],
    permission_epoch: CURRENT_EPOCH,
    principal_space_id: 'principal-space',
    source_access: state,
    space_member: false,
    kind: 'document',
    space: 'source-expiry',
    folder: 'f_default',
    doc: docId,
    stateGeneration: generation,
    cacheGeneration: generation,
  }
}

describe('Yjs live-send source-proof deadline', () => {
  it.each(['scheduled-renewal', 'notice-renewal', 'nonrolling-proof'] as const)(
    'keeps a valid Drive reader connected across %s without delivering against its expired old proof', async trigger => {
      const server = createServer({} as NonNullable<Parameters<typeof createServer>[0]>)
      let now = 1_000
      vi.spyOn(performance, 'now').mockImplementation(() => now)
      const name = `octo:source-expiry:f_default:${crypto.randomUUID()}`
      const document = new Document(name)
      bindStateGeneration(document, generation)
      document.getMap('sheet').set('base', 'saved')
      const readerSocket = captureSocket()
      const writerSocket = captureSocket()
      const reader = await createLiveYjsSession(
        server, document,
        makeCurrentContext('u_valid_renewing_reader', 'd_renewing', currentAccess('reader', SOURCE_REVISION, 7_000)),
        readerSocket.socket,
      )
      const writer = await createLiveYjsSession(
        server, document, makeCurrentContext('u_independent_writer', 'd_renewing', currentAccess('writer')),
        writerSocket.socket,
      )
      const readerSessions = [reader]
      const readerSockets = [readerSocket]
      if (trigger === 'nonrolling-proof') {
        const duplicateSocket = captureSocket()
        readerSockets.push(duplicateSocket)
        readerSessions.push(await createLiveYjsSession(
          server, document,
          makeCurrentContext('u_valid_renewing_reader', 'd_renewing', currentAccess('reader', SOURCE_REVISION, 7_000)),
          duplicateSocket.socket,
        ))
      }
      trackLiveYjsSessions(server, [...readerSessions, writer], [document])
      for (const session of readerSessions) await connectLiveYjsSession(server, session)
      await connectLiveYjsSession(server, writer)
      for (const socket of readerSockets) socket.sent.length = 0
      writerSocket.sent.length = 0
      const readerClosed: unknown[] = []
      for (const session of readerSessions) {
        session.connection.onClose((_, event) => { readerClosed.push(event) })
      }
      const renewed = deferred<CurrentAccess>()
      const renewalStarted = deferred<void>()
      const nonrollingDecisionReturned = deferred<void>()
      let checksAfterOriginalDeadline = 0
      vi.mocked(recheckCurrentAccess).mockImplementation(async (_name, uid) => {
        if (uid !== 'u_valid_renewing_reader') return currentAccess('writer')
        if (trigger === 'nonrolling-proof' && now < 7_000) {
          // The underlying Server MemberProof has not expired: a full Drive decision
          // still carries that original deadline, not a fresh rolling proof lifetime.
          nonrollingDecisionReturned.resolve()
          return currentAccess('reader', SOURCE_REVISION, 7_000)
        }
        if (now >= 7_000) checksAfterOriginalDeadline++
        renewalStarted.resolve()
        return renewed.promise
      })
      setDriveDerivedAccess({
        derivedAccess: async () => null,
        // A matching revision is not a new authorization decision, regardless of this envelope's TTL.
        versions: async bindings => bindings.map(binding => ({
          ...binding, sourceRevision: SOURCE_REVISION, validForMs: 15_000, expiresAt: now + 15_000,
        })),
      })
      vi.spyOn(docMetaRepo, 'getEpochsByDocIds').mockResolvedValue([{
        doc_id: 'd_renewing', document_name: name, permission_epoch: CURRENT_EPOCH, status: 1,
      }])
      const publisher = new Y.Doc()
      const recipient = new Y.Doc()
      const readerBaseline = Y.encodeStateAsUpdate(document)
      Y.applyUpdate(publisher, Y.encodeStateAsUpdate(document))
      Y.applyUpdate(recipient, Y.encodeStateAsUpdate(document))
      try {
        // The first unchanged-version probe is far from expiry and must not extend the full proof.
        await pollActiveAccess()
        expect(reader.context.source_access?.proofExpiresAt).toBe(7_000)
        now = 6_000
        if (trigger === 'notice-renewal' || trigger === 'nonrolling-proof') {
          invalidateActiveAccess('d_renewing', 'principal-space', 'u_valid_renewing_reader')
          if (trigger === 'nonrolling-proof') {
            await nonrollingDecisionReturned.promise
            await new Promise<void>(resolve => setImmediate(resolve))
          } else await renewalStarted.promise
        } else {
          // The next 5-second poll would miss the old deadline, so this round must start
          // a full proof renewal, rather than waiting for the proof to expire first.
          await pollActiveAccess()
        }
        expect(reader.context.source_access?.proofExpiresAt).toBe(7_000)
        now = 7_001
        publisher.getMap('sheet').set('during-renewal', 'must wait for a fresh authorization decision')
        await sendClientUpdate(writer, publisher)
        if (trigger === 'nonrolling-proof') {
          // Two same-binding native readers and another broadcast must share the same
          // pending full decision in the gap before the next five-second poll.
          publisher.getMap('sheet').set('another-during-renewal', 'same pending proof')
          await sendClientUpdate(writer, publisher)
        }
        const deliveredBeforeRenewal = readerSockets.some(socket => containsDocumentMessage(socket.sent, name, MessageType.Sync))
        const remainedConnectedDuringRenewal = readerSessions.every(session => document.hasConnection(session.connection))
        renewed.resolve(currentAccess('reader', SOURCE_REVISION, 22_000))
        await new Promise<void>(resolve => setImmediate(resolve))
        publisher.getMap('sheet').set('after-renewal', 'reader remains a valid Drive member')
        await sendClientUpdate(writer, publisher)
        for (const message of readerSocket.sent) {
          const decoder = createDecoder(message)
          if (readVarString(decoder) !== name || readVarUint(decoder) !== MessageType.Sync) continue
          const syncType = readVarUint(decoder)
          if (syncType === 1 || syncType === 2) Y.applyUpdate(recipient, readVarUint8Array(decoder))
        }

        expect(deliveredBeforeRenewal).toBe(false)
        expect(remainedConnectedDuringRenewal).toBe(true)
        expect(readerClosed).toEqual([])
        expect(document.hasConnection(reader.connection)).toBe(true)
        expect(reader.context.source_access?.proofExpiresAt).toBe(22_000)
        expect(recipient.getMap('sheet').get('during-renewal')).toBe('must wait for a fresh authorization decision')
        expect(recipient.getMap('sheet').get('after-renewal')).toBe('reader remains a valid Drive member')
        expect(document.getMap('sheet').get('after-renewal')).toBe('reader remains a valid Drive member')
        expect(readerSocket.close).not.toHaveBeenCalled()
        expect(writerSocket.close).not.toHaveBeenCalled()
        if (trigger === 'nonrolling-proof') {
          expect(checksAfterOriginalDeadline).toBe(1)
          const duplicate = new Y.Doc()
          try {
            Y.applyUpdate(duplicate, readerBaseline)
            for (const message of readerSockets[1]!.sent) {
              const decoder = createDecoder(message)
              if (readVarString(decoder) !== name || readVarUint(decoder) !== MessageType.Sync) continue
              const syncType = readVarUint(decoder)
              if (syncType === 1 || syncType === 2) Y.applyUpdate(duplicate, readVarUint8Array(decoder))
            }
            expect(duplicate.getMap('sheet').get('during-renewal')).toBe('must wait for a fresh authorization decision')
            expect(duplicate.getMap('sheet').get('after-renewal')).toBe('reader remains a valid Drive member')
            expect(readerSessions[1]!.context.source_access?.proofExpiresAt).toBe(22_000)
            expect(readerSockets[1]!.close).not.toHaveBeenCalled()
          } finally { duplicate.destroy() }
        }
      } finally {
        renewed.resolve(currentAccess('reader', SOURCE_REVISION, 22_000))
        publisher.destroy()
        recipient.destroy()
        await new Promise<void>(resolve => setImmediate(resolve))
      }
    },
  )

  it('does not deliver writer updates after a Drive proof expires while the next poll is blocked', async () => {
    const server = createServer({} as NonNullable<Parameters<typeof createServer>[0]>)
    let now = 1_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const name = `octo:source-expiry:f_default:${crypto.randomUUID()}`
    const document = new Document(name)
    bindStateGeneration(document, generation)
    document.getMap('sheet').set('base', 'saved')
    const readerSocket = captureSocket()
    const writerSocket = captureSocket()
    const expiresAt = now + 1
    const reader = await createLiveYjsSession(
      server, document, makeCurrentContext('u_drive_reader', 'd_drive', currentAccess('reader', SOURCE_REVISION, expiresAt)), readerSocket.socket,
    )
    const writer = await createLiveYjsSession(
      server, document, makeCurrentContext('u_direct_writer', 'd_drive', currentAccess('writer')), writerSocket.socket,
    )
    const sessions = [reader, writer]
    trackLiveYjsSessions(server, sessions, [document])
    await connectLiveYjsSession(server, reader)
    await connectLiveYjsSession(server, writer)
    readerSocket.sent.length = 0
    writerSocket.sent.length = 0
    const readerClose = vi.spyOn(reader.connection, 'close')
    const blockedVersions = deferred<DerivedAccessVersion[] | null>()
    const versions = vi.fn(() => blockedVersions.promise)
    const drive: DriveDerivedAccess = {
      derivedAccess: vi.fn(async () => null),
      versions,
    }
    setDriveDerivedAccess(drive)
    vi.spyOn(docMetaRepo, 'getEpochsByDocIds').mockResolvedValue([{
      doc_id: 'd_drive',
      document_name: name,
      permission_epoch: CURRENT_EPOCH,
      status: 1,
    }])
    vi.mocked(recheckCurrentAccess).mockResolvedValue(currentAccess('reader', null, null, false))

    let pollFinished = false
    const pendingPoll = pollActiveAccess().then(() => { pollFinished = true })
    let pollWasBlockedAfterExpiry = false
    let readerReceivedExpiredUpdate = false
    let writerReceivedUpdate = false
    let readerRemovedFromDocument = false
    try {
      now = expiresAt + 1
      pollWasBlockedAfterExpiry = !pollFinished

      const client = new Y.Doc()
      Y.applyUpdate(client, Y.encodeStateAsUpdate(document))
      client.getMap('sheet').set('late', 'writer update after proof expiry')
      await sendClientUpdate(writer, client)
      client.destroy()
      readerReceivedExpiredUpdate = containsDocumentMessage(readerSocket.sent, name, MessageType.Sync)
      writerReceivedUpdate = containsDocumentMessage(writerSocket.sent, name, MessageType.Sync)
    } finally {
      blockedVersions.resolve(null)
      await pendingPoll
      await Promise.resolve()
      readerRemovedFromDocument = !document.hasConnection(reader.connection)
    }

    expect(pollWasBlockedAfterExpiry).toBe(true)
    expect(readerReceivedExpiredUpdate).toBe(false)
    expect(writerReceivedUpdate).toBe(true)
    expect(readerRemovedFromDocument).toBe(true)
    expect(readerClose.mock.calls.some(([event]) => event?.code === 4401)).toBe(true)
    expect(readerSocket.close).not.toHaveBeenCalled()
    expect(writerSocket.close).not.toHaveBeenCalled()
  })

  it('revoking one Drive-backed document closes only its logical connection on a multiplexed WebSocket', async () => {
    const server = createServer({} as NonNullable<Parameters<typeof createServer>[0]>)
    const driveName = `octo:source-expiry:f_default:${crypto.randomUUID()}`
    const otherName = `octo:source-expiry:f_default:${crypto.randomUUID()}`
    const driveDocument = new Document(driveName)
    const otherDocument = new Document(otherName)
    bindStateGeneration(driveDocument, generation)
    bindStateGeneration(otherDocument, generation)
    driveDocument.getMap('sheet').set('base', 'drive')
    otherDocument.getMap('sheet').set('base', 'independent')
    const sharedSocket = captureSocket()
    const reader = await createLiveYjsSession(
      server,
      driveDocument,
      makeCurrentContext('u_multiplexed', 'd_drive', currentAccess('reader', SOURCE_REVISION, performance.now() + 60_000)),
      sharedSocket.socket,
    )
    const independent = await createLiveYjsSession(
      server,
      otherDocument,
      makeCurrentContext('u_multiplexed', 'd_independent', currentAccess('writer')),
      sharedSocket.socket,
    )
    const sessions = [reader, independent]
    trackLiveYjsSessions(server, sessions, [driveDocument, otherDocument])
    await connectLiveYjsSession(server, reader)
    await connectLiveYjsSession(server, independent)
    sharedSocket.sent.length = 0
    const readerClose = vi.spyOn(reader.connection, 'close')
    const currentAccessResult = deferred<CurrentAccess>()
    vi.mocked(recheckCurrentAccess).mockReturnValueOnce(currentAccessResult.promise)

    const readerClosed = new Promise<void>(resolve => { reader.connection.onClose(() => resolve()) })
    invalidateActiveAccess('d_drive', 'principal-space', 'u_multiplexed')
    currentAccessResult.resolve(currentAccess('none'))
    await readerClosed
    const closedOnlyLogically = readerClose.mock.calls.some(([event]) => event?.code === 4403)
    const targetRemoved = !driveDocument.hasConnection(reader.connection)
    const physicalSocketClosed = sharedSocket.close.mock.calls.length > 0

    const client = new Y.Doc()
    Y.applyUpdate(client, Y.encodeStateAsUpdate(otherDocument))
    client.getMap('sheet').set('still-readable', true)
    await sendClientUpdate(independent, client)
    client.destroy()

    expect(closedOnlyLogically).toBe(true)
    expect(targetRemoved).toBe(true)
    expect(physicalSocketClosed).toBe(false)
    expect(otherDocument.hasConnection(independent.connection)).toBe(true)
    expect(containsDocumentMessage(sharedSocket.sent, otherName, MessageType.Sync)).toBe(true)
  })
})
