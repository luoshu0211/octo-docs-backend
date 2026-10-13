import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { loadBenchmarkSheet } from '../scripts/benchmarkStorageDocument.js'
import { persistence } from '../src/collab/persistence.js'
import { assertStateGeneration } from '../src/collab/stateGeneration.js'

vi.mock('../src/collab/persistence.js', () => ({ persistence: { fetch: vi.fn() } }))
const generation = '00000000-0000-4000-8000-000000000001'
afterEach(() => vi.clearAllMocks())

describe('benchmark documents use the paired persistence state and generation', () => {
  it.each([1, 2] as const)('loads V%i data and binds the fetched identity before editing', async encoding => {
    const source = new Y.Doc()
    source.getMap('sheet').set('cell', { v: 'existing value' })
    const state = encoding === 1 ? Y.encodeStateAsUpdate(source) : Y.encodeStateAsUpdateV2(source)
    vi.mocked(persistence.fetch).mockResolvedValue({ state, encoding, generation })
    const restored = await loadBenchmarkSheet('benchmark-sheet')
    try {
      expect(persistence.fetch).toHaveBeenCalledWith('benchmark-sheet')
      expect(restored.getMap('sheet').toJSON()).toEqual(source.getMap('sheet').toJSON())
      expect(Y.encodeStateVector(restored)).toEqual(Y.encodeStateVector(source))
      expect(() => assertStateGeneration(restored, generation)).not.toThrow()
      expect(() => assertStateGeneration(restored, 'another-generation')).toThrow()
    } finally { source.destroy(); restored.destroy() }
  })

  it('refuses an unregistered/non-sheet result instead of constructing an unbound writer', async () => {
    vi.mocked(persistence.fetch).mockResolvedValue(null)
    await expect(loadBenchmarkSheet('missing')).rejects.toThrow('registered sheet')
  })
})
