import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { EventEmitter } from 'node:events'
import type { Request, Response } from 'express'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/api/app.js'
import { HttpOctoIdentity, setOctoIdentity } from '../src/auth/octoIdentity.js'
import { docMemberNotificationRepo } from '../src/db/repos/docMemberNotificationRepo.js'
import { identityVerificationScope } from '../src/auth/identityVerificationScope.js'

let authority: Server
let app: Server
let authorityOrigin: string
let origin: string
let identity: HttpOctoIdentity
let calls: { token: string; url: string }[]
let status: number
let context: boolean
let spaces: string[]
let hold = false
let waiting: (() => void)[] = []
let firstRequest: () => void = () => {}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function respond(res: ServerResponse, token: string) {
  res.writeHead(token === 'revoked' ? 401 : status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    uid: token === 'other-user' ? 'u_other' : 'u_fixture',
    owned_bots: ['bot_fixture'],
    ...(context ? { context_included: true, spaces, owned_bots_by_space: { s_fixture: ['bot_fixture'] } } : {}),
  }))
}

beforeAll(async () => {
  authority = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += String(chunk)
    const { token } = JSON.parse(body) as { token: string }
    calls.push({ token, url: req.url! })
    if (hold) waiting.push(() => respond(res, token))
    else respond(res, token)
    firstRequest()
  })
  authorityOrigin = await listen(authority)
  app = createServer(createApp({ rateLimit: { max: 10_000 } }))
  origin = await listen(app)
})

beforeEach(() => {
  calls = []
  status = 200
  context = true
  spaces = ['s_fixture']
  hold = false
  waiting = []
  firstRequest = () => {}
  identity = new HttpOctoIdentity(authorityOrigin)
  setOctoIdentity(identity)
  vi.spyOn(docMemberNotificationRepo, 'listUnread').mockResolvedValue({ unreadCount: 0, rows: [] })
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  for (const server of [app, authority]) {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
  }
})

async function notifications(token = 'session', spaceId = 's_fixture') {
  return fetch(origin + '/api/v1/docs/notifications/member-added', {
    headers: { token, 'X-Space-Id': spaceId },
    signal: AbortSignal.timeout(3000),
  })
}

describe('request-scoped identity verification', () => {
  it.each(['finish', 'close'])('stops reuse in inherited async work after response %s', async (event) => {
    const response = new EventEmitter()
    await new Promise<void>((resolve, reject) => {
      identityVerificationScope({} as Request, response as Response, () => {
        void (async () => {
          expect(await identity.verifyToken('session')).toMatchObject({ uid: 'u_fixture' })
          response.emit(event)
          status = 401
          // This continuation inherits the same AsyncLocalStorage context.
          expect(await identity.verifyToken('session')).toBeNull()
          expect(calls).toHaveLength(2)
        })().then(resolve, reject)
      })
    })
  })

  it('uses one authority call for both login and Space checks on the real notification route', async () => {
    const response = await notifications()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ unreadCount: 0, items: [] })
    expect(calls).toEqual([{ token: 'session', url: '/v1/auth/verify?include=context' }])
    expect(docMemberNotificationRepo.listUnread).toHaveBeenCalledWith({
      recipientUid: 'u_fixture', recipientSpaceId: 's_fixture', limit: 100,
    })
  })

  it('rechecks the same session on the next HTTP request and rejects revocation immediately', async () => {
    expect((await notifications()).status).toBe(200)
    status = 401
    expect((await notifications()).status).toBe(401)
    expect(calls).toHaveLength(2)
    expect(docMemberNotificationRepo.listUnread).toHaveBeenCalledTimes(1)
  })

  it('uses fresh verified Space context instead of an older membership cache', async () => {
    expect((await notifications()).status).toBe(200)
    spaces = []
    expect((await notifications()).status).toBe(404)
    expect(calls).toHaveLength(2)
    expect(docMemberNotificationRepo.listUnread).toHaveBeenCalledTimes(1)
  })

  it('never authorizes a client-supplied Space outside the verified membership', async () => {
    expect((await notifications('session', 's_foreign')).status).toBe(404)
    expect(calls).toHaveLength(1)
    expect(docMemberNotificationRepo.listUnread).not.toHaveBeenCalled()
  })

  it('keeps legacy identity responses usable without guessing missing Space context', async () => {
    context = false
    expect(await identity.verifyToken('session')).toMatchObject({ uid: 'u_fixture', ownedBots: ['bot_fixture'] })
    calls = []
    expect((await notifications()).status).toBe(404)
    expect(calls).toHaveLength(1)
    expect(docMemberNotificationRepo.listUnread).not.toHaveBeenCalled()
  })

  it('does not retain an outage or an invalid session across HTTP requests', async () => {
    status = 429
    expect((await notifications()).status).toBe(503)
    status = 401
    expect((await notifications()).status).toBe(401)
    status = 200
    expect((await notifications()).status).toBe(200)
    expect(calls).toHaveLength(3)
    expect(docMemberNotificationRepo.listUnread).toHaveBeenCalledTimes(1)
  })
})

async function releaseAfterFirst<T>(start: () => Promise<T>): Promise<T> {
  hold = true
  const first = new Promise<void>((resolve) => { firstRequest = resolve })
  const result = start()
  await first
  hold = false
  for (const respond of waiting.splice(0)) respond()
  return result
}

describe('concurrent verification', () => {
  it('keeps separate service instances independent', async () => {
    const second = new HttpOctoIdentity(authorityOrigin)
    await releaseAfterFirst(() => Promise.all([
      identity.verifyToken('session'), second.verifyToken('session'),
    ]))
    expect(calls).toHaveLength(2)
  })

  it('bounds stalled shared lookups and retries after the authority recovers', async () => {
    hold = true
    const results = await Promise.allSettled([
      identity.verifyToken('session'), identity.verifyToken('session'),
    ])
    expect(results.every((result) => result.status === 'rejected')).toBe(true)
    expect(calls).toHaveLength(1)
    hold = false
    for (const respond of waiting.splice(0)) respond()
    expect(await identity.verifyToken('session')).toMatchObject({ uid: 'u_fixture' })
    expect(calls).toHaveLength(2)
  }, 8000)

  it('coalesces 100 concurrent verifications into one upstream HTTP request', async () => {
    const results = await releaseAfterFirst(() => Promise.all(
      Array.from({ length: 100 }, () => identity.verifyToken('session')),
    ))
    expect(results).toHaveLength(100)
    expect(results.every((result) => result?.uid === 'u_fixture')).toBe(true)
    expect(calls).toHaveLength(1)
    // There is no process-wide positive cache after the in-flight call settles.
    status = 401
    expect(await identity.verifyToken('session')).toBeNull()
    expect(calls).toHaveLength(2)
  })

  it('isolates concurrent sessions even when the caller supplies the same uid', async () => {
    const results = await releaseAfterFirst(() => Promise.all([
      identity.verifyToken('session'),
      identity.verifyToken('other-user'),
      identity.verifyToken('revoked'),
      identity.isSpaceMember('u_fixture', 's_fixture', 'other-user'),
    ]))
    expect(results).toEqual([
      { uid: 'u_fixture', name: undefined, ownedBots: ['bot_fixture'] },
      { uid: 'u_other', name: undefined, ownedBots: ['bot_fixture'] },
      null,
      false,
    ])
    expect(calls).toHaveLength(3)
  })

  it('coalesces identity, membership, and Bot ownership without sharing mutable results', async () => {
    const results = await releaseAfterFirst(() => Promise.all([
      identity.verifyToken('session'),
      identity.verifyToken('session'),
      identity.isSpaceMember('u_fixture', 's_fixture', 'session'),
      identity.ownedBotsInSpace('u_fixture', 's_fixture', 'session'),
    ]))
    expect(results[2]).toBe(true)
    expect(results[3]).toEqual(['bot_fixture'])
    results[0]!.ownedBots!.push('must-not-leak')
    expect(results[1]!.ownedBots).toEqual(['bot_fixture'])
    expect(calls).toHaveLength(1)
  })

  it('shares one failed lookup across the burst and retries only on a subsequent request', async () => {
    status = 429
    const results = await releaseAfterFirst(() => Promise.allSettled(
      Array.from({ length: 100 }, () => identity.verifyToken('session')),
    ))
    expect(results.every((result) => result.status === 'rejected')).toBe(true)
    expect(calls).toHaveLength(1)
    status = 200
    expect(await identity.verifyToken('session')).toMatchObject({ uid: 'u_fixture' })
    expect(calls).toHaveLength(2)
  })
})
