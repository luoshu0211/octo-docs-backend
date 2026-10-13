import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import * as Y from 'yjs'
import type { Tx } from '../src/db/pool.js'
import { config } from '../src/config/env.js'
import { persistence, computeFinalState } from '../src/collab/persistence.js'
import { encodeStorageState, decodeStorageState, StorageBudgetError, UnknownEncodingError } from '../src/collab/storageCodec.js'

const database = vi.hoisted(() => ({ row: null as null | { state: Buffer; encoding: number }, writes: 0, marks: vi.fn() }))
vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(),
  transaction: async (operation: (tx: Tx) => Promise<void>) => {
    let pending = database.row
    let writes = 0
    const tx = {
      query: async (sql: string, params: unknown[] = []) => {
        if (sql.startsWith('SELECT state')) return pending ? [pending] : []
        if (sql.startsWith('INSERT INTO yjs_document')) {
          pending = { state: params[1] as Buffer, encoding: params[3] as number }
          writes++
        }
        return []
      },
    } as unknown as Tx
    await operation(tx)
    database.row = pending
    database.writes += writes
  },
}))
vi.mock('../src/collab/oversizeGuard.js', () => ({
  markOversized: database.marks,
  clearOversized: vi.fn(),
  clearOverCapResolved: vi.fn(),
  resolvePendingUnrestored: vi.fn(),
  resolveDurableUnrestored: vi.fn(),
}))
vi.mock('../src/collab/compactionNotice.js', () => ({ clearOverCapShared: vi.fn(), resolveUnrestoredOverCap: vi.fn() }))

const original = { maxDocBytes: config.maxDocBytes, maxDocStorageBytes: config.maxDocStorageBytes, yjsStorageGzip: config.yjsStorageGzip, yjsWriteV2: config.yjsWriteV2, yjsBackgroundStore: config.yjsBackgroundStore }
const documents: Y.Doc[] = []
function branch(prefix: string): Y.Doc {
  const doc = new Y.Doc()
  documents.push(doc)
  for (let index = 0; index < 100; index++) doc.getMap('sheet').set(`${prefix}!${index}:0`, { v: createHash('sha256').update(`${prefix}-${index}`).digest('hex') })
  return doc
}
function seed(doc: Y.Doc): void {
  const stored = encodeStorageState(Y.encodeStateAsUpdateV2(doc), 2)
  database.row = { state: stored.state, encoding: stored.encoding }
}
beforeEach(() => {
  Object.assign(config, { maxDocBytes: 1048576, maxDocStorageBytes: 1048576, yjsStorageGzip: true, yjsWriteV2: true })
  database.row = null
  database.writes = 0
  database.marks.mockClear()
})
afterEach(() => {
  Object.assign(config, original)
  for (const doc of documents.splice(0)) doc.destroy()
})

describe.each([false, true])('authoritative merged-state storage budgets (background: %s)', background => {
  beforeEach(() => Object.assign(config, { yjsBackgroundStore: background }))
  it.each([1, 2] as const)('compresses a legacy V%i row larger than the new stored budget', async (encoding) => {
    const doc = branch('legacy-large')
    const raw = encoding === 1 ? Y.encodeStateAsUpdate(doc) : Y.encodeStateAsUpdateV2(doc)
    database.row = { state: Buffer.from(raw), encoding }
    const compressed = encodeStorageState(Y.encodeStateAsUpdateV2(doc), 2)
    expect(raw.length).toBeGreaterThan(compressed.state.length)
    Object.assign(config, { maxDocStorageBytes: compressed.state.length })
    await persistence.store('legacy-large', doc, { user: { id: 'test' } })
    expect(database.writes).toBe(1)
    expect(database.row!.encoding).toBe(4)
    expect(database.row!.state.length).toBe(compressed.state.length)
    const restored = new Y.Doc()
    documents.push(restored)
    Y.applyUpdateV2(restored, decodeStorageState(database.row!.state, 4, 'legacy-large').state)
    expect(restored.getMap('sheet').toJSON()).toEqual(doc.getMap('sheet').toJSON())
    expect(Y.encodeStateVector(restored)).toEqual(Y.encodeStateVector(doc))
  })

  it('persists the divergent union without losing either writer', async () => {
    const left = branch('left')
    const right = branch('right')
    seed(left)
    await persistence.store('union', right, { user: { id: 'test' } })
    expect(database.writes).toBe(1)
    expect(database.row!.encoding).toBe(4)
    const stored = decodeStorageState(database.row!.state, database.row!.encoding, 'union')
    const restored = new Y.Doc()
    documents.push(restored)
    Y.applyUpdateV2(restored, stored.state)
    expect(restored.getMap('sheet').size).toBe(200)
    for (const doc of [left, right]) {
      for (const [key, value] of doc.getMap('sheet')) expect(restored.getMap('sheet').get(key)).toEqual(value)
    }
  })

  it('rejects a final union exceeding decoded budget even when each branch fits', async () => {
    const left = branch('left')
    const right = branch('right')
    seed(left)
    const previous = database.row
    const incoming = Y.encodeStateAsUpdateV2(right)
    const leftState = Y.encodeStateAsUpdateV2(left)
    const limit = Math.max(incoming.length, leftState.length) + 1
    Object.assign(config, { maxDocBytes: limit })
    const union = computeFinalState({ state: leftState, encoding: 2 }, right, incoming, 2).finalState
    expect(union.length).toBeGreaterThan(limit)
    await expect(persistence.store('raw-union', right)).rejects.toMatchObject({ name: 'StorageBudgetError', dimension: 'decoded' })
    expect(database.writes).toBe(0)
    expect(database.row).toBe(previous)
    expect(database.marks).toHaveBeenCalledWith('raw-union', union.length, limit, expect.any(Object))
  })

  it('rejects a final union exceeding stored budget even when each compressed branch fits', async () => {
    const left = branch('left')
    const right = branch('right')
    seed(left)
    const previous = database.row
    const leftState = Y.encodeStateAsUpdateV2(left)
    const incoming = Y.encodeStateAsUpdateV2(right)
    const limit = Math.max(encodeStorageState(leftState, 2).state.length, encodeStorageState(incoming, 2).state.length) + 1
    const union = computeFinalState({ state: leftState, encoding: 2 }, right, incoming, 2).finalState
    const unionBytes = encodeStorageState(union, 2).state.length
    expect(unionBytes).toBeGreaterThan(limit)
    Object.assign(config, { maxDocStorageBytes: limit })
    await expect(persistence.store('stored-union', right)).rejects.toMatchObject({ name: 'StorageBudgetError', dimension: 'stored' })
    expect(database.writes).toBe(0)
    expect(database.row).toBe(previous)
    expect(database.marks).toHaveBeenCalledWith('stored-union', unionBytes, limit, expect.any(Object))
  })

  it('rejects incoming storage overflow before writing or clearing the guard', async () => {
    const doc = branch('incoming')
    Object.assign(config, { maxDocStorageBytes: 10 })
    await expect(persistence.store('incoming', doc)).rejects.toBeInstanceOf(StorageBudgetError)
    expect(database.writes).toBe(0)
    expect(database.row).toBeNull()
    expect(database.marks).toHaveBeenCalledTimes(1)
  })

  it('does not overwrite a row written with an unknown encoding', async () => {
    database.row = { state: Buffer.from([0, 0]), encoding: 99 }
    const previous = database.row
    await expect(persistence.store('unknown', branch('new'))).rejects.toBeInstanceOf(UnknownEncodingError)
    expect(database.writes).toBe(0)
    expect(database.row).toBe(previous)
  })
})
