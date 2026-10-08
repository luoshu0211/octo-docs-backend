import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { query, type Tx } from '../src/db/pool.js'
import { config } from '../src/config/env.js'
import { yjsDocumentRepo } from '../src/db/repos/yjsDocumentRepo.js'
import { encodeStorageState, UnknownEncodingError } from '../src/collab/storageCodec.js'

vi.mock('../src/db/pool.js', () => ({ query: vi.fn() }))
const original = { maxDocBytes: config.maxDocBytes, maxDocStorageBytes: config.maxDocStorageBytes, yjsStorageGzip: config.yjsStorageGzip }
beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(config, { maxDocBytes: 65536, maxDocStorageBytes: 8192, yjsStorageGzip: true })
})
afterEach(() => Object.assign(config, original))

describe('compressed database rows', () => {
  it('stores the physical length and new encoding, and normalizes both reads', async () => {
    const doc = new Y.Doc()
    doc.getText('text').insert(0, 'hello'.repeat(3000))
    const state = Y.encodeStateAsUpdateV2(doc)
    const expected = encodeStorageState(state, 2)
    const tx = { query: vi.fn().mockResolvedValue([]), execute: vi.fn() } as unknown as Tx
    await yjsDocumentRepo.upsertStateTx(tx, 'compressed', Buffer.from(state), 2)
    expect(tx.query).toHaveBeenCalledWith(expect.any(String), ['compressed', expected.state, expected.state.length, 4])
    const row = { state: expected.state, encoding: 4 }
    vi.mocked(query).mockResolvedValue([row])
    vi.mocked(tx.query).mockResolvedValue([row])
    for (const decoded of [await yjsDocumentRepo.fetchState('compressed'), await yjsDocumentRepo.selectForUpdateTx(tx, 'compressed')]) {
      expect(decoded?.encoding).toBe(2)
      expect(Buffer.from(decoded!.state)).toEqual(Buffer.from(state))
    }
    doc.destroy()
  })

  it('keeps missing rows distinct from unreadable rows', async () => {
    vi.mocked(query).mockResolvedValue([])
    expect(await yjsDocumentRepo.fetchState('missing')).toBeNull()
    vi.mocked(query).mockResolvedValue([{ state: Buffer.from([0, 0]), encoding: 99 }])
    await expect(yjsDocumentRepo.fetchState('unknown')).rejects.toBeInstanceOf(UnknownEncodingError)
    vi.mocked(query).mockResolvedValue([{ state: Buffer.from('not gzip'), encoding: 4 }])
    await expect(yjsDocumentRepo.fetchState('corrupt')).rejects.toThrow()
  })
})
