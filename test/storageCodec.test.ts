import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import * as Y from 'yjs'
import { config } from '../src/config/env.js'
import { decodeStorageState, encodeStorageState, StorageBudgetError, UnknownEncodingError } from '../src/collab/storageCodec.js'
import { persistedByteLength } from '../src/collab/persistedEncoding.js'
import { applyStoredState } from '../src/collab/collabDatabase.js'

const original = {
  maxDocBytes: config.maxDocBytes,
  maxDocStorageBytes: config.maxDocStorageBytes,
  yjsStorageGzip: config.yjsStorageGzip,
  yjsWriteV2: config.yjsWriteV2,
}
const documents: Y.Doc[] = []
function newDoc(): Y.Doc {
  const doc = new Y.Doc()
  documents.push(doc)
  return doc
}

beforeEach(() => {
  Object.assign(config, { maxDocBytes: 1024 * 1024, maxDocStorageBytes: 65536, yjsStorageGzip: true, yjsWriteV2: true })
})
afterEach(() => {
  Object.assign(config, original)
  for (const doc of documents.splice(0)) doc.destroy()
})

describe('versioned Yjs storage codec', () => {
  it.each([1, 2] as const)('round trips encoding %i without changing cells or causal identity', (encoding) => {
    const source = newDoc()
    source.transact(() => {
      for (let index = 0; index < 1000; index++) source.getMap('sheet').set(`default!${index}:0`, { v: index, t: 2, s: { bl: 1 } })
    })
    const state = encoding === 1 ? Y.encodeStateAsUpdate(source) : Y.encodeStateAsUpdateV2(source)
    const stored = encodeStorageState(state, encoding)
    expect(stored.encoding).toBe(encoding + 2)
    expect(stored.state.length).toBeLessThan(state.length)
    const decoded = decodeStorageState(stored.state, stored.encoding, 'roundtrip')
    expect(decoded.encoding).toBe(encoding)
    expect(Buffer.from(decoded.state)).toEqual(Buffer.from(state))
    const restored = newDoc()
    applyStoredState(restored, decoded)
    expect(restored.getMap('sheet').toJSON()).toEqual(source.getMap('sheet').toJSON())
    expect(Y.encodeStateVector(restored)).toEqual(Y.encodeStateVector(source))
  })

  it.each([1, 2] as const)('reads a legacy uncompressed encoding %i row', (encoding) => {
    const source = newDoc()
    source.getText('text').insert(0, 'legacy')
    const state = encoding === 1 ? Y.encodeStateAsUpdate(source) : Y.encodeStateAsUpdateV2(source)
    expect(decodeStorageState(state, encoding, 'legacy')).toEqual({ state, encoding })
  })

  it('defaults legacy null encoding to v1', () => {
    const state = Y.encodeStateAsUpdate(newDoc())
    expect(decodeStorageState(state, null, 'legacy').encoding).toBe(1)
  })

  it('reads gzip rows even with gzip writes disabled', () => {
    const state = Buffer.alloc(20000, 42)
    const stored = encodeStorageState(state, 2)
    Object.assign(config, { yjsStorageGzip: false })
    expect(Buffer.from(decodeStorageState(stored.state, 4, 'rollout').state)).toEqual(state)
    expect(encodeStorageState(state, 2).encoding).toBe(2)
  })

  it('keeps the original representation when gzip adds overhead', () => {
    const state = Y.encodeStateAsUpdateV2(newDoc())
    const stored = encodeStorageState(state, 2)
    expect(stored.encoding).toBe(2)
    expect(stored.state).toEqual(Buffer.from(state))
  })

  it('rejects unsupported encodings instead of producing an empty document', () => {
    for (const encoding of [0, 5, 99, '2']) {
      expect(() => decodeStorageState(Buffer.from([0, 0]), encoding, 'future')).toThrow(UnknownEncodingError)
    }
  })

  it('rejects corrupt gzip CRC and truncated streams', () => {
    const stored = encodeStorageState(Buffer.alloc(20000, 42), 2)
    const corrupted = Buffer.from(stored.state)
    corrupted[corrupted.length - 8] = corrupted[corrupted.length - 8]! ^ 1
    expect(() => decodeStorageState(corrupted, 4, 'crc')).toThrow()
    expect(() => decodeStorageState(stored.state.subarray(0, -5), 4, 'truncated')).toThrow()
  })

  it('bounds decompression even when the compressed bytes fit', () => {
    const compressed = gzipSync(Buffer.alloc(65537))
    Object.assign(config, { maxDocBytes: 65536 })
    expect(() => decodeStorageState(compressed, 4, 'bomb')).toThrow()
  })

  it('accepts the exact decoded boundary and rejects one byte above it', () => {
    Object.assign(config, { maxDocBytes: 65536 })
    expect(() => encodeStorageState(Buffer.alloc(65536), 2)).not.toThrow()
    expect(() => encodeStorageState(Buffer.alloc(65537), 2)).toThrow(StorageBudgetError)
  })

  it('accepts the exact stored boundary and rejects one byte less budget', () => {
    const state = Buffer.alloc(65536)
    const stored = encodeStorageState(state, 2)
    Object.assign(config, { maxDocStorageBytes: stored.state.length })
    expect(() => encodeStorageState(state, 2)).not.toThrow()
    Object.assign(config, { maxDocStorageBytes: stored.state.length - 1 })
    expect(() => encodeStorageState(state, 2)).toThrow(StorageBudgetError)
  })

  it.each([1, 2] as const)('keeps legacy encoding %i readable after lowering write budgets', (encoding) => {
    const source = newDoc()
    source.getText('text').insert(0, 'recover existing content')
    const state = encoding === 1 ? Y.encodeStateAsUpdate(source) : Y.encodeStateAsUpdateV2(source)
    Object.assign(config, { maxDocBytes: 1, maxDocStorageBytes: 1, yjsStorageGzip: false })
    const decoded = decodeStorageState(state, encoding, 'legacy-overcap')
    const restored = newDoc()
    applyStoredState(restored, decoded)
    expect(restored.getText('text').toString()).toBe('recover existing content')
    expect(() => encodeStorageState(state, encoding)).toThrow(StorageBudgetError)
  })

  it.each([1, 2] as const)('keeps compressed encoding %i readable after lowering the stored write budget', (encoding) => {
    const source = newDoc()
    source.getText('text').insert(0, 'recover existing content'.repeat(100))
    const state = encoding === 1 ? Y.encodeStateAsUpdate(source) : Y.encodeStateAsUpdateV2(source)
    const stored = encodeStorageState(state, encoding)
    expect(stored.encoding).toBe(encoding + 2)
    Object.assign(config, { maxDocStorageBytes: stored.state.length - 1 })
    const decoded = decodeStorageState(stored.state, stored.encoding, 'compressed-overcap')
    expect(Buffer.from(decoded.state)).toEqual(Buffer.from(state))
    expect(() => encodeStorageState(state, encoding)).toThrow(StorageBudgetError)
  })

  it('rejects poorly compressible content at the storage gate', () => {
    Object.assign(config, { maxDocStorageBytes: 1024 })
    expect(() => encodeStorageState(randomBytes(8192), 2)).toThrow(StorageBudgetError)
  })

  it('preflights storage overflow before a live edit while keeping raw size reporting', () => {
    const source = newDoc()
    source.getMap('sheet').set('default!0:0', { v: randomBytes(8192).toString('hex') })
    Object.assign(config, { maxDocStorageBytes: 1024 })
    expect(() => persistedByteLength(source)).toThrow(StorageBudgetError)
    Object.assign(config, { maxDocStorageBytes: 65536 })
    expect(persistedByteLength(source)).toBe(Y.encodeStateAsUpdateV2(source).length)
    Object.assign(config, { maxDocBytes: 1 })
    expect(persistedByteLength(source)).toBeGreaterThan(config.maxDocBytes)
  })

  it('preserves concurrent edits, same-cell convergence and deletions after reload', () => {
    const left = newDoc()
    left.getMap('sheet').set('remove', { v: 'remove me' })
    const right = newDoc()
    const stored = encodeStorageState(Y.encodeStateAsUpdateV2(left), 2)
    applyStoredState(right, decodeStorageState(stored.state, stored.encoding, 'peer'))
    left.getMap('sheet').set('left', { v: 1 })
    right.getMap('sheet').set('right', { v: 2 })
    left.getMap('sheet').set('same', { v: 'left' })
    right.getMap('sheet').set('same', { v: 'right' })
    right.getMap('sheet').delete('remove')
    const leftUpdate = Y.encodeStateAsUpdateV2(left, Y.encodeStateVector(right))
    const rightUpdate = Y.encodeStateAsUpdateV2(right, Y.encodeStateVector(left))
    Y.applyUpdateV2(left, rightUpdate)
    Y.applyUpdateV2(right, leftUpdate)
    expect(left.getMap('sheet').toJSON()).toEqual(right.getMap('sheet').toJSON())
    expect(left.getMap('sheet').size).toBe(3)
    const reloaded = newDoc()
    const merged = encodeStorageState(Y.encodeStateAsUpdateV2(left), 2)
    applyStoredState(reloaded, decodeStorageState(merged.state, merged.encoding, 'merged'))
    expect(reloaded.getMap('sheet').toJSON()).toEqual(left.getMap('sheet').toJSON())
    expect(Y.encodeStateVector(reloaded)).toEqual(Y.encodeStateVector(left))
  })
})
