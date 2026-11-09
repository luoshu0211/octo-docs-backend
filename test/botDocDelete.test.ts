import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type { Request, Response } from 'express'

vi.mock('../src/db/pool.js', () => ({ query: vi.fn(async () => []), transaction: vi.fn() }))
vi.mock('../src/db/repos/docMetaRepo.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/db/repos/docMetaRepo.js')>()
  return {
    ...actual,
    docMetaRepo: {
      ...actual.docMetaRepo,
      getByDocId: vi.fn(),
      getByOctoDocSlug: vi.fn(),
      softDelete: vi.fn(),
    },
  }
})
vi.mock('../src/db/repos/docMemberRepo.js', () => ({ docMemberRepo: { getRole: vi.fn() } }))
vi.mock('../src/permission/epoch.js', () => ({ refreshAndPublish: vi.fn() }))

import { createApp } from '../src/api/app.js'
import { deleteDocHandler, octoDocDeleteHandler } from '../src/api/routes/docs.js'
import { setOctoIdentity, type OctoIdentity } from '../src/auth/octoIdentity.js'
import { docMetaRepo, type DocMeta } from '../src/db/repos/docMetaRepo.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import { refreshAndPublish } from '../src/permission/epoch.js'

const getByDocId = vi.mocked(docMetaRepo.getByDocId)
const getByOctoDocSlug = vi.mocked(docMetaRepo.getByOctoDocSlug)
const softDelete = vi.mocked(docMetaRepo.softDelete)
const getRole = vi.mocked(docMemberRepo.getRole)
const publish = vi.mocked(refreshAndPublish)
const isSpaceMember = vi.fn<OctoIdentity['isSpaceMember']>()
const botPaths = ['/d_delete', '/octo-doc/html-slug']
const docTypes = ['doc', 'sheet', 'board', 'html', 'html_ppt']

let server: Server
let base: string
let meta: DocMeta

beforeAll(async () => {
  const app = createApp()
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})

beforeEach(() => {
  vi.clearAllMocks()
  meta = {
    doc_id: 'd_delete', document_name: 'octo:s_docs:f_default:d_delete', title: 'Keep this document',
    owner_id: 'bot_actor', owner_space_id: 's_docs', space_id: 's_docs', folder_id: 'f_default',
    doc_type: 'doc', octo_doc_slug: 'html-slug', html_idempotency_key_hash: null,
    status: 1, permission_epoch: 3, share_scope: 0, share_role: 1, discoverability_scope: 0,
    created_at: new Date(0), updated_at: new Date(0), created_by: 'bot_actor', updated_by: 'bot_actor',
  }
  getByDocId.mockImplementation(async () => meta)
  getByOctoDocSlug.mockImplementation(async () => meta)
  getRole.mockResolvedValue('admin')
  softDelete.mockImplementation(async () => ({ documentName: meta.document_name, permissionEpoch: 4 }))
  publish.mockResolvedValue(undefined)
  isSpaceMember.mockResolvedValue(true)
  setOctoIdentity({
    verifyToken: async (token) => token === 'human-token' ? { uid: 'human_actor' } : null,
    verifyApiKey: async () => null,
    verifyBot: async (token) => token === 'bot-token'
      ? { uid: 'bot_actor', spaceId: 's_docs', ownerUid: 'human_actor' } : null,
    getUser: async () => null,
    getUserAsBot: async () => null,
    lookupSpacePrincipalAsBot: async () => ({ status: 'not_found' }),
    getUsers: async () => [],
    getUsersBatch: async () => new Map(),
    getUsersAsBotBatch: async () => new Map(),
    isSpaceMember,
    ownedBotsInSpace: async () => [],
    listCallerBots: async () => [],
    spaceBots: async () => [],
    spaceMembers: async () => [],
  })
})

function expectNoDeletion() {
  expect(softDelete).not.toHaveBeenCalled()
  expect(publish).not.toHaveBeenCalled()
  expect(meta.permission_epoch).toBe(3)
}

async function expectBotDenied(response: globalThis.Response) {
  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ error: 'bot_delete_forbidden' })
  expect(getByDocId).not.toHaveBeenCalled()
  expect(getByOctoDocSlug).not.toHaveBeenCalled()
  expect(getRole).not.toHaveBeenCalled()
  expectNoDeletion()
}

function deleteAsBot(path: string, headers: Record<string, string> = {}) {
  return fetch(`${base}/v1/bot/docs${path}`, {
    method: 'DELETE', headers: { authorization: 'Bearer bot-token', ...headers },
  })
}

function deleteAsHuman(headers: Record<string, string> = {}) {
  return fetch(`${base}/api/v1/docs/d_delete`, {
    method: 'DELETE', headers: { token: 'human-token', 'X-Space-Id': 's_docs', ...headers },
  })
}

describe('bot document deletion is forbidden before document lookup', () => {
  it.each(docTypes)('rejects the bot owner of a %s document', async (docType) => {
    meta.doc_type = docType
    await expectBotDenied(await deleteAsBot('/d_delete'))
    expect(meta.status).toBe(1)
  })

  it.each(botPaths)('rejects a bot admin of a human-owned document through %s', async (path) => {
    meta.owner_id = 'human_actor'
    await expectBotDenied(await deleteAsBot(path))
  })

  it.each(botPaths)('rejects a bot admin of another bot-owned document through %s', async (path) => {
    meta.owner_id = 'another_bot'
    await expectBotDenied(await deleteAsBot(path))
  })

  it('rejects the bot owner through the HTML slug route', async () => {
    meta.doc_type = 'html'
    await expectBotDenied(await deleteAsBot('/octo-doc/html-slug'))
  })

  it.each(botPaths)('rejects deleted, archived and nonexistent documents uniformly through %s', async (path) => {
    for (const status of [0, 2]) {
      meta.status = status
      meta.octo_doc_slug = meta.doc_id
      meta.html_idempotency_key_hash = Buffer.alloc(32, 1)
      await expectBotDenied(await deleteAsBot(path))
    }
    getByDocId.mockResolvedValue(null)
    getByOctoDocSlug.mockResolvedValue(null)
    await expectBotDenied(await deleteAsBot(path))
  })

  it.each(botPaths)('ignores forged human identity and Space fields through %s', async (path) => {
    const response = await fetch(`${base}/v1/bot/docs${path}?ownerId=human_actor`, {
      method: 'DELETE',
      headers: {
        authorization: 'Bearer bot-token', 'content-type': 'application/json',
        'X-Space-Id': 's_foreign', 'X-User-Id': 'human_actor',
      },
      body: JSON.stringify({ uid: 'human_actor', ownerId: 'human_actor', docSpaceScope: { mode: 'human' } }),
    })
    await expectBotDenied(response)
  })

  it.each(botPaths)('keeps missing and invalid bot tokens unauthorized through %s', async (path) => {
    for (const authorization of ['', 'Bearer invalid-token']) {
      const response = await deleteAsBot(path, { authorization })
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'unauthorized' })
      expectNoDeletion()
    }
  })

  it('does not accept a bot token on the human route', async () => {
    const response = await deleteAsHuman({ token: 'bot-token' })
    expect(response.status).toBe(401)
    expectNoDeletion()
  })

  it.each([deleteDocHandler, octoDocDeleteHandler])('fails closed without trusted principal context in %s', async (handler) => {
    const request = { uid: 'bot_actor', params: { docId: 'd_delete', octoDocSlug: 'html-slug' } } as unknown as Request
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() }
    await handler(request, response as unknown as Response)
    expect(response.status).toHaveBeenCalledWith(403)
    expect(response.json).toHaveBeenCalledWith({ error: 'bot_delete_forbidden' })
    expectNoDeletion()
  })
})

describe('human document deletion retains its existing authorization', () => {
  it.each(docTypes)('allows a human owner to delete a %s document', async (docType) => {
    meta.owner_id = 'human_actor'
    meta.doc_type = docType
    getRole.mockResolvedValue(undefined)
    const response = await deleteAsHuman()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ docId: 'd_delete', status: 'deleted' })
    expect(softDelete).toHaveBeenCalledTimes(1)
    expect(softDelete).toHaveBeenCalledWith('d_delete')
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith(meta.document_name, 4)
  })

  it('allows a human direct admin to delete a bot-owned document', async () => {
    const response = await deleteAsHuman()
    expect(response.status).toBe(200)
    expect(getRole).toHaveBeenCalledWith('d_delete', 'human_actor', 's_docs')
    expect(softDelete).toHaveBeenCalledTimes(1)
    expect(softDelete).toHaveBeenCalledWith('d_delete')
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith(meta.document_name, 4)
  })

  it.each(['writer', 'reader', undefined] as const)('still rejects a human with role %s', async (role) => {
    getRole.mockResolvedValue(role)
    const response = await deleteAsHuman()
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'forbidden' })
    expectNoDeletion()
  })

  it('still verifies the human current Space', async () => {
    isSpaceMember.mockResolvedValue(false)
    const response = await deleteAsHuman({ 'X-Space-Id': 's_foreign' })
    expect(response.status).toBe(404)
    expectNoDeletion()
  })
})
