/**
 * @Bot-in-comment report to octo-server (POST /v1/internal/bot-mentions).
 *
 * When a comment is created and its body @-mentions one or more of the author's
 * User Bots, docs-backend reports the mention to octo-server ONCE PER BOT so the
 * bot can take its turn. Mirrors the docsNotify producer (api/services/docsNotify.ts):
 * a docs-specific `X-Internal-Token`, best-effort, silent no-op when unconfigured.
 *
 * ── Responsibility split (authoritative integration spec) ────────────────────
 * docs-backend (here) owns:
 *   - persisting the comment + parsing its `@[type:id:label]` mention tokens;
 *   - verifying that the acting human may access and EDIT the document
 *     (BOT_MENTION_MIN_ROLE below);
 *   - verifying that the mentioned bot is one the caller may summon at all — a bot
 *     it OWNS or a bot it is FRIENDS with (resolveCandidateBots below);
 *   - verifying that the MENTIONED BOT itself may act on the document, against
 *     its own doc_member row (resolveBotDocAccess, agent/botIdentity.ts);
 *   - one POST per mentioned User Bot that clears ALL of the above (they are
 *     combined with AND: relationship AND the bot's own document permission).
 * octo-server owns: active-User-Bot validation, the gray-release gate,
 * idempotency, and enqueueing. It does NOT check document permissions and does
 * NOT edit the document — which is exactly why the permission gate must be
 * enforced here, before anything is reported.
 *
 * ── Contract invariants honoured here ────────────────────────────────────────
 *   - `idempotency_key` is STABLE and unique per (comment, bot): every retry
 *     reuses the same key AND the byte-identical request body (the body is built
 *     once, serialized once, and that one string is re-sent).
 *   - `thread_id` is NEVER sent — octo-server derives the thread from parent_id,
 *     falling back to comment_id. A root comment therefore omits parent_id.
 *   - `text` is required and capped at 10 KiB; the whole request at 32 KiB.
 *   - `url` is optional and only ever an ABSOLUTE http/https address.
 *   - Only active User Bots are supported (App Bots are not) — octo-server is
 *     authoritative and answers 404 for a non-User-Bot / stopped bot.
 *
 * ── Security ────────────────────────────────────────────────────────────────
 * Logs carry DIAGNOSTIC METADATA ONLY: doc/comment/bot ids, HTTP status, reason,
 * attempt number. The internal token, the comment text, and the request body are
 * NEVER logged.
 */
import { config } from '../../config/env.js'
import { roleAtLeast, type ResolvedRole } from '../../permission/role.js'
import { resolveBotDocAccess, BOT_DOC_ACCESS_MIN_ROLE } from '../../agent/botIdentity.js'
import { getOctoIdentity } from '../../auth/octoIdentity.js'
import { mentionedUserUids } from './docsNotify.js'
import { buildDocShareUrl } from '../../util/docShareLink.js'

const BOT_MENTION_PATH = '/v1/internal/bot-mentions'
const INTERNAL_TOKEN_HEADER = 'X-Internal-Token'

/** Contract cap on the `text` field (10 KiB), measured in UTF-8 BYTES. */
const MAX_TEXT_BYTES = 10 * 1024
/** Contract cap on the whole serialized request (32 KiB), in UTF-8 bytes. */
const MAX_REQUEST_BYTES = 32 * 1024

/**
 * Minimum document role the ACTING HUMAN must hold for a mention to be reported.
 *
 * The integration spec requires docs-backend to verify "访问、编辑权限" — access
 * AND edit. `writer` is the edit floor and subsumes read (roleRank writer >
 * reader), so a single roleAtLeast comparison covers both halves. Comparison goes
 * through roleAtLeast because the STORED role value is not the privilege ordinal
 * (commenter is stored as 4 but ranks between reader and writer — see
 * permission/role.ts); comparing raw numbers here would be a privilege-escalation
 * bug.
 *
 * Consequence worth knowing: a caller holding only `commenter` can post a comment
 * that @s a bot, and the mention is silently NOT reported. That is the spec's
 * edit-permission requirement, applied fail-closed.
 *
 * The MENTIONED BOT is gated separately and against its OWN doc_member row — see
 * BOT_DOC_ACCESS_MIN_ROLE in agent/botIdentity.ts. The two floors are independent
 * on purpose: they are statements about two different subjects, and a bot's access
 * does NOT follow its owner's.
 */
export const BOT_MENTION_MIN_ROLE: ResolvedRole = 'writer'

/** Injectable clock/timer seam so the retry ladder is testable without real waits. */
export interface BotMentionDeps {
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The exact wire body. Field names are snake_case per the spec. Optional fields
 * are OMITTED (not sent as null/'') when absent so the body stays byte-stable
 * across retries and octo-server's parent_id-else-comment_id thread derivation
 * sees a genuinely absent parent for a root comment.
 */
export interface BotMentionRequest {
  idempotency_key: string
  doc_id: string
  /**
   * Which kind of document `doc_id` identifies — omitted for docs-backend docs
   * (doc/sheet/board), 'html' when it is an octo-doc slug.
   *
   * The consumer needs this to pick an API family: HTML bodies live in octo-doc
   * and are addressed by slug, so passing that slug to a docId-keyed
   * docs-backend endpoint 404s. It cannot be inferred downstream — a 404 there
   * is indistinguishable from "that document does not exist".
   */
  doc_kind?: string
  comment_id: string
  parent_id?: string
  from_uid: string
  bot_uid: string
  text: string
  url?: string
  space_id?: string
}

/**
 * Per-bot delivery outcome, one variant per row of the spec's response table.
 *   accepted  — 200 accepted=true (replay=true is a successful idempotent replay)
 *   skipped   — 200 accepted=false reason=disabled: not in the gray release; no retry
 *   permanent — 400 (bad request) / 404 (unknown, stopped, or non-User Bot); no retry
 *   alert     — 401 (token misconfigured) / 409 idempotency_conflict (same key, changed
 *               body): STOP retrying and raise an operator-visible alert
 *   retry     — 409 in_progress (honour Retry-After) / 500 / network timeout: retry
 *               with the SAME key and SAME body under bounded exponential backoff
 */
export type BotMentionOutcome =
  | { kind: 'accepted'; replay: boolean }
  | { kind: 'skipped'; reason: string }
  | { kind: 'permanent'; reason: string }
  | { kind: 'alert'; reason: string }
  | { kind: 'retry'; reason: string; delayMs?: number }

export interface BotMentionParams {
  docId: string
  /**
   * Which kind of document `docId` identifies. Omit for docs-backend docs
   * (doc/sheet/board); pass 'html' when docId is an octo-doc slug.
   *
   * Only the caller knows this — the HTML path reaches this service from a
   * different route entirely (routes/htmlComments.ts), so it states the kind
   * rather than having this service sniff it.
   */
  docKind?: 'html'
  /**
   * Id of the comment just created.
   *
   * `number` on the Yjs docs path (doc_comment.id). `string` on the HTML path —
   * octo-docs-html mints string comment ids, and the wire contract in bin.md has
   * `comment_id` as a string anyway (buildBotMentionRequest already stringifies).
   * Widened rather than parsed: turning an opaque HTML id into a number would
   * either lose it or invent one.
   */
  commentId: number | string
  /** Root comment id for a reply; absent for a root comment (never send thread_id). */
  parentId?: number | string | null
  spaceId: string
  /** The acting HUMAN's uid (`from_uid`). Bot-authored comments are not reported. */
  authorUid: string
  /**
   * Uids of the User Bots the AUTHOR owns (req.ownedBots, from octo-server's
   * verify `owned_bots`). One of the two RELATIONSHIP sources; the other is the
   * author's friend-bot list, fetched on demand (see resolveCandidateBots).
   */
  ownedBots: string[]
  /**
   * The author's OWN octo session token (req.octoToken), used to authenticate the
   * friend-bot lookup — GET /v1/robot/my_bots answers only for the token holder,
   * so no service secret is involved. Absent/empty => the friend half cannot be
   * confirmed and the report degrades, fail-closed, to owned bots only. NEVER
   * logged.
   */
  callerToken?: string
  /** Raw comment body, still carrying its `@[type:id:label]` mention tokens. */
  body: string
  /** True on the bot mount (req.botToken set): `from_uid` must be a human, so skip. */
  isBotCaller?: boolean
}

/**
 * 作者侧闸门(权限闸 #1)的两种成立方式 —— **二者必居其一，且不可拆开**。
 *
 * 为什么做成判别联合而不是两个可选字段:上一版 `authorPreVerified` 在 params 里、
 * 兜住它的 `botAllowed` 在 deps 里,类型上不要求同行。于是
 * `{ authorPreVerified: true }` 而不传 deps 是一个能编译、能跑、作者侧**完全没有
 * 闸门**的调用 —— 评审两轮都指到这条缝。现在编译器直接拒掉它。
 */
export type BotMentionAuthorGate =
  | {
      /**
       * 常规路径(Yjs 文档/表格/白板):作者在本文档上已解析出的有效角色(guard.role)。
       * 闸门就地判 —— 低于 BOT_MENTION_MIN_ROLE 直接不报。
       */
      authorRole: ResolvedRole
      authorPreVerified?: never
      botAllowed?: (botUid: string) => Promise<boolean>
    }
  | {
      /**
       * HTML 路径:本地没有 doc_member 行可解析,作者角色改由注入的 `botAllowed`
       * 一并判定(见 htmlCommentForward.resolveHtmlBotAccess:它同时判作者够不够
       * writer 和这个 Bot 能不能改这篇文档)。
       *
       * ★ 不是「上游已经验过所以放行」——上游(octo-docs-html)存评论只要 CapComment,
       * 那只证明到「可评论」,证明不到 writer。真正的作者闸在 botAllowed 里,所以
       * 这里**强制**要求它同时出现:少了它就等于没有作者闸。
       */
      authorPreVerified: true
      authorRole?: never
      /** 必填(不是可选):它是这条路上作者闸的唯一载体。 */
      botAllowed: (botUid: string) => Promise<boolean>
    }

export interface BotMentionReport {
  accepted: number
  skipped: number
  failed: number
}

/**
 * Truncate to at most `maxBytes` UTF-8 bytes WITHOUT splitting a multi-byte
 * character. A naive byte slice would emit a lone continuation byte, which
 * JSON.stringify turns into U+FFFD — corrupting the text and, worse, changing
 * the serialized length after we had already measured it.
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return text
  let end = Math.max(0, maxBytes)
  // 0b10xxxxxx (0x80..0xBF) is a UTF-8 continuation byte: the cut landed inside a
  // character, so walk back to that character's start byte and exclude it.
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--
  return buf.subarray(0, end).toString('utf8')
}

/** UTF-8 byte length (what both contract caps are measured in). */
function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

/**
 * Stable idempotency key for one (comment, bot) pair.
 *
 * botUid comes from octo-server's verified owned_bots, so no component is
 * attacker-authored free text. The same inputs must always produce the same key
 * — a retry that changed the key would defeat octo-server's dedupe, and one that
 * changed the BODY under the same key would earn a 409 idempotency_conflict.
 *
 * ── 为什么必须带 docKind ─────────────────────────────────────────────────────
 * `docId` 在两条路上来自**两个不同的命名空间**:Yjs 路上是 docs-backend 自己发的
 * doc_id(`d_` + 12 位随机,见 util/ids.ts),HTML 路上是注册的 octo-doc slug
 * (`[A-Za-z0-9_-]{1,128}`,见 internalHtmlRegistration.ts)。slug 的字符集是
 * doc_id 的超集,所以一个长得像 `d_xxxxxxxxxxxx` 的 slug 能和真实 doc_id 撞上;
 * commentId 同理(一边是 AUTO_INCREMENT,一边是上游的不透明字符串)。
 *
 * 两个命名空间共用一个 keyspace,一旦真撞上,octo-server 会把后来那条当成重放
 * (静默丢弃)或者判成 409 idempotency_conflict —— 而 409 在这里被归类为不可重试的
 * alert(见 classifyFailure),等于一条合法的 @Bot 永久消失。把 kind 折进 key 里
 * 让两个命名空间彻底分开,代价是零。
 *
 * Yjs 路(docKind 为空)保持**原样不加前缀**:那条路上已经在产的 key 不能变,变了
 * 等于所有在途重试全部换 key,octo-server 侧的 dedupe 会漏一轮。
 */
export function buildIdempotencyKey(
  docId: string,
  commentId: number | string,
  botUid: string,
  docKind?: string,
): string {
  const ns = docKind ? `${docKind}:` : ''
  return `docs-comment-mention:${ns}${docId}:${commentId}:${botUid}`
}

/** Only an absolute http/https URL may be sent as `url`; anything else is omitted. */
export function absoluteHttpUrl(raw: string): string | undefined {
  if (!raw) return undefined
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    // Relative/path-only (the webOrigin-empty degrade of buildDocShareUrl) or
    // otherwise unparseable => omit the optional field rather than send garbage.
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  return parsed.toString()
}

export type BuiltRequest =
  | { ok: true; body: BotMentionRequest; json: string; textTruncated: boolean }
  | { ok: false; reason: 'empty_text' | 'request_too_large' }

/**
 * Build and serialize ONE bot's request, enforcing both contract size caps.
 *
 * `text` is capped at 10 KiB first. If the serialized envelope still exceeds
 * 32 KiB — JSON escaping inflates a control character ~6x (`\u0001`), so 10 KiB
 * of them becomes ~60 KiB — `text` is shrunk PROPORTIONALLY to the measured
 * escaped-vs-available ratio and re-serialized. Scaling (rather than subtracting
 * the raw overflow) is what makes this converge under heavy escaping; the loop is
 * bounded anyway and gives up rather than emitting an over-cap request, which
 * would be a guaranteed, non-retryable 400.
 *
 * The comment body is sent VERBATIM (mention tokens included). The spec defines
 * `text` as "comment text", and the `@[type:id:label]` token format is a
 * documented contract shared with octo-web, so rewriting it here would be lossy
 * and outside this service's remit.
 */
export function buildBotMentionRequest(p: BotMentionParams, botUid: string): BuiltRequest {
  if (p.body.trim() === '') return { ok: false, reason: 'empty_text' }

  // ── url:HTML 路上必须省掉,不能发死链 ──────────────────────────────────────
  //
  // buildDocShareUrl 无条件产出 `<origin>/d/<docId>`,而 `/d/:docId` 是按
  // docs-backend 的 doc_id 寻址(docMetaRepo.getByDocId)。HTML 路上 p.docId 是
  // octo-doc 的 slug,两个命名空间不通,拼出来的链接必然 404 —— 而且是「绝对 URL、
  // 协议合法」的 404,absoluteHttpUrl 只校验协议,拦不住它。
  //
  // 任务卡上一条点不开的链接比没有链接更糟:用户会以为文档被删了。在有 HTML 侧的
  // 规范链接构造器之前,这里宁可不发 —— url 本来就是可选字段,消费端已按可选处理。
  const url =
    p.docKind === 'html'
      ? undefined
      : absoluteHttpUrl(buildDocShareUrl(config.webOrigin, p.docId, p.spaceId))
  const base: Omit<BotMentionRequest, 'text'> = {
    idempotency_key: buildIdempotencyKey(p.docId, p.commentId, botUid, p.docKind),
    doc_id: p.docId,
    // Omitted for docs-backend docs so the wire body stays byte-identical to what
    // it was before this field existed — the consumer asserts on the exact key set.
    ...(p.docKind ? { doc_kind: p.docKind } : {}),
    comment_id: String(p.commentId),
    // Root comment => omitted, so octo-server's parent_id-else-comment_id thread
    // derivation resolves the thread to this comment. NEVER send thread_id.
    ...(p.parentId !== undefined && p.parentId !== null ? { parent_id: String(p.parentId) } : {}),
    from_uid: p.authorUid,
    bot_uid: botUid,
    ...(url ? { url } : {}),
    ...(p.spaceId ? { space_id: p.spaceId } : {}),
  }

  // Bytes every field OTHER than the text's own content contributes.
  const overhead = byteLength(JSON.stringify({ ...base, text: '' }))
  const available = MAX_REQUEST_BYTES - overhead
  if (available <= 0) return { ok: false, reason: 'request_too_large' }

  let text = truncateUtf8(p.body, MAX_TEXT_BYTES)
  const textTruncated = text !== p.body
  for (let attempt = 0; attempt < 8; attempt++) {
    const body: BotMentionRequest = { ...base, text }
    const json = JSON.stringify(body)
    if (byteLength(json) <= MAX_REQUEST_BYTES) return { ok: true, body, json, textTruncated }
    // How many bytes the escaped text currently occupies, and the factor it must
    // shrink by. The -1 guarantees strict progress even when the ratio rounds to 1.
    const escaped = byteLength(json) - overhead
    const rawBytes = byteLength(text)
    const next = Math.min(rawBytes - 1, Math.floor((rawBytes * available) / escaped))
    if (next <= 0) break // the envelope alone leaves no room for any text
    text = truncateUtf8(text, next)
    if (text === '') break
  }
  return { ok: false, reason: 'request_too_large' }
}

/**
 * Parse `Retry-After` (RFC 7231): either delta-seconds or an HTTP-date. Clamped
 * to maxRetryAfterMs so a bogus or hostile value cannot park a detached retry
 * task for hours. Returns undefined when absent/unparseable, letting the caller
 * fall back to its exponential ladder.
 */
export function parseRetryAfterMs(raw: string | null): number | undefined {
  if (!raw) return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  const cap = config.botMention.maxRetryAfterMs
  if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed) * 1000, cap)
  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) return undefined
  return Math.min(Math.max(0, at - Date.now()), cap)
}

/**
 * Map one HTTP response onto the spec's response table. Kept pure (status +
 * parsed body + Retry-After in, outcome out) so every row is unit-testable
 * without a transport.
 */
export function classifyBotMentionResponse(
  status: number,
  body: { accepted?: unknown; replay?: unknown; reason?: unknown } | null,
  retryAfter: string | null,
): BotMentionOutcome {
  if (status === 200) {
    // accepted=true — replay=true is an idempotent replay and counts as SUCCESS.
    if (body?.accepted === true) return { kind: 'accepted', replay: body.replay === true }
    const reason = typeof body?.reason === 'string' ? body.reason : 'unknown'
    // accepted=false, reason=disabled — not in the gray release. Normal skip, no retry.
    if (reason === 'disabled') return { kind: 'skipped', reason }
    // Any other accepted=false is a refusal we cannot fix by retrying, and a
    // malformed 200 must not be treated as success (fail-closed).
    return { kind: 'permanent', reason }
  }
  // Malformed request / field error — retrying the same body cannot help.
  if (status === 400) return { kind: 'permanent', reason: 'bad_request' }
  // Token misconfigured: every subsequent attempt fails identically. Alert.
  if (status === 401) return { kind: 'alert', reason: 'unauthorized' }
  // Bot unknown / stopped / not a User Bot.
  if (status === 404) return { kind: 'permanent', reason: 'bot_not_found' }
  if (status === 409) {
    const reason = typeof body?.reason === 'string' ? body.reason : 'unknown'
    // Same key, DIFFERENT body — a bug on our side; retrying can never converge.
    if (reason === 'idempotency_conflict') return { kind: 'alert', reason }
    // Already being processed: retry the same key + same body, honouring Retry-After.
    if (reason === 'in_progress') {
      const delayMs = parseRetryAfterMs(retryAfter)
      return delayMs === undefined ? { kind: 'retry', reason } : { kind: 'retry', reason, delayMs }
    }
    return { kind: 'permanent', reason }
  }
  // 500 and anything else transient => bounded exponential backoff.
  return { kind: 'retry', reason: `http_${status}` }
}

/** POST once. Never throws: a transport failure/timeout becomes a retry outcome. */
async function sendOnce(json: string, token: string): Promise<BotMentionOutcome> {
  const url = `${config.botMention.baseUrl}${BOT_MENTION_PATH}`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), config.botMention.timeoutMs)
  try {
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'Content-Type': 'application/json',
          [INTERNAL_TOKEN_HEADER]: token,
        },
        body: json,
      })
    } catch {
      // Network error / abort (timeout). Retryable with the same key + body. The
      // error itself is not logged here: it can embed the request URL, and the
      // caller already logs the retry with safe metadata only.
      return { kind: 'retry', reason: 'network' }
    }
    // Only 200 and 409 carry a body we classify on; read inside the abort window
    // so a trickled body stays bounded by the same per-attempt timeout.
    let parsed: { accepted?: unknown; replay?: unknown; reason?: unknown } | null = null
    if (res.status === 200 || res.status === 409) {
      parsed = (await res.json().catch(() => null)) as typeof parsed
    }
    return classifyBotMentionResponse(res.status, parsed, res.headers.get('retry-after'))
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Deliver one bot's report, retrying ONLY the retryable outcomes with the same
 * idempotency key and the same serialized body, under bounded exponential
 * backoff (each delay capped, and the SLEEPS bounded by a wall-clock budget).
 *
 * Note the budget bounds the sleeps, not the attempts: an attempt that starts
 * just inside the deadline still runs its full `timeoutMs`. At shipped defaults
 * (5 attempts x 5s + a 7.5s ladder ~= 32.5s < 60s budget) that never overruns,
 * but this is not a hard wall-clock guarantee. Never throws.
 */
async function deliverOne(
  json: string,
  token: string,
  log: { docId: string; commentId: number | string; botUid: string },
  deps: BotMentionDeps,
): Promise<BotMentionOutcome> {
  const sleep = deps.sleep ?? defaultSleep
  const now = deps.now ?? Date.now
  const { maxAttempts, baseDelayMs, maxDelayMs, budgetMs } = config.botMention
  const deadline = now() + budgetMs
  let last: BotMentionOutcome = { kind: 'retry', reason: 'not_attempted' }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await sendOnce(json, token)
    if (last.kind !== 'retry') break
    if (attempt === maxAttempts) break
    // delay = base * 2^(attempt-1), capped; a server-supplied Retry-After
    // (409 in_progress) overrides the ladder.
    const backoff = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs)
    const delayMs = last.delayMs ?? backoff
    if (now() + delayMs >= deadline) {
      // eslint-disable-next-line no-console
      console.warn('[octo-docs] bot-mention retry budget exhausted', { ...log, attempt, reason: last.reason })
      break
    }
    await sleep(delayMs)
  }

  // Metadata-only logging: ids + status/reason. Never the token, text, or body.
  if (last.kind === 'alert') {
    // eslint-disable-next-line no-console
    console.error('[octo-docs] bot-mention ALERT (stop retrying, operator action required)', {
      ...log,
      reason: last.reason,
    })
  } else if (last.kind === 'retry') {
    // eslint-disable-next-line no-console
    console.warn('[octo-docs] bot-mention delivery failed after retries', { ...log, reason: last.reason })
  } else if (last.kind === 'permanent') {
    // eslint-disable-next-line no-console
    console.warn('[octo-docs] bot-mention rejected (not retried)', { ...log, reason: last.reason })
  }
  return last
}

/**
 * Which @-mentioned uids are candidate User Bots, in first-mention order.
 *
 * This is the RELATIONSHIP half of the rule (a bot the caller may summon at all);
 * the DOCUMENT-PERMISSION half is resolveBotDocAccess, applied by the caller. The
 * two are combined with AND.
 *
 * `candidateBots` is the caller's relationship set: the bots it OWNS
 * (req.ownedBots, from octo-server verify's `owned_bots`) UNION the bots it is
 * FRIENDS with (octoIdentity.listCallerBots => GET /v1/robot/my_bots). Both
 * sources are server-resolved for this caller; neither is client-supplied. See
 * resolveCandidateBots below for how the union is built (and how it fails closed).
 *
 * octo-server remains authoritative on "active User Bot, not App Bot" and answers
 * 404 for anything else, so this set is a cheap candidate filter, not a
 * security-critical classification.
 */
export function resolveMentionedBots(body: string, authorUid: string, candidateBots: string[]): string[] {
  // mentionedUserUids is the SHARED, ReDoS-hardened parser already used by the
  // docs-notify mention path (kept in sync with octo-web's MENTION_TOKEN_RE); it
  // de-dupes and preserves first-mention order, which keeps the per-bot fan-out
  // deterministic. Reused rather than re-implemented so the two report paths can
  // never disagree about what a mention is.
  return filterCandidateBots(mentionedUserUids(body, authorUid), candidateBots)
}

/**
 * Keep only the mentioned uids that are in the caller's relationship set,
 * preserving first-mention order. Split out from resolveMentionedBots so the
 * report path can parse the (up to 1 MB) body exactly ONCE and still filter twice:
 * once to decide whether the friend-bot list is even needed, once against the
 * final union.
 */
export function filterCandidateBots(mentionedUids: string[], candidateBots: string[]): string[] {
  if (candidateBots.length === 0) return []
  const candidates = new Set(candidateBots)
  return mentionedUids.filter((uid) => candidates.has(uid))
}

/**
 * Build the caller's relationship set for this comment: owned bots ∪ friend bots.
 *
 * `ownedBots` is free (already on the request). The friend list costs ONE
 * octo-server call, so it is fetched only when it could change the answer — i.e.
 * when some mentioned uid is not already an owned bot — and at most once per
 * report, never per bot. octoIdentity caches + coalesces it per caller.
 *
 * FAIL-CLOSED: listCallerBots returns null when it could not confirm (transport
 * failure, non-200, unparseable body). "Could not confirm" is treated as "no
 * friend bots", which degrades this path to exactly the previous owned-bots-only
 * behaviour — it never widens the set and never blocks the owned-bots route.
 */
async function resolveCandidateBots(
  p: BotMentionParams,
  mentioned: string[],
): Promise<string[]> {
  const owned = new Set(p.ownedBots)
  if (!mentioned.some((uid) => !owned.has(uid))) return p.ownedBots
  const listed = await getOctoIdentity().listCallerBots(
    p.authorUid,
    p.spaceId,
    p.callerToken ?? '',
  )
  if (listed === null) {
    // Metadata only. An unavailable friend list is an infrastructure signal, not a
    // statement about any relationship: owned bots are still reported normally, and
    // a friend-only bot is silently not reported (fail-closed).
    // eslint-disable-next-line no-console
    console.warn('[octo-docs] bot-mention friend-bot list unavailable (owned bots only)', {
      docId: p.docId,
      commentId: p.commentId,
      spaceId: p.spaceId,
    })
    return p.ownedBots
  }
  // Membership of my_bots already proves "active User Bot AND a friend of the
  // caller" (octo-server resolves it with a friend ⋈ user.robot=1 ⋈ robot.status=1
  // join), so the uid needs no further relationship check here.
  return [...p.ownedBots, ...listed.map((b) => b.uid)]
}

/**
 * Report every User Bot @-mentioned by a freshly-created comment, one POST each.
 *
 * BEST-EFFORT AND NEVER THROWS — the caller fires this after the comment row is
 * committed, so a failure here can never fail comment creation. Returns per-bot
 * counts for tests/metrics.
 */
export async function reportBotMentions(
  p: BotMentionParams & BotMentionAuthorGate,
  deps: BotMentionDeps = {},
): Promise<BotMentionReport> {
  const empty: BotMentionReport = { accepted: 0, skipped: 0, failed: 0 }
  const { token } = config.botMention
  // Fail-safe: unconfigured => silent no-op, no parsing, no IO.
  if (!token) return empty
  // `from_uid` must be a human. The bot mount carries no owned_bots anyway, so
  // this is belt-and-braces on the contract rather than the only guard.
  if (p.isBotCaller) return empty

  try {
    // Permission gate #1 — the acting human must be able to access AND edit the
    // doc. Checked before any parsing so an under-privileged caller costs nothing.
    //
    // HTML 路径没有 doc_member 行可解析,作者角色由注入的 botAllowed 一并判定
    // (BotMentionAuthorGate 在类型上强制 authorPreVerified 与 botAllowed 同行,
    // 所以走到这个分支时闸门一定存在 —— 不是「上游验过了所以跳过」)。
    // 两者都缺的调用编译不过;这里的运行时判断只是把常规路径的角色阈值判掉。
    if (!p.authorPreVerified) {
      if (!p.authorRole || !roleAtLeast(p.authorRole, BOT_MENTION_MIN_ROLE)) return empty
    }

    // RELATIONSHIP half — parse the mention tokens ONCE (the body can be ~1 MB),
    // then resolve the caller's candidate set: owned bots ∪ friend bots. The
    // friend-bot lookup is the only new IO on this path and it happens AT MOST
    // ONCE per report (never per bot), after the author gate and only when the
    // comment actually mentions something the author does not already own.
    const mentioned = mentionedUserUids(p.body, p.authorUid)
    if (mentioned.length === 0) return empty
    const candidates = await resolveCandidateBots(p, mentioned)
    let bots = filterCandidateBots(mentioned, candidates)
    if (bots.length === 0) return empty

    // The fan-out cap is applied BEFORE the per-bot permission reads so a comment
    // @ing many bots cannot fan out into an unbounded number of DB queries. The
    // surviving set is unchanged either way (both take the first `cap` in
    // first-mention order).
    const cap = config.botMention.maxBotsPerComment
    if (bots.length > cap) {
      // eslint-disable-next-line no-console
      console.warn('[octo-docs] bot-mention fan-out capped', {
        docId: p.docId,
        commentId: p.commentId,
        requested: bots.length,
        cap,
      })
      bots = bots.slice(0, cap)
    }

    // Permission gate #2 — THE BOT ITSELF must hold edit access on this document.
    //
    // This is checked per bot against doc_member (see agent/botIdentity.ts), NOT
    // inherited from the author. A bot acts with its OWN token, so octo-docs
    // validates the bot's own permission; a bot that is merely owned by a
    // privileged human but is not a member of THIS doc gets a hard 403 the moment
    // it tries to act. Gating here turns that invisible mid-flight failure into a
    // no-op the audit line explains, instead of a user waiting on a doomed task.
    //
    // A refusal is counted as `skipped` (an intentional non-report, not an error):
    // nothing about it is retryable and the comment itself is already committed.
    // 判定源:p.botAllowed —— 它与 authorPreVerified 由 BotMentionAuthorGate 焊在同一个
    // 对象里(判别联合),是 HTML 那条路上「作者闸 + Bot 闸」的唯一载体。抛异常一律当拒绝:
    // 拿不到答案时放行等于把这道闸作废。没传就回落到默认的 doc_member 查询
    // (Yjs 文档/表格/白板走这条)。
    const injectedBotAllowed = p.botAllowed
    const checkBot = injectedBotAllowed
      ? async (botUid: string) => {
          try {
            return { allowed: await injectedBotAllowed(botUid), reason: 'external' as const }
          } catch {
            return { allowed: false, reason: 'external_error' as const }
          }
        }
      : (botUid: string) => resolveBotDocAccess(p.docId, botUid, p.spaceId)
    const gated = await Promise.all(
      bots.map(async (botUid) => ({ botUid, access: await checkBot(botUid) })),
    )
    const allowed: string[] = []
    let denied = 0
    for (const { botUid, access } of gated) {
      if (access.allowed) {
        allowed.push(botUid)
        continue
      }
      denied++
      // AUDIT LINE — metadata only, and it names the refusal class so
      // "not a member / role too low" is distinguishable from "the permission read
      // failed". Both refuse; only the latter is an infrastructure alarm.
      // eslint-disable-next-line no-console
      console.warn('[octo-docs] bot-mention denied (bot lacks document permission)', {
        docId: p.docId,
        commentId: p.commentId,
        botUid,
        reason: access.reason,
        // 外部判定源(HTML)不回角色 —— 那边的角色语义在它自己那儿,这里如实留空。
        ...('role' in access ? { botRole: access.role } : {}),
        minRole: BOT_DOC_ACCESS_MIN_ROLE,
      })
    }
    if (allowed.length === 0) return { ...empty, skipped: denied }
    bots = allowed

    // One request per mentioned bot, each with its own idempotency key and its own
    // retry chain. Bounded by `cap`, so a flat Promise.all is already bounded.
    const outcomes = await Promise.all(
      bots.map(async (botUid) => {
        const built = buildBotMentionRequest(p, botUid)
        if (!built.ok) {
          // eslint-disable-next-line no-console
          console.warn('[octo-docs] bot-mention skipped (unsendable request)', {
            docId: p.docId,
            commentId: p.commentId,
            botUid,
            reason: built.reason,
          })
          return { kind: 'permanent', reason: built.reason } as BotMentionOutcome
        }
        if (built.textTruncated) {
          // eslint-disable-next-line no-console
          console.warn('[octo-docs] bot-mention text truncated to contract cap', {
            docId: p.docId,
            commentId: p.commentId,
            botUid,
            maxTextBytes: MAX_TEXT_BYTES,
          })
        }
        return deliverOne(built.json, token, { docId: p.docId, commentId: p.commentId, botUid }, deps)
      }),
    )

    const report = { ...empty, skipped: denied }
    for (const o of outcomes) {
      if (o.kind === 'accepted') report.accepted++
      else if (o.kind === 'skipped') report.skipped++
      else report.failed++
    }
    return report
  } catch (err) {
    // Last-resort guard: this path must never surface an error to the caller.
    // eslint-disable-next-line no-console
    console.error('[octo-docs] bot-mention report failed', {
      docId: p.docId,
      commentId: p.commentId,
      err: String(err),
    })
    return empty
  }
}
