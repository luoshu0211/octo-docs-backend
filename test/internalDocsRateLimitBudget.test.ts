import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { Server } from 'node:http'

/**
 * OCTO-456 F2 — `/internal/docs` rate-limit budgets must not be serialized.
 *
 * The two internal routers (legacy `/:docId/role` and the OCTO-456 library
 * contract) are both mounted at `/internal/docs`. A limiter mounted at that app
 * prefix runs for EVERY request that reaches the prefix, even when the router
 * behind it has no matching route (Express falls through), so a request to
 * `/status` used to decrement the role limiter too (and vice versa). With a
 * budget of 1 that made mutually unrelated first requests 429 each other.
 *
 * The fix attaches the limiter to each router's own route chains. These tests
 * pin the observable contract with max=1:
 *   - one request to each surface still succeeds, in either order;
 *   - the same route twice 429s on the second (the budget is real).
 *
 * The repos are mocked; the internal token guard is the real one.
 */
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: {
    getByDocId: vi.fn(async () => ({
      doc_id: 'd1',
      title: 'Doc',
      doc_type: 'doc',
      owner_id: 'owner',
      owner_space_id: 's1',
      space_id: 's1',
      status: 1,
      permission_epoch: 3,
    })),
    getByDocIds: vi.fn(async () => []),
    getLegacyVisibleDocIds: vi.fn(async () => new Set()),
    listSharedWithUser: vi.fn(async () => ({ items: [], nextCursor: null })),
    listReadableForUser: vi.fn(async () => ({ items: [], nextCursor: null })),
  },
  DocOwnershipError: class DocOwnershipError extends Error {},
}))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  docMemberRepo: {
    getRole: vi.fn(async () => 'reader'),
    getRoles: vi.fn(async () => new Map()),
  },
  SOURCE_DIRECT: 1,
  SOURCE_INVITE: 2,
}))
vi.mock('../src/permission/resolveRole.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/permission/resolveRole.js')>()
  return { ...actual, resolveRole: vi.fn(async () => 'reader') }
})

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

const TOKEN = 'octo-456-f2-token'
const mutableConfig = config as unknown as { driveDerived: { inboundToken: string } }
let originalToken = ''
const servers: Server[] = []

async function listen(): Promise<string> {
  // A fresh app (and therefore fresh limiter stores) per test: budgets must not
  // leak between test cases through express-rate-limit's in-process store.
  const server = new Server(createApp({ surface: 'internal', rateLimit: { windowMs: 60_000, max: 1 } }))
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

function status(base: string): Promise<Response> {
  return fetch(`${base}/internal/docs/status`, {
    method: 'POST',
    headers: { 'x-internal-token': TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ uid: 'u1', principal_space_id: 's1', doc_ids: [] }),
  })
}

function role(base: string): Promise<Response> {
  return fetch(`${base}/internal/docs/d1/role?uid=u1&principal_space_id=s1`, {
    headers: { 'x-internal-token': TOKEN },
  })
}

beforeAll(() => {
  setOctoIdentity(denyAllIdentity())
  originalToken = mutableConfig.driveDerived.inboundToken
  mutableConfig.driveDerived.inboundToken = TOKEN
})

beforeEach(() => {
  mutableConfig.driveDerived.inboundToken = TOKEN
})

afterAll(() => {
  mutableConfig.driveDerived.inboundToken = originalToken
})

afterAll(async () => {
  for (const server of servers) {
    await new Promise<void>((resolve, reject) => {
      server.closeAllConnections()
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
})

describe('/internal/docs limiter budgets are independent per surface (max=1)', () => {
  it('status followed by role: both first requests succeed', async () => {
    const base = await listen()
    const first = await status(base)
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ items: [] })

    const second = await role(base)
    expect(second.status).toBe(200)
    expect(await second.json()).toMatchObject({ role: 'reader', doc_status: 1 })
  })

  it('role followed by status: both first requests succeed (reverse order)', async () => {
    const base = await listen()
    const first = await role(base)
    expect(first.status).toBe(200)

    const second = await status(base)
    expect(second.status).toBe(200)
  })

  it('the same route twice still 429s on the second request (budget is real)', async () => {
    const base = await listen()
    expect((await status(base)).status).toBe(200)
    const second = await status(base)
    expect(second.status).toBe(429)
    expect(await second.json()).toEqual({ error: 'rate_limited' })

    const roleBase = await listen()
    expect((await role(roleBase)).status).toBe(200)
    expect((await role(roleBase)).status).toBe(429)
  })
})
