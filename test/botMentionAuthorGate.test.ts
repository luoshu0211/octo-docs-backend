import { describe, it, expect, vi, beforeEach } from 'vitest'

// 这个文件只测一件事:作者侧权限闸(gate #1)在**类型上**不可能被绕过。
//
// 背景 —— 为什么值得单独一个文件:
// 上一版把 `authorPreVerified` 放在 params、把兜住它的 `botAllowed` 放在第二个参数
// deps 里。两者在类型上互不要求,于是
//     reportBotMentions({ ...p, authorPreVerified: true })      // 不传 deps
// 是一个能编译、能跑、而作者侧**完全没有闸门**的调用。评审连续两轮指到这条缝,
// 而当时零测试覆盖 authorPreVerified,所以没有任何东西会因此变红。
//
// 现在 BotMentionAuthorGate 是判别联合:authorPreVerified: true 分支强制要求
// botAllowed 同行。下面 1) 用 @ts-expect-error 把「缺闸门」钉成编译错误
// (@ts-expect-error 若不再报错,tsc 自己会失败 —— 这就是回归锁),
// 2) 再用运行时断言证明闸门真的被调用、拒绝真的生效。
vi.mock('../src/config/env.js', () => ({
  config: {
    webOrigin: 'https://docs.example.com',
    octoIdentity: { serverBaseUrl: 'http://octo-server:8080' },
    notify: { docsToken: '', service: 'docs-service' },
    botMention: {
      token: 'bot-mention-token',
      baseUrl: 'http://octo-server:8080',
      timeoutMs: 5000,
      maxAttempts: 1,
      baseDelayMs: 1,
      maxDelayMs: 2,
      budgetMs: 60_000,
      maxRetryAfterMs: 30_000,
      maxBotsPerComment: 8,
    },
  },
}))

const db = vi.hoisted(() => ({ getRole: vi.fn(), getByDocId: vi.fn() }))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  ROLE_ADMIN: 3,
  docMemberRepo: { list: vi.fn(async () => []), getRole: db.getRole },
}))
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: { getByDocId: db.getByDocId },
}))
vi.mock('../src/auth/octoIdentity.js', () => ({
  listCallerBots: vi.fn(async () => []),
}))

const { reportBotMentions } = await import('../src/api/services/botMention.js')

const BOT = 'bot-uid-1'
// 一条会解析出恰好一个 @Bot 的评论正文。
const BODY = `hi @[user:${BOT}:小助手] 看一下`

const baseParams = {
  docId: 'doc-1',
  commentId: 1,
  parentId: null,
  spaceId: 'space-1',
  authorUid: 'human-1',
  ownedBots: [BOT],
  body: BODY,
}

describe('作者侧权限闸(gate #1)不可绕过', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // 让 Bot 侧的默认闸(doc_member)在常规路径上放行,以便隔离出作者侧的行为。
    db.getByDocId.mockResolvedValue({ docId: 'doc-1', spaceId: 'space-1', creatorUid: 'human-1' })
    db.getRole.mockResolvedValue(3)
    // 契约:200 + accepted=true 才算投递成功(见 classifyResponse)。
    global.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ accepted: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as never
  })

  it('authorPreVerified 缺少 botAllowed => 编译期就被拒(回归锁)', () => {
    // 这一段的价值全在 @ts-expect-error 上:哪天有人把 botAllowed 改回可选、
    // 或把 authorPreVerified 退回成裸 boolean,这里就「不再报错」,
    // 于是 @ts-expect-error 本身变成 tsc 错误 —— 缝一被重新打开就有东西变红。
    const call = () =>
      reportBotMentions(
        // @ts-expect-error authorPreVerified 必须与 botAllowed 同行,少了它就是没有作者闸
        { ...baseParams, authorPreVerified: true },
      )
    expect(typeof call).toBe('function')
  })

  it('authorRole 与 authorPreVerified 互斥 => 不能同时给(编译期)', () => {
    const call = () =>
      reportBotMentions(
        // @ts-expect-error 两个分支互斥:给了 authorRole 就不该再声称 preVerified
        { ...baseParams, authorRole: 'writer', authorPreVerified: true, botAllowed: async () => true },
      )
    expect(typeof call).toBe('function')
  })

  it('HTML 路径:botAllowed 返回 false => 不发请求(作者闸真的在拦)', async () => {
    const botAllowed = vi.fn(async () => false)
    const r = await reportBotMentions({
      ...baseParams,
      authorPreVerified: true,
      botAllowed,
    })
    expect(botAllowed).toHaveBeenCalledWith(BOT)
    expect(r).toEqual({ accepted: 0, skipped: 1, failed: 0 })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('HTML 路径:botAllowed 抛异常 => 当拒绝处理,fail closed', async () => {
    const botAllowed = vi.fn(async () => {
      throw new Error('octo-docs-html unreachable')
    })
    const r = await reportBotMentions({
      ...baseParams,
      authorPreVerified: true,
      botAllowed,
    })
    expect(r.accepted).toBe(0)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('HTML 路径:botAllowed 放行 => 正常投递一次', async () => {
    const r = await reportBotMentions({
      ...baseParams,
      authorPreVerified: true,
      botAllowed: async () => true,
    })
    expect(r.accepted).toBe(1)
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('常规路径:角色低于阈值 => 不发请求,且根本不问 Bot 侧', async () => {
    const botAllowed = vi.fn(async () => true)
    const r = await reportBotMentions({ ...baseParams, authorRole: 'reader', botAllowed })
    expect(r).toEqual({ accepted: 0, skipped: 0, failed: 0 })
    // 作者闸先判 —— 权限不够的调用一分钱解析/IO 都不该花。
    expect(botAllowed).not.toHaveBeenCalled()
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
