/**
 * 让 octo-docs-html 物理删除一个已发布 HTML 文档的内容（OCTO-456 P1「彻底删除」）。
 *
 * HTML 文档的正文/版本/附件都在 octo-docs-html（与评论、改名重发布同一个道理，
 * 见 htmlTitleRepublish.ts / htmlCommentForward.ts），docs-backend 只持有
 * `doc_meta` 路由行。所以彻底删除一个 html 文档必须**先**让 html 侧删掉内容，
 * 成功之后才允许删除 doc_meta —— 否则会留下「列表没了、分享链接还能打开」的
 * 半删状态（正是改名链路要避免的同类不一致）。
 *
 *   POST {OCTO_DOCS_HTML_INTERNAL_URL}/internal/html/purge
 *   X-Internal-Token: {OCTO_DOCS_HTML_INTERNAL_TOKEN}
 *   { "slug": "<doc_meta.octo_doc_slug>" }
 *   → 2xx 成功；404 视为「内容已不存在」（幂等重试）；其余按失败处理。
 *
 * 失败策略由调用方决定：
 *   - 前端触发的 `POST /api/v1/docs/{docId}/purge`：strict —— 失败回 503 且
 *     **不删 doc_meta**（doc_meta 还在，用户仍可看到并重试）。
 *   - 保留期到期的自动清理任务：best_effort —— 内容尽力删除，删不掉也继续删
 *     doc_meta（否则任务会永远卡在一篇坏文档上；html 侧残留由 html 自己的 GC 兜底）。
 *
 * 未配置（URL 或 token 为空）时 `configured=false`：调用方跳过远端调用 —— 这不是
 * 「失败」，而是部署没有启用 HTML 内容回收；API 仍可删 doc_meta（与删除前的行为
 * 一致）。共享密钥绝不写日志。
 */
import { config } from '../../config/env.js'
import { isSafeHtmlSlug } from './htmlPreviewFetch.js'

export type HtmlPurgeResult =
  | { ok: true; skipped?: false }
  | { ok: true; skipped: true; reason: 'config_missing' }
  | { ok: false; reason: 'invalid_slug' | 'network_error' | 'upstream_error'; status?: number }

/** 远端 purge 是否已配置（URL + 共享 token 都非空）。 */
export function htmlPurgeConfigured(): boolean {
  return config.htmlInternal.url.trim() !== '' && config.htmlInternal.token.trim() !== ''
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`
}

/**
 * 调 html 内部 purge。**不抛异常**：所有失败折成返回值。
 * 404 按成功处理（内容已不存在 = 目标状态已达成，重试幂等）。
 */
export async function purgeHtmlDocument(slug: string, docId = '', spaceId = ''): Promise<HtmlPurgeResult> {
  if (!isSafeHtmlSlug(slug)) return { ok: false, reason: 'invalid_slug' }
  if (!htmlPurgeConfigured()) return { ok: true, skipped: true, reason: 'config_missing' }

  const url = joinUrl(config.htmlInternal.url.trim(), '/internal/html/purge')
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), config.htmlInternal.timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': config.htmlInternal.token.trim(),
      },
      body: JSON.stringify({ slug, doc_id: docId, space_id: spaceId }),
      signal: ac.signal,
      // 固定路径 + 自定义内部 token header：跟随重定向等于把共享密钥交给任意主机。
      redirect: 'manual',
    })
    // 204/200/202 都表示远端已完成；404 表示内容已不存在，对「彻底删除」而言
    // 同样是目标状态，重试安全。
    if (res.status === 404) return { ok: true }
    if (res.status >= 200 && res.status < 300) return { ok: true }
    return { ok: false, reason: 'upstream_error', status: res.status }
  } catch {
    return { ok: false, reason: 'network_error' }
  } finally {
    clearTimeout(timer)
  }
}
