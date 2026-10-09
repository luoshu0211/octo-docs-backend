import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import type { Tx } from '../src/db/pool.js'
import { config } from '../src/config/env.js'
import { persistence } from '../src/collab/persistence.js'
import { captureStoreUpdate } from '../src/collab/storeCheckpoint.js'
import { storeWorkerPool } from '../src/collab/storeWorkerPool.js'
import { decodeStorageState, encodeStorageState } from '../src/collab/storageCodec.js'

const db = vi.hoisted(() => ({
  row: null as null | { state: Buffer; encoding: number },
  failCommit: false, beforeSelect: undefined as (() => void) | undefined,
  mark: vi.fn(), resolve: vi.fn(), metadata: [] as unknown[][],
}))
vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(),
  transaction: async (operation: (tx: Tx) => Promise<void>) => {
    let next = db.row
    const tx = { query: async (sql: string, args: unknown[] = []) => {
      if (sql.startsWith('SELECT state')) { db.beforeSelect?.(); return db.row ? [db.row] : [] }
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
  db.row = null; db.failCommit = false; db.beforeSelect = undefined; db.metadata = []
  db.mark.mockClear(); db.resolve.mockClear()
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
