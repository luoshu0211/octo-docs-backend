import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as Y from 'yjs'
import { config } from '../src/config/env.js'
import { query, closePool, transaction } from '../src/db/pool.js'
import { closeRedis } from '../src/db/redis.js'
import { persistence } from '../src/collab/persistence.js'
import { applyStoredState } from '../src/collab/collabDatabase.js'
import { yjsDocumentRepo } from '../src/db/repos/yjsDocumentRepo.js'
import { applySheetCellsToYMap, type SheetCell } from '../src/agent/sheetConversion.js'
import { encodeStorageState, StorageBudgetError } from '../src/collab/storageCodec.js'

const mode = process.argv[2] ?? 'write'
const scenario = process.argv[3] ?? 'sequence'
const count = 1_000_000
const output = process.env.BENCHMARK_OUTPUT_DIR
assert(output, 'BENCHMARK_OUTPUT_DIR is required')
assert(config.mysql.host === '127.0.0.1' && config.mysql.database === 'octo_storage_proto', 'requires the isolated prototype database')
assert(config.redis.prefix.startsWith('codec-prototype-'), 'requires an isolated Redis prefix')
const documentName = `octo:codec-prototype:f_default:sheet:codec-${scenario}`
const style = { ff: 'Arial', fs: 11, bl: 1, bg: { rgb: '#DDEEFF' }, cl: { rgb: '#112233' }, n: { pattern: '0.00' } }
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

function cellAt(index: number): SheetCell {
  if (scenario === 'constant') return { v: 1, t: 2 }
  if (scenario === 'random') return { v: createHash('sha256').update(`octo-benchmark-${index}`).digest('hex').slice(0, 16), t: 1 }
  if (scenario === 'styled') return { v: index + 1, s: style, t: 2 }
  return { v: index + 1, t: 2 }
}
function keyAt(index: number): string {
  return `default!${Math.floor(index / 100)}:${index % 100}`
}
async function rowInfo(name: string = documentName) {
  const [row] = await query<{ encoding: number; size_bytes: number; physical_bytes: number; checksum: string }>(
    'SELECT encoding, size_bytes, OCTET_LENGTH(state) AS physical_bytes, LOWER(SHA2(state, 256)) AS checksum FROM yjs_document WHERE document_name = ?', [name],
  )
  assert(row)
  assert.equal(row.size_bytes, row.physical_bytes)
  return row
}
async function registerDocument(name: string): Promise<void> {
  const id = name.split(':').at(-1)!
  await query(
    `INSERT INTO doc_meta (doc_id, document_name, owner_id, owner_space_id, space_id, folder_id, doc_type, created_by)
     VALUES (?, ?, 'codec-test', 'codec-prototype', 'codec-prototype', 'f_default', 'sheet', 'codec-test')
     ON DUPLICATE KEY UPDATE document_name = VALUES(document_name)`, [id, name],
  )
}
async function saveResult(result: Record<string, unknown>): Promise<void> {
  await mkdir(output!, { recursive: true })
  const value = { ...result, mode, scenario, node: process.version, decodedLimit: config.maxDocBytes, storedLimit: config.maxDocStorageBytes, maxRssKiB: process.resourceUsage().maxRSS }
  await writeFile(path.join(output!, `${scenario}-${mode}.json`), JSON.stringify(value, null, 2))
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

async function run(): Promise<void> {
  if (mode === 'legacy-read') {
    const legacyPath = process.env.LEGACY_BACKEND_PATH
    assert(legacyPath)
    const before = await rowInfo()
    const legacy = await import(pathToFileURL(path.join(legacyPath, 'src/db/repos/yjsDocumentRepo.ts')).href)
    await assert.rejects(() => legacy.yjsDocumentRepo.fetchState(documentName), { name: 'UnknownEncodingError' })
    const legacyPool = await import(pathToFileURL(path.join(legacyPath, 'src/db/pool.ts')).href)
    await legacyPool.closePool()
    assert.deepEqual(await rowInfo(), before)
    await saveResult({ oldReaderRejectedNewFormat: true, rowUnchanged: true })
    return
  }
  if (mode === 'legacy-fixtures') {
    const originalGzip = config.yjsStorageGzip
    const originalStorageLimit = config.maxDocStorageBytes
    for (const encoding of [1, 2] as const) {
      const name = `${documentName}-v${encoding}`
      const doc = new Y.Doc()
      doc.getText('text').insert(0, 'legacy content '.repeat(1000))
      const state = encoding === 1 ? Y.encodeStateAsUpdate(doc) : Y.encodeStateAsUpdateV2(doc)
      Object.assign(config, { yjsStorageGzip: false })
      await transaction((tx) => yjsDocumentRepo.upsertStateTx(tx, name, Buffer.from(state), encoding))
      Object.assign(config, { yjsStorageGzip: originalGzip })
      const compressed = encodeStorageState(Y.encodeStateAsUpdateV2(doc), 2)
      assert(state.length > compressed.state.length)
      Object.assign(config, { maxDocStorageBytes: compressed.state.length })
      const restored = new Y.Doc()
      applyStoredState(restored, (await yjsDocumentRepo.fetchState(name))!)
      assert.equal(restored.getText('text').toString(), doc.getText('text').toString())
      assert.equal((await rowInfo(name)).encoding, encoding)
      await registerDocument(name)
      await persistence.store(name, restored, { user: { id: 'codec-test' } })
      assert.equal((await rowInfo(name)).encoding, 4)
      assert.equal((await rowInfo(name)).physical_bytes, compressed.state.length)
      Object.assign(config, { maxDocStorageBytes: originalStorageLimit })
      doc.destroy()
      restored.destroy()
    }
    await saveResult({ legacyV1AndV2ReadAndLazilyMigrated: true, legacyRowsAboveStoredWriteBudgetMigrated: true })
    return
  }
  if (mode === 'concurrency') {
    await registerDocument(documentName)
    const base = new Y.Doc()
    for (let index = 0; index < 10000; index++) base.getMap('sheet').set(keyAt(index), { v: index, t: 2 })
    await persistence.store(documentName, base, { user: { id: 'codec-test' } })
    const left = new Y.Doc()
    const right = new Y.Doc()
    const state = Y.encodeStateAsUpdateV2(base)
    Y.applyUpdateV2(left, state)
    Y.applyUpdateV2(right, state)
    left.getMap('sheet').set(keyAt(0), { v: 'left', t: 1 })
    right.getMap('sheet').set(keyAt(1), { v: 'right', t: 1 })
    right.getMap('sheet').delete(keyAt(2))
    await Promise.all([
      persistence.store(documentName, left, { user: { id: 'codec-left' } }),
      persistence.store(documentName, right, { user: { id: 'codec-right' } }),
    ])
    const restored = new Y.Doc()
    applyStoredState(restored, (await yjsDocumentRepo.fetchState(documentName))!)
    const cells = restored.getMap('sheet')
    assert.equal(cells.size, 9999)
    assert.deepEqual(cells.get(keyAt(0)), { v: 'left', t: 1 })
    assert.deepEqual(cells.get(keyAt(1)), { v: 'right', t: 1 })
    assert.equal(cells.has(keyAt(2)), false)
    for (let index = 3; index < 10000; index++) assert.deepEqual(cells.get(keyAt(index)), { v: index, t: 2 })
    await saveResult({ concurrentSqlStoresMerged: true, all10000TargetsChecked: true, row: await rowInfo() })
    for (const doc of [base, left, right, restored]) doc.destroy()
    return
  }
  if (mode === 'read') {
    const baseline = JSON.parse(await readFile(path.join(output!, `${scenario}-write.json`), 'utf8'))
    const row = await rowInfo()
    assert.equal(row.checksum, baseline.row.checksum)
    const started = performance.now()
    const stored = await yjsDocumentRepo.fetchState(documentName)
    assert(stored)
    const doc = new Y.Doc()
    applyStoredState(doc, stored)
    const decodeMs = performance.now() - started
    const cells = doc.getMap<SheetCell>('sheet')
    assert.equal(cells.size, count)
    const hash = createHash('sha256')
    for (let index = 0; index < count; index++) {
      const cell = cells.get(keyAt(index))
      assert.deepEqual(cell, cellAt(index))
      hash.update(JSON.stringify([index, cell!.v, cell!.t, cell!.s ?? null]) + '\n')
    }
    assert.equal(hash.digest('hex'), baseline.valuesSha256)
    assert.equal(digest(Y.encodeStateVector(doc)), baseline.stateVectorSha256)
    await saveResult({ cells: count, allCellsValuesTypesAndStylesVerified: true, causalIdentityPreserved: true, sqlChecksumVerified: true, decodeMs, row })
    doc.destroy()
    return
  }
  assert.equal(mode, 'write')
  await registerDocument(documentName)
  const doc = new Y.Doc()
  doc.getMap('benchmark').set('seed', true)
  await persistence.store(documentName, doc, { user: { id: 'codec-test' } })
  const previous = await rowInfo()
  const cells = doc.getMap<SheetCell>('sheet')
  doc.getMap('sheetList').set('default', { name: 'Data', order: 0, rowCount: 10000, columnCount: 100 })
  const started = performance.now()
  const hash = createHash('sha256')
  for (let offset = 0; offset < count; offset += 10000) {
    const batch: Record<string, SheetCell> = {}
    for (let index = offset; index < offset + 10000; index++) {
      const cell = cellAt(index)
      batch[keyAt(index)] = cell
      hash.update(JSON.stringify([index, cell.v, cell.t, cell.s ?? null]) + '\n')
    }
    doc.transact(() => applySheetCellsToYMap(cells, batch))
  }
  const buildMs = performance.now() - started
  const rawBytes = Y.encodeStateAsUpdateV2(doc).length
  const storeStarted = performance.now()
  if (scenario === 'random') {
    await assert.rejects(() => persistence.store(documentName, doc), (error: unknown) => error instanceof StorageBudgetError && error.dimension === 'stored')
    assert.deepEqual(await rowInfo(), previous)
    const recovered = new Y.Doc()
    applyStoredState(recovered, (await yjsDocumentRepo.fetchState(documentName))!)
    assert.equal(recovered.getMap('sheet').size, 0)
    await saveResult({ cells: count, rawBytes, rejectedAtStorageBudget: true, previousDurableRowPreserved: true, previousRowReadable: true, buildMs, rejectMs: performance.now() - storeStarted })
    recovered.destroy()
  } else {
    await persistence.store(documentName, doc, { user: { id: 'codec-test' } })
    const storeMs = performance.now() - storeStarted
    const row = await rowInfo()
    assert.equal(row.encoding, 4)
    assert(row.physical_bytes <= config.maxDocStorageBytes)
    await saveResult({ cells: count, rawBytes, row, valuesSha256: hash.digest('hex'), stateVectorSha256: digest(Y.encodeStateVector(doc)), buildMs, storeMs })
  }
  doc.destroy()
}

try {
  await run()
} finally {
  await new Promise((resolve) => setTimeout(resolve, 100))
  await closeRedis()
  await closePool()
}
