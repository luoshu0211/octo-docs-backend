import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadCompression(raw: string | undefined) {
  vi.resetModules()
  vi.stubEnv('YJS_STORAGE_GZIP', raw)
  vi.stubEnv('MAX_DOC_BYTES', undefined)
  vi.stubEnv('MAX_DOC_STORAGE_BYTES', undefined)
  vi.stubEnv('SHEET_READ_MAX_CELL_BYTES', undefined)
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
    expect(config.maxDocBytes).toBe(20971520)
    expect(config.sheetRead.maxCellBytes).toBe(config.maxDocBytes)
    expect(config.maxDocStorageBytes).toBe(0)
    const state = Buffer.from('automatically compressed state'.repeat(1000))
    const stored = encodeStorageState(state, 2)
    expect(stored.encoding).toBe(4)
    expect(stored.state.length).toBeLessThan(state.length)
    expect(Buffer.from(decodeStorageState(stored.state, 4, 'automatic').state)).toEqual(state)
  })

  it('round-trips exactly 20 MiB and rejects one byte more before compression', async () => {
    const { encodeStorageState, decodeStorageState } = await loadCompression(undefined)
    const state = Buffer.alloc(20 * 1024 * 1024, 0x41)
    const stored = encodeStorageState(state, 2)
    expect(Buffer.from(decodeStorageState(stored.state, stored.encoding, 'boundary').state).equals(state)).toBe(true)
    expect(() => encodeStorageState(Buffer.alloc(state.length + 1), 2)).toThrow()
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

  it('inherits a configured document cap but preserves an explicit sheet-read override', async () => {
    await loadCompression(undefined)
    vi.stubEnv('MAX_DOC_BYTES', '10485760')
    vi.resetModules()
    expect((await import('../src/config/env.js')).config.sheetRead.maxCellBytes).toBe(10485760)
    vi.stubEnv('SHEET_READ_MAX_CELL_BYTES', '1048576')
    vi.resetModules()
    expect((await import('../src/config/env.js')).config.sheetRead.maxCellBytes).toBe(1048576)
  })
})
