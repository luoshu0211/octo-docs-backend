// HTML 文档评论的转发 + Bot 任务上报。
//
// ── 为什么是「转发」而不是「自己存」 ────────────────────────────────────────────
// HTML 文档的评论**存在 octo-docs-html**,不在 docs-backend。它必须留在那边:发布(Publish)
// 会做 publish_merge + AnchorMigrations,把评论锚点从旧 aid 迁到新 aid。搬到 docs-backend
// 就没有这套迁移了 —— 每发布一次,所有评论的引用就全部失效(满屏「原引用已失效」)。
//
// 所以这条路是:前端 → docs-backend → 转发存到 octo-docs-html → 识别 mention → 入队。
// docs-backend 在中间只做两件它擅长的事:mention 识别 + 可靠上报(重试/退避/幂等已有实现)。
//
// ── 权限在哪判 ────────────────────────────────────────────────────────────────
// **都在本地判**(resolveHtmlBotAccess),用的是与 Yjs 文档同一张 doc_member 表、同一组
// 四角色、同一个 resolveRole。第一版我加了个 /v1/internal/bot-capability 去问
// octo-docs-html,那是错的:鉴权本来就是同一套(它内部那套 Capability 只是把四角色映射成
// 能力等级,不是第二种模型),问它等于把授权规则复制到另一个服务里,两边迟早漂。
//
// 两个主体各判一次,谁也不能顶替谁:
//   · 发起人要 writer(BOT_MENTION_MIN_ROLE) —— 不能拿「上游收下了这条评论」当凭据,
//     上游存评论只要 CapComment,那样一个只能评论的人就能召唤有编辑权的 Bot。
//   · 被 @ 的 Bot 要 writer(BOT_DOC_ACCESS_MIN_ROLE)。
//
// 判不出来一律拒绝:下游 octo-server 的 /v1/internal/bot-mentions 完全信任调用方已经验过
// 权限(它连 from_uid 都不校验),入队之后没有第二道关卡。

import { config } from '../../config/env.js'
import { reportBotMentions, BOT_MENTION_MIN_ROLE } from './botMention.js'
import { docMetaRepo } from '../../db/repos/docMetaRepo.js'
import { resolveRole } from '../../permission/resolveRole.js'
import { roleAtLeast } from '../../permission/role.js'
import { resolveBotDocAccess } from '../../agent/botIdentity.js'

/** 转发给 octo-docs-html 的评论创建请求(原样透传前端的形状)。 */
export interface HtmlCommentCreateInput {
  slug: string
  body: unknown
}

export type HtmlForwardResult =
  | { ok: true; status: number; payload: unknown; commentId: string | null }
  | { ok: false; status: number; payload: unknown }

/**
 * 从 octo-docs-html 的创建响应里取出评论 id。
 *
 * 形状容错是刻意的:取不到 id 只意味着**不能上报**(没有 comment_id 就没法入队),
 * 绝不能因此把已经存好的评论判成失败 —— 评论落库了就是落库了,前端必须看到成功。
 * 所以返回 null 而不是抛。
 */
export function extractHtmlCommentId(payload: unknown): string | null {
  if (payload == null || typeof payload !== 'object') return null
  const root = payload as Record<string, unknown>
  // 后端的信封是 { data: ... };兼容直接返回裸对象的形状。
  const data = (root.data ?? root) as Record<string, unknown>
  if (data == null || typeof data !== 'object') return null
  for (const key of ['id', 'comment_id', 'commentId']) {
    const v = data[key]
    if (typeof v === 'string' && v !== '') return v
    // HTML 侧的 id 是字符串,但万一给了数字也认 —— 上报时反正要 String()。
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return null
}

/**
 * 从前端传来的 body 里取出评论正文与父评论 id。
 *
 * 只读**上报需要的字段**,其余原样透传给 octo-docs-html —— docs-backend 不该知道
 * HTML 评论的完整契约(anchor 的形状、version、pinned aid…),知道得越多越容易和它漂。
 */
export function readCommentFields(body: unknown): { text: string; parentId: string | null } {
  if (body == null || typeof body !== 'object') return { text: '', parentId: null }
  const b = body as Record<string, unknown>
  const text = typeof b.text === 'string' ? b.text : typeof b.body === 'string' ? b.body : ''
  const rawParent = b.parentId ?? b.parent_id
  const parentId =
    typeof rawParent === 'string' && rawParent !== ''
      ? rawParent
      : typeof rawParent === 'number' && Number.isFinite(rawParent)
        ? String(rawParent)
        : null
  return { text, parentId }
}

/** 转发是否可用。只看基址 —— config.docHtml 没有密钥(转发带的是调用方自己的 token)。 */
export function htmlForwardEnabled(): boolean {
  return config.docHtml.baseUrl.trim() !== ''
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`
}

/**
 * 把评论创建转发给 octo-docs-html,带调用方自己的 token。
 *
 * 原样回传它的状态码和响应体:403/409/422 这些都是它的判断结果,docs-backend 不该翻译或
 * 吞掉 —— 前端已经在按它的错误码做提示了。
 */
export async function forwardHtmlComment(
  input: HtmlCommentCreateInput,
  callerToken: string,
): Promise<HtmlForwardResult> {
  const url = joinUrl(config.docHtml.baseUrl, '/v1/comments')
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), config.docHtml.timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 用调用方的 token,不是服务间密钥:让 octo-docs-html 用它自己的规则判作者权限。
        Authorization: `Bearer ${callerToken}`,
        token: callerToken,
      },
      // ★ 路径 slug 放在展开**之后**,必须由它赢。
      //
      // 写成 `{ slug: input.slug, ...body }` 是一个提权漏洞:body 里的 slug 会覆盖路径的,
      // 于是上游按 **body** 的 slug 鉴权并存评论,而闸② 和入队任务用的是 **路径** 的 slug。
      // 攻击者把路径填成自己零权限的 VICTIM、body 填成自己有权限的文档:上游按 body 鉴权
      // 放行(评论落在他自己的文档里),而任务带着他写的指令派去改 VICTIM。
      // 收口点**只有这一处**:路径 slug 放在展开之后,强制取胜。
      // route 层不拒带 slug 的 body(前端一直这么发,拒了功能就没了 —— 见
      // routes/htmlComments.ts 记的那笔),所以这里不是「第二道」,是唯一一道。
      body: JSON.stringify({ ...(input.body as Record<string, unknown>), slug: input.slug }),
      signal: ac.signal,
    })
    const payload = await res.json().catch(() => null)
    if (!res.ok) return { ok: false, status: res.status, payload }
    return { ok: true, status: res.status, payload, commentId: extractHtmlCommentId(payload) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 把 HTML 的 slug 解析成 docs-backend 的 docId。
 *
 * slug 只在**一个 space 内**唯一(uk_octo_doc_slug 是 (space_id, octo_doc_slug)),所以必须
 * 带 spaceId —— 不带的话 space B 能解析出 space A 的同名文档,那本身就是跨租户越权。
 *
 * 查不到返回 null。HTML 文档要在 doc_meta 里有行,得先注册成功(发布时带 mount_type 且
 * 服务端配了注册地址);没注册的文档在侧边栏里根本看不见,判不出权限就一律拒绝。
 *
 * ── 生命周期:非 active 一律当作解析不到 ─────────────────────────────────────────
 * doc_meta.status 是 1=active / 0=deleted / 2=archived。这里必须自己判,因为下游
 * resolveRole 只看 doc_member 与 owner_id,**不看 status** —— 软删或归档之后成员行还在,
 * 所以不判的话一篇已删除的文档照样能把 Bot 任务派出去。
 *
 * 两种状态对**调用方**都只表现为「解析不到」(不像 guard.ts 那样 404 / 409 分开):调用方
 * 只需要「能不能派 Bot」这一个布尔,归档文档不可写,不可写就不该派编辑型 Bot;把状态差异
 * 透出去反而会让上报路径变成一个探测文档是否存在的旁路。
 * 但**进程内日志**要分得开(见 resolveHtmlBotAccess 的 reason):「文档没注册」和「文档被
 * 删了/归档了」的处理办法完全不同,混成一个 reason 会让排查时分不清是配置问题还是正常拒绝。
 */
async function resolveHtmlDocId(
  slug: string,
  spaceId: string,
): Promise<{ docId: string | null; reason: 'ok' | 'not_registered' | 'deleted' | 'archived' }> {
  if (!slug || !spaceId) return { docId: null, reason: 'not_registered' }
  const meta = await docMetaRepo.getByOctoDocSlug(slug, spaceId)
  if (!meta) return { docId: null, reason: 'not_registered' }
  if (meta.status === 0) return { docId: null, reason: 'deleted' }
  if (meta.status !== 1) return { docId: null, reason: 'archived' }
  return { docId: meta.doc_id ?? null, reason: meta.doc_id ? 'ok' : 'not_registered' }
}

/**
 * 这个 Bot 能不能改这篇 HTML 文档,以及发起人有没有资格召唤它。
 *
 * ── 为什么在本地判,而不是问 octo-docs-html ────────────────────────────────────
 * 鉴权是**同一套**:同一张 doc_member 表、同一组四角色(reader/commenter/writer/admin)。
 * octo-docs-html 内部那套 Capability 只是把这四个角色映射成能力等级,不是第二种模型。
 * 既然是同一套就不该有第二处实现 —— 第一版我加了个 /v1/internal/bot-capability 去问它,
 * 等于把授权规则复制到另一个服务里,两边迟早漂。
 *
 * 复用 resolveBotDocAccess / resolveRole 还顺手修掉一个缺口:resolveRole 里有
 * `uid === meta.owner_id → admin`(owner implies admin),而 Bot 确实会拥有文档(它自己
 * 发布的 HTML,owner_id 就是它)。只翻 doc_member 名单会把「Bot 改自己创建的文档」判成
 * 无权限 —— 所有者不在协作者名单里,就像群主不在成员列表里。
 *
 * ── 两个主体各判一次,不能互相顶替 ──────────────────────────────────────────────
 * 发起人要 writer(BOT_MENTION_MIN_ROLE:能读**并且**能编辑),被 @ 的 Bot 要 writer
 * (BOT_DOC_ACCESS_MIN_ROLE)。上一版把「上游收下了这条评论」当成发起人权限的凭据
 * (authorPreVerified),那是错的:上游存评论只要 CapComment,于是一个**只能评论**的人
 * 在 HTML 文档上能召唤有编辑权的 Bot,而同一个人在 Yjs 文档上不行。既然现在本地能判,
 * 就本地判,两条路的门槛回到一致。
 */
export async function resolveHtmlBotAccess(params: {
  slug: string
  spaceId: string
  authorUid: string
  botUid: string
}): Promise<{ allowed: boolean; reason: string }> {
  const { slug, spaceId, authorUid, botUid } = params
  if (!slug || !spaceId || !authorUid || !botUid) return { allowed: false, reason: 'missing_input' }
  try {
    const resolved = await resolveHtmlDocId(slug, spaceId)
    // 没注册进 doc_meta 的文档判不出权限 ⇒ 拒绝。产品结论:那种文档用户在侧边栏看不见,
    // 也就不会去 @ Bot;为它留一条「再问另一个服务」的后路,等于把刚合并掉的第二处判定请回来。
    // 已删除/已归档同样拒绝,但 reason 分开记 —— 三者对运维意味着完全不同的事。
    if (!resolved.docId) return { allowed: false, reason: `doc_${resolved.reason}` }
    const docId = resolved.docId

    const authorRole = await resolveRole(authorUid, docId)
    if (!roleAtLeast(authorRole, BOT_MENTION_MIN_ROLE)) {
      return { allowed: false, reason: 'author_role_too_low' }
    }
    const bot = await resolveBotDocAccess(docId, botUid)
    return bot.allowed ? { allowed: true, reason: 'ok' } : { allowed: false, reason: bot.reason }
  } catch {
    // 判不出来就是不放行:入队之后没有别的关卡了。
    return { allowed: false, reason: 'lookup_failed' }
  }
}

/**
 * 评论已经存好之后,识别 @bot 并上报入队。
 *
 * **脱离式、绝不抛**:评论已经落库了,上报失败不能反过来让创建看起来失败。这一条和文档侧的
 * fireBotMentionReport 是同一个硬要求(见 routes/comments.ts 的说明)。
 */
export function fireHtmlBotMentionReport(params: {
  slug: string
  commentId: string
  parentId: string | null
  text: string
  authorUid: string
  spaceId: string
  ownedBots: string[]
  callerToken?: string
}): void {
  void (async () => {
    try {
      await reportBotMentions(
        {
          docId: params.slug,
          // ★ 必须标出来:docId 在这条路上是 octo-doc 的 slug,不是 docs-backend 的 docId。
          // 消费端(插件/agent)靠它选 API —— 拿 slug 去打按 docId 寻址的接口只会 404,
          // 而那个 404 跟「文档真的不存在」长得一模一样,下游自己判断不了。
          docKind: 'html',
          commentId: params.commentId,
          parentId: params.parentId,
          spaceId: params.spaceId,
          authorUid: params.authorUid,
          // 发起人权限**在这里本地判**(见 resolveHtmlBotAccess),不再拿「上游收下了这条
          // 评论」当凭据 —— 上游存评论只要 CapComment,那样一个只能评论的人就能在 HTML
          // 文档上召唤有编辑权的 Bot,而同一个人在 Yjs 文档上不行。
          authorPreVerified: true,
          ownedBots: params.ownedBots,
          ...(params.callerToken ? { callerToken: params.callerToken } : {}),
          body: params.text,
          // ★ botAllowed 与 authorPreVerified 必须在**同一个对象**里传(BotMentionAuthorGate
          // 是判别联合)。上一版它在第二个参数 deps 里,类型上跟 authorPreVerified 无关,
          // 于是「标了 preVerified 却忘了注入闸门」能编译通过 —— 现在编译期就挡住。
          //
          // 两个主体一次判完:发起人够不够 writer + 这个 Bot 能不能改这篇文档。
          // 都走本地的 resolveRole,与 Yjs 文档同一套规则、同一张表。
          botAllowed: async (botUid: string) => {
            const access = await resolveHtmlBotAccess({
              slug: params.slug,
              spaceId: params.spaceId,
              authorUid: params.authorUid,
              botUid,
            })
            if (!access.allowed) {
              // 只记元数据(不记评论正文)。reason 让「作者权限不够」和「Bot 权限不够」
              // 以及「文档没注册」在日志里可区分 —— 三者的处理办法完全不同。
              // eslint-disable-next-line no-console
              console.warn('[octo-docs] html bot mention denied', {
                slug: params.slug,
                botUid,
                reason: access.reason,
              })
            }
            return access.allowed
          },
        },
      )
    } catch (err) {
      // 只记日志。这里抛出去会变成未处理的 rejection,而它跟调用方的成功响应毫无关系。
      // eslint-disable-next-line no-console
      console.warn('[octo-docs] html bot mention report failed', { slug: params.slug, err })
    }
  })()
}
