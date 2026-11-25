import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { Server } from 'node:http'

/**
 * OCTO-456 surface split — the four `/internal/docs/*` service-to-service routes.
 *
 * They must live ONLY on the internal listener and stay behind the shared
 * `X-Internal-Token`: no token or a wrong token is 401 (the token guard ran, so
 * the mount exists), while the public listener 404s them (the guard never runs
 * there). This is the mount-layer counterpart of the handler-level
 * internalDocsLibrary.test.ts — it proves createApp actually wires the router
 * onto the internal surface, which a direct handler call cannot.
 *
 * The repos are mocked so no MySQL/Redis is needed. Identity denies every
 * caller: these routes are token-authenticated, not user-authenticated.
 */
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: {
    getByDocIds: vi.fn(async () => []),
    getLegacyVisibleDocIds: vi.fn(async () => new Set()),
    listSharedWithUser: vi.fn(async () => ({ items: [], nextCursor: null })),
    listReadableForUser: vi.fn(async () => ({ items: [], nextCursor: null })),
    listForUser: vi.fn(async () => ({ total: 0, items: [] })),
    getByDocId: vi.fn(async () => null),
  },
  MAX_LIBRARY_PAGE_SIZE: 500,
  DocOwnershipError: class DocOwnershipError extends Error {},
}))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  docMemberRepo: { getRoles: vi.fn(async () => new Map()), getRole: vi.fn(async () => undefined) },
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

const TOKEN = 'octo-456-surface-token'
const mutableConfig = config as unknown as { driveDerived: { inboundToken: string } }
let originalToken = ''
let internalServer: Server
let publicServer: Server
let internalBase = ''
let publicBase = ''

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

/** One request shape per mounted route; `doc_ids: []` never touches a repo. */
const routes = [
  {
    name: 'POST /internal/docs/status',
    method: 'POST',
    path: '/internal/docs/status',
    body: { uid: 'u1', principal_space_id: 's1', doc_ids: [] },
    okBody: { items: [] },
  },
  {
    name: 'POST /internal/docs/capabilities',
    method: 'POST',
    path: '/internal/docs/capabilities',
    body: { uid: 'u1', principal_space_id: 's1', doc_ids: [] },
    okBody: { items: [] },
  },
  {
    name: 'GET /internal/docs/shared',
    method: 'GET',
    path: '/internal/docs/shared?uid=u1&principal_space_id=s1',
    body: undefined,
    okBody: { items: [], next_cursor: null, has_more: false },
  },
  {
    name: 'GET /internal/docs/readable',
    method: 'GET',
    path: '/internal/docs/readable?uid=u1&principal_space_id=s1',
    body: undefined,
    okBody: { items: [], next_cursor: null, has_more: false },
  },
] as const

function call(base: string, route: (typeof routes)[number], token?: string) {
  return fetch(base + route.path, {
    method: route.method,
    headers: {
      ...(route.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === undefined ? {} : { 'x-internal-token': token }),
    },
    ...(route.body === undefined ? {} : { body: JSON.stringify(route.body) }),
  })
}

beforeAll(async () => {
  setOctoIdentity(denyAllIdentity())
  originalToken = mutableConfig.driveDerived.inboundToken
  mutableConfig.driveDerived.inboundToken = TOKEN
  internalServer = new Server(createApp({ surface: 'internal' }))
  publicServer = new Server(createApp({ surface: 'public' }))
  internalBase = await listen(internalServer)
  publicBase = await listen(publicServer)
})

afterAll(async () => {
  mutableConfig.driveDerived.inboundToken = originalToken
  for (const server of [internalServer, publicServer]) {
    await new Promise<void>((resolve, reject) => {
      server.closeAllConnections()
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
})

describe('internal surface: /internal/docs/* mounts', () => {
  it.each(routes)('$name is reachable with a valid token', async (route) => {
    const res = await call(internalBase, route, TOKEN)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(route.okBody)
  })

  it.each(routes)('$name rejects a missing token with 401', async (route) => {
    const res = await call(internalBase, route)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })

  it.each(routes)('$name rejects a wrong token with 401', async (route) => {
    const res = await call(internalBase, route, 'wrong-token')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })
})

describe('public surface: /internal/docs/* is NOT mounted', () => {
  it.each(routes)('$name 404s (the internal-token guard never runs)', async (route) => {
    const res = await call(publicBase, route, TOKEN)
    expect(res.status).toBe(404)
  })
})
