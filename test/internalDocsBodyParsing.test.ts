import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { Server } from 'node:http'

/**
 * P1-1 — internal library POST bodies are parsed only AFTER the route limiter and
 * the X-Internal-Token check. The global 1 MiB express.json parser must not see
 * /internal/docs/**, otherwise an unauthenticated caller spends parser CPU/memory
 * and a malformed body fails before 401.
 *
 * Order pinned here: limiter -> token (401) -> 64 KiB JSON (400/413) -> handler.
 */
import { createApp } from '../src/api/app.js'
import { config } from '../src/config/env.js'
import { setOctoIdentity, type OctoIdentity, type OctoUser } from '../src/auth/octoIdentity.js'

function denyAllIdentity(): OctoIdentity {
  return {
    verifyToken: async () => null,
    verifyBot: async () => null,
    getUser: async (): Promise<OctoUser | null> => null,
    getUsers: async (): Promise<OctoUser[]> => [],
    isSpaceMember: async () => false,
  }
}

const TOKEN = 'octo-456-body-token'
const mutableConfig = config as unknown as { driveDerived: { inboundToken: string } }
let originalToken = ''
const servers: Server[] = []

async function listen(rateLimit?: { windowMs: number; max: number }): Promise<string> {
  const server = new Server(createApp({ surface: 'internal', ...(rateLimit ? { rateLimit } : {}) }))
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

function call(base: string, opts: { token?: string; body: string }) {
  return fetch(`${base}/internal/docs/status`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(opts.token === undefined ? {} : { 'x-internal-token': opts.token }),
    },
    body: opts.body,
  })
}

beforeAll(() => {
  setOctoIdentity(denyAllIdentity())
  originalToken = mutableConfig.driveDerived.inboundToken
  mutableConfig.driveDerived.inboundToken = TOKEN
})

afterAll(async () => {
  mutableConfig.driveDerived.inboundToken = originalToken
  for (const server of servers) {
    await new Promise<void>((resolve, reject) => {
      server.closeAllConnections()
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
})

describe('/internal/docs body parsing runs after limiter + token', () => {
  it('an invalid token + malformed JSON is 401 (the parser never ran)', async () => {
    const base = await listen()
    const res = await call(base, { token: 'wrong', body: '{not-json' })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })

  it('an invalid token + oversized body is 401, not 413', async () => {
    const base = await listen()
    const res = await call(base, { token: 'wrong', body: JSON.stringify({ uid: 'u1', principal_space_id: 's1', doc_ids: [], pad: 'x'.repeat(80 * 1024) }) })
    expect(res.status).toBe(401)
  })

  it('a valid token + malformed JSON reaches the 64 KiB parser and returns 400', async () => {
    const base = await listen()
    const res = await call(base, { token: TOKEN, body: '{not-json' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_body' })
  })

  it('a valid token + oversized body is 413 from the route parser', async () => {
    const base = await listen()
    const res = await call(base, {
      token: TOKEN,
      body: JSON.stringify({ uid: 'u1', principal_space_id: 's1', doc_ids: [], pad: 'x'.repeat(80 * 1024) }),
    })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'doc_too_large' })
  })

  it('the limiter runs before the parser: a throttled malformed request is 429', async () => {
    const base = await listen({ windowMs: 60_000, max: 1 })
    const ok = await call(base, { token: TOKEN, body: JSON.stringify({ uid: 'u1', principal_space_id: 's1', doc_ids: [] }) })
    expect(ok.status).toBe(200)

    const throttled = await call(base, { token: TOKEN, body: '{not-json' })
    expect(throttled.status).toBe(429)
    expect(await throttled.json()).toEqual({ error: 'rate_limited' })
  })
})
