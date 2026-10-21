import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Server } from '@hocuspocus/server'
import * as Y from 'yjs'
import type { Tx } from '../src/db/pool.js'
import { config } from '../src/config/env.js'
import { CollabDatabase } from '../src/collab/collabDatabase.js'
import { loadAdmission } from '../src/collab/loadAdmission.js'
import { persistence } from '../src/collab/persistence.js'
import { storeWorkerPool } from '../src/collab/storeWorkerPool.js'
import { decodeStorageState } from '../src/collab/storageCodec.js'

// Only SQL and side-channel notices are mocked. Hocuspocus (including its
// debouncer, save mutex and unload), the adapter and the save child are real.
const db = vi.hoisted(() => ({
  rows: new Map<string, { state: Buffer; encoding: number }>(),
  beforeSelect: undefined as undefined | ((name: string) => Promise<void>),
  beforeCommit: undefined as undefined | ((name: string) => Promise<void>),
  selected: [] as string[], commits: [] as string[],
}))
vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(),
  transaction: async (operation: (tx: Tx) => Promise<unknown>) => {
    let next: { name: string; state: Buffer; encoding: number } | undefined
    const tx = { query: async (sql: string, args: unknown[] = []) => {
      const name = args[0] as string
      if (sql.startsWith('SELECT state')) {
        db.selected.push(name)
        await db.beforeSelect?.(name)
        return db.rows.has(name) ? [db.rows.get(name)] : []
      }
      if (sql.startsWith('INSERT INTO yjs_document')) {
        next = { name, state: args[1] as Buffer, encoding: args[3] as number }
      }
      return []
    } } as unknown as Tx
    const result = await operation(tx)
    if (next) {
      await db.beforeCommit?.(next.name)
      db.rows.set(next.name, next); db.commits.push(next.name)
    }
    return result
  },
}))
vi.mock('../src/collab/oversizeGuard.js', () => ({
  markOversized: vi.fn(), clearOversized: vi.fn(), clearOverCapResolved: vi.fn(),
  resolvePendingUnrestored: vi.fn(), resolveDurableUnrestored: vi.fn(),
}))
vi.mock('../src/collab/compactionNotice.js', () => ({ clearOverCapShared: vi.fn(), resolveUnrestoredOverCap: vi.fn() }))

const original = { yjsBackgroundStore: config.yjsBackgroundStore, yjsWriteV2: config.yjsWriteV2,
  yjsStorageGzip: config.yjsStorageGzip, maxDocBytes: config.maxDocBytes, maxDocStorageBytes: config.maxDocStorageBytes }
beforeEach(() => {
  Object.assign(config, { yjsWriteV2: true, yjsStorageGzip: true, maxDocBytes: 1048576, maxDocStorageBytes: 1048576 })
  db.rows.clear(); db.selected = []; db.commits = []; db.beforeSelect = undefined; db.beforeCommit = undefined
  vi.spyOn(loadAdmission, 'assertHeadroom').mockImplementation(() => {})
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); Object.assign(config, original) })
afterAll(() => storeWorkerPool.close())
const turn = () => new Promise<void>(resolve => setImmediate(resolve))

describe.each([false, true])('direct flush under admission pressure (background: %s)', background => {
  it.each(['full', 'expired'] as const)('retains an edited room when the save queue is %s, then commits before disconnect resolves', async pressure => {
    Object.assign(config, { yjsBackgroundStore: background })
    const server = new Server({ quiet: true, debounce: 60_000, maxDebounce: 60_000,
      extensions: [new CollabDatabase(persistence)] })
    const connection = await server.hocuspocus.openDirectConnection('victim', { user: { id: 'editor' } })
    const live = connection.document!
    await connection.transact(doc => { doc.getMap('m').set('keep', 'accepted edit') })
    const blocker = new Y.Doc(); blocker.getMap('m').set('base', 1)
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    let releaseCommit!: () => void
    const commitBlocked = new Promise<void>(resolve => { releaseCommit = resolve })
    let prepared = false
    db.beforeCommit = async name => { if (name === 'victim') { prepared = true; await commitBlocked } }
    db.selected = []
    db.beforeSelect = async name => { if (name === 'blocker') await blocked }
    if (pressure === 'expired') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const jobs = Array.from({ length: pressure === 'full' ? 16 : 1 }, (_, i) => persistence.store(i === 0 ? 'blocker' : `queued-${i}`, blocker))
    let settled = false
    const disconnect = connection.disconnect().finally(() => { settled = true })
    let laterDisconnect: Promise<void> | undefined
    try {
      await turn()
      if (pressure === 'expired') await vi.advanceTimersByTimeAsync(30_001)
      await turn()
      // These assertions fail on the reviewed head: disconnect succeeds and
      // destroys the sole live copy, despite no SQL write ever being admitted.
      expect(settled, 'disconnect must not acknowledge an uncommitted edit').toBe(false)
      expect(server.hocuspocus.documents.get('victim')).toBe(live)
      expect(live.isDestroyed).toBe(false)
      expect(live.saveMutex.isLocked()).toBe(true)
      expect(db.selected).toEqual(['blocker'])
      expect(db.rows.has('victim')).toBe(false)
      // Last edits arriving while admission waits must be captured when the
      // room finally gets its turn, not replaced with an earlier snapshot.
      const later = await server.hocuspocus.openDirectConnection('victim', { user: { id: 'editor' } })
      expect(later.document).toBe(live)
      await later.transact(doc => { doc.getMap('m').set('late', 2); doc.getMap('m').delete('keep') })
      laterDisconnect = later.disconnect()
      vi.useRealTimers(); release()
      await Promise.all(jobs)
      await vi.waitFor(() => expect(prepared).toBe(true))
      expect(settled, 'encoding/UPSERT is not a successful COMMIT').toBe(false)
      expect(live.isDestroyed).toBe(false)
      expect(db.rows.has('victim')).toBe(false)
      releaseCommit()
      await disconnect
      await laterDisconnect
      expect(db.commits).toContain('victim')
      const row = db.rows.get('victim')!
      const stored = decodeStorageState(row.state, row.encoding, 'victim')
      const readback = new Y.Doc()
      try {
        ;(stored.encoding === 2 ? Y.applyUpdateV2 : Y.applyUpdate)(readback, stored.state)
        expect(readback.getMap('m').toJSON()).toEqual({ late: 2 })
      } finally { readback.destroy() }
      expect(live.isDestroyed).toBe(true)
      const reopened = await server.hocuspocus.openDirectConnection('victim')
      try { expect(reopened.document!.getMap('m').toJSON()).toEqual({ late: 2 }) }
      finally { await reopened.disconnect() }
    } finally {
      vi.useRealTimers(); db.beforeSelect = undefined; release(); releaseCommit()
      await Promise.all(jobs)
      await disconnect
      await laterDisconnect
      await server.destroy(); blocker.destroy()
    }
  })
})
