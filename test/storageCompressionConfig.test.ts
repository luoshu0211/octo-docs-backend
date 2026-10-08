import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadCompression(raw: string | undefined) {
  vi.resetModules()
  vi.stubEnv('YJS_STORAGE_GZIP', raw)
  vi.stubEnv('MAX_DOC_BYTES', undefined)
  vi.stubEnv('MAX_DOC_STORAGE_BYTES', undefined)
  const { config } = await import('../src/config/env.js')
  const codec = await import('../src/collab/storageCodec.js')
  return { config, ...codec }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('automatic storage compression defaults', () => {
  it.each([undefined, ''])('compresses without opting in when the value is %s', async (raw) => {
    const { config, encodeStorageState, decodeStorageState } = await loadCompression(raw)
    expect(config.yjsStorageGzip).toBe(true)
    expect(config.maxDocBytes).toBe(10485760)
    expect(config.maxDocStorageBytes).toBe(0)
    const state = Buffer.from('automatically compressed state'.repeat(1000))
    const stored = encodeStorageState(state, 2)
    expect(stored.encoding).toBe(4)
    expect(stored.state.length).toBeLessThan(state.length)
    expect(Buffer.from(decodeStorageState(stored.state, 4, 'automatic').state)).toEqual(state)
  })

  it.each(['false', '0'])('allows an explicit %s rollout override without disabling compressed reads', async (raw) => {
    const enabled = await loadCompression(undefined)
    const state = Buffer.from('compatibility rollout state'.repeat(1000))
    const stored = enabled.encodeStorageState(state, 2)
    expect(stored.encoding).toBe(4)
    const disabled = await loadCompression(raw)
    expect(disabled.config.yjsStorageGzip).toBe(false)
    expect(disabled.encodeStorageState(state, 2).encoding).toBe(2)
    expect(Buffer.from(disabled.decodeStorageState(stored.state, 4, 'rollout').state)).toEqual(state)
  })

  it.each(['true', '1'])('accepts an explicit %s value', async (raw) => {
    expect((await loadCompression(raw)).config.yjsStorageGzip).toBe(true)
  })

  it('rejects a mistyped rollout override', async () => {
    await expect(loadCompression('yes')).rejects.toThrow(/YJS_STORAGE_GZIP/)
  })
})
