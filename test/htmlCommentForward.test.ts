// HTML 评论转发 + Bot 任务上报。
//
// 这里钉的是**失败方向**:哪些情况绝不能放行、哪些情况绝不能把已经存好的评论判成失败。
// 两类错的代价都不可逆 —— 前者把任务派给不该动这篇文档的 Bot,后者让用户以为评论没发出去
// (于是重发,产生重复)。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  extractHtmlCommentId,
  readCommentFields,
  resolveHtmlBotAccess,
  forwardHtmlComment,
  htmlForwardEnabled,
} from '../src/api/services/htmlCommentForward.js'
import { config } from '../src/config/env.js'

// 权限判定改在本地做(与 Yjs 文档同一套 resolveRole),所以桩掉那三处数据源。
// 桩到 repo/权限层而不是 fetch:现在这条路**不再发跨服务请求**,钉住这一点本身也是目的。
const perm = vi.hoisted(() => ({
  getByOctoDocSlug:
    vi.fn<(slug: string, spaceId: string) => Promise<{ doc_id: string; status: number } | null>>(),
  resolveRole: vi.fn<(uid: string, docId: string) => Promise<string>>(),
  resolveBotDocAccess: vi.fn<(docId: string, botUid: string) => Promise<{ allowed: boolean; reason: string }>>(),
}))
vi.mock('../src/db/repos/docMetaRepo.js', () => ({ docMetaRepo: { getByOctoDocSlug: perm.getByOctoDocSlug } }))
vi.mock('../src/permission/resolveRole.js', () => ({ resolveRole: perm.resolveRole }))
vi.mock('../src/agent/botIdentity.js', () => ({
  resolveBotDocAccess: perm.resolveBotDocAccess,
  BOT_DOC_ACCESS_MIN_ROLE: 'writer',
}))

const original = { ...config.docHtml }

beforeEach(() => {
  // 默认一路放行,各用例只覆盖它要考察的那一环。
  // status 必须给 —— doc_meta.status 现在是闸门的一部分(1=active)。
  // 不给的话每条用例都会在生命周期门就被拒,后面的角色断言全部测不到。
  perm.getByOctoDocSlug.mockResolvedValue({ doc_id: 'd_1', status: 1 })
  perm.resolveRole.mockResolvedValue('writer')
  perm.resolveBotDocAccess.mockResolvedValue({ allowed: true, reason: 'ok' })
  config.docHtml.baseUrl = 'http://html.test'
  config.docHtml.timeoutMs = 1000
})

afterEach(() => {
  Object.assign(config.docHtml, original)
  vi.restoreAllMocks()
})

describe('extractHtmlCommentId', () => {
  it('reads the id out of the {data} envelope', () => {
    expect(extractHtmlCommentId({ data: { id: 'c_1' } })).toBe('c_1')
  })

  it('also accepts a bare object', () => {
    expect(extractHtmlCommentId({ id: 'c_1' })).toBe('c_1')
  })

  it('accepts a numeric id by stringifying it', () => {
    // 上报的 comment_id 本来就是字符串;万一给了数字也别丢。
    expect(extractHtmlCommentId({ data: { id: 42 } })).toBe('42')
  })

  it('returns null instead of throwing on any unexpected shape', () => {
    // ★ 取不到 id 只意味着**不能上报**。评论此时已经存好了 —— 抛异常会把一次成功的创建
    // 变成 5xx,用户重发就产生重复评论。所以一律 null,由调用方跳过上报、照常回成功。
    for (const shape of [null, undefined, 'str', 7, [], {}, { data: null }, { data: { id: '' } }]) {
      expect(extractHtmlCommentId(shape)).toBeNull()
    }
  })
})

describe('readCommentFields', () => {
  it('reads text and parentId', () => {
    expect(readCommentFields({ text: 'hi', parentId: 'c_1' })).toEqual({ text: 'hi', parentId: 'c_1' })
  })

  it('accepts snake_case parent_id and numeric ids', () => {
    expect(readCommentFields({ body: 'hi', parent_id: 3 })).toEqual({ text: 'hi', parentId: '3' })
  })

  it('degrades to empty text rather than throwing', () => {
    // 空正文会让上报侧判成 empty_text 而跳过 —— 那是对的降级,不该在这里炸。
    expect(readCommentFields(null)).toEqual({ text: '', parentId: null })
    expect(readCommentFields({ text: 42 })).toEqual({ text: '', parentId: null })
  })

  it('treats an empty-string parent as a root comment', () => {
    // 空串不能当成 parent_id 发出去:octo-server 用「有没有 parent_id」推导线程,
    // 发一个空串会让根评论被当成回复。
    expect(readCommentFields({ text: 'x', parentId: '' }).parentId).toBeNull()
  })
})

describe('htmlForwardEnabled', () => {
  it('is off when the base url is unset', () => {
    // 关闭时路由回 503,不是静默成功 —— 漏配要立刻可见。
    config.docHtml.baseUrl = ''
    expect(htmlForwardEnabled()).toBe(false)
    config.docHtml.baseUrl = '   '
    expect(htmlForwardEnabled()).toBe(false)
  })
})

describe('forwardHtmlComment', () => {
  it('sends the CALLER token, never the service secret', async () => {
    // ★ 上游拿这个 token 认「是谁在评论」。带服务身份去写,任何人都能以任何人的名义评论。
    // (作者**权限**闸在本地判,见 resolveHtmlBotAccess —— 上游存评论只要 CapComment,
    // 证明不到 writer。)
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { id: 'c_9' } }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const out = await forwardHtmlComment({ slug: 's1', body: { text: 'hi' } }, 'caller-tok')
    expect(out.ok).toBe(true)
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer caller-tok')
    expect(JSON.stringify(headers)).not.toContain('secret')
  })

  it('forwards the verified Viewer Space to octo-docs-html', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { id: 'c_9' } }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    await forwardHtmlComment({ slug: 's1', body: { text: 'hi' } }, 'caller-tok', 'viewer-space-b')
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>
    expect(headers['X-Space-Id']).toBe('viewer-space-b')
  })

  it('passes the upstream status and payload through unchanged', async () => {
    // 403/409/422 都是 octo-docs-html 的判断结果,前端按它的错误码做提示。
    // 翻译或吞掉会让两边对不上。
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })))
    const out = await forwardHtmlComment({ slug: 's1', body: {} }, 'tok')
    expect(out).toMatchObject({ ok: false, status: 403, payload: { error: 'forbidden' } })
  })

  it('carries the slug into the body', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await forwardHtmlComment({ slug: 's1', body: { text: 'hi' } }, 'tok')
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)).toMatchObject({
      slug: 's1',
      text: 'hi',
    })
  })
})


// ── 权限判定(改为本地判,与 Yjs 文档同一套 resolveRole) ─────────────────────────
// 这一组钉三件事:两个主体各判一次、没注册的文档一律拒、以及**不再发跨服务请求**。
describe('resolveHtmlBotAccess', () => {
  const base = { slug: 's1', spaceId: 'sp1', authorUid: 'u_human', botUid: 'bot_1' }

  it('作者 writer + Bot 有权 ⇒ 放行,且完全不发网络请求', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const got = await resolveHtmlBotAccess(base)
    expect(got.allowed).toBe(true)
    // ★ 判定必须在本地完成。发请求就意味着又出现了第二处授权判定。
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('★ 没注册进 doc_meta 的文档一律拒绝(产品结论)', async () => {
    // HTML 文档要有 doc_meta 行得先注册成功。没注册的在侧边栏看不见,判不出权限就拒。
    perm.getByOctoDocSlug.mockResolvedValue(null)
    const got = await resolveHtmlBotAccess(base)
    expect(got).toEqual({ allowed: false, reason: 'doc_not_registered' })
    // 拒了就不该再去问角色 —— 少一次无谓查询,也证明短路顺序对。
    expect(perm.resolveRole).not.toHaveBeenCalled()
  })

  it('★ 只能评论的发起人不能召唤 Bot(与 Yjs 文档同一个门槛)', async () => {
    // 上一版把「上游收下了这条评论」当作者权限的凭据,而上游存评论只要 CapComment ——
    // 于是 commenter 在 HTML 上能召唤有编辑权的 Bot,在 Yjs 上不行。这条钉住两边一致。
    perm.resolveRole.mockResolvedValue('commenter')
    const got = await resolveHtmlBotAccess(base)
    expect(got).toEqual({ allowed: false, reason: 'author_role_too_low' })
    expect(perm.resolveBotDocAccess).not.toHaveBeenCalled()
  })

  it('作者够权但 Bot 无权 ⇒ 拒绝,并带回 Bot 侧的 reason', async () => {
    perm.resolveBotDocAccess.mockResolvedValue({ allowed: false, reason: 'bot_no_doc_access' })
    expect(await resolveHtmlBotAccess(base)).toEqual({
      allowed: false,
      reason: 'bot_no_doc_access',
    })
  })

  it('slug 必须带 spaceId 去查(slug 只在一个 space 内唯一)', async () => {
    await resolveHtmlBotAccess(base)
    expect(perm.getByOctoDocSlug).toHaveBeenCalledWith('s1', 'sp1')
  })

  it('查询抛异常 ⇒ 拒绝(判不出来不放行)', async () => {
    perm.getByOctoDocSlug.mockRejectedValue(new Error('db down'))
    expect(await resolveHtmlBotAccess(base)).toEqual({ allowed: false, reason: 'lookup_failed' })
  })

  it.each([
    ['slug', { ...base, slug: '' }],
    ['spaceId', { ...base, spaceId: '' }],
    ['authorUid', { ...base, authorUid: '' }],
    ['botUid', { ...base, botUid: '' }],
  ])('缺 %s ⇒ 拒绝', async (_name, params) => {
    expect((await resolveHtmlBotAccess(params)).allowed).toBe(false)
  })
})

// ── P0 回归:路径 slug 与 body slug 不能分叉 ────────────────────────────────────
describe('forwardHtmlComment — slug 收口', () => {
  it('★ body 里的 slug 不能覆盖路径的 slug', async () => {
    // 覆盖发生时是提权:上游按 body 的 slug 鉴权并存评论,而闸②和入队任务用路径的 slug。
    // 攻击者路径填零权限的 VICTIM、body 填自己有权限的文档 —— 上游放行,任务派去改 VICTIM。
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { id: 'c1' } }), { status: 200 }),
    )
    await forwardHtmlComment({ slug: 'path-slug', body: { slug: 'VICTIM', text: 'x' } }, 'tok')
    const sent = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string)
    expect(sent.slug).toBe('path-slug')
    expect(sent.slug).not.toBe('VICTIM')
  })

  it('body 的其它字段仍然原样透传', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { id: 'c1' } }), { status: 200 }),
    )
    await forwardHtmlComment(
      { slug: 's1', body: { text: 'hi', version: 3, anchor: { kind: 'element', aid: 'a1' } } },
      'tok',
    )
    const sent = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string)
    expect(sent).toMatchObject({ slug: 's1', text: 'hi', version: 3 })
    expect(sent.anchor).toEqual({ kind: 'element', aid: 'a1' })
  })
})
