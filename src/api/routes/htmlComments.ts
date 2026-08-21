/**
 * HTML 文档评论的转发入口。
 *   POST /api/v1/docs/html/:slug/comments   body: octo-docs-html 的评论创建体
 *
 * 为什么前端不直连 octo-docs-html 了 —— 直连时 docs-backend 不在链路上,而
 * 「@bot 让它改文档」这件事需要有人识别 mention 并把任务入队。识别和可靠上报的实现
 * (重试/退避/幂等/UTF-8 截断)在 docs-backend 已经有了,在 Go 那侧重写一遍不值得。
 *
 * 但**评论仍然存在 octo-docs-html**:发布会做 publish_merge + AnchorMigrations 把评论锚点
 * 迁到新 aid,搬走就没这套迁移了。详见 services/htmlCommentForward.ts 顶部。
 *
 * 路径里用 `html/:slug` 而不是复用 `/:docId/comments`:HTML 的标识是 slug 不是 docId,
 * 而 `/:docId/comments` 那条路挂着 requireDocRole(查 doc_member)—— HTML 文档没有那行,
 * 挂上去只会稳定 404/403。显式分开一条路径,两边的权限模型各自清楚。
 */
import { Router, type Router as ExpressRouter, type Request, type Response } from 'express'
import {
  forwardHtmlComment,
  fireHtmlBotMentionReport,
  htmlForwardEnabled,
  readCommentFields,
} from '../services/htmlCommentForward.js'

export const htmlCommentsRouter: ExpressRouter = Router()

htmlCommentsRouter.post('/html/:slug/comments', async (req: Request, res: Response) => {
  const slug = String(req.params.slug ?? '')
  if (slug === '') {
    res.status(400).json({ error: 'slug_required' })
    return
  }
  // 没配基址 = 这条路没开。回 503 而不是静默成功:漏配时前端要立刻看到失败,
  // 而不是「评论看着发出去了其实没落库」。
  if (!htmlForwardEnabled()) {
    res.status(503).json({ error: 'html_forward_disabled' })
    return
  }
  // ★ body 里的 slug 一律忽略,**不能**因此拒掉请求。
  //
  // 提权的成因是「路径 slug 与 body slug 分叉」:上游按 body 的 slug 鉴权并存评论,而闸②
  // 和入队任务用**路径**的 slug —— 攻击者路径填零权限的文档 A、body 填自己有权限的 B,
  // 上游按 B 放行,任务却带着他写的指令派去改 A。
  // 收口点在 forwardHtmlComment:路径 slug 放在展开之后,强制取胜(见那里的 P0 回归测试)。
  // 分叉在那一处就已经不可能存在了。
  //
  // 这里**曾经**加过一道 `'slug' in body → 400`。那是错的:前端 createComment()
  // (web: packages/docs/src/html/htmlDocComments.ts)一直在 body 里带 slug,400 会让
  // HTML 评论全量发不出去 —— 拿冗余的第二道防线换掉整个功能不成立。
  // 见 test/htmlCommentsRouteContract.test.ts 的两条:现网形状必须 200,且路径 slug 仍然赢。
  const uid = req.uid
  const callerToken = req.octoToken
  // 转发**必须**带调用方自己的 token —— 上游要拿它认「是谁在评论」,不能拿服务身份替他写。
  // 注意:上游那道判定证明不到 writer(存评论只要 CapComment),所以它**不是**作者闸。
  // 作者闸 ① 在本地(见 htmlCommentForward.resolveHtmlBotAccess),与 Yjs 文档同一套 resolveRole。
  if (!uid || !callerToken) {
    res.status(401).json({ error: 'unauthenticated' })
    return
  }

  const viewerSpaceId = (() => {
    const raw = req.header('X-Space-Id')
    return typeof raw === 'string' ? raw.trim() : ''
  })()

  let forwarded
  try {
    forwarded = await forwardHtmlComment(
      { slug, body: req.body },
      callerToken,
      viewerSpaceId || undefined,
    )
  } catch {
    // 转发本身失败(网络/超时)。502 —— 这不是调用方的错,也不能假装成功。
    res.status(502).json({ error: 'html_upstream_unreachable' })
    return
  }

  // 原样回传 octo-docs-html 的状态码和响应体。403/409/422 都是它的判断结果,
  // 前端已经在按它的错误码做提示,这里翻译或吞掉只会让两边对不上。
  if (!forwarded.ok) {
    res.status(forwarded.status).json(forwarded.payload)
    return
  }

  // ★ 顺序:先把成功响应发出去,再触发上报。
  // 上报是脱离式的 best-effort,绝不能让它的耗时或失败影响这次创建 —— 评论已经落库了。
  res.status(forwarded.status).json(forwarded.payload)

  const { text, parentId } = readCommentFields(req.body)
  // 拿不到 comment_id 就没法入队(bin.md 的契约要 comment_id)。评论已经存好了,所以只
  // 跳过上报、不影响响应。记一行,免得静默丢任务。
  if (!forwarded.commentId) {
    // eslint-disable-next-line no-console
    console.warn('[octo-docs] html comment stored but id missing; skipping bot-mention report', {
      slug,
    })
    return
  }
  // ★ 承重输入:spaceId。
  //
  // 这条路由没有 spaceContextMiddleware,所以 req.spaceId 在本链上永远是 undefined
  // —— 三个写它的地方(spaceContext.ts:106 / verifyBot.ts:48 / ppt/auth.ts:60)都不在本链。
  //
  // 更正一处旧注释的错话:并**不是「没有东西解析 X-Space-Id」**——
  // humanDocSpaceScopeMiddleware(app.ts:194,挂在本路由之前)会把同一个头解析进
  // req.viewerSpaceId,逻辑与下面逐字节相同(docSpaceScope.ts:60-62)。
  // 明知重复仍就地再读一次,是为了不把承重输入绑在上游中间件的挂载上(见下)。
  // 之前直接读 `req.spaceId ?? ''` 的结果是:resolveHtmlDocId(slug, '') 里
  // `if (!slug || !spaceId) return null` 恒真 → 闸②恒 false → **每一条 HTML
  // @Bot 都被拒**,也就是这条路由存在的唯一理由从未生效。
  //
  // 修法为什么是「读头 + 软失败」而不是挂 spaceContextMiddleware:
  //   - 挂中间件缺头即 400,会把**评论转发本身**一起打死(转发是本路由的另一半职责,
  //     且已经落库成功了),拿功能换一道冗余校验不成立。
  //   - 头值不可信,但它在这里**不是授权凭据**:它只是
  //     docMetaRepo.getByOctoDocSlug(slug, spaceId) 的复合查找键。授权在下游由
  //     resolveHtmlBotAccess → resolveRole(docId) 按 doc_member 重新判(见
  //     src/permission/resolveRole.ts:只吃 docId)。填错 space 的后果是解析不出
  //     文档 → null → 拒绝,即 fail-closed;填对 space 也仍要过 doc_member。
  //     所以这里读头既不放大权限,也不会让跨租户名字碰撞变成越权(见
  //     htmlCommentForward.ts:138 的同一论证)。
  // 就地读头,**不复用** req.viewerSpaceId:那个字段由 humanDocSpaceScopeMiddleware
  // 填(app.ts:194),依赖它就把本路由的承重输入绑在「上游中间件必须挂着」这个前提上
  // —— 而 P0 的成因正是承重输入依赖了本链上没人填的字段。就地读头让这条路自给自足。
  if (viewerSpaceId === '') {
    // 缺头不影响评论(已回 200),但 @Bot 这一半必然做不了。显式记一行:
    // 否则又退回「静默恒拒」那个不可观测的状态。
    // eslint-disable-next-line no-console
    console.warn('[octo-docs] html comment stored but X-Space-Id missing; bot-mention report skipped', {
      slug,
      commentId: forwarded.commentId,
    })
    return
  }
  fireHtmlBotMentionReport({
    slug,
    commentId: forwarded.commentId,
    parentId,
    text,
    authorUid: uid,
    spaceId: viewerSpaceId,
    ownedBots: req.ownedBots ?? [],
    ...(callerToken ? { callerToken } : {}),
  })
})
