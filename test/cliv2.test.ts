import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { createCanvas } from '@napi-rs/canvas'
import * as Y from 'yjs'
import * as editDoc from '../src/api/services/editDocBody.js'
import * as liveWrite from '../src/collab/liveDocWrite.js'
import * as liveRead from '../src/collab/liveDocRead.js'
import * as liveSheet from '../src/collab/liveSheetWrite.js'
import * as editSheet from '../src/api/services/editDocSheet.js'
import * as objectStore from '../src/storage/objectStore.js'
import { config } from '../src/config/env.js'
import { SHEET_DATA_VALIDATIONS_FIELD, SHEET_LIST_FIELD, SHEET_YMAP_FIELD } from '../src/agent/sheetConversion.js'
import { encodeBaseVersion } from '../src/collab/docBodyEdit.js'
import { sanitizeSvg } from '../src/util/sanitizeSvg.js'
import { errorForStatus } from '../src/api/cliv2/adapter.js'
import { docAttachmentRepo } from '../src/db/repos/docAttachmentRepo.js'
import { docCommentRepo, type DocComment } from '../src/db/repos/docCommentRepo.js'
import { prepareExcalidrawImport } from '../src/import/excalidraw.js'
import { selectionAnchor } from '../src/api/cliv2/boardGeometry.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { docsOperations } from '../src/api/cliv2/operations.js'
import { createApp } from '../src/api/app.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import { docMetaRepo, type DocMeta } from '../src/db/repos/docMetaRepo.js'
import * as pool from '../src/db/pool.js'

type ReadSchemas = {
  ErrorResponse: {
    properties: {
      error: {
        properties: {
          code: { enum: string[] }
          details: { properties: { candidates: { items: { required: string[] } } } }
        }
      }
    }
  }
  CursorPagination: { required: string[] }
  DocsShareGetResponse: {
    properties: { data: { properties: Record<'share_scope' | 'share_role', { enum: string[] }> } }
  }
}
const { load } = createRequire(import.meta.url)('js-yaml') as {
  load(text: string): { components: { schemas: ReadSchemas } }
}
const schemas = load(readFileSync(new URL('../docs/openapi/v2.yaml', import.meta.url), 'utf8')).components.schemas

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
        ...(['workflows', 'comment-only'].includes(body.token) ? [{
          domain: 'docs.comments', actions: body.token === 'workflows' ? ['docs.comments:*'] : ['docs.comments:write'],
        }] : []),
        ...(body.token === 'workflows' ? [
          { domain: 'docs.content', actions: ['docs.content:*'] },
          { domain: 'docs.access', actions: ['docs.access:read'] },
          { domain: 'docs.attachments', actions: ['docs.attachments:read'] },
        ] : []),
        ...(body.token === 'content-only' ? [{ domain: 'docs.content', actions: ['docs.content:read'] }] : []),
        ...(body.token === 'attachments-only' ? [{ domain: 'docs.attachments', actions: ['docs.attachments:read'] }] : []),
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

  function patchTitle(id: string, token = 'valid') {
    return fetch(appOrigin + endpoint + '/' + id, {
      method: 'PATCH',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'x-space-id': 'space_b' },
      body: JSON.stringify({ title: 'New name' }),
    })
  }

  function mockRenameTransaction(current: DocMeta | null, memberRole?: number) {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT * FROM doc_meta') && sql.endsWith('FOR UPDATE')) return current ? [current] : []
      if (sql.startsWith('SELECT role FROM doc_member') && sql.endsWith('FOR UPDATE')) {
        return memberRole === undefined ? [] : [{ role: memberRole }]
      }
      if (sql.startsWith('UPDATE doc_meta SET title')) return []
      throw new Error('Unexpected query: ' + sql)
    })
    const transaction = vi.spyOn(pool, 'transaction').mockImplementation(fn => fn({ query, execute: vi.fn() }))
    return { query, transaction }
  }

  it.each([
    ['owner', 'valid', 'user_a'],
    ['member admin', 'other-user', 'user_b'],
  ])('renames as the %s in the transaction and skips writes outside the token Space', async (_role, token, uid) => {
    vi.mocked(docMemberRepo.getRole).mockResolvedValue('admin')
    const { query, transaction } = mockRenameTransaction(doc, 3)
    const ok = await patchTitle(doc.doc_id, token)
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ data: { doc_id: doc.doc_id, title: 'New name' } })
    const other = await patchTitle(foreign.doc_id, token)
    expect(other.status).toBe(404)
    expect(transaction).toHaveBeenCalledOnce()
    expect(query).toHaveBeenNthCalledWith(1, expect.stringMatching(/^SELECT .* FOR UPDATE$/), [doc.doc_id])
    if (uid === 'user_b') {
      expect(query).toHaveBeenNthCalledWith(2, expect.stringMatching(/^SELECT role .* FOR UPDATE$/), [doc.doc_id, uid, 'space_a'])
    }
    expect(query).toHaveBeenLastCalledWith(expect.stringMatching(/^UPDATE doc_meta SET title/), ['New name', uid, doc.doc_id])
  })

  it.each([
    ['the member is removed', doc, undefined, 403, 'FORBIDDEN'],
    ['the member is downgraded', doc, 2, 403, 'FORBIDDEN'],
    ['the document is deleted', { ...doc, status: 0 }, 3, 404, 'NOT_FOUND'],
    ['the document is archived', { ...doc, status: 2 }, 3, 409, 'CONFLICT'],
    ['the epoch changes', { ...doc, permission_epoch: 2 }, 3, 409, 'CONFLICT'],
    ['the document changes Space', { ...doc, space_id: 'space_b' }, 3, 404, 'NOT_FOUND'],
  ] as const)('skips renaming when %s after the initial guard', async (_reason, current, role, status, code) => {
    vi.mocked(docMemberRepo.getRole).mockResolvedValue('admin')
    const { query, transaction } = mockRenameTransaction(current, role)
    const response = await patchTitle(doc.doc_id, 'other-user')
    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({ error: { code } })
    expect(transaction).toHaveBeenCalledOnce()
    expect(query.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true)
  })

  it('gates generated and workflow routes with the same authentication', async () => {
    expect(docsOperations).toHaveLength(49)
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
  it.each([false, true])('matches the cursor contract with has_more=%s', async hasMore => {
    const comment: DocComment = {
      id: 71, docId: doc.doc_id, documentName: doc.document_name, parentId: null,
      authorUid: 'user_a', body: 'A comment', anchorStart: null, anchorEnd: null,
      anchorText: '', resolved: false, resolvedBy: null, resolvedAt: null,
      deleted: false, createdAt: date, updatedAt: date,
    }
    vi.spyOn(docCommentRepo, 'listRoots').mockResolvedValue(hasMore ? [comment] : [])
    vi.spyOn(docCommentRepo, 'listRepliesForRoots').mockResolvedValue([])

    const result = await read(endpoint + '/d_same/comments?limit=1', 'workflows')
    expect(result.status).toBe(200)
    const body = await result.json()
    expect(body.pagination).toEqual(hasMore ? { has_more: true, next_cursor: '71' } : { has_more: false })
    expect(Object.keys(body.pagination)).toEqual(expect.arrayContaining(schemas.CursorPagination.required))
  })

  it.each([
    [0, 1, 'restricted', 'read'],
    [1, 4, 'anyone_in_space', 'comment'],
    [2, 4, 'authenticated', 'comment'],
  ] as const)('matches the share read contract for stored scope=%s and role=%s', async (scope, role, scopeName, roleName) => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue({ ...doc, share_scope: scope, share_role: role })
    const result = await read(endpoint + '/d_same/share', 'workflows')
    expect(result.status).toBe(200)
    const body = await result.json()
    expect(body.data).toMatchObject({ share_scope: scopeName, share_role: roleName })
    const properties = schemas.DocsShareGetResponse.properties.data.properties
    expect(properties.share_scope.enum).toContain(body.data.share_scope)
    expect(properties.share_role.enum).toContain(body.data.share_role)
  })

  it('reads a metadata batch as the token user and omits unreadable or foreign documents', async () => {
    const ids = Array.from({ length: 301 }, (_, index) => 'batch-' + index)
    vi.mocked(docMetaRepo.getByDocId).mockImplementation(async (id) => {
      if (id.startsWith('batch-')) return { ...doc, doc_id: id }
      if (id === 'denied') return { ...doc, doc_id: id, owner_id: 'user_b' }
      if (id === 'archived') return { ...doc, doc_id: id, status: 2 }
      if (id === foreign.doc_id) return foreign
      return null
    })
    const response = await post('/_metadata', JSON.stringify({
      doc_ids: [...ids, ids[0], foreign.doc_id, 'denied', 'archived', 'missing'],
    }), 'application/json', 'valid')
    expect(response.status).toBe(200)
    const body = await response.json() as { data: { items: Array<Record<string, unknown>> } }
    expect(body.data.items).toHaveLength(ids.length)
    expect(body.data.items.map(item => item.doc_id)).toEqual(ids)
    expect(body.data.items[0]).toEqual({
      doc_id: ids[0], created_by: 'user_a', updated_by: 'user_a', updated_at: date.toISOString(),
    })
    expect(requests).toHaveLength(1)
    expect(docMemberRepo.getRole).not.toHaveBeenCalledWith(foreign.doc_id, expect.anything(), expect.anything())
  })

  it('rejects invalid metadata batches before document reads', async () => {
    for (const docIds of [Array(501).fill('d_same'), ['d_same', 42]]) {
      const response = await post('/_metadata', JSON.stringify({ doc_ids: docIds }), 'application/json', 'valid')
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    }
    expect(docMetaRepo.getByDocId).not.toHaveBeenCalled()
  })

  it('applies raw Markdown as the token user, even if the client sends the legacy preview header', async () => {
    vi.spyOn(liveWrite, 'readLiveForEdit').mockResolvedValue({ pmDoc: { childCount: 1 }, baseSV: new Uint8Array([1]) } as Awaited<ReturnType<typeof liveWrite.readLiveForEdit>>)
    const edit = vi.spyOn(editDoc, 'editDocBody').mockResolvedValue({ ok: true, baseVersion: 'next', bytes: 28, newDocVersionSeq: 3 })
    const wrongMedia = await post('/d_same/_import_markdown', '# Heading', 'text/plain')
    expect(wrongMedia.status).toBe(415)
    const mediaError = await wrongMedia.json()
    expect(mediaError.error.code).toBe('UNSUPPORTED_MEDIA_TYPE')
    expect(schemas.ErrorResponse.properties.error.properties.code.enum).toContain(mediaError.error.code)
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

  it('carries sheet recovery details through a failed read, repair PATCH and successful reread', async () => {
    const sheet = new Y.Doc()
    const validationKey = 'default!checkbox_needs_repair'
    sheet.getMap(SHEET_YMAP_FIELD).set('default!0:0', { v: 'cell' })
    sheet.getMap(SHEET_DATA_VALIDATIONS_FIELD).set(validationKey, {
      uid: 'checkbox_needs_repair', type: 'checkbox', allowBlank: true,
      ranges: Array.from({ length: 40 }, (_, row) => ({ startRow: row, endRow: row, startColumn: 0, endColumn: 0 })),
    })
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue({ ...doc, doc_type: 'sheet' })
    vi.spyOn(liveSheet, 'readLiveSheet').mockImplementation(async () => ({
      state: Y.encodeStateAsUpdate(sheet), baseSV: Y.encodeStateVector(sheet),
    }))
    const edit = vi.spyOn(editSheet, 'editDocSheet').mockImplementation(async input => {
      expect(input.clientBaseVersion).toEqual(Y.encodeStateVector(sheet))
      expect(input.dataValidations).toEqual({ [validationKey]: null })
      sheet.getMap(SHEET_DATA_VALIDATIONS_FIELD).delete(validationKey)
      return { ok: true, baseVersion: encodeBaseVersion(Y.encodeStateVector(sheet)), bytes: 100, newDocVersionSeq: 3 }
    })
    const readLimits = config.sheetRead as { maxCellBytes: number }
    const previousLimit = readLimits.maxCellBytes
    readLimits.maxCellBytes = 800
    try {
      const failed = await read(endpoint + '/d_same/sheet?limit=1', 'workflows')
      expect(failed.status).toBe(413)
      const error = (await failed.json()).error
      expect(error).toMatchObject({
        code: 'PAYLOAD_TOO_LARGE',
        details: {
          reason: 'sheet_too_large', base_version: encodeBaseVersion(Y.encodeStateVector(sheet)),
          repair_data_validation_key: validationKey, hint: expect.any(String), limit: 800,
        },
      })
      const repaired = await fetch(appOrigin + endpoint + '/d_same/sheet', {
        method: 'PATCH',
        headers: {
          authorization: 'Bearer workflows', 'content-type': 'application/json', 'if-match': error.details.base_version,
        },
        body: JSON.stringify({ data_validations: { [error.details.repair_data_validation_key]: null } }),
      })
      expect(repaired.status).toBe(200)
      expect(edit).toHaveBeenCalledOnce()
      const reread = await read(endpoint + '/d_same/sheet?limit=1', 'workflows')
      expect(reread.status).toBe(200)
      expect((await reread.json()).data.sheet_data_validations).toEqual({})
    } finally {
      readLimits.maxCellBytes = previousLimit
      sheet.destroy()
    }
  })

  it('limits sheet recovery details to published scalar fields', () => {
    const error = errorForStatus(413, {
      error: 'sheet_too_large', baseVersion: { token: 'private' }, repairDataValidationKey: ['private'],
      hint: 5, payloadBytes: NaN, limit: Infinity, stack: 'private', secret: 'private',
    })
    expect(error.envelope.error.details).toEqual({ reason: 'sheet_too_large' })
    expect(errorForStatus(500, { error: 'sheet_too_large', baseVersion: 'private', hint: 'private' }).envelope.error)
      .not.toHaveProperty('details')
  })

  it('returns duplicate-name worksheet candidates and accepts each candidate ID', async () => {
    const sheet = new Y.Doc()
    const name = '重复表名'
    for (const [order, sheetId] of ['sheet_alpha', 'sheet_beta'].entries()) {
      sheet.getMap(SHEET_LIST_FIELD).set(sheetId, { name, order })
      sheet.getMap(SHEET_YMAP_FIELD).set(`${sheetId}!0:0`, { v: sheetId })
    }
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue({ ...doc, doc_type: 'sheet' })
    vi.spyOn(liveSheet, 'readLiveSheet').mockImplementation(async () => ({
      state: Y.encodeStateAsUpdate(sheet), baseSV: Y.encodeStateVector(sheet),
    }))
    try {
      const query = new URLSearchParams({ sheet_name: name, limit: '1' })
      const ambiguous = await read(endpoint + '/d_same/sheet?' + query, 'workflows')
      expect(ambiguous.status).toBe(409)
      const error = (await ambiguous.json()).error
      expect(error).toMatchObject({
        code: 'CONFLICT',
        details: {
          reason: 'ambiguous_sheet_name',
          candidates: [{ sheet_id: 'sheet_alpha', name }, { sheet_id: 'sheet_beta', name }],
        },
      })
      for (const candidate of error.details.candidates) {
        const required = schemas.ErrorResponse.properties.error.properties.details.properties.candidates.items.required
        expect(Object.keys(candidate)).toEqual(expect.arrayContaining(required))
        const selection = new URLSearchParams({ sheet_id: candidate.sheet_id, limit: '1' })
        const selected = await read(endpoint + '/d_same/sheet?' + selection, 'workflows')
        expect(selected.status).toBe(200)
        const body = await selected.json()
        expect(body.data.sheet_id).toBe(candidate.sheet_id)
        expect(body.data.sheet_cells[`${candidate.sheet_id}!0:0`]).toEqual({ v: candidate.sheet_id })
      }
    } finally {
      sheet.destroy()
    }
  })

  it('projects only valid public worksheet candidate fields', () => {
    const error = errorForStatus(409, {
      error: 'ambiguous_sheet_name',
      candidates: [{ sheetId: 'sheet_alpha', name: 'Repeated', private: 'hidden' }, null, { sheetId: 'bad', name: 1 }],
    })
    expect(error.envelope.error.details).toEqual({
      reason: 'ambiguous_sheet_name', candidates: [{ sheet_id: 'sheet_alpha', name: 'Repeated' }],
    })
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

  it.each(['content-only', 'attachments-only'])('rejects portable images for %s before attachment lookup or download', async token => {
    vi.spyOn(liveRead, 'readLiveDocState').mockResolvedValue(boardState([
      { id: 'image', type: 'image', index: 'a0', fileId: 'BinaryId', x: 0, y: 0, width: 1, height: 1 },
    ], { BinaryId: { attachId: 'att_A' } }))
    const attachments = vi.spyOn(docAttachmentRepo, 'listByDoc')
    const download = vi.fn()
    vi.spyOn(objectStore, 'getObjectStore').mockReturnValue({ download } as unknown as objectStore.ObjectStore)

    const result = await read(endpoint + '/b_same/scene/_export?format=excalidraw', token)
    expect(result.status).toBe(403)
    expect(await result.json()).toMatchObject({ error: { code: 'FORBIDDEN' } })
    expect(attachments).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()
  })

  it.each(['/scene/_export', '/_export'])('checks attachment permission before SVG embedding at %s', async path => {
    const png = createCanvas(1, 1).toBuffer('image/png')
    const image = { id: 'image', type: 'image', index: 'a0', fileId: 'BinaryId', x: 0, y: 0, width: 1, height: 1 }
    const refs = { BinaryId: { attachId: 'att_A' } }
    const state = vi.spyOn(liveRead, 'readLiveDocState').mockResolvedValue(boardState([image], refs))
    const attachments = vi.spyOn(docAttachmentRepo, 'listByDoc').mockResolvedValue([{
      attachId: 'att_A', docId: board.doc_id, objectKey: 'b_same/att_A/image.png',
      mime: 'image/png', sizeBytes: png.length, fileName: 'image.png', createdBy: 'user_a', createdAt: date,
    }])
    const download = vi.fn().mockResolvedValue(png)
    vi.spyOn(objectStore, 'getObjectStore').mockReturnValue({ download } as unknown as objectStore.ObjectStore)
    const url = endpoint + '/b_same' + path + '?format=svg'

    const denied = await read(url, 'content-only')
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ error: { code: 'FORBIDDEN' } })
    expect(attachments).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()

    const allowed = await read(url, 'workflows')
    expect(allowed.status).toBe(200)
    expect(await allowed.text()).toContain('data:image/png;base64,' + png.toString('base64'))

    state.mockResolvedValue(boardState([{ ...image, isDeleted: true }], refs))
    const withoutImage = await read(url, 'content-only')
    expect(withoutImage.status).toBe(200)
    expect(await withoutImage.text()).not.toContain('data:image/png;base64,')
    expect(attachments).toHaveBeenCalledOnce()
    expect(download).toHaveBeenCalledOnce()
  })

  it('requires a document reader role even with both portable export Actions', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue({ ...board, owner_id: 'different-user' })
    const scene = vi.spyOn(liveRead, 'readLiveDocState')
    const attachments = vi.spyOn(docAttachmentRepo, 'listByDoc')
    const result = await read(endpoint + '/b_same/scene/_export?format=excalidraw', 'workflows')
    expect(result.status).toBe(403)
    expect(scene).not.toHaveBeenCalled()
    expect(attachments).not.toHaveBeenCalled()
  })

  it.each([false, true])('exports without attachment permission when the board has no live image (deleted=%s)', async deleted => {
    vi.spyOn(liveRead, 'readLiveDocState').mockResolvedValue(boardState(deleted ? [
      { id: 'gone', type: 'image', index: 'a0', fileId: 'BinaryId', isDeleted: true },
    ] : [], { BinaryId: { attachId: 'att_A' } }))
    const attachments = vi.spyOn(docAttachmentRepo, 'listByDoc')
    const result = await read(endpoint + '/b_same/scene/_export?format=excalidraw', 'content-only')
    expect(result.status).toBe(200)
    expect(await result.json()).toMatchObject({ elements: [], files: {} })
    expect(attachments).not.toHaveBeenCalled()
  })

  it.each([
    ['image/x-png', 'image/png', 1],
    ['IMAGE/PNG; charset=binary', 'image/png', 1],
    ['image/png', 'image/png', 256],
    ['image/jpg', 'image/jpeg', 1],
    ['image/pjpeg', 'image/jpeg', 1],
    ['image/jpeg; charset=binary', 'image/jpeg', 1],
    ['image/webp', 'image/webp', 1],
    ['IMAGE/WEBP; charset=binary', 'image/webp', 1],
    ['image/svg+xml', 'image/svg+xml', 1],
  ])('round-trips a portable attachment declared as %s (%s, %ipx)', async (declaredMime, normalizedMime, size) => {
    const canvas = createCanvas(size, size)
    if (size > 1) {
      const ctx = canvas.getContext('2d')
      const pixels = ctx.createImageData(size, size)
      let seed = 1
      for (let i = 0; i < pixels.data.length; i++) {
        seed = Math.imul(seed, 1664525) + 1013904223
        pixels.data[i] = i % 4 === 3 ? 255 : seed >>> 24
      }
      ctx.putImageData(pixels, 0, 0)
    }
    let image: Buffer
    if (normalizedMime === 'image/svg+xml') {
      image = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="1" height="1"/></svg>')
    } else if (normalizedMime === 'image/png') {
      image = canvas.toBuffer('image/png')
    } else if (normalizedMime === 'image/webp') {
      image = canvas.toBuffer('image/webp')
    } else {
      image = canvas.toBuffer('image/jpeg')
    }
    const portableBytes = normalizedMime === 'image/svg+xml' ? sanitizeSvg(image) : image
    if (size > 1) expect(image.length).toBeGreaterThan(config.boardSceneWrite.maxElementContentBytes)
    vi.spyOn(liveRead, 'readLiveDocState').mockResolvedValue(boardState([
      { id: 'image', type: 'image', index: 'a0', x: 0, y: 0, width: 1, height: 1, fileId: 'BinaryId' },
    ], { BinaryId: { attachId: 'att_A' } }))
    vi.spyOn(docAttachmentRepo, 'listByDoc').mockResolvedValue([{
      attachId: 'att_A', docId: board.doc_id, objectKey: 'b_same/att_A/image',
      mime: declaredMime, sizeBytes: image.length, fileName: 'image', createdBy: 'user_a', createdAt: date,
    }])
    vi.spyOn(objectStore, 'getObjectStore').mockReturnValue({
      download: vi.fn().mockResolvedValue(image),
    } as unknown as objectStore.ObjectStore)

    const result = await read(endpoint + '/b_same/scene/_export?format=excalidraw', 'workflows')
    expect(result.status).toBe(200)
    const scene = await result.json()
    expect(scene.files.BinaryId).toMatchObject({
      mimeType: normalizedMime, dataURL: `data:${normalizedMime};base64,${portableBytes.toString('base64')}`,
    })

    const upload = vi.fn(async () => 'att_reimported')
    const imported = await prepareExcalidrawImport({
      scene, docId: board.doc_id, uid: 'user_a', existingElements: [], existingFiles: {}, upload,
    })
    expect(upload).toHaveBeenCalledWith(portableBytes, normalizedMime, expect.any(String))
    expect(imported.files.BinaryId).toMatchObject({ attachId: 'att_reimported', mimeType: normalizedMime })
  })

  it.each(['image/png', 'image/svg+xml'])('rejects WebP bytes declared as %s', async declaredMime => {
    const image = createCanvas(1, 1).toBuffer('image/webp')
    vi.spyOn(liveRead, 'readLiveDocState').mockResolvedValue(boardState([
      { id: 'image', type: 'image', index: 'a0', x: 0, y: 0, width: 1, height: 1, fileId: 'BinaryId' },
    ], { BinaryId: { attachId: 'att_A' } }))
    vi.spyOn(docAttachmentRepo, 'listByDoc').mockResolvedValue([{
      attachId: 'att_A', docId: board.doc_id, objectKey: 'b_same/att_A/image',
      mime: declaredMime, sizeBytes: image.length, fileName: 'image', createdBy: 'user_a', createdAt: date,
    }])
    vi.spyOn(objectStore, 'getObjectStore').mockReturnValue({
      download: vi.fn().mockResolvedValue(image),
    } as unknown as objectStore.ObjectStore)
    const result = await read(endpoint + '/b_same/scene/_export?format=excalidraw', 'workflows')
    expect(result.status).toBe(409)
    expect(await result.json()).toMatchObject({ error: { code: 'CONFLICT', details: { reason: 'portable_attachment_invalid' } } })
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
