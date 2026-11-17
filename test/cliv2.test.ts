import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as Y from 'yjs'
import * as editDoc from '../src/api/services/editDocBody.js'
import * as liveWrite from '../src/collab/liveDocWrite.js'
import * as liveRead from '../src/collab/liveDocRead.js'
import * as objectStore from '../src/storage/objectStore.js'
import { docAttachmentRepo } from '../src/db/repos/docAttachmentRepo.js'
import { docCommentRepo } from '../src/db/repos/docCommentRepo.js'
import { selectionAnchor } from '../src/api/cliv2/boardGeometry.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { docsOperations } from '../src/api/cliv2/operations.js'
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
const board: DocMeta = { ...doc, doc_id: 'b_same', doc_type: 'board', document_name: 'octo:space_a:f_default:wb:b_same' }

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
      permissions: [
        { domain: 'docs.documents', actions: body.token === 'no-action' ? ['docs.content:*'] : ['docs.documents:*'] },
        ...(['workflows', 'comment-only'].includes(body.token) ? [{ domain: 'docs.comments', actions: ['docs.comments:write'] }] : []),
        ...(body.token === 'workflows' ? [{ domain: 'docs.content', actions: ['docs.content:*'] }] : []),
      ],
      bot_bindings: [{ bot_id: 'bot_a' }],
    } }))
  }))
  vi.stubEnv('OCTO_AUTH_SERVER_URL', authOrigin + '/auth')
  vi.stubEnv('OCTO_AUTH_SERVICE_SECRET', secret)
  vi.spyOn(docMetaRepo, 'getByDocId').mockImplementation(async (id) => {
    if (id === doc.doc_id) return doc
    if (id === foreign.doc_id) return foreign
    if (id === board.doc_id) return board
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

  it('uses the existing rename transaction with the token user and skips writes outside its Space', async () => {
    const rename = vi.spyOn(docMetaRepo, 'rename').mockResolvedValue(undefined)
    const patch = (id: string) => fetch(appOrigin + endpoint + '/' + id, {
      method: 'PATCH',
      headers: { authorization: 'Bearer valid', 'content-type': 'application/json', 'x-space-id': 'space_b' },
      body: JSON.stringify({ title: 'New name' }),
    })
    const ok = await patch(doc.doc_id)
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ data: { doc_id: doc.doc_id, title: 'New name' } })
    const other = await patch(foreign.doc_id)
    expect(other.status).toBe(404)
    expect(rename).toHaveBeenCalledTimes(1)
    expect(rename).toHaveBeenCalledWith(doc.doc_id, 'New name', 'user_a')
  })

  it('gates generated and workflow routes with the same authentication', async () => {
    expect(docsOperations).toHaveLength(48)
    const responses = await Promise.all(docsOperations.map(async ([method, path]) =>
      fetch(appOrigin + '/v2/cli' + path.replace(/:[a-z_]+/g, 'fixture_id'), { method: method.toUpperCase() })))
    expect(responses.map(response => response.status)).toEqual(docsOperations.map(() => 401))
    const manual = await fetch(appOrigin + '/v2/cli/docs/d_same/import/docx', { method: 'POST' })
    expect(manual.status).toBe(404)
    expect(requests).toHaveLength(0)
  })

  it('keeps the CLI delete policy, public mount, and legacy auth independent', async () => {
    const internal = await listen(createServer(createApp({ surface: 'internal' })))
    expect((await fetch(internal + endpoint)).status).toBe(404)
    const legacy = await read('/api/v1/docs')
    expect(legacy.status).toBe(401)
    expect(await legacy.json()).toEqual({ error: 'unauthorized' })
    const write = await fetch(appOrigin + endpoint + '/' + doc.doc_id, {
      method: 'DELETE', headers: { authorization: 'Bearer valid' },
    })
    expect(write.status).toBe(403)
    expect(await write.json()).toMatchObject({ error: { code: 'FORBIDDEN', details: { reason: 'cli_delete_disabled' } } })
    expect(requests).toHaveLength(1)
    expect(docMetaRepo.getByDocId).not.toHaveBeenCalled()
  })
})

function post(path: string, body: string, media: string, token = 'workflows') {
  return fetch(appOrigin + endpoint + path, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': media, 'x-octo-import-apply': 'false' },
    body,
  })
}

function boardState(elements: Array<Record<string, unknown>>, files: Record<string, Record<string, unknown>> = {}) {
  const y = new Y.Doc()
  const elementMap = y.getMap('elements')
  const fileMap = y.getMap('files')
  for (const el of elements) elementMap.set(String(el.id), new Y.Map(Object.entries(el)))
  for (const [id, file] of Object.entries(files)) fileMap.set(id, new Y.Map(Object.entries(file)))
  return Y.encodeStateAsUpdate(y)
}

describe('Docs CLI v2 workflows', () => {
  it('applies raw Markdown as the token user, even if the client sends the legacy preview header', async () => {
    vi.spyOn(liveWrite, 'readLiveForEdit').mockResolvedValue({ pmDoc: { childCount: 1 }, baseSV: new Uint8Array([1]) } as Awaited<ReturnType<typeof liveWrite.readLiveForEdit>>)
    const edit = vi.spyOn(editDoc, 'editDocBody').mockResolvedValue({ ok: true, baseVersion: 'next', bytes: 28, newDocVersionSeq: 3 })
    const wrongMedia = await post('/d_same/_import_markdown', '# Heading', 'text/plain')
    expect(wrongMedia.status).toBe(415)
    const otherSpace = await post('/d_foreign/_import_markdown', '# Heading', 'text/markdown')
    expect(otherSpace.status).toBe(404)
    const allowed = await post('/d_same/_import_markdown', '# Heading', 'text/markdown')
    expect(allowed.status).toBe(200)
    expect(await allowed.json()).toMatchObject({
      data: { doc_id: 'd_same', base_version: 'next', bytes: 28, new_doc_version_seq: 3 },
    })
    expect(edit).toHaveBeenCalledTimes(1)
    expect(edit).toHaveBeenCalledWith(expect.objectContaining({
      uid: 'user_a', docId: 'd_same', principalSpaceId: 'space_a', isBot: false, ops: [expect.objectContaining({ type: 'replace' })],
    }))
  })

  it('resolves whiteboard element anchors from live state only after both Actions', async () => {
    const readState = vi.spyOn(liveRead, 'readLiveDocState').mockResolvedValue(boardState([
      { id: 'shape', type: 'rectangle', x: 15, y: 24, width: 20, height: 12 },
      { id: 'label', type: 'text', containerId: 'shape' },
      { id: 'deleted', type: 'rectangle', isDeleted: true },
    ]))
    const create = vi.spyOn(docCommentRepo, 'create').mockResolvedValue(71)
    const request = JSON.stringify({ body: 'Please revise', element_ids: ['label', 'shape'] })
    const denied = await post('/b_same/comments', request, 'application/json', 'comment-only')
    expect(denied.status).toBe(403)
    expect(readState).not.toHaveBeenCalled()
    const ok = await post('/b_same/comments', request, 'application/json')
    expect(ok.status).toBe(201)
    expect(await ok.json()).toEqual({ data: { comment_id: 71 } })
    expect(readState).toHaveBeenCalledOnce()
    const input = create.mock.calls[0]![0]
    expect(input.authorUid).toBe('user_a')
    expect(input.anchorStart).toEqual(input.anchorEnd)
    expect(JSON.parse(input.anchorStart!.toString())).toEqual({ version: 1, kind: 'element', elementId: 'shape', x: 35, y: 24 })
    const point = await post('/b_same/comments', JSON.stringify({ body: 'Note', point: '5,9' }), 'application/json', 'comment-only')
    expect(point.status).toBe(201)
    expect(readState).toHaveBeenCalledOnce()
    const deleted = await post('/b_same/comments', JSON.stringify({ body: 'Note', element_ids: ['deleted'] }), 'application/json')
    expect(deleted.status).toBe(400)
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('packages a portable Excalidraw file with only the surviving, same-document attachments', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZ0AAAAASUVORK5CYII=', 'base64')
    vi.spyOn(liveRead, 'readLiveDocState').mockResolvedValue(boardState([
      { id: 'image', type: 'image', index: 'a0', x: 1, y: 2, width: 1, height: 1, fileId: 'BinaryId' },
      { id: 'gone', type: 'image', index: 'a1', fileId: 'unreferenced', isDeleted: true },
      { id: 'line', type: 'line', index: 'a2', x: 4, y: 5, width: 1, height: 1, points: [[0, 0], [1, 1]], lastCommittedPoint: [1, 1] },
    ], { BinaryId: { attachId: 'att_A', createdAt: 7 }, unreferenced: { attachId: 'att_B' } }))
    const attachments = vi.spyOn(docAttachmentRepo, 'listByDoc').mockResolvedValue([{
      attachId: 'att_A', docId: board.doc_id, objectKey: 'b_same/att_A/image.png',
      mime: 'image/png', sizeBytes: png.length, fileName: 'image.png', createdBy: 'user_a', createdAt: date,
    }])
    const download = vi.fn().mockResolvedValue(png)
    vi.spyOn(objectStore, 'getObjectStore').mockReturnValue({ download } as unknown as objectStore.ObjectStore)
    const result = await read(endpoint + '/b_same/scene/_export?format=excalidraw', 'workflows')
    expect(result.status).toBe(200)
    expect(result.headers.get('content-type')).toContain('application/vnd.excalidraw+json')
    expect(result.headers.get('content-disposition')).toBe('attachment; filename="b_same.excalidraw"')
    expect(await result.json()).toMatchObject({
      type: 'excalidraw', version: 2,
      elements: [{ id: 'image' }, { id: 'line', lastCommittedPoint: null }],
      files: { BinaryId: { created: 7, dataURL: 'data:image/png;base64,' + png.toString('base64') } },
    })
    expect(attachments).toHaveBeenCalledOnce()
    expect(download).toHaveBeenCalledOnce()
    expect(download).toHaveBeenCalledWith('b_same/att_A/image.png', expect.objectContaining({ maxBytes: expect.any(Number) }))
    attachments.mockResolvedValue([])
    const invalid = await read(endpoint + '/b_same/scene/_export?format=excalidraw', 'workflows')
    expect(invalid.status).toBe(409)
    expect(download).toHaveBeenCalledOnce()
  })

  it('preserves the web anchor geometry for a rounded connector with bound text', () => {
    const arrow = {
      id: 'a', type: 'line', x: 100, y: 200, width: 150, height: 80, angle: 0.43, seed: 12345, roughness: 1,
      strokeStyle: 'solid', roundness: { type: 2 }, points: [[0.5, 0.5], [50, 80], [100, 20], [149.5, 69.5]],
      boundElements: [{ id: 't', type: 'text' }],
    }
    const text = { id: 't', type: 'text', x: 0, y: 0, width: 152, height: 25, angle: 0, containerId: 'a' }
    const [x, y] = selectionAnchor(['a'], new Map<string, Record<string, unknown>>([['a', arrow], ['t', text]]))
    expect(x).toBeCloseTo(254.47989689987472, 8)
    expect(y).toBeCloseTo(172.1502302524064, 8)
  })
})
