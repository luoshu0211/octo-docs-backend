import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * TES-150 — driveDerived internal token split. The single shared internalToken was
 * split into two independent tokens: inboundToken (DOCS_INTERNAL_TOKEN, validated on
 * the drive -> docs role endpoint) and outboundToken (DRIVE_INTERNAL_TOKEN, sent on
 * the docs -> drive derived-access lookup). No cross-fallback: each direction fails
 * closed on its own when its token is unset. These pin the env resolution.
 */
async function loadTokens(env: { docs?: string; drive?: string }) {
  vi.resetModules()
  vi.stubEnv('DOCS_INTERNAL_TOKEN', env.docs ?? '')
  vi.stubEnv('DRIVE_INTERNAL_TOKEN', env.drive ?? '')
  const { config } = await import('../src/config/env.js')
  return {
    inbound: config.driveDerived.inboundToken,
    outbound: config.driveDerived.outboundToken,
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('driveDerived inbound/outbound token split (TES-150)', () => {
  it('resolves each token from its own env var, no cross-fallback', async () => {
    const { inbound, outbound } = await loadTokens({ docs: 'docs-tok', drive: 'drive-tok' })
    expect(inbound).toBe('docs-tok')
    expect(outbound).toBe('drive-tok')
  })

  it('only DOCS_INTERNAL_TOKEN set => inbound configured, outbound empty (out direction fails closed)', async () => {
    const { inbound, outbound } = await loadTokens({ docs: 'docs-tok' })
    expect(inbound).toBe('docs-tok')
    expect(outbound).toBe('')
  })

  it('only DRIVE_INTERNAL_TOKEN set => outbound configured, inbound empty (in direction 401s)', async () => {
    const { inbound, outbound } = await loadTokens({ drive: 'drive-tok' })
    expect(inbound).toBe('')
    expect(outbound).toBe('drive-tok')
  })
})
