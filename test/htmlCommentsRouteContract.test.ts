// route 层契约测试:POST /html/:slug/comments 收到**前端真实发出的 body** 时必须成功。
//
// 为什么要有这个文件 —— htmlCommentForward.test.ts 只测 service,route 层那个
// 「body 带 slug 就 400」的分支之前一条测试都没有,而前端 createComment()
// (web: packages/docs/src/html/htmlDocComments.ts)恰恰**一直**在 body 里带 slug。
// 两个仓库各自的测试都绿,跨仓这条契约没人守 ⇒ HTML 评论全量发不出去。
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import express, { json, type Express, type Request, type Response, type NextFunction } from 'express'

const forwardHtmlComment = vi.fn()
const fireHtmlBotMentionReport = vi.fn()

vi.mock('../src/api/services/htmlCommentForward.js', () => ({
  forwardHtmlComment: (...a: unknown[]) => forwardHtmlComment(...a),
  fireHtmlBotMentionReport: (...a: unknown[]) => fireHtmlBotMentionReport(...a),
  htmlForwardEnabled: () => true,
  readCommentFields: (body: Record<string, unknown>) => ({
    text: String(body?.text ?? ''),
    parentId: body?.parent_id as string | undefined,
  }),
}))

let app: Express
let server: Server
let base: string

beforeAll(async () => {
  const { htmlCommentsRouter } = await import('../src/api/routes/htmlComments.js')
  app = express()
  app.use(json())
  // 模拟鉴权中间件已注入身份(真链路里由 octoIdentity 完成)。
  // ★ 这里**故意不写 req.spaceId** —— 真链路上就没人写:htmlCommentsRouter 在
  // app.ts:219 裸挂,前面只有 authMiddleware,没有 spaceContextMiddleware。
  // 之前这个 harness 注入了 spaceId='sp_1',正是它把「spaceId 永远为空 ⇒ 闸② 恒拒」
  // 这条 P0 从测试里遮住了。现在按真实链路来,spaceId 只能从 X-Space-Id 头取。
  app.use((req: Request, _res: Response, next: NextFunction) => {
    ;(req as unknown as Record<string, unknown>).uid = 'u_caller'
    ;(req as unknown as Record<string, unknown>).octoToken = 'tok_caller'
    ;(req as unknown as Record<string, unknown>).ownedBots = []
    next()
  })
  app.use(htmlCommentsRouter)
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve())
  })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  forwardHtmlComment.mockReset()
  fireHtmlBotMentionReport.mockReset()
  forwardHtmlComment.mockResolvedValue({ ok: true, status: 200, payload: { id: 'c1' }, commentId: 'c1' })
})

describe('POST /html/:slug/comments — 前端真实 body 的契约', () => {
  it('★ 前端发的 body 带 slug(现网形状)必须被接受,不能 400', async () => {
    // 这就是 web/packages/docs/src/html/htmlDocComments.ts createComment() 的真实形状:
    //   body = { slug, text, version, anchor? | parent_id? }
    const res = await fetch(`${base}/html/my-slug/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: 'my-slug',
        text: 'please fix',
        version: 3,
        anchor: { kind: 'element', aid: 'a42' },
      }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 'c1' })
  })

  it('★ 提权仍被挡住:body 的 slug 与路径不一致时,转发用的必须是路径 slug', async () => {
    // P0 的真正判据不是「拒绝请求」,而是「路径 slug 赢」。
    // 攻击者路径填零权限的 VICTIM、body 填自己有权限的文档,上游必须按 VICTIM 鉴权。
    const res = await fetch(`${base}/html/VICTIM/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'attacker-own-doc', text: 'do evil', version: 1 }),
    })
    expect(res.status).toBe(200)
    const call = forwardHtmlComment.mock.calls[0]![0] as { slug: string }
    expect(call.slug).toBe('VICTIM')
  })
})

describe('POST /html/:slug/comments — @Bot 上报拿到的 spaceId(P0 回归)', () => {
  it('★ 带 X-Space-Id 时,上报的 spaceId 必须是该头的值,不能是空串', async () => {
    // 这条钉住的是「路由存在的唯一理由」:spaceId 为空 ⇒ resolveHtmlDocId 的
    // `if (!slug || !spaceId) return null` 恒真 ⇒ 闸② 恒 false ⇒ 每一条 HTML
    // @Bot 都被拒。此前读的是 req.spaceId,而本链路无人写它 ⇒ 恒空。
    const res = await fetch(`${base}/html/my-slug/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Space-Id': 'sp_real' },
      body: JSON.stringify({ slug: 'my-slug', text: '@bot 帮我改一下', version: 1 }),
    })
    expect(res.status).toBe(200)
    expect(forwardHtmlComment.mock.calls[0]![2]).toBe('sp_real')
    // 上报是 res 之后脱离式触发的,等一个微任务轮次。
    await new Promise((r) => setTimeout(r, 0))
    expect(fireHtmlBotMentionReport).toHaveBeenCalledTimes(1)
    const arg = fireHtmlBotMentionReport.mock.calls[0]![0] as { spaceId: string; slug: string }
    expect(arg.spaceId).toBe('sp_real')
    expect(arg.spaceId).not.toBe('')
    // 顺带钉住:上报用的也必须是路径 slug。
    expect(arg.slug).toBe('my-slug')
  })

  it('★ 头两侧空白要 trim —— 未 trim 的值当查找键会解析不出文档,退化成恒拒', async () => {
    const res = await fetch(`${base}/html/my-slug/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Space-Id': '  sp_pad  ' },
      body: JSON.stringify({ slug: 'my-slug', text: '@bot', version: 1 }),
    })
    expect(res.status).toBe(200)
    expect(forwardHtmlComment.mock.calls[0]![2]).toBe('sp_pad')
    await new Promise((r) => setTimeout(r, 0))
    const arg = fireHtmlBotMentionReport.mock.calls[0]![0] as { spaceId: string }
    expect(arg.spaceId).toBe('sp_pad')
  })

  it('★ 缺 X-Space-Id 时:评论仍必须 200(不能拿功能换校验),但不得带空 spaceId 去上报', async () => {
    // 修法故意**没有**挂 spaceContextMiddleware:那会缺头即 400,把评论转发
    // 这一半一起打死。所以缺头的正确行为是「评论成功 + 跳过上报并记账」,
    // 而不是「评论成功 + 拿空 spaceId 触发一次注定被拒的上报」。
    const res = await fetch(`${base}/html/my-slug/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'my-slug', text: '@bot', version: 1 }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 'c1' })
    await new Promise((r) => setTimeout(r, 0))
    expect(fireHtmlBotMentionReport).not.toHaveBeenCalled()
  })
})
