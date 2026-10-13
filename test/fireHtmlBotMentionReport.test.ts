// fireHtmlBotMentionReport —— 端到端的「派不派 Bot」闸门测试。
//
// 为什么单开一个文件而不是并进 htmlCommentForward.test.ts:那边测的是
// resolveHtmlBotAccess 这个**纯判定函数**,拿它的返回值做断言。而真正决定线上
// 会不会给 Bot 派活的,是 fireHtmlBotMentionReport —— 它自己组装 authorPreVerified
// 和 botAllowed 传进 reportBotMentions。判定函数正确、组装写错(比如把 resolver 换成
// `async () => true`),前者全绿、线上照样漏。评审明确点了这一点:
// 「一个用拒绝的 resolver 驱动 fireHtmlBotMentionReport、断言零外发的测试」。
//
// 所以这里的断言口径统一是 **fetch 调用次数** —— 不是返回值,不是日志。
// 上报要真发出去,唯一可观察的出口就是打向 octo-server 的那个 HTTP 请求。
// 零 fetch = Bot 没被派活,这是唯一不会被内部重构绕过的判据。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireHtmlBotMentionReport } from '../src/api/services/htmlCommentForward.js'

// 整个 config 桩掉(与 botMention.test.ts 同一惯例):这条路会走真实的重试/退避实现,
// 用真实默认值会让「拒绝」用例白等好几秒的退避阶梯。这里只需要「token 配了 ⇒ 上报通道是
// 开的」,好让零 fetch 只可能是闸门拦下的,不可能是通道本来就关着。
vi.mock('../src/config/env.js', () => ({
  config: {
    webOrigin: 'https://docs.example.com',
    octoIdentity: { serverBaseUrl: 'http://octo-server:8080' },
    notify: { docsToken: '', service: 'docs-service' },
    docHtml: { baseUrl: 'http://html.test', timeoutMs: 1000 },
    botMention: {
      token: 'bot-mention-token',
      baseUrl: 'http://octo-server:8080',
      timeoutMs: 5000,
      maxAttempts: 5,
      baseDelayMs: 500,
      maxDelayMs: 8000,
      budgetMs: 60_000,
      maxRetryAfterMs: 30_000,
      maxBotsPerComment: 8,
    },
  },
}))

const perm = vi.hoisted(() => ({
  trackCommentTask: vi.fn(async () => {}),
  getByOctoDocSlug:
    vi.fn<(slug: string, spaceId: string) => Promise<{ doc_id: string; status: number } | null>>(),
  resolveRole: vi.fn<(uid: string, docId: string) => Promise<string>>(),
  resolveBotDocAccess:
    vi.fn<(docId: string, botUid: string) => Promise<{ allowed: boolean; reason: string }>>(),
}))
// Keep the real dispatch/permission path, but isolate its persistence observer.
// The observer's database contract is covered by commentTaskTracking/Repo tests.
vi.mock('../src/api/services/commentTaskTracking.js', () => ({
  trackCommentTask: perm.trackCommentTask,
}))
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: { getByOctoDocSlug: perm.getByOctoDocSlug },
}))
vi.mock('../src/permission/resolveRole.js', () => ({ resolveRole: perm.resolveRole }))
vi.mock('../src/agent/botIdentity.js', () => ({
  resolveBotDocAccess: perm.resolveBotDocAccess,
  BOT_DOC_ACCESS_MIN_ROLE: 'writer',
}))

// fireHtmlBotMentionReport 是**脱离式**的(void 一个 async IIFE,绝不抛)。
// 它返回时上报还没发生,所以断言前必须把微任务队列排干,否则测的是「还没跑」而不是
// 「没派活」—— 那样连一个真实缺陷都抓不住。
async function drain(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve()
  await new Promise((r) => setImmediate(r))
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

const baseParams = {
  slug: 'slug_1',
  commentId: 'c_1',
  parentId: null,
  // mention 必须是 `@[type:id:label]` 令牌 —— 纯文本 "@bot_1" 解析不出任何 mention,
  // 于是在权限判定**之前**就返回了,所有「零外发」断言都会变成假绿。
  text: '@[user:bot_1:助手] 帮我改一下',
  authorUid: 'u_author',
  spaceId: 'sp_1',
  ownedBots: ['bot_1'],
  callerToken: 'tok_caller',
}

beforeEach(() => {
  perm.trackCommentTask.mockReset()
  // 默认全放行 + 文档 active,各用例只翻它要考察的那一环。
  perm.getByOctoDocSlug.mockResolvedValue({ doc_id: 'd_1', status: 1 })
  perm.resolveRole.mockResolvedValue('writer')
  perm.resolveBotDocAccess.mockResolvedValue({ allowed: true, reason: 'ok' })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  global.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ accepted: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch
})

afterEach(() => {
  vi.restoreAllMocks()
})

function fetchCalls(): number {
  return (global.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length
}

describe('fireHtmlBotMentionReport — 放行基线', () => {
  it.each(['prepare', 'delivery'] as const)('dispatches when the %s tracking observer throws', async phase => {
    if (phase === 'delivery') perm.trackCommentTask.mockResolvedValueOnce(undefined)
    perm.trackCommentTask.mockRejectedValueOnce(new Error('tracking unavailable'))
    fireHtmlBotMentionReport(baseParams)
    await drain()
    expect(fetchCalls()).toBe(1)
    expect(perm.trackCommentTask).toHaveBeenCalledTimes(2)
    expect(perm.trackCommentTask).toHaveBeenLastCalledWith(expect.any(Object), 'bot_1', { kind: 'accepted', replay: false })
    expect(console.warn).toHaveBeenCalledWith('[octo-docs] bot-mention tracking unavailable', expect.objectContaining({ phase }))
  })

  it('作者 writer + Bot writer + 文档 active ⇒ 真的发出上报', async () => {
    // 这条是**基线**,不是凑数:下面每条拒绝用例都只有在「其它条件下会放行」时才有意义。
    // 没有它,一个把 fetch 整个拆掉的改动会让所有拒绝用例继续全绿。
    fireHtmlBotMentionReport(baseParams)
    await drain()
    expect(fetchCalls()).toBe(1)
    const task = expect.objectContaining({ docId: 'slug_1', commentId: 'c_1', docKind: 'html', spaceId: 'sp_1' })
    expect(perm.trackCommentTask).toHaveBeenCalledTimes(2)
    expect(perm.trackCommentTask).toHaveBeenNthCalledWith(1, task, 'bot_1')
    expect(perm.trackCommentTask).toHaveBeenNthCalledWith(2, task, 'bot_1', expect.objectContaining({ kind: 'accepted' }))
  })
})

describe('fireHtmlBotMentionReport — 作者侧闸门(评审要求的那条)', () => {
  it('作者只有 commenter ⇒ 零外发', async () => {
    // 这正是 authorPreVerified 曾经放过去的那个人:上游存评论只要 CapComment,
    // 于是「只能评论」的人能在 HTML 文档上召唤有编辑权的 Bot,而在 Yjs 文档上不行。
    perm.resolveRole.mockResolvedValue('commenter')
    fireHtmlBotMentionReport(baseParams)
    await drain()
    expect(fetchCalls()).toBe(0)
    expect(perm.trackCommentTask).not.toHaveBeenCalled()
  })

  it('作者 reader ⇒ 零外发', async () => {
    perm.resolveRole.mockResolvedValue('reader')
    fireHtmlBotMentionReport(baseParams)
    await drain()
    expect(fetchCalls()).toBe(0)
  })

  it('作者在这篇文档上没有任何角色 ⇒ 零外发', async () => {
    perm.resolveRole.mockResolvedValue('none')
    fireHtmlBotMentionReport(baseParams)
    await drain()
    expect(fetchCalls()).toBe(0)
  })
})

describe('fireHtmlBotMentionReport — Bot 侧闸门', () => {
  it('被 @ 的 Bot 改不了这篇文档 ⇒ 零外发', async () => {
    perm.resolveBotDocAccess.mockResolvedValue({ allowed: false, reason: 'role_too_low' })
    fireHtmlBotMentionReport(baseParams)
    await drain()
    expect(fetchCalls()).toBe(0)
    expect(perm.trackCommentTask).not.toHaveBeenCalled()
  })
})

describe('fireHtmlBotMentionReport — 文档生命周期', () => {
  // resolveRole 只看 doc_member / owner_id,**不看 status**:软删或归档之后成员行
  // 还在,所以不判 status 的话,一篇已删除的文档照样能把 Bot 任务派出去。
  it('软删除的文档(status=0)⇒ 零外发', async () => {
    perm.getByOctoDocSlug.mockResolvedValue({ doc_id: 'd_1', status: 0 })
    fireHtmlBotMentionReport(baseParams)
    await drain()
    expect(fetchCalls()).toBe(0)
  })

  it('归档的文档(status=2)⇒ 零外发', async () => {
    // 归档 = 不可写。不可写就不该派编辑型 Bot。
    perm.getByOctoDocSlug.mockResolvedValue({ doc_id: 'd_1', status: 2 })
    fireHtmlBotMentionReport(baseParams)
    await drain()
    expect(fetchCalls()).toBe(0)
  })

  it('没注册进 doc_meta 的文档 ⇒ 零外发', async () => {
    perm.getByOctoDocSlug.mockResolvedValue(null)
    fireHtmlBotMentionReport(baseParams)
    await drain()
    expect(fetchCalls()).toBe(0)
  })
})

describe('fireHtmlBotMentionReport — 跨租户', () => {
  it('slug 必须带着调用方的 spaceId 去解析(不能解析出别的 space 的同名文档)', async () => {
    fireHtmlBotMentionReport({ ...baseParams, spaceId: 'sp_other' })
    await drain()
    expect(perm.getByOctoDocSlug).toHaveBeenCalledWith('slug_1', 'sp_other')
  })
})

describe('fireHtmlBotMentionReport — 绝不抛', () => {
  it('权限查询抛异常 ⇒ 不冒泡、且零外发(fail-closed)', async () => {
    // 评论已经落库了。上报失败不能反过来让创建看起来失败 —— 但也不能因此放行。
    perm.resolveRole.mockRejectedValue(new Error('db down'))
    expect(() => fireHtmlBotMentionReport(baseParams)).not.toThrow()
    await drain()
    expect(fetchCalls()).toBe(0)
  })
})
