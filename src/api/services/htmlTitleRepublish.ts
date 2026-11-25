/**
 * 让 octo-docs-html 重新 publish 一个版本,把 HTML 文档的新标题同步过去
 * (OCTO-456 §4.8“两步都成功才 200”)。
 *
 * ── 为什么改名必须先过这里 ────────────────────────────────────────────────────
 * 资料库列表读 docs-backend 的 `doc_meta.title`,而 HTML 文档打开后渲染的标题读
 * octo-docs-html 自己的那一版。两边是同一个 MySQL,但 HTML 版本里的标题不是实时读
 * doc_meta 的:它由 html 侧 publish 时写进版本内容。
 *
 * 所以「只改 doc_meta」会出现用户最先看到的那种不一致 —— 列表已是新标题,打开文档还是
 * 旧标题;等下一次有人在 html 侧发布,标题又可能被旧值覆盖回来。v3.1 §4.8 的合同因此是:
 *
 *   POST /internal/html/republish-title {slug, title, idempotency_key, revision}
 *     → 200 {slug, version, title}
 *     → 409 stale_revision  (revision <= the document's max published revision and
 *                            no receipt matched; do NOT retry — a later rename
 *                            already advanced the html side)
 *
 * The revision fence is part of octo-docs-html !40 (same head): the html service
 * tracks max_published_revision per document, replays a matching receipt, and
 * rejects any lower revision. Docs therefore passes doc_rename_operation.revision
 * (monotonic AUTO_INCREMENT) on every republish; the fence still protects delayed
 * requests after their receipt was closed.
 *   成功后**才**写 doc_meta;任一步失败都不写,由调用方回 503 rename_failed。
 *
 * ── 失败策略:fail closed ──────────────────────────────────────────────────────
 * 网络错误、超时、非 2xx、URL/token 没配 —— 全部按失败处理,调用方回 503 且不写
 * doc_meta。这里**没有**「降级成只改 doc_meta」的分支:那正是合同要禁止的半成功状态。
 * 未配置时只 warn 一次(说明缺哪个变量),避免每次改名都刷日志。
 *
 * ── 安全 ──────────────────────────────────────────────────────────────────────
 * `X-Internal-Token` 是服务间共享密钥,不是用户 token,绝不写日志。`redirect: 'manual'`:
 * 固定路径没有任何跟随重定向的正当理由,而 fetch 的跨源重定向保护**只剥
 * `Authorization`**,自定义 header(这里就是 X-Internal-Token)会被原样转发到重定向
 * 目标 —— 跟随重定向等于把内部密钥交给任意主机。
 */
import { config } from '../../config/env.js'
import { trimTitleWhitespace } from '../../util/title.js'

export type HtmlRepublishResult =
  | {
    ok: true
    version: number | null
    /**
     * Monotonic publish sequence of the commit this republish made, when the html
     * service reports one. The caller records it as the applied title order in the
     * SAME transaction as doc_meta.title, so a later — older — post-publish
     * callback cannot roll the title back. null for HTML instances that predate
     * the sequence (rolling deploy); their callbacks fall back to `version`.
     */
    publishSeq: number | null
  }
  | { ok: false; reason: 'config_missing'; missing: string[] }
  | { ok: false; reason: 'upstream_error'; status: number }
  | { ok: false; reason: 'stale_revision'; status: 409 }
  /**
   * The html service refused the asserted document identity (OCTO-456 !40).
   * Both are definitive conflicts, NOT upstream outages: republishing would
   * mutate a different document / cannot prove the binding, so docs must not
   * retry them as a transient 503.
   */
  | { ok: false; reason: 'identity_mismatch' | 'identity_unverified'; status: 409 }
  | { ok: false; reason: 'invalid_response' }
  | { ok: false; reason: 'network_error' }

export interface HtmlRepublishInput {
  slug: string
  /**
   * docs-backend's doc_meta identity for this document. octo-docs-html binds a
   * slug to a local document; a delete + re-publish can put a DIFFERENT document
   * under the same slug. The html service verifies both values under its slug
   * lock (409 identity_mismatch / identity_unverified) before publishing.
   */
  docId: string
  spaceId: string
  title: string
  /**
   * 幂等键。由调用方从 doc_rename_operation.id(uuid)传入 —— 一次逻辑改名一个 id,
   * 重试复用,新的改名(含 A→B→A→B 的第三次)拿新 id。html 侧按 (slug, key) 去重:
   * 同 key 已完成则直接返回上次的 {slug, version, title},不重新发布。
   */
  idempotencyKey: string
  /**
   * Monotonic journal revision (doc_rename_operation.revision). The html service
   * keeps a per-document max published revision: a request whose revision is not
   * higher is rejected with 409 stale_revision instead of publishing, which fences
   * delayed requests even after their receipt was closed.
   */
  revision: number
}

/**
 * 缺哪些配置。空数组 = 已配置。
 *
 * 只看非空,不做 URL 形状校验:形状错误会在 fetch 时变成 network_error,同样是
 * fail closed;而多一条启动期校验在这里没有额外收益。
 */
export function missingHtmlRepublishConfig(): string[] {
  const missing: string[] = []
  if (config.htmlInternal.url.trim() === '') missing.push('OCTO_DOCS_HTML_INTERNAL_URL')
  if (config.htmlInternal.token.trim() === '') missing.push('OCTO_DOCS_HTML_INTERNAL_TOKEN')
  return missing
}

// 进程级只提醒一次。漏配是部署配置问题,不是每篇文档的错误 —— 但也不能静默:
// 否则唯一的现象是“所有 html 改名都 503”,没人知道为什么。
let warnedMissingConfig = false

function warnMissingConfigOnce(missing: string[]): void {
  if (warnedMissingConfig) return
  warnedMissingConfig = true
  // eslint-disable-next-line no-console
  console.warn(
    `[octo-docs] html rename republish is not configured (${missing.join(', ')} empty); ` +
      'renaming an html document will fail closed with 503 rename_failed. ' +
      'Set OCTO_DOCS_HTML_INTERNAL_URL and OCTO_DOCS_HTML_INTERNAL_TOKEN to enable it.',
  )
}

/** 仅供测试重置“只 warn 一次”的进程级状态。 */
export function __resetHtmlRepublishWarnStateForTests(): void {
  warnedMissingConfig = false
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`
}

function isStaleRevisionCode(value: unknown): boolean {
  return typeof value === 'string' && value.toLowerCase() === 'stale_revision'
}

const IDENTITY_CONFLICT_CODES = ['identity_mismatch', 'identity_unverified'] as const
type IdentityConflictCode = (typeof IDENTITY_CONFLICT_CODES)[number]

function identityConflictCodeOf(value: unknown): IdentityConflictCode | null {
  if (typeof value !== 'string') return null
  const normalized = value.toLowerCase()
  return (IDENTITY_CONFLICT_CODES as readonly string[]).includes(normalized)
    ? normalized as IdentityConflictCode
    : null
}

/**
 * Recognize the html 409 identity-conflict envelope. The html service's apperr
 * writer puts the fine-grained code in BOTH `error.code` and
 * `error.details.code`; accept the older top-level variants too so a
 * mixed-version rollout keeps failing closed for the right reason.
 */
export function identityConflictCode(payload: unknown): IdentityConflictCode | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  const root = payload as Record<string, unknown>
  const direct = identityConflictCodeOf(root.error) ?? identityConflictCodeOf(root.code)
  if (direct) return direct
  const error = root.error
  if (error !== null && typeof error === 'object' && !Array.isArray(error)) {
    const nested = error as Record<string, unknown>
    const fromCode = identityConflictCodeOf(nested.code)
    if (fromCode) return fromCode
    const details = nested.details
    if (details !== null && typeof details === 'object' && !Array.isArray(details)) {
      return identityConflictCodeOf((details as Record<string, unknown>).code)
    }
  }
  return null
}

/**
 * Recognize the html 409 fence envelope. The authoritative shape is the service
 * error envelope:
 *
 *   {"error":{"code":"stale_revision","message":"...",
 *             "details":{"code":"stale_revision"}}}
 *
 * Older/top-level variants are still accepted so a mixed-version rollout keeps
 * working: `{"error":"stale_revision"}` and `{"code":"stale_revision"}`.
 * Looking only at `payload.error` as a STRING was the bug: the real nested
 * envelope fell through as a generic upstream failure, leaving the op pending
 * and blocking later renames with rename_in_progress.
 */
export function isStaleRevisionPayload(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false
  const root = payload as Record<string, unknown>
  if (isStaleRevisionCode(root.error) || isStaleRevisionCode(root.code)) return true
  const error = root.error
  if (error !== null && typeof error === 'object' && !Array.isArray(error)) {
    const nested = error as Record<string, unknown>
    if (isStaleRevisionCode(nested.code)) return true
    const details = nested.details
    if (details !== null && typeof details === 'object' && !Array.isArray(details)) {
      if (isStaleRevisionCode((details as Record<string, unknown>).code)) return true
    }
  }
  return false
}

/**
 * 调 html 内部接口重新发布标题。**不抛异常**:所有失败都折成返回值,由调用方统一映射
 * 成 503,并保证 doc_meta 不会被写。
 */
export async function republishHtmlTitle(input: HtmlRepublishInput): Promise<HtmlRepublishResult> {
  const { slug, docId, spaceId, title, idempotencyKey, revision } = input
  const missing = missingHtmlRepublishConfig()
  if (missing.length > 0) {
    warnMissingConfigOnce(missing)
    return { ok: false, reason: 'config_missing', missing }
  }
  const url = joinUrl(config.htmlInternal.url.trim(), '/internal/html/republish-title')
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), config.htmlInternal.timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': config.htmlInternal.token.trim(),
      },
      // Identity fields are part of the wire contract since the html binding
      // check: they assert WHICH doc_meta row this slug must still describe.
      body: JSON.stringify({
        slug,
        doc_id: docId,
        space_id: spaceId,
        title,
        idempotency_key: idempotencyKey,
        revision,
      }),
      signal: ac.signal,
      // 见文件头:自定义内部 token header 不会被 fetch 的跨源保护剥掉。
      redirect: 'manual',
    })
    if (res.status !== 200) {
      const bodyText = await res.text().catch(() => '')
      if (res.status === 409) {
        // The html-side monotonic fence: a later revision already published (or
        // this key's receipt was closed), so this publish must never happen.
        let payload: unknown = null
        try {
          payload = JSON.parse(bodyText)
        } catch {
          // Not JSON — treat as a generic upstream failure below.
        }
        if (isStaleRevisionPayload(payload)) {
          return { ok: false, reason: 'stale_revision', status: 409 }
        }
        // A binding conflict means this request was aimed at a different
        // document (or none can be proven). Retrying cannot fix it, and it is
        // NOT a 503 upstream outage — preserve the 409 all the way to the caller.
        const identityCode = identityConflictCode(payload)
        if (identityCode) {
          return { ok: false, reason: identityCode, status: 409 }
        }
      }
      return { ok: false, reason: 'upstream_error', status: res.status }
    }
    // 200 也必须严格校验响应体:一个形状不对的 200 同样意味着无法证明新版本已经
    // 按这次请求发布。宁可回 503 让客户端重试(同 op id 幂等),也不要把未知结果
    // 写成 doc_meta。要求:
    //   · JSON 是普通对象;· slug/title 与请求逐字一致;
    //   · version 是正整数(0/负数/小数/字符串都不接受)。
    const raw: unknown = await res.json().catch(() => null)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, reason: 'invalid_response' }
    }
    const payload = raw as Record<string, unknown>
    // Compare normalized titles: html TrimSpaces with Go semantics, and older
    // receipts may still carry an edge-space variant from before docs normalized
    // at the entry point.
    if (payload.slug !== slug || typeof payload.title !== 'string'
        || trimTitleWhitespace(payload.title) !== trimTitleWhitespace(title)) {
      return { ok: false, reason: 'invalid_response' }
    }
    const version = payload.version
    if (typeof version !== 'number' || !Number.isInteger(version) || version <= 0) {
      return { ok: false, reason: 'invalid_response' }
    }
    // publish_seq is optional (older HTML instances omit it, and a receipt
    // persisted before the sequence existed replays as 0) but must be a positive
    // integer when it carries information: a malformed value cannot order the
    // write. 0 means "unknown" and falls back to the version watermark — rejecting
    // it would fail a rename whose publish already succeeded.
    const rawSeq = payload.publish_seq
    let publishSeq: number | null = null
    if (rawSeq !== undefined && rawSeq !== null) {
      if (typeof rawSeq !== 'number' || !Number.isInteger(rawSeq) || rawSeq < 0) {
        return { ok: false, reason: 'invalid_response' }
      }
      publishSeq = rawSeq > 0 ? rawSeq : null
    }
    return { ok: true, version, publishSeq }
  } catch {
    return { ok: false, reason: 'network_error' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Close the html-side completed receipt for one idempotency key.
 *
 * Best-effort: called after an operation reaches a terminal, NON-RESUMABLE state
 * so the html service can drop the replay record. A failure only warns — it must
 * never change the rename result (`renameHtmlDoc` already committed or already
 * refused the local write). Pending or resumable-failed operations keep their
 * receipt: the recovery path still needs the replay.
 */
export interface HtmlCloseReceiptInput {
  slug: string
  docId: string
  spaceId: string
  idempotencyKey: string
}

/**
 * Close the html-side completed receipt for one idempotency key.
 *
 * Best-effort: called after an operation reaches a terminal, NON-RESUMABLE state
 * so the html service can drop the replay record. A failure only warns — it must
 * never change the rename result (`renameHtmlDoc` already committed or already
 * refused the local write). Pending or resumable-failed operations keep their
 * receipt: the recovery path still needs the replay.
 *
 * Carries the same doc_id/space_id binding as republish so a stale journal from
 * a deleted-and-republished slug cannot delete another document's receipt.
 */
export async function closeHtmlRepublishReceipt(input: HtmlCloseReceiptInput): Promise<void> {
  const { slug, docId, spaceId, idempotencyKey } = input
  const missing = missingHtmlRepublishConfig()
  if (missing.length > 0) {
    warnMissingConfigOnce(missing)
    return
  }
  const url = joinUrl(config.htmlInternal.url.trim(), '/internal/html/republish-title/close')
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), config.htmlInternal.timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': config.htmlInternal.token.trim(),
      },
      body: JSON.stringify({ slug, doc_id: docId, space_id: spaceId, idempotency_key: idempotencyKey }),
      signal: ac.signal,
      redirect: 'manual',
    })
    await res.text().catch(() => '')
    if (res.status < 200 || res.status >= 300) {
      // eslint-disable-next-line no-console
      console.warn('[octo-docs] html republish receipt close failed', { slug, status: res.status })
    }
  } catch {
    // eslint-disable-next-line no-console
    console.warn('[octo-docs] html republish receipt close failed', { slug, reason: 'network_error' })
  } finally {
    clearTimeout(timer)
  }
}
