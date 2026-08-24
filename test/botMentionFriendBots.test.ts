import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The FRIEND-bot half of the @Bot relationship rule, end to end through
// reportBotMentions.
//
// Rule under test: a mention is reported when
//   (the bot is one the caller CREATED  OR  one the caller is FRIENDS with)
//   AND the bot itself holds writer+ on this document.
// The friend half comes from octoIdentity.listCallerBots (octo-server
// GET /v1/robot/my_bots). Everything is mocked — no MySQL, no network.
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

// docsNotify (whose mention parser this path reuses) and the doc-access gate
// (permission/resolveRole -> docMetaRepo + docMemberRepo) pull these in at import
// time. vi.hoisted so the handles exist before the mock factories run.
const db = vi.hoisted(() => ({ getRole: vi.fn(), getByDocId: vi.fn() }))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  ROLE_ADMIN: 3,
  docMemberRepo: { list: vi.fn(async () => []), getRole: db.getRole },
}))
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: { getByDocId: db.getByDocId },
}))

const identity = vi.hoisted(() => ({ listCallerBots: vi.fn() }))
vi.mock('../src/auth/octoIdentity.js', () => ({
  getOctoIdentity: () => ({
    getUser: vi.fn(async () => null),
    listCallerBots: identity.listCallerBots,
  }),
}))

import { reportBotMentions, type BotMentionParams } from '../src/api/services/botMention.js'

const noSleep = vi.fn(async (_ms: number) => {})
let warnSpy: ReturnType<typeof vi.spyOn>

function params(over: Partial<BotMentionParams> = {}): BotMentionParams {
  return {
    docId: 'doc-1',
    commentId: 42,
    spaceId: 'space-1',
    authorUid: 'u-human',
    authorRole: 'writer',
    // The author owns NO bot: every case below stands or falls on friendship.
    ownedBots: [],
    callerToken: 'caller-tok',
    body: 'please review @[user:bot-friend:Friend Bot]',
    ...over,
  }
}

/** One my_bots entry as octoIdentity surfaces it (uid + creatorUid). */
function friend(uid: string, creatorUid = 'u-other') {
  return { uid, creatorUid }
}

function fetchOk() {
  return vi.fn(async () => new Response(JSON.stringify({ accepted: true }), { status: 200 }))
}

function reportedBotUids(): string[] {
  return (fetch as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls.map(
    (c) => (JSON.parse(c[1].body as string) as { bot_uid: string }).bot_uid,
  )
}

beforeEach(() => {
  // Doc-access gate defaults: the doc exists, a third party owns it, and every uid
  // asked about is a `writer` member — so the doc half passes unless overridden.
  db.getByDocId.mockResolvedValue({ doc_id: 'doc-1', owner_id: 'u-someone' })
  db.getRole.mockResolvedValue('writer')
  identity.listCallerBots.mockReset()
  noSleep.mockClear()
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('friend bots are @-mentionable', () => {
  it('REPORTS a bot the caller did not create but IS friends with', async () => {
    // The gap this change closes: previously this mention parsed fine, matched
    // nothing, and the user got silence.
    identity.listCallerBots.mockResolvedValue([friend('bot-friend')])
    vi.stubGlobal('fetch', fetchOk())
    const r = await reportBotMentions(params(), { sleep: noSleep })
    expect(r).toEqual({ accepted: 1, skipped: 0, failed: 0 })
    expect(reportedBotUids()).toEqual(['bot-friend'])
  })

  it('asks octo-server with the CALLER\'s own uid, space and token', async () => {
    identity.listCallerBots.mockResolvedValue([friend('bot-friend')])
    vi.stubGlobal('fetch', fetchOk())
    await reportBotMentions(params(), { sleep: noSleep })
    expect(identity.listCallerBots).toHaveBeenCalledWith('u-human', 'space-1', 'caller-tok')
  })

  it('DOES NOT report a bot that is neither created by nor friends with the caller', async () => {
    identity.listCallerBots.mockResolvedValue([friend('some-other-bot')])
    vi.stubGlobal('fetch', fetchOk())
    const r = await reportBotMentions(params(), { sleep: noSleep })
    expect(r).toEqual({ accepted: 0, skipped: 0, failed: 0 })
    expect(fetch).not.toHaveBeenCalled()
    // Relationship is judged BEFORE any permission read.
    expect(db.getRole).not.toHaveBeenCalled()
  })

  it('reports owned AND friend bots from the same comment, in first-mention order', async () => {
    identity.listCallerBots.mockResolvedValue([friend('bot-friend')])
    vi.stubGlobal('fetch', fetchOk())
    const r = await reportBotMentions(
      params({
        ownedBots: ['bot-mine'],
        body: '@[user:bot-friend:F] @[user:bot-mine:M] @[user:u-bob:Bob]',
      }),
      { sleep: noSleep },
    )
    expect(r).toEqual({ accepted: 2, skipped: 0, failed: 0 })
    expect(reportedBotUids()).toEqual(['bot-friend', 'bot-mine'])
  })

  it('a friend bot whose creator is the caller themself is still fine (no double count)', async () => {
    // my_bots can legitimately contain a bot the caller also owns (you can be
    // friends with your own bot). The union must not report it twice.
    identity.listCallerBots.mockResolvedValue([friend('bot-mine', 'u-human')])
    vi.stubGlobal('fetch', fetchOk())
    const r = await reportBotMentions(
      params({ ownedBots: ['bot-mine'], body: '@[user:bot-mine:M]' }),
      { sleep: noSleep },
    )
    expect(r).toEqual({ accepted: 1, skipped: 0, failed: 0 })
    expect(reportedBotUids()).toEqual(['bot-mine'])
  })
})

describe('friend bots are ANDed with the document-permission gate', () => {
  it('a friend bot WITHOUT writer on this doc is NOT reported', async () => {
    // Being friends is the relationship half only; the bot's own doc_member row
    // still decides. This is the AND that must survive the widening.
    identity.listCallerBots.mockResolvedValue([friend('bot-friend')])
    db.getRole.mockResolvedValue('reader')
    vi.stubGlobal('fetch', fetchOk())
    const r = await reportBotMentions(params(), { sleep: noSleep })
    expect(r).toEqual({ accepted: 0, skipped: 1, failed: 0 })
    expect(fetch).not.toHaveBeenCalled()
    // Judged against the BOT's own uid on THIS doc.
    expect(db.getRole).toHaveBeenCalledWith('doc-1', 'bot-friend', 'space-1')
  })

  it('a friend bot is refused when the permission read itself fails (fail-closed)', async () => {
    identity.listCallerBots.mockResolvedValue([friend('bot-friend')])
    db.getRole.mockRejectedValue(new Error('ER_CON_COUNT_ERROR: too many connections'))
    vi.stubGlobal('fetch', fetchOk())
    expect(await reportBotMentions(params(), { sleep: noSleep })).toEqual({
      accepted: 0,
      skipped: 1,
      failed: 0,
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('the author still needs edit permission to summon a friend bot', async () => {
    identity.listCallerBots.mockResolvedValue([friend('bot-friend')])
    vi.stubGlobal('fetch', fetchOk())
    const r = await reportBotMentions(params({ authorRole: 'commenter' }), { sleep: noSleep })
    expect(r).toEqual({ accepted: 0, skipped: 0, failed: 0 })
    // The author gate runs first, so the friend lookup is not even attempted.
    expect(identity.listCallerBots).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('friend-bot lookup fails closed', () => {
  it('null (octo-server unavailable) => the friend-only bot is NOT reported', async () => {
    identity.listCallerBots.mockResolvedValue(null)
    vi.stubGlobal('fetch', fetchOk())
    const r = await reportBotMentions(params(), { sleep: noSleep })
    expect(r).toEqual({ accepted: 0, skipped: 0, failed: 0 })
    expect(fetch).not.toHaveBeenCalled()
    // Logged as an infrastructure signal, with metadata only — never the token.
    const line = warnSpy.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('friend-bot list unavailable'),
    )
    expect(line).toBeDefined()
    expect(JSON.stringify(line)).not.toContain('caller-tok')
  })

  it('null does NOT break the OWNED-bot route (it degrades to owned only)', async () => {
    identity.listCallerBots.mockResolvedValue(null)
    vi.stubGlobal('fetch', fetchOk())
    const r = await reportBotMentions(
      params({ ownedBots: ['bot-mine'], body: '@[user:bot-mine:M] @[user:bot-friend:F]' }),
      { sleep: noSleep },
    )
    expect(r).toEqual({ accepted: 1, skipped: 0, failed: 0 })
    expect(reportedBotUids()).toEqual(['bot-mine'])
  })

  it('a THROWING lookup can never fail the report (best-effort contract)', async () => {
    identity.listCallerBots.mockRejectedValue(new Error('boom'))
    vi.stubGlobal('fetch', fetchOk())
    await expect(reportBotMentions(params(), { sleep: noSleep })).resolves.toEqual({
      accepted: 0,
      skipped: 0,
      failed: 0,
    })
  })

  it('a missing caller token means the friend half cannot be confirmed', async () => {
    // octoIdentity itself short-circuits an empty token to null; assert the report
    // path forwards the empty token rather than inventing a service secret.
    identity.listCallerBots.mockResolvedValue(null)
    vi.stubGlobal('fetch', fetchOk())
    const r = await reportBotMentions(params({ callerToken: undefined }), { sleep: noSleep })
    expect(identity.listCallerBots).toHaveBeenCalledWith('u-human', 'space-1', '')
    expect(r).toEqual({ accepted: 0, skipped: 0, failed: 0 })
  })
})

describe('the friend-bot lookup costs at most ONE call per report', () => {
  it('ONE call even when the comment @s many unknown uids', async () => {
    identity.listCallerBots.mockResolvedValue([friend('bot-friend')])
    vi.stubGlobal('fetch', fetchOk())
    const body = ['a', 'b', 'c', 'd', 'e', 'f']
      .map((u) => `@[user:u-${u}:${u}]`)
      .concat('@[user:bot-friend:F]')
      .join(' ')
    const r = await reportBotMentions(params({ body }), { sleep: noSleep })
    expect(r).toEqual({ accepted: 1, skipped: 0, failed: 0 })
    // Not per mentioned uid, and not per candidate bot: exactly one.
    expect(identity.listCallerBots).toHaveBeenCalledTimes(1)
  })

  it('ONE call even when several friend bots are mentioned', async () => {
    identity.listCallerBots.mockResolvedValue([friend('bot-a'), friend('bot-b'), friend('bot-c')])
    vi.stubGlobal('fetch', fetchOk())
    const r = await reportBotMentions(
      params({ body: '@[user:bot-a:A] @[user:bot-b:B] @[user:bot-c:C]' }),
      { sleep: noSleep },
    )
    expect(r).toEqual({ accepted: 3, skipped: 0, failed: 0 })
    expect(identity.listCallerBots).toHaveBeenCalledTimes(1)
  })

  it('NO call at all when every mentioned uid is already an owned bot', async () => {
    // The free source answers the question, so the paid one is never consulted.
    vi.stubGlobal('fetch', fetchOk())
    const r = await reportBotMentions(
      params({ ownedBots: ['bot-mine'], body: '@[user:bot-mine:M]' }),
      { sleep: noSleep },
    )
    expect(r).toEqual({ accepted: 1, skipped: 0, failed: 0 })
    expect(identity.listCallerBots).not.toHaveBeenCalled()
  })

  it('NO call when the comment mentions nobody', async () => {
    vi.stubGlobal('fetch', fetchOk())
    const r = await reportBotMentions(params({ body: 'no mentions here' }), { sleep: noSleep })
    expect(r).toEqual({ accepted: 0, skipped: 0, failed: 0 })
    expect(identity.listCallerBots).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('NO call when the bot-mention feature is unconfigured', async () => {
    const cfg = (await import('../src/config/env.js')).config as unknown as {
      botMention: { token: string }
    }
    const saved = cfg.botMention.token
    cfg.botMention.token = ''
    try {
      vi.stubGlobal('fetch', fetchOk())
      expect(await reportBotMentions(params(), { sleep: noSleep })).toEqual({
        accepted: 0,
        skipped: 0,
        failed: 0,
      })
      expect(identity.listCallerBots).not.toHaveBeenCalled()
    } finally {
      cfg.botMention.token = saved
    }
  })

  it('the friend lookup stays INSIDE the fan-out cap protection', async () => {
    // The cap bounds the per-bot DB reads and HTTP fan-out; the friend lookup is a
    // single call that happens before them, so a comment @ing many friend bots
    // still costs 1 lookup + `cap` permission reads.
    const cfg = (await import('../src/config/env.js')).config as unknown as {
      botMention: { maxBotsPerComment: number }
    }
    const saved = cfg.botMention.maxBotsPerComment
    cfg.botMention.maxBotsPerComment = 2
    try {
      const uids = ['bot-1', 'bot-2', 'bot-3', 'bot-4']
      identity.listCallerBots.mockResolvedValue(uids.map((u) => friend(u)))
      vi.stubGlobal('fetch', fetchOk())
      await reportBotMentions(
        params({ body: uids.map((u) => `@[user:${u}:${u}]`).join(' ') }),
        { sleep: noSleep },
      )
      expect(identity.listCallerBots).toHaveBeenCalledTimes(1)
      expect(db.getRole).toHaveBeenCalledTimes(2)
      expect(reportedBotUids()).toEqual(['bot-1', 'bot-2'])
    } finally {
      cfg.botMention.maxBotsPerComment = saved
    }
  })
})

describe('a malformed my_bots list cannot widen the candidate set', () => {
  it('an entry with no uid contributes no candidate', async () => {
    // octoIdentity already drops malformed rows; this pins that a list which
    // contains ONLY malformed rows reports nothing.
    identity.listCallerBots.mockResolvedValue([])
    vi.stubGlobal('fetch', fetchOk())
    expect(await reportBotMentions(params(), { sleep: noSleep })).toEqual({
      accepted: 0,
      skipped: 0,
      failed: 0,
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('the mentioned uid must MATCH a listed bot uid exactly (no prefix/suffix match)', async () => {
    identity.listCallerBots.mockResolvedValue([friend('bot-friend-2')])
    vi.stubGlobal('fetch', fetchOk())
    expect(await reportBotMentions(params(), { sleep: noSleep })).toEqual({
      accepted: 0,
      skipped: 0,
      failed: 0,
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})
