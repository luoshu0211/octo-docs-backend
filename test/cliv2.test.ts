import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/api/app.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import { docMetaRepo, type DocMeta } from '../src/db/repos/docMetaRepo.js'

const secret = 'fixture-service-secret-with-minimum-length'
const date = new Date('2026-11-17T00:00:00Z')
const doc: DocMeta = {
  doc_id: 'd_same', document_name: 'octo:space_a:f_default:d_same', title: 'Same Space',
  owner_id: 'user_a', owner_space_id: 'space_a', space_id: 'space_a', folder_id: 'f_default',
  doc_type: 'doc', status: 1, permission_epoch: 1, share_scope: 0, share_role: 1,
  discoverability_scope: 0, created_at: date, updated_at: date, created_by: 'user_a',
  updated_by: 'user_a', octo_doc_slug: null, html_idempotency_key_hash: null,
}
const foreign = { ...doc, doc_id: 'd_foreign', space_id: 'space_b' }

let appOrigin: string
let requests: { path: string | undefined; authorization: string | undefined; body: unknown }[]
const servers: Server[] = []

async function listen(server: Server): Promise<string> {
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return 'http://127.0.0.1:' + (server.address() as AddressInfo).port
}

beforeEach(async () => {
  requests = []
  const authOrigin = await listen(createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { token: string }
    requests.push({ path: req.url, authorization: req.headers.authorization, body })
    res.setHeader('content-type', 'application/json')
    if (body.token === 'revoked') {
      res.statusCode = 401
      res.end(JSON.stringify({ error: { code: 'AUTH_REQUIRED' } }))
      return
    }
    const owner = body.token === 'other-user' ? 'user_b' : 'user_a'
    res.end(JSON.stringify({ data: {
      principal: {
        token_id: 'token-fixture', subject_type: 'user', owner_id: owner,
        subject_id: body.token === 'malformed' ? 'wrong-user' : owner, space_id: 'space_a',
      },
      permissions: [{ domain: 'docs.documents', actions: body.token === 'no-action' ? ['docs.content:*'] : ['docs.documents:read'] }],
      bot_bindings: [{ bot_id: 'bot_a' }],
    } }))
  }))
  vi.stubEnv('OCTO_AUTH_SERVER_URL', authOrigin + '/auth')
  vi.stubEnv('OCTO_AUTH_SERVICE_SECRET', secret)
  vi.spyOn(docMetaRepo, 'getByDocId').mockImplementation(async (id) => {
    if (id === doc.doc_id) return doc
    if (id === foreign.doc_id) return foreign
    return null
  })
  vi.spyOn(docMemberRepo, 'getRole').mockResolvedValue(undefined)
  appOrigin = await listen(createServer(createApp({ surface: 'public' })))
})

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.closeAllConnections()
    server.close(error => error ? reject(error) : resolve())
  })))
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const endpoint = '/v2/cli/docs'
function read(path: string, token?: string) {
  return fetch(appOrigin + path, {
    headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), 'x-space-id': 'space_b' },
    signal: AbortSignal.timeout(4000),
  })
}

describe('Docs CLI v2 read pilot', () => {
  it('queries and serializes the token user’s visible documents', async () => {
    const list = vi.spyOn(docMetaRepo, 'listForUser').mockResolvedValue({ total: 3, items: [{ ...doc, role: 3 }] })
    const result = await read(endpoint + '?owner=me&page=2&page_size=2', 'valid')
    expect(result.status).toBe(200)
    expect(await result.json()).toMatchObject({
      data: [{ doc_id: doc.doc_id, role: 'admin', owner_id: 'user_a' }],
      pagination: { total: 3, page: 2, page_size: 2 },
    })
    expect(list).toHaveBeenCalledWith(expect.objectContaining({
      uid: 'user_a', spaceId: 'space_a', principalSpaceId: 'space_a', isSpaceMember: true, owner: 'me',
    }))
    expect(requests).toEqual([{
      path: '/auth/v2/internal/tokens/_resolve', authorization: 'Bearer ' + secret, body: { token: 'valid' },
    }])
    const get = await read(endpoint + '/' + doc.doc_id, 'valid')
    expect(get.status).toBe(200)
    expect(await get.json()).toMatchObject({ data: { space_id: 'space_a', doc_id: doc.doc_id, role: 'admin' } })
  })

  it('rejects a foreign Space before ACL and still enforces ACL in the token Space', async () => {
    const get = await read(endpoint + '/' + foreign.doc_id, 'valid')
    expect(get.status).toBe(404)
    expect(await get.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
    expect(docMemberRepo.getRole).not.toHaveBeenCalled()

    const denied = await read(endpoint + '/' + doc.doc_id, 'other-user')
    expect(denied.status).toBe(403)
    expect(docMemberRepo.getRole).toHaveBeenCalledWith(doc.doc_id, 'user_b', 'space_a')
  })

  it.each([
    [undefined, 401, 'AUTH_REQUIRED'],
    ['revoked', 401, 'AUTH_REQUIRED'],
    ['no-action', 403, 'FORBIDDEN'],
    ['malformed', 503, 'UPSTREAM_UNAVAILABLE'],
  ] as const)('rejects a bad token or grant before touching Docs data (%s)', async (token, status, code) => {
    const response = await read(endpoint + '/' + doc.doc_id, token)
    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({ error: { code } })
    expect(docMetaRepo.getByDocId).not.toHaveBeenCalled()
    expect(requests).toHaveLength(token ? 1 : 0)
  })

  it('mounts only the public read routes and leaves the legacy auth response intact', async () => {
    const internal = await listen(createServer(createApp({ surface: 'internal' })))
    expect((await fetch(internal + endpoint)).status).toBe(404)
    const legacy = await read('/api/v1/docs')
    expect(legacy.status).toBe(401)
    expect(await legacy.json()).toEqual({ error: 'unauthorized' })
    const write = await fetch(appOrigin + endpoint + '/' + doc.doc_id, {
      method: 'DELETE', headers: { authorization: 'Bearer valid' },
    })
    expect(write.status).toBe(404)
    expect(requests).toHaveLength(0)
    expect(docMetaRepo.getByDocId).not.toHaveBeenCalled()
  })
})
