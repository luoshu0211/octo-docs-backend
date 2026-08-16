import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadFlag(raw: string | undefined): Promise<boolean> {
  vi.resetModules()
  vi.stubEnv('COLLAB_ALLOW_LEGACY_TOKENS_WITHOUT_HOME_SPACE_PROOF', raw ?? '')
  const { config } = await import('../src/config/env.js')
  return config.collabToken.allowLegacyWithoutHomeSpaceProof
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('legacy Home-Space token rollout config', () => {
  it('is strict when unset or false', async () => {
    expect(await loadFlag(undefined)).toBe(false)
    expect(await loadFlag('false')).toBe(false)
    expect(await loadFlag('0')).toBe(false)
  })

  it('enables only through an explicit true value', async () => {
    expect(await loadFlag('true')).toBe(true)
    expect(await loadFlag('1')).toBe(true)
  })

  it('fails startup on a mistyped value instead of silently widening compatibility', async () => {
    await expect(loadFlag('yes')).rejects.toThrow(/COLLAB_ALLOW_LEGACY_TOKENS_WITHOUT_HOME_SPACE_PROOF/)
  })
})
