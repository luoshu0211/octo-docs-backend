import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/api/app.js'
import { HttpOctoIdentity, setOctoIdentity } from '../src/auth/octoIdentity.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { docInviteRepo } from '../src/db/repos/docInviteRepo.js'

// Real HTTP on both sides of the production router. Only the identity authority
// is a fixture; no production credentials, database or external service is used.
let authority: Server
let app: Server
let origin: string
let authorityOrigin: string
let upstreamStatus = 200
let upstreamBody = JSON.stringify({ uid: 'u_fixture', name: 'Fixture', owned_bots: [] })
let upstreamCalls = 0
let disconnect = false

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

beforeAll(async () => {
  authority = createServer((req, res) => {
    upstreamCalls++
    req.resume()
    if (disconnect) { req.socket.destroy(); return }
    res.writeHead(upstreamStatus, { 'Content-Type': 'application/json' })
    res.end(upstreamBody)
  })
  authorityOrigin = await listen(authority)
  setOctoIdentity(new HttpOctoIdentity(authorityOrigin))
  app = createServer(createApp({ rateLimit: { max: 10_000 } }))
  origin = await listen(app)
})

afterAll(async () => {
  for (const server of [app, authority]) {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
  }
})

beforeEach(() => {
  upstreamStatus = 200
  upstreamBody = JSON.stringify({ uid: 'u_fixture', name: 'Fixture', owned_bots: [] })
  upstreamCalls = 0
  disconnect = false
  vi.spyOn(docMetaRepo, 'getByDocId').mockResolvedValue(null)
  vi.spyOn(docInviteRepo, 'getForUpdateTx').mockRejectedValue(new Error('must not redeem an invite without identity'))
})
afterEach(() => vi.restoreAllMocks())

const paths = [
  ['document', '/api/v1/docs/d_fixture', 'GET', undefined, 503],
  ['open context', '/api/v1/docs/d_fixture/open-context', 'GET', undefined, 503],
  ['notifications', '/api/v1/docs/notifications/member-added', 'GET', undefined, 503],
  ['document collab token', '/api/v1/docs/d_fixture/collab-token', 'POST', {}, 503],
  ['legacy collab token', '/api/v1/docs/collab-token', 'POST', { documentName: 'octo:s_fixture:f_default:d_fixture' }, 503],
  ['invite', '/api/v1/docs/invites/invite_fixture/accept', 'POST', {}, 503],
  ['PPT source', '/api/v1/ppt/docs/d_fixture/source', 'GET', undefined, 502],
] as const

async function request(path: string, method: string, body?: unknown, token = 'fixture-session') {
  return fetch(origin + path, {
    method,
    headers: { token, 'X-Space-Id': 's_fixture', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(3000),
  })
}

describe.each(paths)('%s identity dependency failures', (_name, path, method, body, status) => {
  it.each([429, 500, 502, 503, 504])('does not turn upstream %i into a session-expired 401', async (upstream) => {
    upstreamStatus = upstream
    upstreamBody = JSON.stringify({ error: 'upstream-private-detail' })
    const response = await request(path, method, body)
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual(status === 502
      ? { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'identity service unavailable' } }
      : { error: 'identity_unavailable' })
    expect(upstreamCalls).toBe(1)
    expect(docMetaRepo.getByDocId).not.toHaveBeenCalled()
    expect(docInviteRepo.getForUpdateTx).not.toHaveBeenCalled()
  })

  it('keeps genuinely invalid sessions at 401', async () => {
    upstreamStatus = 401
    expect((await request(path, method, body)).status).toBe(401)
    expect(upstreamCalls).toBe(1)
    expect(docMetaRepo.getByDocId).not.toHaveBeenCalled()
  })

  it('rejects missing sessions without contacting the authority', async () => {
    expect((await request(path, method, body, '')).status).toBe(401)
    expect(upstreamCalls).toBe(0)
  })
})

describe('identity transport and recovery', () => {
  it('returns a service error when the authority disconnects', async () => {
    disconnect = true
    expect((await request('/api/v1/docs/d_fixture', 'GET')).status).toBe(503)
    expect(docMetaRepo.getByDocId).not.toHaveBeenCalled()
  })

  it.each(['{', '{}', 'null', '[]', '{"uid":12}', '{"uid":""}'])('does not expire the session on a malformed identity response: %s', async (body) => {
    upstreamBody = body
    expect((await request('/api/v1/docs/d_fixture', 'GET')).status).toBe(503)
    expect(docMetaRepo.getByDocId).not.toHaveBeenCalled()
  })

  it('uses the same session after recovery without caching an outage or granting access', async () => {
    upstreamStatus = 429
    expect((await request('/api/v1/docs/d_fixture', 'GET')).status).toBe(503)
    expect(docMetaRepo.getByDocId).not.toHaveBeenCalled()
    upstreamStatus = 200
    // The verified caller now reaches the real document guard and its missing
    // document check. A recovered identity is not a document access grant.
    expect((await request('/api/v1/docs/d_fixture', 'GET')).status).toBe(404)
    expect(docMetaRepo.getByDocId).toHaveBeenCalledTimes(1)
    expect(upstreamCalls).toBe(2)
  })
})
