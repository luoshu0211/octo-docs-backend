import { afterEach, describe, expect, it } from 'vitest'
import { Worker } from 'node:worker_threads'
import { EventEmitter, once } from 'node:events'
import { execFileSync } from 'node:child_process'
import * as Y from 'yjs'
import { prepareStoredState, type StoreJob, type StoreResult } from '../src/collab/storeWorker.js'
import { createStoreWorker, StoreWorkerPool } from '../src/collab/storeWorkerPool.js'
import { decodeStorageState, encodeStorageState, StorageBudgetError } from '../src/collab/storageCodec.js'

const codec = { maxDocBytes: 4 * 1024 * 1024, maxDocStorageBytes: 4 * 1024 * 1024, yjsStorageGzip: true }
const docs: Y.Doc[] = []
const pools: StoreWorkerPool[] = []
const doc = () => { const d = new Y.Doc(); docs.push(d); return d }
const pool = (options?: ConstructorParameters<typeof StoreWorkerPool>[0]) => {
  const p = new StoreWorkerPool(options); pools.push(p); return p
}
const encode = (d: Y.Doc, encoding: 1 | 2, vector?: Uint8Array) => encoding === 2
  ? Y.encodeStateAsUpdateV2(d, vector) : Y.encodeStateAsUpdate(d, vector)
const restore = (result: StoreResult) => {
  if (result.kind !== 'stored') throw new Error('expected stored state')
  const state = decodeStorageState(result.stored.state, result.stored.encoding, 'test', codec)
  const d = doc(); (state.encoding === 2 ? Y.applyUpdateV2 : Y.applyUpdate)(d, state.state); return d
}
function job(d: Y.Doc): StoreJob {
  return { documentName: 'test', existing: null, update: encode(d, 1), encoding: 1, baseVector: null, targetVector: Y.encodeStateVector(d), codec }
}
afterEach(async () => {
  await Promise.all(pools.splice(0).map(p => p.close()))
  for (const d of docs.splice(0)) d.destroy()
})

describe.each([1, 2] as const)('background merge writes V%i', encoding => {
  it.each([1, 2, 3, 4] as const)('merges a delta against storage encoding %i without losing another writer', storageEncoding => {
    const a = doc(); a.getMap('m').set('base', 'keep')
    const base = Y.encodeStateVector(a)
    const b = doc(); Y.applyUpdate(b, encode(a, 1))
    a.getMap('m').set('a', 1); b.getMap('m').set('b', 2)
    const existingEncoding = storageEncoding === 2 || storageEncoding === 4 ? 2 : 1
    // A long value makes gzip choose the compressed representation.
    b.getText('text').insert(0, 'x'.repeat(1000))
    const existing = encodeStorageState(encode(b, existingEncoding), existingEncoding, { ...codec, yjsStorageGzip: storageEncoding >= 3 })
    expect(existing.encoding).toBe(storageEncoding)
    const result = prepareStoredState({ ...job(a), existing, encoding, baseVector: base, update: encode(a, encoding, base) })
    const d = restore(result)
    expect(d.getMap('m').toJSON()).toEqual({ base: 'keep', a: 1, b: 2 })
    expect(d.getText('text').length).toBe(1000)
  })

  it('preserves delete-only changes even though their state vector did not advance', () => {
    const d = doc(); d.getText('t').insert(0, 'abcdef'); d.getMap('m').set('remove', 1)
    const base = Y.encodeStateVector(d)
    const existing = encodeStorageState(encode(d, encoding), encoding, codec)
    d.getText('t').delete(1, 3); d.getMap('m').delete('remove')
    expect(Y.encodeStateVector(d)).toEqual(base)
    const result = prepareStoredState({ ...job(d), existing, encoding, baseVector: base, update: encode(d, encoding, base) })
    expect(restore(result).getText('t').toString()).toBe('aef')
    expect(restore(result).getMap('m').has('remove')).toBe(false)
  })

  it('requests a full update when the row was removed or compacted', () => {
    const d = doc(); d.getMap('m').set('base', 1)
    const base = Y.encodeStateVector(d); d.getMap('m').set('next', 2)
    const replacement = doc(); replacement.getMap('m').set('other', 3)
    for (const existing of [null, encodeStorageState(encode(replacement, encoding), encoding, codec)]) {
      const input = { ...job(d), existing, encoding, baseVector: base, update: encode(d, encoding, base) }
      expect(prepareStoredState(input)).toEqual({ kind: 'needs-full-state' })
      const restored = restore(prepareStoredState({ ...input, baseVector: null, update: encode(d, encoding) }))
      expect(restored.getMap('m').get('base')).toBe(1)
      expect(restored.getMap('m').get('next')).toBe(2)
      if (existing) expect(restored.getMap('m').get('other')).toBe(3)
    }
  })
})

describe('worker isolation and lifecycle', () => {
  it('finishes shutdown in a standalone process with no other event-loop handles', () => {
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { StoreWorkerPool } from './src/collab/storeWorkerPool.ts';
      import * as Y from 'yjs';
      const pool = new StoreWorkerPool(); const doc = new Y.Doc();
      await pool.run({ documentName:'shutdown', existing:null, update:Y.encodeStateAsUpdate(doc), encoding:1,
        baseVector:null, targetVector:Y.encodeStateVector(doc), codec:{maxDocBytes:1000,maxDocStorageBytes:0,yjsStorageGzip:false} });
      await pool.close(); doc.destroy(); process.stdout.write('closed');
    `], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] })
    expect(output).toBe('closed')
  })

  it('keeps the 512 MiB heap boundary when the parent requests 4 GiB', async () => {
    const previous = process.env.NODE_OPTIONS
    process.env.NODE_OPTIONS = '--max-old-space-size=4096'
    const worker = createStoreWorker()
    try {
      const limit = await new Promise<number>((resolve, reject) => {
        worker.on('ready', resolve); worker.on('error', reject)
      })
      // V8 adds its young generation to the 512 MiB old-space budget.
      expect(limit).toBeGreaterThan(512 * 1024 * 1024)
      expect(limit).toBeLessThanOrEqual(576 * 1024 * 1024)
    } finally {
      await worker.terminate()
      if (previous === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = previous
    }
  })

  it('holds the slot and byte reservation until the timed-out process has actually exited', async () => {
    let finishExit!: (code: number) => void
    class SlowExit extends EventEmitter {
      postMessage(): void { /* intentionally unresponsive */ }
      ref(): void { /* test handle */ }
      unref(): void { /* test handle */ }
      terminate(): Promise<number> {
        this.emit('terminating')
        return new Promise(resolve => { finishExit = resolve })
      }
    }
    const slow = new SlowExit()
    let starts = 0
    const input = job(doc())
    const bytes = input.update.byteLength + input.targetVector.byteLength
    const p = pool({ maxBytes: bytes * 2, timeoutMs: 20,
      workerFactory: () => ++starts === 1 ? slow : createStoreWorker() })
    const terminating = once(slow, 'terminating')
    const first = p.run(input).catch(error => error)
    const second = p.run(input).catch(error => error)
    await terminating
    try {
      expect(starts).toBe(1)
      await expect(p.run(input)).rejects.toThrow('capacity exceeded')
    } finally { finishExit(1) }
    expect(await first).toMatchObject({ message: 'Yjs store worker timed out' })
    // The second may time out on startup under this deliberately tiny deadline,
    // but must never start before the first process released its memory.
    await second
    expect(starts).toBe(2)
  })

  it('does the expensive work off the event loop after the worker is already warm', async () => {
    const p = pool(); await p.run(job(doc()))
    const d = doc()
    d.transact(() => { for (let i = 0; i < 40000; i++) d.getMap('m').set(String(i), { v: i }) })
    const input = job(d)
    let ticked = false
    const timer = setTimeout(() => { ticked = true }, 0)
    const result = await p.run(input)
    clearTimeout(timer)
    expect(ticked).toBe(true)
    expect(restore(result).getMap('m').size).toBe(40000)
    expect(input.update.byteLength).toBeGreaterThan(0)
  })

  it('returns typed budget failures and remains usable afterwards', async () => {
    const p = pool(); const d = doc(); d.getText('t').insert(0, 'x'.repeat(10000))
    await expect(p.run({ ...job(d), codec: { ...codec, maxDocBytes: 100 } })).rejects.toBeInstanceOf(StorageBudgetError)
    await expect(p.run({ ...job(d), codec: { ...codec, maxDocStorageBytes: 1 } })).rejects.toMatchObject({ dimension: 'stored' })
    expect(restore(await p.run(job(d))).getText('t').length).toBe(10000)
  })

  it('bounds queued jobs and bytes without dropping the accepted job', async () => {
    const p = pool({ maxJobs: 1 })
    const accepted = p.run(job(doc()))
    await expect(p.run(job(doc()))).rejects.toThrow('capacity exceeded')
    expect((await accepted).kind).toBe('stored')
    await expect(pool({ maxBytes: 1 }).run(job(doc()))).rejects.toThrow('capacity exceeded')
  })

  it('rejects a crashed worker job, replaces the worker, and completes a later save', async () => {
    let starts = 0
    const p = pool({ workerFactory: () => ++starts === 1 ? new Worker('process.exit(7)', { eval: true }) : createStoreWorker() })
    await expect(p.run(job(doc()))).rejects.toThrow('exited (7)')
    expect((await p.run(job(doc()))).kind).toBe('stored')
  })

  it('times out an unresponsive worker instead of retaining a row lock forever', async () => {
    const p = pool({ timeoutMs: 40, workerFactory: () => new Worker('setInterval(() => {}, 1000)', { eval: true }) })
    await expect(p.run(job(doc()))).rejects.toThrow('timed out')
  })

  it('drains accepted work before shutdown and rejects subsequent requests', async () => {
    const p = pool(); const a = p.run(job(doc())); const b = p.run(job(doc()))
    await p.close()
    expect((await a).kind).toBe('stored'); expect((await b).kind).toBe('stored')
    await expect(p.run(job(doc()))).rejects.toThrow('closed')
  })
})
