import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Integration shape of the 2026-08-21 oversize incident, at the seam that
 * actually failed: `persistence.store` rejects the write, but nothing stopped
 * the document from accepting the NEXT one. These tests pin the two halves of
 * the fix — arm on rejection, disarm on a successful store — with the database
 * mocked out, so they exercise the guard wiring rather than MySQL.
 */

const TINY_LIMIT = 1024

vi.mock('../src/config/env.js', () => ({
  config: { maxDocBytes: TINY_LIMIT },
}))

const upsertStateTx = vi.fn(async () => {})
const selectForUpdateTx = vi.fn(async () => null)
const txQuery = vi.fn(async () => [])

vi.mock('../src/db/pool.js', () => ({
  transaction: async (fn: (tx: { query: typeof txQuery }) => Promise<void>) => fn({ query: txQuery }),
}))

vi.mock('../src/db/repos/yjsDocumentRepo.js', () => ({
  yjsDocumentRepo: {
    fetchState: async () => null,
    selectForUpdateTx: (...a: unknown[]) => selectForUpdateTx(...(a as [])),
    upsertStateTx: (...a: unknown[]) => upsertStateTx(...(a as [])),
  },
}))

import * as Y from 'yjs'

/**
 * Build a document whose v2 encoding lands either side of TINY_LIMIT. The cap is
 * now measured against the v2 bytes we actually persist, so the fixture has to
 * be a real document rather than a raw byte array.
 */
function docOfAtLeast(bytes: number): Y.Doc {
  const doc = new Y.Doc()
  const text = doc.getText('t')
  while (Y.encodeStateAsUpdateV2(doc).length <= bytes) {
    doc.transact(() => text.insert(text.length, 'x'.repeat(256)))
  }
  return doc
}

const { persistence } = await import('../src/collab/persistence.js')
const { getOversized, resetOversizedForTest } = await import('../src/collab/oversizeGuard.js')

const DOC = 'octo:space:f_default:d_incident'
const small = (): Y.Doc => new Y.Doc()
const huge = (): Y.Doc => docOfAtLeast(TINY_LIMIT)

describe('persistence.store oversize guard wiring', () => {
  beforeEach(() => {
    resetOversizedForTest()
    upsertStateTx.mockClear()
  })

  it('an oversized store is rejected AND arms the guard', async () => {
    await expect(persistence.store(DOC, huge())).rejects.toThrow(/exceeds max size/)
    expect(getOversized(DOC)?.bytes).toBeGreaterThan(TINY_LIMIT)
    expect(getOversized(DOC)?.limit).toBe(TINY_LIMIT)
  })

  it('the oversized store never reaches the database', async () => {
    await expect(persistence.store(DOC, huge())).rejects.toThrow()
    // The throw is before `transaction(...)`, so no row is locked or written —
    // this is what keeps a 17 MB decode out of the row lock.
    expect(upsertStateTx).not.toHaveBeenCalled()
  })

  it('a successful store disarms the guard (document shrank back under the cap)', async () => {
    await expect(persistence.store(DOC, huge())).rejects.toThrow()
    expect(getOversized(DOC)).not.toBeNull()

    await persistence.store(DOC, small())
    expect(upsertStateTx).toHaveBeenCalledTimes(1)
    expect(getOversized(DOC)).toBeNull()
  })

  it('a small store on a healthy document leaves the guard disarmed', async () => {
    await persistence.store(DOC, small())
    expect(getOversized(DOC)).toBeNull()
  })

  it('arming one document does not arm another', async () => {
    await expect(persistence.store(DOC, huge())).rejects.toThrow()
    expect(getOversized('octo:space:f_default:d_bystander')).toBeNull()
  })
})
