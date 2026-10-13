import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Offline unit tests for the @Bot-in-comment report producer (octo-server
// POST /v1/internal/bot-mentions). config, the doc repos, octoIdentity and
// global.fetch are all mocked, so nothing here touches MySQL, Redis, or the
// network. Coverage mirrors the integration spec:
//   - mention parsing (malformed / injection-shaped / label containing ':')
//   - idempotency_key stability (same inputs => same key; retries reuse key+body)
//   - EVERY row of the response-handling table
//   - the 10 KiB text cap and the 32 KiB whole-request cap
//   - unconfigured token => silent no-op (no fetch at all)
//   - one request per mentioned bot
//   - the per-bot doc-access gate (bot must be a doc_member at >= writer)
vi.mock('../src/config/env.js', () => ({
  config: {
    webOrigin: 'https://docs.example.com',
    octoIdentity: { serverBaseUrl: 'http://octo-server:8080' },
    notify: { docsToken: '', service: 'docs-service' },
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
// Two consumers of these repos: docsNotify (whose mention parser botMention
// reuses) pulls them in at import time, and the bot doc-access gate resolves the
// bot's OWN role through permission/resolveRole -> docMetaRepo + docMemberRepo.
// vi.hoisted so the handles exist before the hoisted vi.mock factories run.
const db = vi.hoisted(() => ({ getRole: vi.fn(), getByDocId: vi.fn() }))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  ROLE_ADMIN: 3,
  docMemberRepo: { list: vi.fn(async () => []), getRole: db.getRole },
}))
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: { getByDocId: db.getByDocId },
}))
// The mention path now also asks octoIdentity for the caller's FRIEND-bot list
// (GET /v1/robot/my_bots). Default: a confirmed EMPTY list, so every case in this
// file keeps judging relationships purely from ownedBots — the friend-bot half has
// its own file (botMentionFriendBots.test.ts).
const identity = vi.hoisted(() => ({ listCallerBots: vi.fn(async () => [] as Array<{ uid: string; creatorUid: string }>) }))
vi.mock('../src/auth/octoIdentity.js', () => ({
  getOctoIdentity: () => ({ getUser: vi.fn(async () => null), listCallerBots: identity.listCallerBots }),
}))

import {
  reportBotMentions,
  resolveMentionedBots,
  buildIdempotencyKey,
  buildBotMentionRequest,
  classifyBotMentionResponse,
  parseRetryAfterMs,
  truncateUtf8,
  absoluteHttpUrl,
  type BotMentionParams,
} from '../src/api/services/botMention.js'
import { resolveBotDocAccess } from '../src/agent/botIdentity.js'
import { config } from '../src/config/env.js'

const cfg = config as unknown as { botMention: { token: string; maxBotsPerComment: number } }

/** Never actually wait: the retry ladder is asserted via the recorded delays. */
const noSleep = vi.fn(async (_ms: number) => {})

// The service logs diagnostics through console.warn/error. Hold the spies here so
// assertions never reference `console.*` directly (the repo lints no-console on).
let warnSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>

function params(over: Partial<BotMentionParams> = {}): BotMentionParams {
  return {
    docId: 'doc-1',
    commentId: 42,
    spaceId: 'space-1',
    authorUid: 'u-human',
    authorRole: 'writer',
    ownedBots: ['bot-1'],
    body: 'please review @[user:bot-1:My Bot]',
    ...over,
  }
}

/** One JSON response, optionally carrying a Retry-After header. */
function resp(status: number, body?: unknown, headers?: Record<string, string>) {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers })
}

function fetchMock(...responses: Array<Response | Error>) {
  let i = 0
  return vi.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)]
    i++
    if (r instanceof Error) throw r
    // A Response body can only be consumed once; clone per call so repeated
    // attempts against the same canned response still parse.
    return (r as Response).clone()
  })
}

/** Every request body seen by fetch, as the raw serialized string. */
function sentBodies(): string[] {
  return (fetch as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls.map(
    (c) => c[1].body as string,
  )
}

function sentJson(): Array<Record<string, unknown>> {
  return sentBodies().map((b) => JSON.parse(b) as Record<string, unknown>)
}

beforeEach(() => {
  cfg.botMention.token = 'bot-mention-token'
  cfg.botMention.maxBotsPerComment = 8
  noSleep.mockClear()
  // Doc-access gate defaults: the doc exists, the human owns it, and every uid
  // asked about is a `writer` member — so a mentioned bot CLEARS the gate. The
  // end-to-end cases below predate the gate and assume it passes; the gate's own
  // cases override these two mocks per test.
  db.getByDocId.mockResolvedValue({ doc_id: 'doc-1', owner_id: 'u-human', owner_space_id: 'space-1' })
  db.getRole.mockResolvedValue('writer')
  identity.listCallerBots.mockReset()
  identity.listCallerBots.mockResolvedValue([])
  // Silence the service's intentional diagnostic logging; assertions target
  // behaviour, not log lines.
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

// ── mention parsing ──────────────────────────────────────────────────────────

describe('resolveMentionedBots — mention token parsing', () => {
  it('extracts an owned bot from a well-formed user token', () => {
    expect(resolveMentionedBots('hi @[user:bot-1:My Bot]', 'u-human', ['bot-1'])).toEqual(['bot-1'])
  })

  it('ignores doc-type tokens (only user mentions can be a bot)', () => {
    expect(resolveMentionedBots('see @[doc:bot-1:Some Doc]', 'u-human', ['bot-1'])).toEqual([])
  })

  it('keeps a label containing colons (label is the last, greedy field)', () => {
    // Frontend serializeMention only strips ']'; ':' inside a label is legal and
    // must not shift the id capture group.
    expect(resolveMentionedBots('@[user:bot-1:Ops: Deploy: Bot]', 'u-human', ['bot-1'])).toEqual(['bot-1'])
  })

  it('de-dupes a bot mentioned several times into ONE report target', () => {
    const body = '@[user:bot-1:A] then @[user:bot-1:A] and @[user:bot-1:A]'
    expect(resolveMentionedBots(body, 'u-human', ['bot-1'])).toEqual(['bot-1'])
  })

  it('preserves first-mention order so the fan-out is deterministic', () => {
    const body = '@[user:bot-2:B] @[user:bot-1:A] @[user:bot-2:B]'
    expect(resolveMentionedBots(body, 'u-human', ['bot-1', 'bot-2'])).toEqual(['bot-2', 'bot-1'])
  })

  it('drops mentioned uids that are not bots the author owns', () => {
    const body = '@[user:u-colleague:Bob] @[user:bot-1:A] @[user:bot-stranger:X]'
    expect(resolveMentionedBots(body, 'u-human', ['bot-1'])).toEqual(['bot-1'])
  })

  it('returns nothing when the author owns no bots (fail-closed default)', () => {
    expect(resolveMentionedBots('@[user:bot-1:A]', 'u-human', [])).toEqual([])
  })

  it.each([
    ['unclosed token', '@[user:bot-1:My Bot'],
    ['missing label segment', '@[user:bot-1]'],
    ['missing id segment', '@[user::label]'],
    ['empty token', '@[]'],
    ['unknown type', '@[robot:bot-1:A]'],
    ['bare at-sign', '@bot-1'],
    ['no at-sign prefix', '[user:bot-1:A]'],
    ['colon in the id position splits early', '@[user:bot:1:A]'],
    ['nested opening bracket', '@[user:@[user:bot-1:A]:B]'],
  ])('does not report a bot for malformed input: %s', (_name, body) => {
    expect(resolveMentionedBots(body, 'u-human', ['bot-1'])).toEqual([])
  })

  it('treats injection-shaped payloads as inert text, never as a bot', () => {
    const bodies = [
      '@[user:<script>alert(1)</script>:A]',
      '@[user:bot-1\u0000:A]',
      "@[user:'; DROP TABLE doc_comment; --:A]",
      '@[user:../../etc/passwd:A]',
      '@[user:%s%s%s:A]', // util.format directives must never reach a format string
      '@[user:{{7*7}}:A]',
    ]
    for (const body of bodies) {
      expect(resolveMentionedBots(body, 'u-human', ['bot-1'])).toEqual([])
    }
  })

  it('still finds a real bot mention alongside injection-shaped noise', () => {
    const body = '@[user:%s%s:X] <script>x</script> @[user:bot-1:Real Bot] \u0000 ${{}}'
    expect(resolveMentionedBots(body, 'u-human', ['bot-1'])).toEqual(['bot-1'])
  })

  it('does not treat the author themselves as a bot even if self-owned', () => {
    // mentionedUserUids excludes the author, so a self-mention can never fan out.
    expect(resolveMentionedBots('@[user:u-human:Me]', 'u-human', ['u-human'])).toEqual([])
  })
})

// ── idempotency key ──────────────────────────────────────────────────────────

describe('buildIdempotencyKey — stability and uniqueness', () => {
  it('is deterministic: identical inputs always produce an identical key', () => {
    const a = buildIdempotencyKey('doc-1', 42, 'bot-1')
    const b = buildIdempotencyKey('doc-1', 42, 'bot-1')
    expect(a).toBe(b)
    expect(a).toBe('docs-comment-mention:doc-1:42:bot-1')
  })

  it('differs per bot, per comment, and per doc', () => {
    const base = buildIdempotencyKey('doc-1', 42, 'bot-1')
    expect(buildIdempotencyKey('doc-1', 42, 'bot-2')).not.toBe(base)
    expect(buildIdempotencyKey('doc-1', 43, 'bot-1')).not.toBe(base)
    expect(buildIdempotencyKey('doc-2', 42, 'bot-1')).not.toBe(base)
  })

  it('renders a large safe-integer comment id without precision loss or exponent form', () => {
    // doc_comment.id is a MySQL AUTO_INCREMENT read into a JS number. parseId
    // guarantees Number.isSafeInteger, so String() is lossless and never yields
    // '1e+21'-style notation that would silently change the key.
    const id = Number.MAX_SAFE_INTEGER
    expect(buildIdempotencyKey('doc-1', id, 'bot-1')).toBe(`docs-comment-mention:doc-1:${id}:bot-1`)
    expect(buildIdempotencyKey('doc-1', id, 'bot-1')).not.toMatch(/e\+/i)
  })

  it('namespaces the key by docKind so an html slug can never collide with a real doc_id', () => {
    // doc_id 和 octo-doc slug 是两个命名空间,slug 的字符集 ([A-Za-z0-9_-]{1,128})
    // 是 doc_id (`d_` + 12 位) 的超集 —— 一个长得像 `d_abc123abc123` 的 slug 能和
    // 真实 doc_id 撞出同一个 key。撞上之后 octo-server 要么当重放静默丢弃,要么判
    // 409 idempotency_conflict(classifyFailure 里归为不可重试 alert),等于一条
    // 合法的 @Bot 永久消失。
    const yjs = buildIdempotencyKey('d_abc123abc123', 42, 'bot-1')
    const html = buildIdempotencyKey('d_abc123abc123', 42, 'bot-1', 'html')
    expect(html).not.toBe(yjs)
    expect(html).toBe('docs-comment-mention:html:d_abc123abc123:42:bot-1')
  })

  it('leaves the Yjs-path key BYTE-IDENTICAL to what it was before docKind existed', () => {
    // 在途重试必须复用同一个 key。给 Yjs 路加前缀 = 所有在飞的重试换 key,
    // octo-server 侧 dedupe 漏一轮。
    expect(buildIdempotencyKey('doc-1', 42, 'bot-1', undefined)).toBe(
      'docs-comment-mention:doc-1:42:bot-1',
    )
    expect(buildIdempotencyKey('doc-1', 42, 'bot-1', '')).toBe(
      'docs-comment-mention:doc-1:42:bot-1',
    )
  })

  it('serializes comment_id / parent_id as STRINGS on the wire while staying numeric internally', () => {
    const built = buildBotMentionRequest(params({ commentId: 42, parentId: 7 }), 'bot-1')
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.body.comment_id).toBe('42')
    expect(built.body.parent_id).toBe('7')
    expect(typeof built.body.comment_id).toBe('string')
    expect(typeof built.body.parent_id).toBe('string')
  })

  it('omits parent_id for a root comment and NEVER sends thread_id', () => {
    const built = buildBotMentionRequest(params({ parentId: undefined }), 'bot-1')
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.body).not.toHaveProperty('parent_id')
    expect(built.body).not.toHaveProperty('thread_id')
    expect(built.json).not.toContain('thread_id')
  })

  it('never sends thread_id for a reply either (octo-server derives it)', () => {
    const built = buildBotMentionRequest(params({ parentId: 7 }), 'bot-1')
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.json).not.toContain('thread_id')
  })

  it('omits doc_kind for a docs-backend doc, keeping the body byte-identical to before the field existed', () => {
    // The consumer asserts on the exact key set of the event payload. An
    // unconditional doc_kind would break that assertion for every ordinary doc —
    // and those are the overwhelming majority of reports.
    const built = buildBotMentionRequest(params({}), 'bot-1')
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.body).not.toHaveProperty('doc_kind')
    expect(built.json).not.toContain('doc_kind')
  })

  it("sends doc_kind:'html' when docId is an octo-doc slug", () => {
    // Without this the consumer takes the slug to a docId-keyed endpoint and 404s,
    // indistinguishably from "no such document".
    const built = buildBotMentionRequest(params({ docKind: 'html' }), 'bot-1')
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.body.doc_kind).toBe('html')
  })

  it('OMITS url on the html path instead of shipping a guaranteed-404 link', () => {
    // buildDocShareUrl 无条件产出 `<origin>/d/<docId>`,而 `/d/:docId` 按 docs-backend
    // 的 doc_id 寻址 (docMetaRepo.getByDocId)。html 路上 docId 是 octo-doc slug,
    // 两个命名空间不通,拼出来必然 404 —— 而且是「绝对 URL + 协议合法」的 404,
    // absoluteHttpUrl 只校验协议,拦不住。任务卡上一条点不开的链接比没有链接更糟:
    // 用户会以为文档被删了。url 是可选字段,消费端已按可选处理。
    const built = buildBotMentionRequest(params({ docKind: 'html' }), 'bot-1')
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.body).not.toHaveProperty('url')
    expect(built.json).not.toContain('/d/')
  })

  it('still carries url on the Yjs path (the html omission must not leak across)', () => {
    const built = buildBotMentionRequest(params({}), 'bot-1')
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.body.url).toBe('https://docs.example.com/d/doc-1')
  })

  it('carries the docKind-namespaced idempotency_key end-to-end on the html path', () => {
    // buildIdempotencyKey 的单测锁住了函数本身;这条锁住 buildBotMentionRequest
    // 真的把 p.docKind 透传了进去 —— 少传这一个实参,namespacing 就等于没做。
    const built = buildBotMentionRequest(params({ docKind: 'html' }), 'bot-1')
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.body.idempotency_key).toBe('docs-comment-mention:html:doc-1:42:bot-1')
  })
})

// ── response-handling table, row by row ──────────────────────────────────────

describe('classifyBotMentionResponse — one case per spec table row', () => {
  it('200 accepted=true => accepted', () => {
    expect(classifyBotMentionResponse(200, { accepted: true }, null)).toEqual({
      kind: 'accepted',
      replay: false,
    })
  })

  it('200 accepted=true replay=true => accepted (idempotent replay is SUCCESS)', () => {
    expect(classifyBotMentionResponse(200, { accepted: true, replay: true }, null)).toEqual({
      kind: 'accepted',
      replay: true,
    })
  })

  it('200 accepted=false reason=disabled => skipped, not retried', () => {
    expect(classifyBotMentionResponse(200, { accepted: false, reason: 'disabled' }, null)).toEqual({
      kind: 'skipped',
      reason: 'disabled',
    })
  })

  it('400 => permanent, not retried', () => {
    expect(classifyBotMentionResponse(400, null, null)).toEqual({
      kind: 'permanent',
      reason: 'bad_request',
    })
  })

  it('401 => alert (token misconfigured): stop retrying and raise', () => {
    expect(classifyBotMentionResponse(401, null, null)).toEqual({
      kind: 'alert',
      reason: 'unauthorized',
    })
  })

  it('404 => permanent (unknown / stopped / not a User Bot), not retried', () => {
    expect(classifyBotMentionResponse(404, null, null)).toEqual({
      kind: 'permanent',
      reason: 'bot_not_found',
    })
  })

  it('409 in_progress => retry, honouring Retry-After', () => {
    expect(classifyBotMentionResponse(409, { reason: 'in_progress' }, '3')).toEqual({
      kind: 'retry',
      reason: 'in_progress',
      delayMs: 3000,
    })
  })

  it('409 in_progress without Retry-After => retry on the exponential ladder', () => {
    expect(classifyBotMentionResponse(409, { reason: 'in_progress' }, null)).toEqual({
      kind: 'retry',
      reason: 'in_progress',
    })
  })

  it('409 idempotency_conflict => alert: stop retrying and raise', () => {
    expect(classifyBotMentionResponse(409, { reason: 'idempotency_conflict' }, null)).toEqual({
      kind: 'alert',
      reason: 'idempotency_conflict',
    })
  })

  it('500 => retry (bounded exponential backoff)', () => {
    expect(classifyBotMentionResponse(500, null, null)).toEqual({ kind: 'retry', reason: 'http_500' })
  })

  it('a malformed 200 is NOT treated as success (fail-closed)', () => {
    expect(classifyBotMentionResponse(200, null, null)).toEqual({ kind: 'permanent', reason: 'unknown' })
    expect(classifyBotMentionResponse(200, { accepted: 'yes' }, null)).toEqual({
      kind: 'permanent',
      reason: 'unknown',
    })
  })
})

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfterMs('2')).toBe(2000)
  })

  it('clamps an absurd value to the configured ceiling', () => {
    expect(parseRetryAfterMs('999999')).toBe(30_000)
  })

  it('parses an HTTP-date and clamps a past date to 0', () => {
    expect(parseRetryAfterMs('Thu, 01 Jan 1970 00:00:00 GMT')).toBe(0)
  })

  it('returns undefined for absent/unparseable values (fall back to the ladder)', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined()
    expect(parseRetryAfterMs('')).toBeUndefined()
    expect(parseRetryAfterMs('soon')).toBeUndefined()
  })
})

describe('reportBotMentions — end-to-end per response row', () => {
  it.each(['prepare', 'delivery', 'both'] as const)('preserves dispatch and accepted outcomes when %s tracking fails', async phase => {
    vi.stubGlobal('fetch', fetchMock(resp(200, { accepted: true })))
    const result = await reportBotMentions(params({ ownedBots: ['bot-1', 'bot-2'], body: '@[user:bot-1:One] @[user:bot-2:Two]' }), {
      sleep: noSleep,
      onTask: async (_params, _bot, outcome) => {
        if (phase === 'both' || (outcome ? 'delivery' : 'prepare') === phase) throw new Error('tracking unavailable')
      },
    })
    expect(result).toEqual({ accepted: 2, skipped: 0, failed: 0 })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('prepares tracking before enqueue and records the actual transport outcome afterward', async () => {
    const order: string[] = []
    vi.stubGlobal('fetch', vi.fn(async () => { order.push('enqueue'); return resp(200, { accepted: true }) }))
    const result = await reportBotMentions(params(), {
      sleep: noSleep,
      onTask: async (_params, _bot, outcome) => { order.push(outcome ? outcome.kind : 'prepared') },
    })
    expect(result.accepted).toBe(1)
    expect(order).toEqual(['prepared', 'enqueue', 'accepted'])
  })

  it('200 accepted=true: one POST, counted as accepted', async () => {
    vi.stubGlobal('fetch', fetchMock(resp(200, { accepted: true })))
    const r = await reportBotMentions(params(), { sleep: noSleep })
    expect(r).toEqual({ accepted: 1, skipped: 0, failed: 0 })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('200 replay=true is success, not a failure', async () => {
    vi.stubGlobal('fetch', fetchMock(resp(200, { accepted: true, replay: true })))
    const r = await reportBotMentions(params(), { sleep: noSleep })
    expect(r).toEqual({ accepted: 1, skipped: 0, failed: 0 })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('reason=disabled: counted as skipped and NEVER retried', async () => {
    vi.stubGlobal('fetch', fetchMock(resp(200, { accepted: false, reason: 'disabled' })))
    const r = await reportBotMentions(params(), { sleep: noSleep })
    expect(r).toEqual({ accepted: 0, skipped: 1, failed: 0 })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(noSleep).not.toHaveBeenCalled()
  })

  it.each([
    [400, 'bad request'],
    [404, 'bot not found'],
  ])('%i is not retried', async (status) => {
    vi.stubGlobal('fetch', fetchMock(resp(status)))
    const r = await reportBotMentions(params(), { sleep: noSleep })
    expect(r).toEqual({ accepted: 0, skipped: 0, failed: 1 })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(noSleep).not.toHaveBeenCalled()
  })

  it('401 stops immediately and logs an operator alert', async () => {
    vi.stubGlobal('fetch', fetchMock(resp(401)))
    const r = await reportBotMentions(params(), { sleep: noSleep })
    expect(r).toEqual({ accepted: 0, skipped: 0, failed: 1 })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(noSleep).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('ALERT'),
      expect.objectContaining({ reason: 'unauthorized' }),
    )
  })

  it('409 idempotency_conflict stops immediately and logs an operator alert', async () => {
    vi.stubGlobal('fetch', fetchMock(resp(409, { reason: 'idempotency_conflict' })))
    const r = await reportBotMentions(params(), { sleep: noSleep })
    expect(r).toEqual({ accepted: 0, skipped: 0, failed: 1 })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(noSleep).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('ALERT'),
      expect.objectContaining({ reason: 'idempotency_conflict' }),
    )
  })

  it('409 in_progress retries on Retry-After with the SAME key and SAME body, then succeeds', async () => {
    vi.stubGlobal(
      'fetch',
      fetchMock(resp(409, { reason: 'in_progress' }, { 'Retry-After': '2' }), resp(200, { accepted: true })),
    )
    const r = await reportBotMentions(params(), { sleep: noSleep })
    expect(r).toEqual({ accepted: 1, skipped: 0, failed: 0 })
    expect(fetch).toHaveBeenCalledTimes(2)
    // Retry-After (2s) overrides the exponential ladder's first step (500ms).
    expect(noSleep).toHaveBeenCalledWith(2000)
    const bodies = sentBodies()
    expect(bodies[0]).toBe(bodies[1]) // byte-identical retry: same key, same body
  })

  it('500 retries with bounded exponential backoff, then gives up as failed', async () => {
    vi.stubGlobal('fetch', fetchMock(resp(500)))
    const r = await reportBotMentions(params(), { sleep: noSleep })
    expect(r).toEqual({ accepted: 0, skipped: 0, failed: 1 })
    // maxAttempts=5 => 5 POSTs and 4 waits.
    expect(fetch).toHaveBeenCalledTimes(5)
    expect(noSleep.mock.calls.map((c) => c[0])).toEqual([500, 1000, 2000, 4000])
    // Every attempt carries the identical key and body.
    expect(new Set(sentBodies()).size).toBe(1)
  })

  it('a network failure / timeout retries the same body and can still succeed', async () => {
    vi.stubGlobal('fetch', fetchMock(new Error('socket hang up'), resp(200, { accepted: true })))
    const r = await reportBotMentions(params(), { sleep: noSleep })
    expect(r).toEqual({ accepted: 1, skipped: 0, failed: 0 })
    expect(fetch).toHaveBeenCalledTimes(2)
    const bodies = sentBodies()
    expect(bodies[0]).toBe(bodies[1])
  })

  it('caps the total retry ladder by the wall-clock budget', async () => {
    vi.stubGlobal('fetch', fetchMock(resp(500)))
    // A clock that jumps past the whole 60s budget between calls, so the very
    // first would-be retry already sits outside the deadline.
    let t = 0
    const now = () => {
      t += 80_000
      return t
    }
    const r = await reportBotMentions(params(), { sleep: noSleep, now })
    expect(r).toEqual({ accepted: 0, skipped: 0, failed: 1 })
    // Budget exhausted before any retry: far short of maxAttempts (5).
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(noSleep).not.toHaveBeenCalled()
  })
})

// ── request shape, gating and size caps ──────────────────────────────────────

describe('reportBotMentions — gating', () => {
  it('is a silent no-op when the internal token is unset (NO fetch at all)', async () => {
    cfg.botMention.token = ''
    vi.stubGlobal('fetch', fetchMock(resp(200, { accepted: true })))
    const r = await reportBotMentions(params(), { sleep: noSleep })
    expect(r).toEqual({ accepted: 0, skipped: 0, failed: 0 })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not report when the caller is a bot (from_uid must be human)', async () => {
    vi.stubGlobal('fetch', fetchMock(resp(200, { accepted: true })))
    const r = await reportBotMentions(params({ isBotCaller: true }), { sleep: noSleep })
    expect(r).toEqual({ accepted: 0, skipped: 0, failed: 0 })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['none', 'reader', 'commenter'] as const)(
    'does not report when the author only holds %s (edit permission required)',
    async (role) => {
      vi.stubGlobal('fetch', fetchMock(resp(200, { accepted: true })))
      const r = await reportBotMentions(params({ authorRole: role }), { sleep: noSleep })
      expect(r).toEqual({ accepted: 0, skipped: 0, failed: 0 })
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it.each(['writer', 'admin'] as const)('reports when the author holds %s', async (role) => {
    vi.stubGlobal('fetch', fetchMock(resp(200, { accepted: true })))
    const r = await reportBotMentions(params({ authorRole: role }), { sleep: noSleep })
    expect(r.accepted).toBe(1)
  })

  it('does nothing when the body mentions no owned bot', async () => {
    vi.stubGlobal('fetch', fetchMock(resp(200, { accepted: true })))
    const r = await reportBotMentions(params({ body: 'plain comment @[user:u-bob:Bob]' }), {
      sleep: noSleep,
    })
    expect(r).toEqual({ accepted: 0, skipped: 0, failed: 0 })
    expect(fetch).not.toHaveBeenCalled()
  })
})

// ── the bot's OWN document permission (the gate this change adds) ─────────────
//
// A bot acts with its own token, so the backend validates the BOT's permission,
// not its owner's. Field evidence: a non-member bot was @-mentioned, took the
// turn, then died on `403 forbidden / bot lacks permission`. These cases pin the
// gate that stops the mention at the entry point instead.

/** The single audit line the gate emits, if any. */
function denyAudit(): Record<string, unknown> | undefined {
  const call = warnSpy.mock.calls.find(
    (c) => typeof c[0] === 'string' && (c[0] as string).includes('bot lacks document permission'),
  )
  return call?.[1] as Record<string, unknown> | undefined
}

describe('reportBotMentions — bot doc-access gate', () => {
  it('reports when the bot IS a member of this doc at writer', async () => {
    db.getRole.mockResolvedValue('writer')
    vi.stubGlobal('fetch', fetchMock(resp(200, { accepted: true })))
    const r = await reportBotMentions(params(), { sleep: noSleep })
    expect(r).toEqual({ accepted: 1, skipped: 0, failed: 0 })
    // Asked about the BOT's own uid on THIS doc — not the author's.
    expect(db.getRole).toHaveBeenCalledWith('doc-1', 'bot-1', 'space-1')
    expect(denyAudit()).toBeUndefined()
  })

  it('reports when the bot is a member at admin', async () => {
    db.getRole.mockResolvedValue('admin')
    vi.stubGlobal('fetch', fetchMock(resp(200, { accepted: true })))
    expect(await reportBotMentions(params(), { sleep: noSleep })).toEqual({
      accepted: 1,
      skipped: 0,
      failed: 0,
    })
  })

  it('does NOT report a bot that is not a member of this doc (the observed 403 case)', async () => {
    // No doc_member row for the bot, and it is not the owner.
    db.getRole.mockResolvedValue(undefined)
    vi.stubGlobal('fetch', fetchMock(resp(200, { accepted: true })))
    const r = await reportBotMentions(params(), { sleep: noSleep })
    // Counted as an intentional skip, never as a delivery failure.
    expect(r).toEqual({ accepted: 0, skipped: 1, failed: 0 })
    expect(fetch).not.toHaveBeenCalled()
    // The audit line names the refusal class and carries no secrets.
    expect(denyAudit()).toMatchObject({
      docId: 'doc-1',
      commentId: 42,
      botUid: 'bot-1',
      reason: 'bot_no_doc_access',
      botRole: 'none',
      minRole: 'writer',
    })
  })

  it.each(['reader', 'commenter'] as const)(
    'does NOT report a bot whose role is only %s (below the edit floor)',
    async (role) => {
      db.getRole.mockResolvedValue(role)
      vi.stubGlobal('fetch', fetchMock(resp(200, { accepted: true })))
      const r = await reportBotMentions(params(), { sleep: noSleep })
      expect(r).toEqual({ accepted: 0, skipped: 1, failed: 0 })
      expect(fetch).not.toHaveBeenCalled()
      expect(denyAudit()).toMatchObject({ reason: 'bot_no_doc_access', botRole: role })
    },
  )

  it('reports a bot that OWNS the document (owner is implicit admin, no member row)', async () => {
    // A doc-owning bot has NO doc_member row; a doc_member-only check would
    // wrongly refuse it. Bots do own docs (docMetaRepo owner='me' ownerSet).
    db.getByDocId.mockResolvedValue({ doc_id: 'doc-1', owner_id: 'bot-1', owner_space_id: 'space-1' })
    db.getRole.mockResolvedValue(undefined)
    vi.stubGlobal('fetch', fetchMock(resp(200, { accepted: true })))
    expect(await reportBotMentions(params(), { sleep: noSleep })).toEqual({
      accepted: 1,
      skipped: 0,
      failed: 0,
    })
  })

  it('does NOT report when the document row is gone', async () => {
    db.getByDocId.mockResolvedValue(null)
    vi.stubGlobal('fetch', fetchMock(resp(200, { accepted: true })))
    expect(await reportBotMentions(params(), { sleep: noSleep })).toEqual({
      accepted: 0,
      skipped: 1,
      failed: 0,
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('FAILS CLOSED when the permission read itself throws, with a distinct reason', async () => {
    db.getRole.mockRejectedValue(new Error('ER_CON_COUNT_ERROR: too many connections'))
    vi.stubGlobal('fetch', fetchMock(resp(200, { accepted: true })))
    const r = await reportBotMentions(params(), { sleep: noSleep })
    expect(r).toEqual({ accepted: 0, skipped: 1, failed: 0 })
    expect(fetch).not.toHaveBeenCalled()
    // A DB outage is an infrastructure alarm, NOT a statement about the bot's
    // permission — the audit line must distinguish the two.
    const audit = denyAudit()
    expect(audit).toMatchObject({ reason: 'bot_doc_access_unavailable' })
    // The DB error text (which can carry connection/SQL detail) is not logged.
    expect(JSON.stringify(audit)).not.toContain('ER_CON_COUNT_ERROR')
  })

  it('gates each bot INDEPENDENTLY: the permitted one is reported, the other is not', async () => {
    db.getRole.mockImplementation(async (_docId: string, uid: string) =>
      uid === 'bot-1' ? 'writer' : 'reader',
    )
    vi.stubGlobal('fetch', fetchMock(resp(200, { accepted: true })))
    const r = await reportBotMentions(
      params({ ownedBots: ['bot-1', 'bot-2'], body: '@[user:bot-1:A] @[user:bot-2:B]' }),
      { sleep: noSleep },
    )
    expect(r).toEqual({ accepted: 1, skipped: 1, failed: 0 })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(sentJson()[0]!.bot_uid).toBe('bot-1')
  })

  it('checks the relationship FIRST: a non-owned mention costs no permission read', async () => {
    vi.stubGlobal('fetch', fetchMock(resp(200, { accepted: true })))
    await reportBotMentions(params({ body: 'hi @[user:u-bob:Bob]' }), { sleep: noSleep })
    expect(db.getRole).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('checks the author gate before any permission read', async () => {
    vi.stubGlobal('fetch', fetchMock(resp(200, { accepted: true })))
    await reportBotMentions(params({ authorRole: 'commenter' }), { sleep: noSleep })
    expect(db.getRole).not.toHaveBeenCalled()
  })

  it('never reads permissions more than once per bot, capped by maxBotsPerComment', async () => {
    // The cap bounds the DB fan-out, not just the HTTP fan-out.
    cfg.botMention.maxBotsPerComment = 2
    db.getRole.mockResolvedValue('writer')
    vi.stubGlobal('fetch', fetchMock(resp(200, { accepted: true })))
    const bots = ['bot-1', 'bot-2', 'bot-3', 'bot-4']
    await reportBotMentions(
      params({ ownedBots: bots, body: bots.map((b) => `@[user:${b}:${b}]`).join(' ') }),
      { sleep: noSleep },
    )
    expect(db.getRole).toHaveBeenCalledTimes(2)
  })
})

describe('resolveBotDocAccess — the judgement in isolation', () => {
  it('allows at or above the floor and refuses below it', async () => {
    db.getByDocId.mockResolvedValue({ doc_id: 'd1', owner_id: 'u-other', owner_space_id: 'sp1' })
    for (const role of ['writer', 'admin'] as const) {
      db.getRole.mockResolvedValue(role)
      expect(await resolveBotDocAccess('d1', 'b1', 'sp1')).toEqual({ allowed: true, role })
    }
    for (const role of ['reader', 'commenter'] as const) {
      db.getRole.mockResolvedValue(role)
      expect(await resolveBotDocAccess('d1', 'b1', 'sp1')).toEqual({
        allowed: false,
        reason: 'bot_no_doc_access',
        role,
      })
    }
  })

  it('honours an explicit lower floor (per-capability floors, if ever needed)', async () => {
    db.getByDocId.mockResolvedValue({ doc_id: 'd1', owner_id: 'u-other', owner_space_id: 'sp1' })
    db.getRole.mockResolvedValue('commenter')
    expect(await resolveBotDocAccess('d1', 'b1', 'sp1', 'commenter')).toEqual({
      allowed: true,
      role: 'commenter',
    })
    // `commenter` ranks BETWEEN reader and writer even though it is STORED as 4 —
    // the compare must go through roleAtLeast, never the raw stored number.
    expect(await resolveBotDocAccess('d1', 'b1', 'sp1', 'writer')).toEqual({
      allowed: false,
      reason: 'bot_no_doc_access',
      role: 'commenter',
    })
    db.getRole.mockResolvedValue('reader')
    expect(await resolveBotDocAccess('d1', 'b1', 'sp1', 'commenter')).toEqual({
      allowed: false,
      reason: 'bot_no_doc_access',
      role: 'reader',
    })
  })

  it('refuses an empty docId/botUid without touching the DB', async () => {
    expect(await resolveBotDocAccess('', 'b1', 'sp1')).toEqual({
      allowed: false,
      reason: 'bot_no_doc_access',
      role: 'none',
    })
    expect(await resolveBotDocAccess('d1', '', 'sp1')).toEqual({
      allowed: false,
      reason: 'bot_no_doc_access',
      role: 'none',
    })
    expect(db.getByDocId).not.toHaveBeenCalled()
  })

  it('never throws — a failing read becomes an explicit refusal', async () => {
    db.getByDocId.mockRejectedValue(new Error('boom'))
    expect(await resolveBotDocAccess('d1', 'b1', 'sp1')).toEqual({
      allowed: false,
      reason: 'bot_doc_access_unavailable',
      role: 'none',
    })
  })
})

describe('reportBotMentions — multi-bot fan-out', () => {
  it('sends exactly ONE request per mentioned bot, each with its own key', async () => {
    vi.stubGlobal('fetch', fetchMock(resp(200, { accepted: true })))
    const r = await reportBotMentions(
      params({
        ownedBots: ['bot-1', 'bot-2', 'bot-3'],
        body: '@[user:bot-1:A] @[user:bot-2:B] @[user:bot-3:C]',
      }),
      { sleep: noSleep },
    )
    expect(r).toEqual({ accepted: 3, skipped: 0, failed: 0 })
    expect(fetch).toHaveBeenCalledTimes(3)
    const bodies = sentJson()
    expect(bodies.map((b) => b.bot_uid).sort()).toEqual(['bot-1', 'bot-2', 'bot-3'])
    expect(new Set(bodies.map((b) => b.idempotency_key)).size).toBe(3)
    // Same comment for all three: doc/comment/from stay identical.
    for (const b of bodies) {
      expect(b.doc_id).toBe('doc-1')
      expect(b.comment_id).toBe('42')
      expect(b.from_uid).toBe('u-human')
    }
  })

  it('a duplicate mention of one bot still yields exactly one request', async () => {
    vi.stubGlobal('fetch', fetchMock(resp(200, { accepted: true })))
    const r = await reportBotMentions(
      params({ body: '@[user:bot-1:A] again @[user:bot-1:A]' }),
      { sleep: noSleep },
    )
    expect(r.accepted).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('one bot failing does not prevent the others from being reported', async () => {
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call++
        return call === 1 ? resp(400) : resp(200, { accepted: true })
      }),
    )
    const r = await reportBotMentions(
      params({ ownedBots: ['bot-1', 'bot-2'], body: '@[user:bot-1:A] @[user:bot-2:B]' }),
      { sleep: noSleep },
    )
    expect(r).toEqual({ accepted: 1, skipped: 0, failed: 1 })
  })

  it('caps the fan-out at maxBotsPerComment', async () => {
    cfg.botMention.maxBotsPerComment = 2
    vi.stubGlobal('fetch', fetchMock(resp(200, { accepted: true })))
    const r = await reportBotMentions(
      params({
        ownedBots: ['bot-1', 'bot-2', 'bot-3', 'bot-4'],
        body: '@[user:bot-1:A] @[user:bot-2:B] @[user:bot-3:C] @[user:bot-4:D]',
      }),
      { sleep: noSleep },
    )
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(r.accepted).toBe(2)
  })
})

describe('request shape and the contract size caps', () => {
  it('POSTs to /v1/internal/bot-mentions with the X-Internal-Token header', async () => {
    vi.stubGlobal('fetch', fetchMock(resp(200, { accepted: true })))
    await reportBotMentions(params(), { sleep: noSleep })
    const [url, init] = (fetch as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock
      .calls[0]!
    expect(url).toBe('http://octo-server:8080/v1/internal/bot-mentions')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['X-Internal-Token']).toBe('bot-mention-token')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('carries an absolute https url and the space_id', async () => {
    vi.stubGlobal('fetch', fetchMock(resp(200, { accepted: true })))
    await reportBotMentions(params(), { sleep: noSleep })
    const body = sentJson()[0]!
    // upstream #170「remove space parameter from document URLs」起,文档 URL 不再带 ?sp= ——
    // buildDocShareUrl 的 spaceId 形参已标为忽略的 legacy(_spaceId)。
    // space 仍然单独放在 space_id 字段里传给 octo-server,信息没丢,只是不再塞进 URL。
    expect(body.url).toBe('https://docs.example.com/d/doc-1')
    expect(body.space_id).toBe('space-1')
  })

  it('absoluteHttpUrl omits anything that is not absolute http/https', () => {
    expect(absoluteHttpUrl('https://a/b')).toBe('https://a/b')
    expect(absoluteHttpUrl('http://a/b')).toBe('http://a/b')
    // The webOrigin-empty degrade of buildDocShareUrl is path-only => omitted.
    expect(absoluteHttpUrl('/d/doc-1?sp=space-1')).toBeUndefined()
    expect(absoluteHttpUrl('javascript:alert(1)')).toBeUndefined()
    expect(absoluteHttpUrl('ftp://host/x')).toBeUndefined()
    expect(absoluteHttpUrl('')).toBeUndefined()
    expect(absoluteHttpUrl('not a url')).toBeUndefined()
  })

  it('truncateUtf8 never splits a multi-byte character', () => {
    // '好' is 3 UTF-8 bytes; cutting at 4 must drop the second char entirely.
    expect(truncateUtf8('好好', 4)).toBe('好')
    expect(truncateUtf8('好好', 6)).toBe('好好')
    expect(truncateUtf8('好好', 2)).toBe('')
    // 4-byte emoji (surrogate pair) must not be halved.
    expect(truncateUtf8('🙂🙂', 5)).toBe('🙂')
    expect(truncateUtf8('abc', 10)).toBe('abc')
  })

  it('truncates text over the 10 KiB cap and still sends a valid request', async () => {
    vi.stubGlobal('fetch', fetchMock(resp(200, { accepted: true })))
    const body = '@[user:bot-1:A] ' + 'x'.repeat(40_000)
    const r = await reportBotMentions(params({ body }), { sleep: noSleep })
    expect(r.accepted).toBe(1)
    const sent = sentJson()[0]!
    expect(Buffer.byteLength(sent.text as string, 'utf8')).toBeLessThanOrEqual(10 * 1024)
    // Truncation keeps the prefix, so the mention token itself survives.
    expect(sent.text as string).toContain('@[user:bot-1:A]')
  })

  it('keeps a multi-byte body under the 10 KiB cap without corrupting characters', () => {
    const built = buildBotMentionRequest(params({ body: '@[user:bot-1:A]' + '好'.repeat(20_000) }), 'bot-1')
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(Buffer.byteLength(built.body.text, 'utf8')).toBeLessThanOrEqual(10 * 1024)
    expect(built.body.text).not.toContain('�') // no replacement char => no split
    expect(built.textTruncated).toBe(true)
  })

  it('keeps the WHOLE request under 32 KiB even when JSON escaping inflates the text', async () => {
    vi.stubGlobal('fetch', fetchMock(resp(200, { accepted: true })))
    // Control characters serialize as six chars each, so a 10 KiB run of them
    // would produce a ~60 KiB envelope without the proportional shrink.
    const body = '@[user:bot-1:A] ' + '\u0001'.repeat(30_000)
    const r = await reportBotMentions(params({ body }), { sleep: noSleep })
    expect(r.accepted).toBe(1)
    const raw = sentBodies()[0]!
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(32 * 1024)
    expect(Buffer.byteLength(JSON.parse(raw).text as string, 'utf8')).toBeLessThanOrEqual(10 * 1024)
  })

  it('reports nothing for an effectively empty body rather than sending empty text', () => {
    const built = buildBotMentionRequest(params({ body: '   ' }), 'bot-1')
    expect(built).toEqual({ ok: false, reason: 'empty_text' })
  })

  it('a request that cannot be shrunk under the cap is skipped, never sent over-cap', async () => {
    vi.stubGlobal('fetch', fetchMock(resp(200, { accepted: true })))
    // A doc id large enough that the envelope alone exceeds 32 KiB leaves no room
    // for any text; the report is dropped instead of earning a guaranteed 400.
    const r = await reportBotMentions(params({ docId: 'd'.repeat(40_000) }), { sleep: noSleep })
    expect(r).toEqual({ accepted: 0, skipped: 0, failed: 1 })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('security — logging never leaks secrets or comment text', () => {
  it('logs only diagnostic metadata on failure (no token, no text, no body)', async () => {
    vi.stubGlobal('fetch', fetchMock(resp(500)))
    const secret = 'SUPER-SECRET-SENTENCE-IN-THE-COMMENT'
    await reportBotMentions(
      params({ body: `@[user:bot-1:A] ${secret}` }),
      { sleep: noSleep },
    )
    const logged = [...warnSpy.mock.calls, ...errorSpy.mock.calls]
      .map((c) => JSON.stringify(c))
      .join('\n')
    expect(logged).not.toContain(secret)
    expect(logged).not.toContain('bot-mention-token')
    // ...while still carrying the ids an operator needs.
    expect(logged).toContain('doc-1')
    expect(logged).toContain('bot-1')
  })
})
