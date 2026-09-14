import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'

/** PPT derives its endpoint from the existing trusted collaboration URL. */

// A production env in which EVERY other boot gate is satisfied, so only the
// PPT_RELAY_PUBLIC_WS_URL gate is under test.
const BASE_PROD_ENV: Record<string, string> = {
  NODE_ENV: 'production',
  ATTACHMENT_SIGNING_SECRET: 'a-real-prod-attachment-secret',
  COLLAB_TOKEN_PUBLIC_WS_URL: 'wss://collab.example.com',
  CARD_DISPLAY_TIME_ZONE: 'UTC',
}

async function loadConfigWith(env: Record<string, string | undefined>): Promise<unknown> {
  vi.resetModules()
  for (const [k, v] of Object.entries(env)) {
    // An empty string is the unset-equivalent here: both `str(name, '')` and
    // `strictBool(name, false)` treat '' exactly like a missing var.
    vi.stubEnv(k, v ?? '')
  }
  const mod = await import('../src/config/env.js')
  return (mod as { config: unknown }).config
}

describe('PPT relay public WS URL boot gate (XIN-1825 P1-2)', () => {
  beforeEach(() => {
    // Clear the two relay knobs so each case starts from a known-unset baseline;
    // stubEnv restores them after the test.
    vi.stubEnv('PPT_RELAY_ENABLED', '')
    vi.stubEnv('PPT_RELAY_PUBLIC_WS_URL', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('relay DISABLED + PPT_RELAY_PUBLIC_WS_URL unset => boots clean in production (was: bricked every doc type)', async () => {
    const config = (await loadConfigWith({
      ...BASE_PROD_ENV,
      PPT_RELAY_ENABLED: 'false',
      PPT_RELAY_PUBLIC_WS_URL: '',
    })) as { ppt: { relay: { enabled: boolean; publicWsUrl: string } } }
    expect(config.ppt.relay.enabled).toBe(false)
    expect(config.ppt.relay.publicWsUrl).toBe('') // inert, never consulted while disabled
  })

  it('relay UNSET (default on) + PPT_RELAY_PUBLIC_WS_URL unset => boots clean in production', async () => {
    const config = (await loadConfigWith({
      ...BASE_PROD_ENV,
      // PPT_RELAY_ENABLED omitted -> defaults to true
      PPT_RELAY_PUBLIC_WS_URL: '',
    })) as { ppt: { relay: { enabled: boolean } } }
    expect(config.ppt.relay.enabled).toBe(true)
  })

  it('reuses the existing URL without extra PPT configuration', async () => {
    const config = await loadConfigWith({ ...BASE_PROD_ENV,
      COLLAB_TOKEN_PUBLIC_WS_URL: 'wss://im-test.example.com/docs-collab', OCTO_WEB_ORIGIN: '',
    }) as { webOrigin: string; ppt: { relay: { enabled: boolean; publicWsUrl: string } } }
    expect(config.ppt.relay).toMatchObject({ enabled: true, publicWsUrl: 'wss://im-test.example.com/api/v1/ppt/collab' })
    expect(config.webOrigin).toBe('https://im-test.example.com')
  })

  it.each(['https://wrong.example.com', 'wss://user:password@example.com', 'wss://example.com/?token=secret', 'wss://example.com/#fragment'])('rejects an unsafe override %s', async url => {
    await expect(loadConfigWith({ ...BASE_PROD_ENV, PPT_RELAY_PUBLIC_WS_URL: url })).rejects.toThrow()
  })

  it('relay ENABLED + PPT_RELAY_PUBLIC_WS_URL set => boots in production', async () => {
    const config = (await loadConfigWith({
      ...BASE_PROD_ENV,
      PPT_RELAY_ENABLED: 'true',
      PPT_RELAY_PUBLIC_WS_URL: 'wss://ppt-relay.example.com',
    })) as { ppt: { relay: { enabled: boolean; publicWsUrl: string } } }
    expect(config.ppt.relay.enabled).toBe(true)
    expect(config.ppt.relay.publicWsUrl).toBe('wss://ppt-relay.example.com')
  })
})
