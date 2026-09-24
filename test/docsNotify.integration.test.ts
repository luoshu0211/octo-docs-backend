import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'

// Captured requests from the live server.
type CapturedBody = {
  space_id: string
  targets: string[]
  payload?: unknown
  card?: unknown
  docs_card: Record<string, unknown>
}
const captured: Array<{ headers: Record<string, string | string[] | undefined>; body: CapturedBody }> = []
let server: Server
let baseUrl = ''

vi.mock('../src/config/env.js', () => ({
  config: {
    // serverBaseUrl is patched to the live mock in beforeAll (see below).
    octoIdentity: { get serverBaseUrl() { return baseUrl } },
    notify: { docsToken: 'itok-integration', service: 'docs-service' },
  },
}))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  ROLE_ADMIN: 3,
  docMemberRepo: {
    list: vi.fn(async () => [
      { doc_id: 'doc-1', uid: 'u-admin', principal_space_id: 'space-1', role: 3 },
      { doc_id: 'doc-1', uid: 'u-owner', principal_space_id: 'space-1', role: 3 },
    ]),
  },
}))
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: { getByDocId: vi.fn(async () => ({
    doc_id: 'doc-1', space_id: 'home-space', owner_id: 'owner', owner_space_id: 'home-space',
    share_scope: 0, status: 1,
  })) },
}))
vi.mock('../src/auth/octoIdentity.js', () => ({
  getOctoIdentity: () => ({
    getUser: vi.fn(async (uid: string) => ({ uid, name: uid === 'u-req' ? '小明' : uid })),
    getSpaceName: vi.fn(async () => '123 Space'),
    spaceBots: vi.fn(async () => [
      { uid: 'bot-a', name: '分析助手' },
      { uid: 'bot-b', name: '写作助手' },
    ]),
  }),
}))
vi.mock('../src/api/guard.js', () => ({ requireDocRole: vi.fn() }))
vi.mock('../src/db/pool.js', () => ({ query: vi.fn(async () => []), transaction: vi.fn() }))
vi.mock('../src/db/repos/docCommentRepo.js', () => ({
  docCommentRepo: { create: vi.fn(async () => 202), createReplyIfRoot: vi.fn(async () => 203) },
}))
vi.mock('../src/api/services/commentEvents.js', () => ({ publishCommentMutation: vi.fn(async () => {}) }))
vi.mock('../src/api/services/botMention.js', () => ({
  reportBotMentions: vi.fn(async () => ({ accepted: 0, skipped: 0, failed: 0 })),
}))
vi.mock('../src/collab/anchorResolve.js', () => ({
  resolveAnchorFromLiveDoc: vi.fn(), AmbiguousAnchorError: class extends Error {}, AnchorTextNotFoundError: class extends Error {},
}))

import { notifyDocAccessRequested, notifyDocMentioned } from '../src/api/services/docsNotify.js'
import { commentsRouter } from '../src/api/routes/comments.js'
import { requireDocRole } from '../src/api/guard.js'
import { docCommentRepo } from '../src/db/repos/docCommentRepo.js'

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    Object.assign(req, { uid: 'u-req', spaceId: 'space-1', principalSpaceId: 'space-1', ownedBots: [] })
    next()
  })
  app.use('/api/v1/docs', commentsRouter)
  server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/internal/notify') {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        const body = JSON.parse(raw)
        captured.push({ headers: req.headers, body })
        if (!body.docs_card.title.trim()) {
          res.writeHead(400)
          res.end()
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        // Echo the single target back as delivered, like octo-server on success.
        res.end(JSON.stringify({ delivered: [body.targets[0]], filtered: {} }))
      })
      return
    }
    app(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  captured.length = 0
  vi.clearAllMocks()
})

describe('docsNotify integration (real HTTP round-trip)', () => {
  it.each([
    { docType: 'doc', reply: false }, { docType: 'doc', reply: true },
    { docType: 'sheet', reply: false }, { docType: 'sheet', reply: true },
  ])('delivers a redacted card after HTTP comment creation ($docType, reply=$reply)', async ({ docType, reply }) => {
    vi.mocked(requireDocRole).mockResolvedValue({
      meta: { doc_id: 'doc-1', document_name: 'octo:home-space:f:doc-1', doc_type: docType,
        title: '保密项目预算', space_id: 'home-space', status: 1 },
      role: 'commenter',
    } as never)
    const body = '@[user:outsider:未授权成员] 保密金额 1234567'
    const response = await fetch(`${baseUrl}/api/v1/docs/doc-1/comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body, ...(reply ? { parentId: 201 } : { anchorStart: 'AQID', anchorEnd: 'BAUG' }) }),
    })
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ id: reply ? 203 : 202 })
    expect(reply ? docCommentRepo.createReplyIfRoot : docCommentRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ docId: 'doc-1', authorUid: 'u-req', body }),
    )
    await vi.waitFor(() => expect(captured).toHaveLength(1))
    expect(captured[0]?.body).toMatchObject({
      space_id: 'space-1', targets: ['outsider'],
      docs_card: { doc_id: 'doc-1', title: '你在一篇文档中被提及', kind: 'commented',
        excerpt: '你暂时没有访问权限，打开文档后可申请访问。' },
    })
    expect(JSON.stringify(captured)).not.toContain('保密')
    expect(JSON.stringify(captured)).not.toContain('1234567')
  })

  it('delivers a human mention with a nonempty title in the authorized recipient Space', async () => {
    expect(await notifyDocMentioned({
      docId: 'doc-1', spaceId: 'home-space', principalSpaceId: 'space-1',
      title: '', authorUid: 'u-req', body: '@[user:u-admin:成员] 看一下 @[user:outsider:未授权成员]',
    })).toBe(2)
    expect(captured).toHaveLength(2)
    expect(captured[0]?.headers['x-internal-token']).toBe('itok-integration')
    expect(captured[0]?.body).toMatchObject({
      space_id: 'space-1', targets: ['u-admin'],
      docs_card: { doc_id: 'doc-1', title: '无标题文档', kind: 'commented', actor_uid: 'u-req' },
    })
    expect(captured[1]?.body).toEqual({
      service: 'docs-service', space_id: 'space-1', targets: ['outsider'], actor_uid: '',
      docs_card: {
        doc_id: 'doc-1', request_id: '', kind: 'commented', title: '你在一篇文档中被提及',
        actor_uid: 'u-req', actor_name: '小明',
        excerpt: '你暂时没有访问权限，打开文档后可申请访问。', updated_at: expect.any(String),
      },
    })
  })

  it('sends a redacted notification when every mentioned user lacks document access', async () => {
    expect(await notifyDocMentioned({
      docId: 'doc-1', spaceId: 'home-space', principalSpaceId: 'space-1',
      title: '保密项目预算', authorUid: 'u-req',
      body: '@[user:outsider:未授权成员] 保密金额 1234567 @[doc:secret-doc:秘密文档]',
    })).toBe(1)
    expect(captured).toHaveLength(1)
    expect(captured[0]?.body.targets).toEqual(['outsider'])
    expect(captured[0]?.body.docs_card).toMatchObject({
      doc_id: 'doc-1', title: '你在一篇文档中被提及', excerpt: '你暂时没有访问权限，打开文档后可申请访问。',
    })
    const wire = JSON.stringify(captured)
    for (const secret of ['保密项目预算', '1234567', 'secret-doc', '秘密文档', '未授权成员']) {
      expect(wire).not.toContain(secret)
    }
  })

  it('delivers to both approvers with the exact contract wire shape', async () => {
    const delivered = await notifyDocAccessRequested({
      docId: 'doc-1',
      requestId: 'req-1',
      spaceId: 'space-1',
      principalSpaceId: 'space-1',
      ownerId: 'u-owner',
      ownerSpaceId: 'space-1',
      title: 'Q3 计划',
      requesterUid: 'u-req',
      requesterSpaceId: 'space-1',
      reason: '需要编辑权限',
      botUids: ['bot-a', 'bot-b'],
    })

    expect(delivered).toBe(2)
    expect(captured).toHaveLength(2)

    // Every request carried the internal token and the structured docs_card.
    for (const c of captured) {
      expect(c.headers['x-internal-token']).toBe('itok-integration')
      expect(c.headers['content-type']).toContain('application/json')
      expect(c.body.targets).toHaveLength(1)
      expect(c.body.payload).toBeUndefined()
      expect(c.body.card).toBeUndefined()
      expect(c.body.docs_card).toMatchObject({
        doc_id: 'doc-1',
        kind: 'access_requested',
        title: 'Q3 计划',
        actor_name: '小明',
        actor_uid: 'u-req',
        excerpt: '需要编辑权限',
        requester_space_name: '123 Space',
        requested_bot_names: ['分析助手', '写作助手'],
      })
      expect(c.body.docs_card.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    }
    const recipients = captured.map((c) => c.body.targets[0]).sort()
    expect(recipients).toEqual(['u-admin', 'u-owner'])
  })
})
