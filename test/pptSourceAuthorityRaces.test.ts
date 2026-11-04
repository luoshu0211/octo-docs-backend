// Env seeding MUST be first so config/env.ts reads it at load time.
import './helpers/pptRelayEnv.js'


import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { WebSocket } from 'ws'
import { config } from '../src/config/env.js'
import { PPT_RELAY_TICKET_AUD } from '../src/auth/pptCollabToken.js'
import { InMemoryPptRelayStore } from '../src/ppt/relay/store.js'
import { PptRelay, type PptRelayDeps, type RelayLimits } from '../src/ppt/relay/pptRelay.js'
import { invalidateActiveAccess, pollActiveAccess } from '../src/permission/activeAccess.js'
import { getDriveDerivedAccess, setDriveDerivedAccess, type DriveDerivedAccess } from '../src/drive/derivedAccessClient.js'
import type { CurrentAccess } from '../src/permission/resolveRole.js'
import type { ResolvedRole, Role } from '../src/permission/role.js'
import { effectiveRole, SHARE_ROLE_EDIT, SHARE_SCOPE_ANYONE } from '../src/permission/shareScope.js'
const activeAccessMocks = vi.hoisted(() => ({
  getEpochsByDocIds: vi.fn(async (docIds: readonly string[]) =>
    docIds.map(doc_id => ({ doc_id, document_name: '', permission_epoch: 0, status: 1 }))),
}))

vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: { getEpochsByDocIds: activeAccessMocks.getEpochsByDocIds },
}))

const originalDriveAccess = getDriveDerivedAccess()

const DOC = 'd_ppt_source_authority'
const DOCNAME = 'octo:s_1:f_default:ppt:d_ppt_source_authority'
const SPACE = 's_1'

type ClientFrame = Record<string, unknown>

class WsClient {
  readonly frames: ClientFrame[] = []
  readonly closed: Promise<{ code: number }>
  closeInfo: { code: number } | undefined
  private readonly waiters: Array<{
    predicate: (frame: ClientFrame) => boolean
    after: number
    resolve: (frame: ClientFrame) => void
  }> = []
  private resolveClosed!: (value: { code: number }) => void

  constructor(readonly ws: WebSocket) {
    this.closed = new Promise(resolve => { this.resolveClosed = resolve })
    ws.on('message', data => {
      const frame = JSON.parse(data.toString()) as ClientFrame
      const index = this.frames.push(frame) - 1
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        const waiter = this.waiters[i]!
        if (index >= waiter.after && waiter.predicate(frame)) {
          this.waiters.splice(i, 1)
          waiter.resolve(frame)
        }
      }
    })
    ws.on('close', (code: number) => {
      this.closeInfo = { code }
      this.resolveClosed({ code })
    })
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame))
  }

  waitFor(predicate: (frame: ClientFrame) => boolean, after = 0): Promise<ClientFrame> {
    const index = this.frames.findIndex((frame, i) => i >= after && predicate(frame))
    if (index >= 0) return Promise.resolve(this.frames[index]!)
    return new Promise(resolve => this.waiters.push({ predicate, after, resolve }))
  }

  close(): void {
    this.ws.close()
  }
}

interface Harness {
  relay: PptRelay
  store: InMemoryPptRelayStore
  connect: (opts: { uid: string; role: Role; spaceMember?: boolean; expSeconds?: number }) => Promise<WsClient>
  close: () => Promise<void>
}

const harnesses: Harness[] = []

type SetupOptions = {
  roleProvider?: PptRelayDeps['roleProvider']
  accessProvider?: PptRelayDeps['accessProvider']
  epochProvider?: PptRelayDeps['epochProvider']
  limits?: Partial<RelayLimits>
}

async function setup(options: SetupOptions = {}): Promise<Harness> {
  const store = new InMemoryPptRelayStore()
  const relay = new PptRelay({
    store,
    epochProvider: options.epochProvider ?? (async () => 0),
    docStatusProvider: async () => 'live',
    ...(options.roleProvider ? { roleProvider: options.roleProvider } : {}),
    ...(options.accessProvider ? { accessProvider: options.accessProvider } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
  })
  const server: HttpServer = createServer()
  relay.attach(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const clients: WsClient[] = []
  const connect: Harness['connect'] = async opts => {
    const expSeconds = opts.expSeconds ?? Math.floor(Date.now() / 1000) + 3_600
    const ticket = jwt.sign({
      uid: opts.uid,
      docId: DOC,
      documentName: DOCNAME,
      role: opts.role,
      permission_epoch: 0,
      principal_space_id: SPACE,
      space_member: opts.spaceMember ?? false,
      home_space_verified: true,
      current_space_verified: true,
      jti: randomUUID(),
      exp: expSeconds,
    }, config.collabToken.secret, { algorithm: 'HS256', audience: PPT_RELAY_TICKET_AUD })
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ppt/collab`, ['ppt-relay', ticket])
    const client = new WsClient(ws)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    clients.push(client)
    return client
  }
  const harness: Harness = {
    relay,
    store,
    connect,
    close: () => new Promise<void>(resolve => {
      relay.close()
      for (const client of clients) {
        if (client.ws.readyState === WebSocket.OPEN) client.close()
      }
      server.close(() => resolve())
    }),
  }
  harnesses.push(harness)
  return harness
}

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.close()
  activeAccessMocks.getEpochsByDocIds.mockClear()
  setDriveDerivedAccess(originalDriveAccess)
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function sourceAccess(role: ResolvedRole, permissionEpoch: number, proofExpiresAt: number): CurrentAccess {
  return {
    role,
    permissionEpoch,
    sourceRevision: 'source-revision-1',
    proofExpiresAt,
    sourceConfirmed: true,
  }
}

function independentAccess(role: ResolvedRole): CurrentAccess {
  return { role, permissionEpoch: 0, sourceRevision: null, proofExpiresAt: null, sourceConfirmed: true }
}

interface OpsFrame {
  t: 'ops'
  pv: 2
  k: number
  frameId: string
  epoch: number
  ops: unknown[]
}

function opsFrame(k: number, frameId: string, epoch = 0): OpsFrame {
  return {
    t: 'ops',
    pv: 2,
    k,
    frameId,
    epoch,
    ops: [{ op: 'set', a: 'u-test', s: 1, l: 1, k: 'x', v: frameId }],
  }
}

async function helloReady(client: WsClient, since = 0): Promise<ClientFrame> {
  const ready = client.waitFor(frame => frame.ctl === 'ready')
  client.send({ t: 'hello', pv: 2, liveAuth: true, since })
  return ready
}

async function sendAndAck(client: WsClient, frame: OpsFrame): Promise<ClientFrame> {
  const start = client.frames.length
  const ack = client.waitFor(message => message.ctl === 'ack' && message.k === frame.k, start)
  client.send(frame)
  return ack
}


function turn(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

interface TestConn {
  uid: string
  roleEpoch: number
  outboundDepth: number
  liveBuffer: unknown[]
}

interface InternalRelay {
  rooms: Map<string, Set<TestConn>>
  deliver: (conn: TestConn, frame: unknown) => Promise<void>
  expireShareMembership: (conn: TestConn) => Promise<void>
}

function connectionFor(relay: PptRelay, uid: string): { internal: InternalRelay; conn: TestConn } {
  const internal = relay as unknown as InternalRelay
  const conn = [...internal.rooms.get(DOC)!].find(candidate => candidate.uid === uid)!
  return { internal, conn }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

describe('PPT relay source-authority races', () => {
  it('renews one nonrolling source proof for duplicate readers before resuming writer broadcasts', async () => {
    let now = 1_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const nonrollingReturned = deferred<void>()
    const freshProof = deferred<CurrentAccess>()
    let checksAfterDeadline = 0
    const h = await setup({
      roleProvider: async ({ uid }) => uid === 'u_direct_writer' ? 'writer' : 'reader',
      accessProvider: async ({ uid }) => {
        if (uid === 'u_direct_writer') return independentAccess('writer')
        if (now < 7_000) {
          if (now === 6_000) nonrollingReturned.resolve()
          return sourceAccess('reader', 0, 7_000)
        }
        checksAfterDeadline++
        return freshProof.promise
      },
    })
    const readers = [
      await h.connect({ uid: 'u_nonrolling_reader', role: 'reader' }),
      await h.connect({ uid: 'u_nonrolling_reader', role: 'reader' }),
    ]
    const writer = await h.connect({ uid: 'u_direct_writer', role: 'writer' })
    for (const reader of readers) await helloReady(reader)
    await helloReady(writer)
    try {
      now = 6_000
      invalidateActiveAccess(DOC, SPACE, 'u_nonrolling_reader')
      await nonrollingReturned.promise
      await turn()
      now = 7_001
      const starts = readers.map(reader => reader.frames.length)
      const outcomes = readers.map((reader, index) => Promise.race([
        reader.closed.then(({ code }) => ({ kind: 'closed' as const, code })),
        reader.waitFor(frame => frame.ctl === 'op' && frame.q === 1, starts[index])
          .then(frame => ({ kind: 'op' as const, frame })),
      ]))
      expect(await sendAndAck(writer, opsFrame(1, 'content-waits-for-nonrolling-renewal')))
        .toMatchObject({ ctl: 'ack', q: 1 })
      const leakedBeforeFreshProof = readers.some((reader, index) =>
        reader.frames.slice(starts[index]).some(frame => frame.ctl === 'op'))
      freshProof.resolve(sourceAccess('reader', 0, 22_000))
      for (const outcome of outcomes) expect(await outcome).toMatchObject({ kind: 'op', frame: { ctl: 'op', q: 1 } })
      expect(leakedBeforeFreshProof).toBe(false)
      expect(checksAfterDeadline).toBe(1)
      expect(readers.every(reader => reader.ws.readyState === WebSocket.OPEN)).toBe(true)
      expect(writer.ws.readyState).toBe(WebSocket.OPEN)
      expect(await h.store.currentSeq(DOC)).toBe(1)
    } finally {
      freshProof.resolve(sourceAccess('reader', 0, 22_000))
    }
  })

  it('keeps a newly independently authorized reader receiving writer broadcasts after an old source denial', async () => {
    let liveEpoch = 0
    const oldProof = sourceAccess('reader', 0, performance.now() + 60_000)
    const sourceStarted = deferred<void>()
    const sourceResult = deferred<CurrentAccess>()
    const sourceReturned = deferred<void>()
    let sourceReads = 0
    const h = await setup({
      epochProvider: async () => liveEpoch,
      roleProvider: async ({ uid }) => uid === 'u_direct_writer' ? 'writer' : liveEpoch === 1 ? 'reader' : 'none',
      accessProvider: async ({ uid }) => {
        if (uid === 'u_direct_writer') return independentAccess('writer')
        if (++sourceReads === 1) return oldProof
        sourceStarted.resolve()
        const result = await sourceResult.promise
        sourceReturned.resolve()
        return result
      },
    })
    const reader = await h.connect({ uid: 'u_new_direct_reader', role: 'reader' })
    const writer = await h.connect({ uid: 'u_direct_writer', role: 'writer' })
    await helloReady(reader)
    await helloReady(writer)

    try {
      invalidateActiveAccess(DOC, SPACE, 'u_new_direct_reader')
      await sourceStarted.promise
      // The old lookup has already read Docs ACL epoch 0, before the new direct grant.
      liveEpoch = 1
      const start = reader.frames.length
      await h.relay.applyEpochBump(DOCNAME)
      expect(await reader.waitFor(frame => frame.ctl === 'auth-updated' && frame.epoch === 1, start))
        .toMatchObject({ ctl: 'auth-updated', role: 'reader', epoch: 1 })
      sourceResult.resolve({ ...independentAccess('none'), permissionEpoch: 0 })
      await sourceReturned.promise
      await turn()

      const delivery = Promise.race([
        reader.closed.then(({ code }) => ({ kind: 'closed' as const, code })),
        reader.waitFor(frame => frame.ctl === 'op' && frame.q === 1, start)
          .then(frame => ({ kind: 'op' as const, frame })),
      ])
      expect(await sendAndAck(writer, opsFrame(1, 'content-after-independent-grant', 1)))
        .toMatchObject({ ctl: 'ack', q: 1 })
      expect(await delivery).toMatchObject({ kind: 'op', frame: { ctl: 'op', q: 1 } })
      expect(reader.closeInfo).toBeUndefined()
      expect(reader.ws.readyState).toBe(WebSocket.OPEN)
      expect(await h.store.currentSeq(DOC)).toBe(1)
    } finally {
      sourceResult.resolve({ ...independentAccess('none'), permissionEpoch: 0 })
    }
  })

  it('does not let an old source denial terminate a newer ticket reauthorization grace period', async () => {
    const sourceStarted = deferred<void>()
    const sourceResult = deferred<CurrentAccess>()
    const sourceReturned = deferred<void>()
    let reads = 0
    const h = await setup({
      limits: { authRefreshMs: 60_000, heartbeatIntervalMs: 60_000, reauthGraceMs: 200 },
      roleProvider: async () => 'none',
      accessProvider: async ({ spaceMember }) => {
        if (++reads === 1) return sourceAccess('writer', 0, performance.now() + 60_000)
        if (!spaceMember) return independentAccess('none')
        sourceStarted.resolve()
        const result = await sourceResult.promise
        sourceReturned.resolve()
        return result
      },
    })
    const expiry = Math.floor(Date.now() / 1000) + 3_600
    const share = await h.connect({ uid: 'u_ticket_pending', role: 'writer', spaceMember: true, expSeconds: expiry })
    await helloReady(share)
    const { internal, conn } = connectionFor(h.relay, 'u_ticket_pending')
    try {
      invalidateActiveAccess(DOC, SPACE, 'u_ticket_pending')
      await sourceStarted.promise
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      vi.setSystemTime(new Date(expiry * 1_000 + 1))
      await internal.expireShareMembership(conn)
      sourceResult.resolve(independentAccess('none'))
      await sourceReturned.promise
      for (let i = 0; i < 3; i++) await turn()
      expect(share.closeInfo).toBeUndefined()
      expect(share.ws.readyState).toBe(WebSocket.OPEN)
      const refused = share.waitFor(frame => frame.ctl === 'refused', share.frames.length)
      share.send(opsFrame(1, 'still-needs-new-ticket'))
      expect(await refused).toMatchObject({ ctl: 'refused' })
      expect(await h.store.currentSeq(DOC)).toBe(0)
      await vi.advanceTimersByTimeAsync(200)
      expect(await share.closed).toEqual({ code: 4403 })
    } finally {
      sourceResult.resolve(independentAccess('none'))
      vi.useRealTimers()
    }
  })

  it('closes an expired source reader before live delivery while an independent writer keeps writing', async () => {
    let now = 1_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const proof = sourceAccess('reader', 0, 61_000)
    const directWriter = independentAccess('writer')
    const h = await setup({
      roleProvider: async ({ uid }) => uid === 'u_direct_writer' ? 'writer' : 'none',
      accessProvider: async ({ uid }) => uid === 'u_source_reader' ? proof : directWriter,
    })
    const reader = await h.connect({ uid: 'u_source_reader', role: 'reader' })
    const writer = await h.connect({ uid: 'u_direct_writer', role: 'writer' })
    await helloReady(reader)
    await helloReady(writer)

    // Expire the monotonic source deadline without starting the 5-second monitor.
    now = 61_001
    const readerStart = reader.frames.length
    const delivery = Promise.race([
      reader.closed.then(({ code }) => ({ kind: 'closed' as const, code })),
      reader.waitFor(frame => frame.ctl === 'op', readerStart).then(frame => ({ kind: 'frame' as const, frame })),
    ])
    const firstWrite = sendAndAck(writer, opsFrame(1, 'writer-after-source-expiry'))
    const firstDelivery = await delivery
    const firstAck = await firstWrite
    const secondAck = await sendAndAck(writer, opsFrame(2, 'writer-still-authorized'))

    expect(firstDelivery).toEqual({ kind: 'closed', code: 4401 })
    expect(reader.frames.slice(readerStart).some(frame => frame.ctl === 'op')).toBe(false)
    expect(firstAck).toMatchObject({ ctl: 'ack', q: 1 })
    expect(secondAck).toMatchObject({ ctl: 'ack', q: 2 })
    expect(await h.store.currentSeq(DOC)).toBe(2)
    expect(writer.ws.readyState).toBe(WebSocket.OPEN)

  })
  it('checks the proof again when an already-started replay reaches its first send', async () => {
    let now = 1_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const proof = sourceAccess('reader', 0, 61_000)
    const h = await setup({
      roleProvider: async () => 'none',
      accessProvider: async () => proof,
    })
    const seed = opsFrame(1, 'replay-after-proof-expiry')
    await h.store.appendOp(DOC, seed.frameId, seed)
    const originalOpenReplay = h.store.openReplay.bind(h.store)
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const parked = new Promise<void>(resolve => { entered = resolve })
    vi.spyOn(h.store, 'openReplay').mockImplementationOnce(async (...args) => {
      entered()
      await gate
      return originalOpenReplay(...args)
    })

    const reader = await h.connect({ uid: 'u_replay_reader', role: 'reader' })
    const start = reader.frames.length
    const replayOutcome = Promise.race([
      reader.closed.then(({ code }) => ({ kind: 'closed' as const, code })),
      reader.waitFor(frame => frame.ctl === 'op' || frame.ctl === 'ready', start)
        .then(frame => ({ kind: 'frame' as const, frame })),
    ])
    reader.send({ t: 'hello', pv: 2, liveAuth: true, since: 0 })
    try {
      await parked
      now = 61_001
      release()
      const outcome = await replayOutcome
      expect(outcome).toEqual({ kind: 'closed', code: 4401 })
      expect(reader.frames.slice(start).some(frame => frame.ctl === 'op' || frame.ctl === 'ready')).toBe(false)
    } finally {
      release()
    }
  })


  it('keeps an expired membership socket frozen through a source notice and closes at the original grace deadline', async () => {

    const shareAccess = independentAccess('writer')
    const directWriter = independentAccess('writer')
    const h = await setup({
      limits: { authRefreshMs: 60_000, heartbeatIntervalMs: 60_000, reauthGraceMs: 200 },
      roleProvider: async ({ uid, spaceMember }) => uid === 'u_share_writer'
        ? spaceMember ? 'writer' : 'none'
        : 'writer',
      accessProvider: async ({ uid, spaceMember }) => uid === 'u_share_writer'
        ? spaceMember ? shareAccess : independentAccess('none')
        : directWriter,
    })
    const expiry = Math.floor(Date.now() / 1000) + 3_600
    const share = await h.connect({ uid: 'u_share_writer', role: 'writer', spaceMember: true, expSeconds: expiry })
    const writer = await h.connect({ uid: 'u_direct_writer', role: 'writer', expSeconds: expiry + 3_600 })
    await helloReady(share)
    await helloReady(writer)
    const { internal, conn } = connectionFor(h.relay, 'u_share_writer')

    try {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      vi.setSystemTime(new Date(expiry * 1_000 + 1))
      await internal.expireShareMembership(conn)
      const initialRefusal = await (async () => {
        const start = share.frames.length
        const outcome = share.waitFor(frame => frame.ctl === 'refused' || (frame.ctl === 'ack' && frame.k === 1), start)
        share.send(opsFrame(1, 'write-during-ticket-grace'))
        return outcome
      })()
      expect(initialRefusal.ctl).toBe('refused')

      const shareStart = share.frames.length
      expect(await sendAndAck(writer, opsFrame(1, 'peer-content-during-grace'))).toMatchObject({ ctl: 'ack', q: 1 })
      await turn()
      expect(share.frames.slice(shareStart).some(frame => frame.ctl === 'op')).toBe(false)

      await vi.advanceTimersByTimeAsync(100)

      invalidateActiveAccess(DOC, SPACE, 'u_share_writer')
      await turn()

      const writeStart = share.frames.length
      const writeOutcome = share.waitFor(frame => frame.ctl === 'refused' || (frame.ctl === 'ack' && frame.k === 2), writeStart)
      share.send(opsFrame(2, 'write-after-stale-source-notice'))
      const afterNotice = await writeOutcome
      await turn()
      expect(afterNotice.ctl).toBe('refused')
      expect(share.frames.slice(shareStart).some(frame => frame.ctl === 'op')).toBe(false)
      expect(await h.store.currentSeq(DOC)).toBe(1)

      await vi.advanceTimersByTimeAsync(100)
      expect(await share.closed).toEqual({ code: 4403 })
      expect(writer.ws.readyState).toBe(WebSocket.OPEN)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not deliver buffered content when an old source lookup completes during an epoch authority wait', async () => {
    let liveEpoch = 0
    const proof = sourceAccess('reader', 0, performance.now() + 60_000)
    let sourceCheckStarted!: () => void
    let releaseSourceCheck!: () => void
    let sourceCheckReturned!: () => void
    let authorityCheckStarted!: () => void
    let releaseAuthorityCheck!: () => void
    const sourceStarted = new Promise<void>(resolve => { sourceCheckStarted = resolve })
    const sourceGate = new Promise<void>(resolve => { releaseSourceCheck = resolve })
    const sourceReturned = new Promise<void>(resolve => { sourceCheckReturned = resolve })
    const authorityStarted = new Promise<void>(resolve => { authorityCheckStarted = resolve })
    const authorityGate = new Promise<void>(resolve => { releaseAuthorityCheck = resolve })
    let sourceCalls = 0
    let pauseAuthority = false
    const h = await setup({
      epochProvider: async () => liveEpoch,
      roleProvider: async () => {
        if (pauseAuthority) {
          authorityCheckStarted()
          await authorityGate
          pauseAuthority = false
        }
        return 'reader'
      },
      accessProvider: async () => {
        sourceCalls++
        if (sourceCalls === 2) {
          sourceCheckStarted()
          await sourceGate
          sourceCheckReturned()
        }
        return proof
      },
    })
    const reader = await h.connect({ uid: 'u_epoch_reader', role: 'reader' })
    await helloReady(reader)
    const start = reader.frames.length
    const { internal, conn } = connectionFor(h.relay, 'u_epoch_reader')
    let bump: Promise<void> | undefined

    try {
      invalidateActiveAccess(DOC, SPACE, 'u_epoch_reader')
      await sourceStarted
      liveEpoch = 1
      pauseAuthority = true
      bump = h.relay.applyEpochBump(DOCNAME)
      await authorityStarted

      const content = opsFrame(1, 'content-during-epoch-authority-wait')
      const { seq } = await h.store.appendOp(DOC, content.frameId, content)
      await internal.deliver(conn, { ctl: 'op', q: seq, frame: content })
      releaseSourceCheck()
      await sourceReturned
      await turn()

      releaseAuthorityCheck()
      await bump
      const authority = await reader.waitFor(frame => frame.ctl === 'auth-updated' && frame.epoch === 1, start)
      const delivered = await reader.waitFor(frame => frame.ctl === 'op' && frame.q === 1, start)
      expect(authority).toMatchObject({ ctl: 'auth-updated', epoch: 1 })
      expect(reader.frames.indexOf(authority)).toBeLessThan(reader.frames.indexOf(delivered))
    } finally {
      releaseSourceCheck()
      releaseAuthorityCheck()
      if (bump) await bump
    }
  })

  it('does not let a source result that predates an epoch bump roll the live role epoch back', async () => {
    let liveEpoch = 0
    const proof = sourceAccess('reader', 0, performance.now() + 60_000)
    let sourceCheckStarted!: () => void
    let releaseSourceCheck!: () => void
    let sourceCheckReturned!: () => void
    const sourceStarted = new Promise<void>(resolve => { sourceCheckStarted = resolve })
    const sourceGate = new Promise<void>(resolve => { releaseSourceCheck = resolve })
    const sourceReturned = new Promise<void>(resolve => { sourceCheckReturned = resolve })
    let sourceCalls = 0
    const h = await setup({
      epochProvider: async () => liveEpoch,
      roleProvider: async () => 'reader',
      accessProvider: async () => {
        sourceCalls++
        if (sourceCalls === 2) {
          sourceCheckStarted()
          await sourceGate
          sourceCheckReturned()
        }
        return proof
      },
    })
    const reader = await h.connect({ uid: 'u_epoch_reader_after', role: 'reader' })
    await helloReady(reader)
    const start = reader.frames.length
    const { conn } = connectionFor(h.relay, 'u_epoch_reader_after')

    try {
      invalidateActiveAccess(DOC, SPACE, 'u_epoch_reader_after')
      await sourceStarted
      liveEpoch = 1
      await h.relay.applyEpochBump(DOCNAME)
      expect(await reader.waitFor(frame => frame.ctl === 'auth-updated' && frame.epoch === 1, start))
        .toMatchObject({ ctl: 'auth-updated', epoch: 1 })

      releaseSourceCheck()
      await sourceReturned
      await turn()
      const roleEpochPreserved = conn.roleEpoch === 1

      const nextReady = reader.waitFor(frame => frame.ctl === 'ready' && frame.epoch === 1, reader.frames.length)
      reader.send({ t: 'hello', pv: 2, liveAuth: true, since: 0 })
      expect(await nextReady).toMatchObject({ ctl: 'ready', epoch: 1, role: 'reader' })
      expect(roleEpochPreserved).toBe(true)
    } finally {
      releaseSourceCheck()
    }
  })

  it('does not restore share-writer authority from a lapsed ticket claim after the direct grant is withdrawn', async () => {
    let direct: ResolvedRole = 'writer'
    let liveEpoch = 0
    const h = await setup({
      epochProvider: async () => liveEpoch,
      roleProvider: async () => direct,
      // Mirrors the production seam: the direct doc grant plus the space-share
      // setting. Only the CURRENT membership proof may open the share-derived role.
      accessProvider: async ({ spaceMember }) => ({
        role: effectiveRole(direct, spaceMember, SHARE_SCOPE_ANYONE, SHARE_ROLE_EDIT),
        permissionEpoch: 0,
        sourceRevision: null,
        proofExpiresAt: null,
        sourceConfirmed: true,
      }),
    })
    const expiry = Math.floor(Date.now() / 1000) + 3_600
    const share = await h.connect({
      uid: 'u_lapsed_share_writer', role: 'writer', spaceMember: true, expSeconds: expiry,
    })
    await helloReady(share)
    const { internal, conn } = connectionFor(h.relay, 'u_lapsed_share_writer')
    expect(await sendAndAck(share, opsFrame(1, 'direct-writer-before-membership-expiry')))
      .toMatchObject({ ctl: 'ack', q: 1 })
    expect(await h.store.currentSeq(DOC)).toBe(1)

    // The direct grant still covers the socket, so the expiry path drops the
    // stale membership claim instead of closing it.
    await internal.expireShareMembership(conn)
    direct = 'none'
    liveEpoch = 1
    // Direct Docs permission changes are carried by the Docs epoch. The relay
    // re-resolves the independent grant rather than relying on an expired share
    // claim or treating a Drive-source notice as a direct-grant invalidation.
    const epochBump = h.relay.applyEpochBump(DOCNAME)
    const start = share.frames.length
    const outcome = Promise.race([
      share.closed.then(({ code }) => ({ kind: 'closed' as const, code })),
      share.waitFor(frame => frame.ctl === 'ack' && frame.k === 2, start)
        .then(() => ({ kind: 'ack' as const })),
    ])
    share.send(opsFrame(2, 'write-after-direct-grant-withdrawn'))
    expect(await outcome).toEqual({ kind: 'closed', code: 4403 })
    await epochBump
    expect(await h.store.currentSeq(DOC)).toBe(1)
  })
  it('registers Drive proof after share expiry so a lost notice is found by the shared source probe', async () => {
    let now = 1_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const revisionA = `sha256:${'a'.repeat(64)}`
    let driveRevision = revisionA
    let sourceRevoked = false
    let firstExpiredResolution = true
    const expiredProof = deferred<CurrentAccess>()
    const proofExpiresAt = 61_000
    setDriveDerivedAccess({
      derivedAccess: async () => null,
      versions: async bindings => bindings.map(binding => ({
        ...binding,
        sourceRevision: driveRevision,
        validForMs: 60_000,
        expiresAt: now + 60_000,
      })),
    } satisfies DriveDerivedAccess)

    const sourceAccessFor = (role: ResolvedRole, sourceRevision: string): CurrentAccess => ({
      role,
      permissionEpoch: 0,
      sourceRevision,
      proofExpiresAt,
      sourceConfirmed: true,
    })
    const h = await setup({
      roleProvider: async ({ uid }) => uid === 'u_share_reader' ? 'reader' : 'writer',
      accessProvider: async ({ uid, spaceMember }) => {
        if (uid !== 'u_share_reader') return independentAccess('writer')
        if (spaceMember) return independentAccess('reader')
        if (firstExpiredResolution) {
          firstExpiredResolution = false
          return expiredProof.promise
        }
        return sourceRevoked ? sourceAccessFor('none', driveRevision) : sourceAccessFor('reader', driveRevision)
      },
    })
    const expiry = Math.floor(Date.now() / 1_000) + 3_600
    const reader = await h.connect({ uid: 'u_share_reader', role: 'reader', spaceMember: true, expSeconds: expiry })
    const writer = await h.connect({ uid: 'u_independent_writer', role: 'writer', expSeconds: expiry + 3_600 })
    await helloReady(reader)
    await helloReady(writer)
    const { internal, conn } = connectionFor(h.relay, 'u_share_reader')

    let expiryCheck: Promise<void> | undefined
    try {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      vi.setSystemTime(new Date(expiry * 1_000 + 1))
      expiryCheck = internal.expireShareMembership(conn)
      await turn()

      const pendingFrameStart = reader.frames.length
      expect(await sendAndAck(writer, opsFrame(1, 'drive-reader-after-membership-expiry')))
        .toMatchObject({ ctl: 'ack', q: 1 })
      await turn()
      expect(reader.frames.slice(pendingFrameStart).some(frame => frame.ctl === 'op')).toBe(false)

      expiredProof.resolve(sourceAccessFor('reader', revisionA))
      await expiryCheck
      expect(await reader.waitFor(frame => frame.ctl === 'op' && frame.q === 1))
        .toMatchObject({ ctl: 'op', q: 1 })

      // The Server→Docs notice is dropped. A changed Drive source revision is
      // discovered by the ordinary aggregate probe; the complete resolver then
      // confirms the last read source is gone and the socket must stop receiving.
      driveRevision = `sha256:${'b'.repeat(64)}`
      sourceRevoked = true
      await pollActiveAccess()
      await vi.waitFor(() => expect(reader.closeInfo?.code).toBe(4403))

      const start = reader.frames.length
      expect(await sendAndAck(writer, opsFrame(2, 'writer-after-source-revocation')))
        .toMatchObject({ ctl: 'ack', q: 2 })
      await turn()
      expect(reader.frames.slice(start).some(frame => frame.ctl === 'op')).toBe(false)
      expect(writer.ws.readyState).toBe(WebSocket.OPEN)
    } finally {
      expiredProof.resolve(sourceAccessFor('reader', revisionA))
      await expiryCheck
      now = 1_000
    }

  })
  it('keeps each same-UID PPT connection on its own share proof after one ticket expires and its replacement disconnects', async () => {
    let now = 1_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const revisionA = `sha256:${'c'.repeat(64)}`
    let driveRevision = revisionA
    let sourceRevoked = false
    let holdShareRecheck = false
    let holdDriveRecheck = false
    const shareRecheckStarted = deferred<void>()
    const staleShareRecheck = deferred<CurrentAccess>()
    const driveRecheckStarted = deferred<void>()
    const directDriveRecheck = deferred<CurrentAccess>()
    const proofExpiresAt = 61_000
    setDriveDerivedAccess({
      derivedAccess: async () => null,
      versions: async bindings => bindings.map(binding => ({
        ...binding,
        sourceRevision: driveRevision,
        validForMs: 60_000,
        expiresAt: now + 60_000,
      })),
    } satisfies DriveDerivedAccess)
    const h = await setup({
      accessProvider: async ({ uid, spaceMember }) => {
        if (uid === 'u_connection_scoped_share' && spaceMember) {
          if (holdShareRecheck) {
            shareRecheckStarted.resolve(undefined)
            return staleShareRecheck.promise
          }
          return {
            role: 'writer',
            permissionEpoch: 0,
            sourceRevision: driveRevision,
            proofExpiresAt,
            sourceConfirmed: true,
          }
        }
        if (uid === 'u_connection_scoped_share') {
          if (holdDriveRecheck) {
            driveRecheckStarted.resolve(undefined)
            return directDriveRecheck.promise
          }
          return {
            role: sourceRevoked ? 'none' : 'reader',
            permissionEpoch: 0,
            sourceRevision: driveRevision,
            proofExpiresAt,
            sourceConfirmed: true,
          }
        }
        return independentAccess('writer')
      },
    })
    const expiry = Math.floor(Date.now() / 1_000) + 3_600
    const expiredReader = await h.connect({
      uid: 'u_connection_scoped_share', role: 'writer', spaceMember: true, expSeconds: expiry,
    })
    const directWriter = await h.connect({
      uid: 'u_connection_scope_writer', role: 'writer', expSeconds: expiry + 3_600,
    })
    await helloReady(expiredReader)
    await helloReady(directWriter)
    const { internal, conn } = connectionFor(h.relay, 'u_connection_scoped_share')

    try {
      holdShareRecheck = true
      invalidateActiveAccess(DOC, SPACE, 'u_connection_scoped_share')
      await shareRecheckStarted.promise
      holdShareRecheck = false

      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      vi.setSystemTime(new Date(expiry * 1_000 + 1))
      holdDriveRecheck = true
      const expiryRecheck = internal.expireShareMembership(conn)
      await driveRecheckStarted.promise

      staleShareRecheck.resolve(independentAccess('writer'))
      await staleShareRecheck.promise
      const frozenStart = expiredReader.frames.length
      expect(await sendAndAck(directWriter, opsFrame(1, 'blocked-during-expiry-recheck')))
        .toMatchObject({ ctl: 'ack', q: 1 })
      await turn()
      expect(expiredReader.frames.slice(frozenStart).some(frame => frame.ctl === 'op')).toBe(false)

      holdDriveRecheck = false
      directDriveRecheck.resolve({
        role: 'reader',
        permissionEpoch: 0,
        sourceRevision: driveRevision,
        proofExpiresAt,
        sourceConfirmed: true,
      })
      await expiryRecheck

      const readyAfterExpiry = expiredReader.waitFor(
        frame => frame.ctl === 'ready',
        expiredReader.frames.length,
      )
      expiredReader.send({ t: 'hello', pv: 2, liveAuth: true, since: 0 })
      expect(await readyAfterExpiry).toMatchObject({ ctl: 'ready', role: 'reader' })

      const renewedShare = await h.connect({
        uid: 'u_connection_scoped_share', role: 'writer', spaceMember: true,
        expSeconds: expiry + 3_600,
      })
      await helloReady(renewedShare)
      expect(await sendAndAck(renewedShare, opsFrame(2, 'fresh-share-proof-before-disconnect')))
        .toMatchObject({ ctl: 'ack', q: 2 })
      expect(await expiredReader.waitFor(frame => frame.ctl === 'op' && frame.q === 2))
        .toMatchObject({ ctl: 'op', q: 2 })
      renewedShare.close()
      await renewedShare.closed
      expect(renewedShare.ws.readyState).toBe(WebSocket.CLOSED)

      expect(await sendAndAck(directWriter, opsFrame(3, 'drive-reader-remains-authorized')))
        .toMatchObject({ ctl: 'ack', q: 3 })
      expect(await expiredReader.waitFor(frame => frame.ctl === 'op' && frame.q === 3))
        .toMatchObject({ ctl: 'op', q: 3 })
      const readerWriteStart = expiredReader.frames.length
      expiredReader.send(opsFrame(30, 'expired-share-reader-cannot-write'))
      expect(await expiredReader.waitFor(frame => frame.ctl === 'refused', readerWriteStart))
        .toMatchObject({ ctl: 'refused', code: 'forbidden-role' })

      sourceRevoked = true
      driveRevision = `sha256:${'d'.repeat(64)}`
      await pollActiveAccess()
      await vi.waitFor(() => expect(expiredReader.closeInfo?.code).toBe(4403))

      const start = expiredReader.frames.length
      expect(await sendAndAck(directWriter, opsFrame(4, 'no-frame-after-final-source-revocation')))
        .toMatchObject({ ctl: 'ack', q: 4 })
      await turn()
      expect(expiredReader.frames.slice(start).some(frame => frame.ctl === 'op')).toBe(false)
      expect(directWriter.ws.readyState).toBe(WebSocket.OPEN)
    } finally {
      vi.useRealTimers()
      now = 1_000
    }
  })
  it('keeps source tracking through repeated epoch wins while share-expiry lookup is pending', async () => {
    let liveEpoch = 0
    let driveRevision = `sha256:${'a'.repeat(64)}`
    let driveRevoked = false
    let directChecks = 0
    let epochRechecks = 0
    let revocationCheckStarted = false
    const directCheckStarted = deferred<void>()
    const directCheck = deferred<CurrentAccess>()
    const revokedCheckStarted = deferred<void>()
    const revokedCheck = deferred<CurrentAccess>()
    const epochCheckStarted = [deferred<void>(), deferred<void>()]
    const epochCheck = [deferred<ResolvedRole>(), deferred<ResolvedRole>()]
    const proofExpiresAt = performance.now() + 60_000
    setDriveDerivedAccess({
      derivedAccess: async () => null,
      versions: async bindings => bindings.map(binding => ({
        ...binding,
        sourceRevision: driveRevision,
        validForMs: 60_000,
        expiresAt: performance.now() + 60_000,
      })),
    })
    const h = await setup({
      epochProvider: async () => liveEpoch,
      roleProvider: async ({ uid, spaceMember }) => {
        if (uid !== 'u_epoch_handoff') return 'writer'
        if (spaceMember) return 'writer'
        if (epochRechecks < epochCheck.length) {
          const index = epochRechecks++
          epochCheckStarted[index]!.resolve()
          return epochCheck[index]!.promise
        }
        return 'reader'
      },
      accessProvider: async ({ uid, spaceMember }) => {
        if (uid !== 'u_epoch_handoff') return independentAccess('writer')
        if (spaceMember) return independentAccess('writer')
        directChecks++
        directCheckStarted.resolve()
        if (!driveRevoked) return directCheck.promise
        revocationCheckStarted = true
        revokedCheckStarted.resolve()
        return revokedCheck.promise
      },
    })
    const expiry = Math.floor(Date.now() / 1_000) + 3_600
    const reader = await h.connect({
      uid: 'u_epoch_handoff', role: 'writer', spaceMember: true, expSeconds: expiry,
    })
    const writer = await h.connect({
      uid: 'u_handoff_writer', role: 'writer', expSeconds: expiry + 3_600,
    })
    await helloReady(reader)
    await helloReady(writer)
    const { internal, conn } = connectionFor(h.relay, 'u_epoch_handoff')
    const liveConn = conn as TestConn & { auth: { pendingReauth?: boolean } }
    let firstBump: Promise<void> | undefined
    let secondBump: Promise<void> | undefined
    let sourcePoll: Promise<void> | undefined
    try {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      vi.setSystemTime(new Date(expiry * 1_000 + 1))
      const expiryCheck = internal.expireShareMembership(conn)
      await directCheckStarted.promise

      liveEpoch = 1
      firstBump = h.relay.applyEpochBump(DOCNAME)
      await epochCheckStarted[0]!.promise
      liveEpoch = 2
      secondBump = h.relay.applyEpochBump(DOCNAME)
      await epochCheckStarted[1]!.promise

      directCheck.resolve({
        role: 'reader',
        permissionEpoch: 2,
        sourceRevision: driveRevision,
        proofExpiresAt,
        sourceConfirmed: true,
      })
      await expiryCheck
      expect(directChecks).toBe(1)
      expect(liveConn.auth.pendingReauth).toBe(true)

      epochCheck[0]!.resolve('reader')
      await firstBump
      epochCheck[1]!.resolve('reader')
      await secondBump
      expect(conn.roleEpoch).toBe(2)
      expect(liveConn.auth.pendingReauth).not.toBe(true)

      const beforeRevocation = reader.frames.length
      expect(await sendAndAck(writer, opsFrame(1, 'writer-after-repeated-epoch-handoff', 2)))
        .toMatchObject({ ctl: 'ack', q: 1 })
      expect(await reader.waitFor(frame => frame.ctl === 'op' && frame.q === 1, beforeRevocation))
        .toMatchObject({ ctl: 'op', q: 1 })

      driveRevoked = true
      driveRevision = `sha256:${'b'.repeat(64)}`
      sourcePoll = pollActiveAccess()
      await vi.waitFor(() => expect(revocationCheckStarted).toBe(true))
      const beforeSourceClose = reader.frames.length
      expect(await sendAndAck(writer, opsFrame(2, 'source-check-freezes-reader-before-revocation-confirmation', 2)))
        .toMatchObject({ ctl: 'ack', q: 2 })
      await turn()
      expect(reader.frames.slice(beforeSourceClose).some(frame => frame.ctl === 'op')).toBe(false)
      revokedCheck.resolve({
        role: 'none',
        permissionEpoch: liveEpoch,
        sourceRevision: driveRevision,
        proofExpiresAt,
        sourceConfirmed: true,
      })
      await sourcePoll
      await vi.waitFor(() => expect(reader.closeInfo?.code).toBe(4403))

      const afterRevocation = reader.frames.length
      expect(await sendAndAck(writer, opsFrame(3, 'no-frame-after-repeated-epoch-revocation', 2)))
        .toMatchObject({ ctl: 'ack', q: 3 })
      await turn()
      expect(reader.frames.slice(afterRevocation).some(frame => frame.ctl === 'op')).toBe(false)
    } finally {
      directCheck.resolve({
        role: driveRevoked ? 'none' : 'reader',
        permissionEpoch: liveEpoch,
        sourceRevision: driveRevision,
        proofExpiresAt,
        sourceConfirmed: true,
      })
      revokedCheck.resolve({
        role: 'none',
        permissionEpoch: liveEpoch,
        sourceRevision: driveRevision,
        proofExpiresAt,
        sourceConfirmed: true,
      })
      epochCheck[0]!.resolve('reader')
      epochCheck[1]!.resolve('reader')
      if (sourcePoll) await sourcePoll
      await firstBump
      await secondBump
    }
  })
  it('does not let an older epoch proof replace the newer epoch Drive proof', async () => {
    let liveEpoch = 0
    let driveRevision = `sha256:${'a'.repeat(64)}`
    let directReads = 0
    const expiryAccessStarted = deferred<void>()
    const expiryAccess = deferred<CurrentAccess>()
    const oldEpochAccessStarted = deferred<void>()
    const oldEpochAccess = deferred<CurrentAccess>()
    const currentEpochAccessStarted = deferred<void>()
    const currentEpochAccess = deferred<CurrentAccess>()
    const revokedAccessStarted = deferred<void>()
    const revokedAccess = deferred<CurrentAccess>()
    const proofExpiresAt = performance.now() + 60_000
    const proof = (role: ResolvedRole, permissionEpoch: number, sourceRevision: string): CurrentAccess => ({
      role,
      permissionEpoch,
      sourceRevision,
      proofExpiresAt,
      sourceConfirmed: true,
    })
    setDriveDerivedAccess({
      derivedAccess: async () => null,
      versions: async bindings => bindings.map(binding => ({
        ...binding,
        sourceRevision: driveRevision,
        validForMs: 60_000,
        expiresAt: performance.now() + 60_000,
      })),
    })
    const initialAccess = independentAccess('writer')
    const h = await setup({
      epochProvider: async () => liveEpoch,
      roleProvider: async ({ uid, spaceMember }) =>
        uid === 'u_epoch_proof_handoff' && !spaceMember ? 'reader' : 'writer',
      accessProvider: async ({ uid, spaceMember }) => {
        if (uid !== 'u_epoch_proof_handoff' || spaceMember) return independentAccess('writer')
        switch (++directReads) {
          case 1:
            expiryAccessStarted.resolve()
            return expiryAccess.promise
          case 2:
            oldEpochAccessStarted.resolve()
            return oldEpochAccess.promise
          case 3:
            currentEpochAccessStarted.resolve()
            return currentEpochAccess.promise
          default:
            revokedAccessStarted.resolve()
            return revokedAccess.promise
        }
      },
    })
    const expiry = Math.floor(Date.now() / 1_000) + 3_600
    const reader = await h.connect({
      uid: 'u_epoch_proof_handoff', role: 'writer', spaceMember: true, expSeconds: expiry,
    })
    const writer = await h.connect({
      uid: 'u_epoch_proof_writer', role: 'writer', expSeconds: expiry + 3_600,
    })
    await helloReady(reader)
    await helloReady(writer)
    const { internal, conn } = connectionFor(h.relay, 'u_epoch_proof_handoff')
    const liveConn = conn as TestConn & {
      auth: { pendingReauth?: boolean }
      sourceAccess?: CurrentAccess
      shareExpiryGeneration?: number
      reauthGeneration: number
    }
    let expiryCheck: Promise<void> | undefined
    let oldBump: Promise<void> | undefined
    let currentBump: Promise<void> | undefined
    try {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      vi.setSystemTime(new Date(expiry * 1_000 + 1))
      expiryCheck = internal.expireShareMembership(conn)
      await expiryAccessStarted.promise

      liveEpoch = 1
      oldBump = h.relay.applyEpochBump(DOCNAME)
      await oldEpochAccessStarted.promise
      expiryAccess.resolve(proof('reader', 1, driveRevision))
      await expiryCheck

      liveEpoch = 2
      currentBump = h.relay.applyEpochBump(DOCNAME)
      await currentEpochAccessStarted.promise
      const sourceBeforeOldResult = liveConn.sourceAccess
      oldEpochAccess.resolve(proof('reader', 1, driveRevision))
      await oldBump
      expect(liveConn.auth.pendingReauth).toBe(true)
      expect(liveConn.sourceAccess).toBe(sourceBeforeOldResult)
      expect(liveConn.shareExpiryGeneration).toBe(liveConn.reauthGeneration)

      const beforeCurrentProof = reader.frames.length
      expect(await sendAndAck(writer, opsFrame(1, 'epoch-proof-stays-pending', 2)))
        .toMatchObject({ ctl: 'ack', q: 1 })
      await turn()
      expect(reader.frames.slice(beforeCurrentProof).some(frame => frame.ctl === 'op')).toBe(false)

      const currentRevision = `sha256:${'b'.repeat(64)}`
      driveRevision = currentRevision
      currentEpochAccess.resolve(proof('reader', 2, currentRevision))
      await currentBump
      expect(liveConn.roleEpoch).toBe(2)
      expect(liveConn.sourceAccess).toMatchObject({ role: 'reader', sourceRevision: currentRevision })
      expect(liveConn.auth.pendingReauth).not.toBe(true)
      expect(liveConn.shareExpiryGeneration).toBeUndefined()
      expect(await reader.waitFor(frame => frame.ctl === 'op' && frame.q === 1, beforeCurrentProof))
        .toMatchObject({ ctl: 'op', q: 1 })

      driveRevision = `sha256:${'c'.repeat(64)}`
      invalidateActiveAccess(DOC, SPACE, 'u_epoch_proof_handoff')
      await revokedAccessStarted.promise
      const beforeRevocation = reader.frames.length
      expect(await sendAndAck(writer, opsFrame(2, 'latest-source-proof-is-tracked', 2)))
        .toMatchObject({ ctl: 'ack', q: 2 })
      await turn()
      expect(reader.frames.slice(beforeRevocation).some(frame => frame.ctl === 'op')).toBe(false)
      revokedAccess.resolve(proof('none', 2, driveRevision))
      await vi.waitFor(() => expect(reader.closeInfo?.code).toBe(4403))
    } finally {
      expiryAccess.resolve(proof('reader', 1, driveRevision))
      oldEpochAccess.resolve(proof('reader', 1, driveRevision))
      currentEpochAccess.resolve(proof('reader', 2, driveRevision))
      revokedAccess.resolve(proof('none', 2, driveRevision))
      await expiryCheck
      await oldBump
      await currentBump
    }
  })
  it('does not let a stale share-expiry proof clear a newer epoch freeze', async () => {
    let liveEpoch = 0
    let directReads = 0
    const driveRevision = `sha256:${'a'.repeat(64)}`
    const proofExpiresAt = performance.now() + 60_000
    const expiryAccessStarted = deferred<void>()
    const expiryAccess = deferred<CurrentAccess>()
    const epochTwoRoleStarted = deferred<void>()
    const epochTwoRole = deferred<ResolvedRole>()
    const proof = (permissionEpoch: number): CurrentAccess => ({
      role: 'reader',
      permissionEpoch,
      sourceRevision: driveRevision,
      proofExpiresAt,
      sourceConfirmed: true,
    })
    setDriveDerivedAccess({
      derivedAccess: async () => null,
      versions: async bindings => bindings.map(binding => ({
        ...binding,
        sourceRevision: driveRevision,
        validForMs: 60_000,
        expiresAt: performance.now() + 60_000,
      })),
    })
    const h = await setup({
      epochProvider: async () => liveEpoch,
      roleProvider: async ({ uid, spaceMember }) => {
        if (uid !== 'u_stale_expiry_epoch_owner') return 'writer'
        if (spaceMember) return 'writer'
        if (liveEpoch === 2) {
          epochTwoRoleStarted.resolve()
          return epochTwoRole.promise
        }
        return 'reader'
      },
      accessProvider: async ({ uid, spaceMember }) => {
        if (uid !== 'u_stale_expiry_epoch_owner' || spaceMember) return independentAccess('writer')
        if (++directReads === 1) {
          expiryAccessStarted.resolve()
          return expiryAccess.promise
        }
        return proof(1)
      },
    })
    const expiry = Math.floor(Date.now() / 1_000) + 3_600
    const reader = await h.connect({
      uid: 'u_stale_expiry_epoch_owner',
      role: 'writer',
      spaceMember: true,
      expSeconds: expiry,
    })
    const writer = await h.connect({
      uid: 'u_stale_expiry_writer',
      role: 'writer',
      expSeconds: expiry + 3_600,
    })
    await helloReady(reader)
    await helloReady(writer)
    const { internal, conn } = connectionFor(h.relay, 'u_stale_expiry_epoch_owner')
    const liveConn = conn as TestConn & {
      auth: { pendingReauth?: boolean; readAllowed: boolean }
      epochGeneration: number
      epochResolvedGeneration: number
    }
    let expiryCheck: Promise<void> | undefined
    let firstBump: Promise<void> | undefined
    let secondBump: Promise<void> | undefined
    try {
      expiryCheck = internal.expireShareMembership(conn)
      await expiryAccessStarted.promise

      liveEpoch = 1
      firstBump = h.relay.applyEpochBump(DOCNAME)
      await firstBump
      expect(liveConn.epochGeneration).toBe(1)
      expect(liveConn.epochResolvedGeneration).toBe(1)
      expect(liveConn.auth.pendingReauth).not.toBe(true)

      liveEpoch = 2
      secondBump = h.relay.applyEpochBump(DOCNAME)
      await epochTwoRoleStarted.promise
      expect(liveConn.epochGeneration).toBe(2)
      expect(liveConn.epochResolvedGeneration).toBe(1)
      expect(liveConn.auth.pendingReauth).toBe(true)

      const beforeOldExpiryProof = reader.frames.length
      expiryAccess.resolve(proof(1))
      await expiryCheck
      expect(liveConn.auth.pendingReauth).toBe(true)
      expect(liveConn.auth.readAllowed).toBe(false)

      expect(await sendAndAck(writer, opsFrame(1, 'new-epoch-freeze-stays-private', 2)))
        .toMatchObject({ ctl: 'ack', q: 1 })
      await turn()
      expect(reader.frames.slice(beforeOldExpiryProof).some(frame => frame.ctl === 'op')).toBe(false)

      epochTwoRole.resolve('none')
      await secondBump
      await vi.waitFor(() => expect(reader.closeInfo?.code).toBe(4403))
    } finally {
      expiryAccess.resolve(proof(1))
      epochTwoRole.resolve('none')
      await expiryCheck
      await firstBump
      await secondBump
    }
  })
  it('does not let an epoch recheck reopen a source-revoked reader during share expiry', async () => {
    let liveEpoch = 0
    let driveRevision = `sha256:${'a'.repeat(64)}`
    let driveRevoked = false
    const directCheckStarted = deferred<void>()
    const directCheck = deferred<CurrentAccess>()
    const epochCheckStarted = deferred<void>()
    const epochCheck = deferred<ResolvedRole>()
    const revokedCheckStarted = deferred<void>()
    const revokedCheck = deferred<CurrentAccess>()
    const proofExpiresAt = performance.now() + 60_000
    setDriveDerivedAccess({
      derivedAccess: async () => null,
      versions: async bindings => bindings.map(binding => ({
        ...binding,
        sourceRevision: driveRevision,
        validForMs: 60_000,
        expiresAt: performance.now() + 60_000,
      })),
    })
    const h = await setup({
      epochProvider: async () => liveEpoch,
      roleProvider: async ({ uid, spaceMember }) => {
        if (uid !== 'u_epoch_source_close') return 'writer'
        if (spaceMember) return 'writer'
        epochCheckStarted.resolve()
        return epochCheck.promise
      },
      accessProvider: async ({ uid, spaceMember }) => {
        if (uid !== 'u_epoch_source_close') return independentAccess('writer')
        if (spaceMember) return independentAccess('writer')
        directCheckStarted.resolve()
        if (!driveRevoked) return directCheck.promise
        revokedCheckStarted.resolve()
        return revokedCheck.promise
      },
    })
    const expiry = Math.floor(Date.now() / 1_000) + 3_600
    const reader = await h.connect({
      uid: 'u_epoch_source_close', role: 'writer', spaceMember: true, expSeconds: expiry,
    })
    const writer = await h.connect({
      uid: 'u_epoch_source_close_writer', role: 'writer', expSeconds: expiry + 3_600,
    })
    await helloReady(reader)
    await helloReady(writer)
    const { internal, conn } = connectionFor(h.relay, 'u_epoch_source_close')

    let expiryCheck: Promise<void> | undefined
    let epochBump: Promise<void> | undefined
    try {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      vi.setSystemTime(new Date(expiry * 1_000 + 1))
      expiryCheck = internal.expireShareMembership(conn)
      await directCheckStarted.promise

      liveEpoch = 1
      epochBump = h.relay.applyEpochBump(DOCNAME)
      await epochCheckStarted.promise
      directCheck.resolve({
        role: 'reader',
        permissionEpoch: 1,
        sourceRevision: driveRevision,
        proofExpiresAt,
        sourceConfirmed: true,
      })
      await expiryCheck

      driveRevoked = true
      driveRevision = `sha256:${'b'.repeat(64)}`
      invalidateActiveAccess(DOC, SPACE, 'u_epoch_source_close')
      await revokedCheckStarted.promise
      const beforeRevocation = reader.frames.length
      expect(await sendAndAck(writer, opsFrame(1, 'no-peer-frame-during-source-check', 1)))
        .toMatchObject({ ctl: 'ack', q: 1 })
      await turn()
      expect(reader.frames.slice(beforeRevocation).some(frame => frame.ctl === 'op')).toBe(false)
      revokedCheck.resolve({
        role: 'none',
        permissionEpoch: liveEpoch,
        sourceRevision: driveRevision,
        proofExpiresAt,
        sourceConfirmed: true,
      })
      await vi.waitFor(() => expect(reader.closeInfo?.code).toBe(4403))
      epochCheck.resolve('reader')
      await epochBump
      expect(reader.ws.readyState).toBe(WebSocket.CLOSED)

      const afterClose = reader.frames.length
      expect(await sendAndAck(writer, opsFrame(2, 'no-frame-after-epoch-source-revocation', 1)))
        .toMatchObject({ ctl: 'ack', q: 2 })
      await turn()
      expect(reader.frames.slice(afterClose).some(frame => frame.ctl === 'op')).toBe(false)
    } finally {
      directCheck.resolve({
        role: driveRevoked ? 'none' : 'reader',
        permissionEpoch: liveEpoch,
        sourceRevision: driveRevision,
        proofExpiresAt,
        sourceConfirmed: true,
      })
      revokedCheck.resolve({
        role: 'none',
        permissionEpoch: liveEpoch,
        sourceRevision: driveRevision,
        proofExpiresAt,
        sourceConfirmed: true,
      })
      epochCheck.resolve('reader')
      vi.useRealTimers()
      await expiryCheck
      await epochBump
    }
  })
})
