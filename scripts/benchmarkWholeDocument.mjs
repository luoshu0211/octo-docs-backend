/* global process, performance, gc */
// Run each sample in a fresh, memory-limited container; never against production.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import * as Y from 'yjs'

const [mode, file, countArg = '1', encodingArg = '2'] = process.argv.slice(2)
const count = Number(countArg)
assert(file && Number.isSafeInteger(count) && count > 0)
const encoding = Number(encodingArg)
assert(encoding === 1 || encoding === 2)
const encode = encoding === 2 ? Y.encodeStateAsUpdateV2 : Y.encodeStateAsUpdate
const apply = encoding === 2 ? Y.applyUpdateV2 : Y.applyUpdate
const key = i => `default!${Math.floor(i / 100)}:${i % 100}`
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const cgroup = name => {
  try { return Number(readFileSync(`/sys/fs/cgroup/${name}`, 'utf8').trim()) } catch { return null }
}
const snapshot = () => ({ ...process.memoryUsage(), maxRssBytes: process.resourceUsage().maxRSS * 1024,
  cgroupCurrent: cgroup('memory.current'), cgroupPeak: cgroup('memory.peak') })
const collect = () => { for (let i = 0; i < 3; i++) gc() }
const result = { mode, file, count, encoding, node: process.version, baseline: snapshot(), stages: [] }
const mark = (stage, start) => {
  const record = { stage, ms: performance.now() - start, ...snapshot() }
  result.stages.push(record)
  process.stdout.write(`${JSON.stringify(record)}\n`)
}
let pool
try {
  if (mode === 'generate') {
    const doc = new Y.Doc(); doc.clientID = 123456
    const cells = doc.getMap('sheet')
    const start = performance.now()
    doc.transact(() => {
      for (let i = 0; i < count; i++) cells.set(key(i), { v: i + 1, t: 2 })
    })
    const bytes = encode(doc)
    writeFileSync(file, bytes)
    result.bytes = bytes.length; result.sha256 = digest(bytes)
    writeFileSync(`${file}.json`, JSON.stringify({ count, encoding, bytes: bytes.length, sha256: result.sha256 }))
    mark('generated', start); doc.destroy()
  } else {
    assert(mode === 'load' || mode === 'save' || mode === 'rooms')
    const fixture = JSON.parse(readFileSync(`${file}.json`, 'utf8'))
    assert.equal(fixture.encoding, encoding)
    const bytes = readFileSync(file)
    assert.equal(digest(bytes), fixture.sha256)
    result.bytes = bytes.length; result.sha256 = fixture.sha256; result.cellsPerDocument = fixture.count
    const docs = []
    const admission = mode === 'rooms' ? (await import('../dist/collab/loadAdmission.js')).loadAdmission : null
    for (let n = 0; n < count; n++) {
      const start = performance.now()
      const doc = new Y.Doc()
      try {
        if (admission) await admission.run(async () => { apply(doc, bytes) })
        else apply(doc, bytes)
      } catch (error) {
        doc.destroy()
        result.admission = { accepted: docs.length, rejected: 1, error: error.message }
        break
      }
      docs.push(doc)
      assert.equal(doc.getMap('sheet').size, fixture.count)
      assert.deepEqual(doc.getMap('sheet').get(key(fixture.count - 1)), { v: fixture.count, t: 2 })
      mark(`loaded-${n + 1}`, start)
      if (!admission) { collect(); mark(`retained-${n + 1}`, start) }
    }
    if (mode === 'save' || mode === 'rooms') {
      assert(docs.length > 0)
      const { StoreWorkerPool, createStoreWorker } = await import('../dist/collab/storeWorkerPool.js')
      // The pool's production 64 MiB input budget remains in force.
      pool = new StoreWorkerPool({ workerFactory: () => {
        const worker = createStoreWorker()
        worker.on('ready', limit => { result.workerHeapLimitBytes = limit })
        return worker
      } })
      const { encodeStorageState, decodeStorageState } = await import('../dist/collab/storageCodec.js')
      const codec = { maxDocBytes: 128 * 1024 * 1024, maxDocStorageBytes: 0, yjsStorageGzip: true }
      const existing = encodeStorageState(bytes, encoding, codec)
      const doc = docs[0]
      const baseVector = Y.encodeStateVector(doc)
      doc.getMap('sheet').set(key(0), { v: 'edited', t: 1 })
      const start = performance.now()
      try {
        const saved = await pool.run({ documentName: 'benchmark', existing, update: encode(doc, baseVector),
          encoding, baseVector, targetVector: Y.encodeStateVector(doc), codec })
        assert.equal(saved.kind, 'stored')
        const restored = decodeStorageState(saved.stored.state, saved.stored.encoding, 'benchmark', codec)
        // Compare encoded bytes to the live model: avoids constructing a third full Y.Doc.
        assert.equal(digest(restored.state), digest(encode(doc)))
        result.save = { ok: true, storedBytes: saved.stored.state.length, decodedBytes: saved.stored.decodedBytes }
      } catch (error) {
        result.save = { ok: false, error: error.message }
      }
      mark('save', start)
      const small = new Y.Doc(); small.getMap('sheet').set('default!0:0', { v: 'recovery', t: 1 })
      const recovery = await pool.run({ documentName: 'recovery', existing: null, update: encode(small),
        encoding, baseVector: null, targetVector: Y.encodeStateVector(small), codec })
      assert.equal(recovery.kind, 'stored'); result.recoverySavePassed = true; small.destroy()
      await pool.close(); pool = undefined
      collect(); mark('after-worker-close', start)
    }
    for (const doc of docs) doc.destroy()
  }
  result.final = snapshot()
  if (process.env.BENCHMARK_RESULT) {
    mkdirSync(dirname(process.env.BENCHMARK_RESULT), { recursive: true })
    writeFileSync(process.env.BENCHMARK_RESULT, JSON.stringify(result, null, 2))
  }
  process.stdout.write(`${JSON.stringify({ result })}\n`)
} finally { await pool?.close() }
