import { afterEach, describe, expect, it, vi } from 'vitest'
import { Document, Server, type onLoadDocumentPayload } from '@hocuspocus/server'
import * as Y from 'yjs'
import { CapacityBusyError, CapacityLane } from '../src/collab/capacityLane.js'
import { LoadAdmission, loadAdmission } from '../src/collab/loadAdmission.js'
import { CollabDatabase } from '../src/collab/collabDatabase.js'

afterEach(() => vi.restoreAllMocks())

describe('snapshot admission', () => {
  it('bounds waiting work and never starts expired or rejected operations', async () => {
    const lane = new CapacityLane(2, 10)
    let release!: () => void
    const first = lane.run(() => new Promise<void>(resolve => { release = resolve }))
    const waiting = vi.fn(async () => 'unexpected')
    const second = lane.run(waiting)
    try {
      await expect(lane.run(waiting)).rejects.toThrow('queue is full')
      await expect(second).rejects.toThrow('wait expired')
      expect(waiting).not.toHaveBeenCalled()
    } finally { release(); await first }
    await expect(lane.run(async () => 'recovered')).resolves.toBe('recovered')
  })

  it('retains admission during an active operation and recovers after an error', async () => {
    const lane = new CapacityLane(2)
    let reject!: (error: Error) => void
    const first = lane.run(() => new Promise<void>((_resolve, fail) => { reject = fail })).catch(e => e)
    const next = vi.fn(async () => 2)
    const second = lane.run(next)
    expect(next).not.toHaveBeenCalled()
    reject(new Error('save failed'))
    expect(await first).toMatchObject({ message: 'save failed' })
    await expect(second).resolves.toBe(2)
  })

  it('resumes a retained flush after a failed active job without polling or encoding while blocked', async () => {
    vi.useFakeTimers()
    const lane = new CapacityLane(1, 10)
    const attempts = vi.spyOn(lane, 'run')
    let fail!: (error: Error) => void
    const first = lane.run(() => new Promise<void>((_resolve, reject) => { fail = reject })).catch(e => e)
    const save = vi.fn(async () => 'committed')
    const retained = lane.runRetained(save)
    try {
      await vi.advanceTimersByTimeAsync(60_000)
      expect(attempts).toHaveBeenCalledTimes(2)
      expect(save).not.toHaveBeenCalled()
      fail(new Error('first transaction failed'))
      await first
      await expect(retained).resolves.toBe('committed')
      expect(save).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it.each([new Error('SQL failed'), new CapacityBusyError('operation failed after starting')])(
    'does not retry or disguise an admitted operation failure: %s', async error => {
      const lane = new CapacityLane(1)
      const save = vi.fn(async () => { throw error })
      await expect(lane.runRetained(save)).rejects.toBe(error)
      expect(save).toHaveBeenCalledTimes(1)
      await expect(lane.runRetained(async () => 'next')).resolves.toBe('next')
    },
  )
})

describe('room memory admission', () => {
  it('reserves enough for a save helper on a 2 GiB pod even above 20 percent free', async () => {
    const gate = new LoadAdmission(() => ({ heapUsed: 100, heapLimit: 1000, available: 600 * 1024 ** 2, capacity: 2 * 1024 ** 3 }))
    await expect(gate.run(async () => 'unsafe')).rejects.toThrow('memory headroom')
  })
  it('does not mistake low free OS pages for a cgroup limit on an unconstrained host', async () => {
    const gate = new LoadAdmission(() => ({ heapUsed: 100, heapLimit: 1000, available: 1, capacity: 0 }))
    await expect(gate.run(async () => 'loaded')).resolves.toBe('loaded')
  })
  it.each(['heap', 'cgroup'])('rejects new loads at the %s watermark and resumes when memory recovers', async dimension => {
    const GiB = 1024 ** 3
    const reading = { heapUsed: 100, heapLimit: 1000, available: 3 * GiB, capacity: 4 * GiB }
    const gate = new LoadAdmission(() => reading)
    if (dimension === 'heap') reading.heapUsed = 850
    else reading.available = 0.5 * GiB
    const load = vi.fn(async () => 'loaded')
    await expect(gate.run(load)).rejects.toThrow('memory headroom')
    expect(load).not.toHaveBeenCalled()
    reading.heapUsed = 100; reading.available = 3 * GiB
    await expect(gate.run(load)).resolves.toBe('loaded')
  })

  it('does not fetch a rejected room and destroys the document created for the failed load', async () => {
    const fetch = vi.fn(async () => null)
    const database = new CollabDatabase({ fetch, store: vi.fn() })
    const document = new Document('rejected')
    vi.spyOn(loadAdmission, 'assertHeadroom').mockImplementation(() => { throw new Error('pressure') })
    await expect(database.onLoadDocument({ document, documentName: 'rejected' } as onLoadDocumentPayload)).rejects.toThrow('pressure')
    expect(fetch).not.toHaveBeenCalled()
    expect(document.isDestroyed).toBe(true)
  })

  it('checks again after fetch and does not apply a snapshot when memory became scarce', async () => {
    const original = new Y.Doc(); original.getMap('m').set('value', 'preserve')
    const state = Y.encodeStateAsUpdateV2(original)
    const document = new Document('pressure-during-fetch')
    const loaded = vi.fn()
    const check = vi.spyOn(loadAdmission, 'assertHeadroom').mockImplementationOnce(() => {})
      .mockImplementation(() => { throw new Error('pressure after fetch') })
    const database = new CollabDatabase({ fetch: async () => ({ state, encoding: 2 }), store: vi.fn(), loaded })
    try {
      await expect(database.onLoadDocument({ document, documentName: document.name } as onLoadDocumentPayload))
        .rejects.toThrow('pressure after fetch')
      expect(check).toHaveBeenCalledTimes(2)
      expect(document.getMap('m').size).toBe(0)
      expect(document.isDestroyed).toBe(true)
      expect(loaded).not.toHaveBeenCalled()
    } finally { original.destroy() }
  })

  it('coalesces room loads, reuses an open room under pressure, and unloads after a durable save', async () => {
    const source = new Y.Doc(); source.getMap('m').set('base', 1)
    let state = Y.encodeStateAsUpdateV2(source)
    const fetch = vi.fn(async () => ({ state, encoding: 2 as const }))
    const store = vi.fn(async (_name: string, doc: Y.Doc) => { state = Y.encodeStateAsUpdateV2(doc) })
    const server = new Server({ quiet: true, unloadImmediately: true,
      extensions: [new CollabDatabase({ fetch, store })] })
    const pressure = vi.spyOn(loadAdmission, 'assertHeadroom').mockImplementation(() => {})
    const connections = []
    try {
      const [first, second] = await Promise.all([
        server.hocuspocus.openDirectConnection('same'), server.hocuspocus.openDirectConnection('same'),
      ])
      connections.push(first, second)
      expect(fetch).toHaveBeenCalledTimes(1)
      await first.transact(doc => { doc.getMap('m').set('saved', 2) })
      pressure.mockImplementation(() => { throw new Error('pressure') })
      const third = await server.hocuspocus.openDirectConnection('same'); connections.push(third)
      await third.transact(doc => { expect(doc.getMap('m').get('saved')).toBe(2) })
      await expect(server.hocuspocus.openDirectConnection('another')).rejects.toThrow('pressure')
      expect(server.hocuspocus.documents.size).toBe(1)
      for (const connection of connections.splice(0)) await connection.disconnect()
      await vi.waitFor(() => expect(server.hocuspocus.documents.size).toBe(0))
      pressure.mockImplementation(() => {})
      const reopened = await server.hocuspocus.openDirectConnection('same'); connections.push(reopened)
      await reopened.transact(doc => { expect(doc.getMap('m').get('saved')).toBe(2) })
      expect(store).toHaveBeenCalled()
    } finally {
      for (const connection of connections) await connection.disconnect()
      await server.destroy(); source.destroy()
    }
  })
})
