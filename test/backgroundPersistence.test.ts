import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import type { Tx } from '../src/db/pool.js'
import { config } from '../src/config/env.js'
import { persistence } from '../src/collab/persistence.js'
import { captureStoreUpdate } from '../src/collab/storeCheckpoint.js'
import { storeWorkerPool } from '../src/collab/storeWorkerPool.js'
import { decodeStorageState, encodeStorageState } from '../src/collab/storageCodec.js'
import { bindStateGeneration } from '../src/collab/stateGeneration.js'
import { durableReceipt } from '../src/collab/durableReceipt.js'

const db = vi.hoisted(() => ({
  row: null as null | { state: Buffer; encoding: number },
  generation: null as string | null,
  failCommit: false, beforeSelect: undefined as (() => void) | undefined,
  mark: vi.fn(), resolve: vi.fn(), metadata: [] as unknown[][],
}))
vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(),
  transaction: async (operation: (tx: Tx) => Promise<void>) => {
    let next = db.row
    const tx = { query: async (sql: string, args: unknown[] = []) => {
      if (sql.startsWith('SELECT state')) { db.beforeSelect?.(); return db.row ? [db.row] : [] }
      if (sql.startsWith('SELECT generation')) return db.generation ? [{ generation: db.generation }] : []
      if (sql.startsWith('INSERT INTO yjs_document')) next = { state: args[1] as Buffer, encoding: args[3] as number }
      if (sql.startsWith('UPDATE doc_meta')) db.metadata.push(args)
      return []
    } } as unknown as Tx
    await operation(tx)
    if (db.failCommit) throw new Error('commit failed')
    db.row = next
  },
}))
vi.mock('../src/collab/oversizeGuard.js', () => ({
  markOversized: db.mark, clearOversized: vi.fn(), clearOverCapResolved: vi.fn(),
  resolvePendingUnrestored: db.resolve, resolveDurableUnrestored: vi.fn(),
}))
vi.mock('../src/collab/compactionNotice.js', () => ({ clearOverCapShared: vi.fn(), resolveUnrestoredOverCap: vi.fn() }))

const original = { yjsBackgroundStore: config.yjsBackgroundStore, yjsWriteV2: config.yjsWriteV2, yjsStorageGzip: config.yjsStorageGzip, maxDocBytes: config.maxDocBytes, maxDocStorageBytes: config.maxDocStorageBytes }
const docs: Y.Doc[] = []
function doc() { const d = new Y.Doc(); docs.push(d); return d }
function read() {
  const stored = decodeStorageState(db.row!.state, db.row!.encoding, 'doc')
  const d = doc(); (stored.encoding === 2 ? Y.applyUpdateV2 : Y.applyUpdate)(d, stored.state); return d
}
beforeEach(() => {
  Object.assign(config, { yjsBackgroundStore: true, yjsStorageGzip: true, maxDocBytes: 1048576, maxDocStorageBytes: 1048576 })
  db.row = null; db.generation = null; db.failCommit = false; db.beforeSelect = undefined; db.metadata = []
  db.mark.mockClear(); db.resolve.mockClear()
})

describe.each([false, true])('generation and commit receipts (background: %s)', background => {
  beforeEach(() => { Object.assign(config, { yjsBackgroundStore: background, yjsWriteV2: true }); db.generation = 'generation-one' })
  function sheet() { const d = doc(); bindStateGeneration(d, db.generation); return Object.assign(d, { broadcastStateless: vi.fn() }) }

  it('rejects a stale loaded document before a full-state fallback can restore its old identities', async () => {
    const d = sheet(); d.getMap('m').set('base', 1); await persistence.store('doc', d)
    const row = db.row, ack = durableReceipt(d)
    db.generation = 'generation-two'; d.getMap('m').set('offline', 2)
    await expect(persistence.store('doc', d)).rejects.toThrow('state generation changed')
    expect(db.row).toBe(row); expect(durableReceipt(d)).toBe(ack)
    expect(d.broadcastStateless).toHaveBeenCalledTimes(1)
  })

  it('checks generation after acquiring the row lock, including a rotation during the await', async () => {
    const d = sheet(); db.beforeSelect = () => { db.generation = 'generation-two' }
    await expect(persistence.store('doc', d)).rejects.toThrow('state generation changed')
    expect(db.row).toBeNull(); expect(d.broadcastStateless).not.toHaveBeenCalled()
  })

  it('emits no new receipt when COMMIT fails, including delete-only writes', async () => {
    const d = sheet(); d.getMap('m').set('a', 1); await persistence.store('doc', d)
    const ack = durableReceipt(d); d.getMap('m').delete('a'); db.failCommit = true
    await expect(persistence.store('doc', d)).rejects.toThrow('commit failed')
    expect(durableReceipt(d)).toBe(ack); expect(d.broadcastStateless).toHaveBeenCalledTimes(1)
    db.failCommit = false; await persistence.store('doc', d)
    expect(read().getMap('m').has('a')).toBe(false)
    expect(Y.decodeSnapshot(Buffer.from(JSON.parse(durableReceipt(d)!).snapshot, 'base64')).ds.clients.size).toBe(1)
  })

  it('does not acknowledge edits made during an asynchronous save', async () => {
    const d = sheet(); d.getMap('m').set('first', 1)
    const captured = Y.snapshot(d)
    db.beforeSelect = () => { d.getMap('m').delete('first'); d.getMap('m').set('later', 2) }
    await persistence.store('doc', d)
    const saved = Y.decodeSnapshot(Buffer.from(JSON.parse(durableReceipt(d)!).snapshot, 'base64'))
    expect(Y.equalSnapshots(saved, captured)).toBe(true)
    expect(Y.equalSnapshots(saved, Y.snapshot(d))).toBe(false)
    expect(read().getMap('m').toJSON()).toEqual({ first: 1 })
  })

  it('keeps a committed store successful if receipt delivery throws', async () => {
    const d = sheet(); d.getMap('m').set('saved', 1)
    d.broadcastStateless.mockImplementation(() => { throw new Error('socket closed') })
    await expect(persistence.store('doc', d)).resolves.toBeUndefined()
    expect(read().getMap('m').get('saved')).toBe(1)
    expect(durableReceipt(d)).toBeDefined()
  })
})
afterEach(() => { Object.assign(config, original); for (const d of docs.splice(0)) d.destroy() })
afterAll(() => storeWorkerPool.close())

describe.each([false, true])('background persistence (write V2: %s)', v2 => {
  beforeEach(() => { Object.assign(config, { yjsWriteV2: v2 }) })
  it('uses a small delta after a successful save and stores a complete snapshot', async () => {
    const d = doc(); for (let i = 0; i < 1000; i++) d.getMap('m').set(String(i), i)
    await persistence.store('doc', d)
    d.getMap('m').set('0', 'changed')
    const delta = captureStoreUpdate('doc', d, true)
    expect(delta.state.length).toBeLessThan(200)
    expect(delta.state.length).toBeLessThan(captureStoreUpdate('doc', d, false).state.length / 20)
    await persistence.store('doc', d)
    expect(read().getMap('m').toJSON()).toEqual(d.getMap('m').toJSON())
  })

  it('does not acknowledge edits received while SQL/worker awaits are in flight', async () => {
    const d = doc(); d.getMap('m').set('first', 1)
    db.beforeSelect = () => { d.getMap('m').set('later', 2) }
    const captured = Y.encodeStateVector(d)
    await persistence.store('doc', d)
    expect(read().getMap('m').has('later')).toBe(false)
    expect(captureStoreUpdate('doc', d, true).baseVector).toEqual(captured)
    expect(db.resolve).toHaveBeenLastCalledWith('doc', Object.fromEntries([...Y.decodeStateVector(captured)].map(([id, clock]) => [String(id), clock])))
    db.beforeSelect = undefined
    await persistence.store('doc', d)
    expect(read().getMap('m').toJSON()).toEqual({ first: 1, later: 2 })
  })

  it('does not advance the checkpoint on SQL commit failure; retry retains every change', async () => {
    const d = doc(); d.getText('t').insert(0, 'base'); await persistence.store('doc', d)
    d.getText('t').insert(4, ' retry')
    const pending = captureStoreUpdate('doc', d, true)
    const oldRow = db.row; db.failCommit = true
    await expect(persistence.store('doc', d)).rejects.toThrow('commit failed')
    expect(db.row).toBe(oldRow)
    expect(captureStoreUpdate('doc', d, true).state).toEqual(pending.state)
    db.failCommit = false
    await persistence.store('doc', d)
    expect(read().getText('t').toString()).toBe('base retry')
  })

  it('falls back to a complete state if compaction/replacement invalidated the durable base', async () => {
    const d = doc(); d.getMap('m').set('old', 1); await persistence.store('doc', d)
    const replacement = doc(); replacement.getMap('m').set('new', 2)
    const raw = encodeStorageState(Y.encodeStateAsUpdate(replacement), 1)
    db.row = { state: raw.state, encoding: raw.encoding }
    d.getMap('m').set('local', 3)
    await persistence.store('doc', d)
    expect(read().getMap('m').toJSON()).toEqual({ old: 1, new: 2, local: 3 })
  })

  it('unions two separately checkpointed writers including a deletion', async () => {
    const a = doc(); a.getMap('m').set('remove', 1); await persistence.store('doc', a)
    const b = read(); persistence.loaded('doc', b)
    a.getMap('m').delete('remove'); a.getMap('m').set('a', 1)
    b.getMap('m').set('b', 2)
    await persistence.store('doc', a); await persistence.store('doc', b)
    expect(read().getMap('m').toJSON()).toEqual({ a: 1, b: 2 })
  })

  it('keeps the old row and marks the captured rejected state when a delta crosses the cap', async () => {
    const d = doc(); d.getText('t').insert(0, 'base'); await persistence.store('doc', d)
    const previous = db.row
    d.getText('t').insert(4, 'x'.repeat(500)); Object.assign(config, { maxDocBytes: 400 })
    await expect(persistence.store('doc', d)).rejects.toThrow('exceeds max size')
    expect(db.row).toBe(previous); expect(db.mark).toHaveBeenCalledTimes(1)
    Object.assign(config, { maxDocBytes: 1048576 }); await persistence.store('doc', d)
    expect(read().getText('t').length).toBe(504)
  })

  it('does not attribute a read-only flush to a new editor', async () => {
    const d = doc(); await persistence.store('doc', d, { user: { id: 'system' } })
    expect(db.metadata).toHaveLength(0)
    d.getMap('m').set('edit', 1); await persistence.store('doc', d, { user: { id: 'human' } })
    expect(db.metadata).toEqual([['human', 'doc']])
  })
})
