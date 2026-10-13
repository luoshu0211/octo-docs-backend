import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { Connection, Document, MessageType, type WebSocketLike } from '@hocuspocus/server'
import { createEncoder, toUint8Array, writeVarString, writeVarUint, writeVarUint8Array } from 'lib0/encoding'
import { createServer, setEpochWatermark } from '../src/collab/server.js'
import { bindStateGeneration } from '../src/collab/stateGeneration.js'
import { stateGenerationRepo } from '../src/db/repos/stateGenerationRepo.js'
import { recheckCurrentRole } from '../src/permission/resolveRole.js'
import { recheckCurrentRoleCached } from '../src/permission/recheck.js'
import type { AuthContext } from '../src/collab/authenticate.js'

vi.mock('../src/db/repos/stateGenerationRepo.js', () => ({ stateGenerationRepo: { current: vi.fn() } }))
vi.mock('../src/permission/resolveRole.js', async original => ({
  ...await original<typeof import('../src/permission/resolveRole.js')>(), recheckCurrentRole: vi.fn(),
}))

const generation = '00000000-0000-4000-8000-000000000001'
const nextGeneration = '00000000-0000-4000-8000-000000000002'
const cleanups: Array<() => void | Promise<void>> = []
beforeEach(() => {
  vi.mocked(stateGenerationRepo.current).mockReset().mockResolvedValue(generation)
  vi.mocked(recheckCurrentRole).mockReset().mockResolvedValue('writer')
  vi.spyOn(console, 'error').mockImplementation(() => {}) // receiver logs expected rejections
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
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
