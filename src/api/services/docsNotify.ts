/**
 * Docs notification via octo-server's internal notify API (docs-notify producer,
 * octo-server PR #584 — see .octospec/tasks/card-message-internal-dispatch/
 * docs-notify-contract.md in octo-server).
 *
 * When a doc access request is submitted, docs-backend POSTs a STRUCTURED
 * `docs_card` (raw fields only — no hand-built type-17 map, no template, no text
 * fallback) to `POST /v1/internal/notify`. octo-server authors the octo/v1 card
 * (attribution copy, deep-link, i18n; approve/deny buttons when request_id is set
 * and OCTO_DOCS_APPROVAL_CARD_ENABLED is on) and delivers it as a DM from the
 * shared notification bot, then returns `{delivered, filtered}`. Auth is the
 * docs-specific `X-Internal-Token: <OCTO_DOCS_NOTIFY_TOKEN>`, NOT a bot token.
 *
 * Contract invariants honoured here:
 *   - ONE recipient per request (`targets` single-element). We resolve the doc's
 *     approvers (owner + admins) and fan out one POST each.
 *   - Only `docs_card` is sent (never `payload`/`card`), and we never build a
 *     type-17 map — server rejects that (Decision 14).
 *   - Best-effort. Fired-and-forgotten from the submit route AFTER the request
 *     row is persisted; never throws back into it. The pull-based pending list
 *     remains the source of truth if a push fails.
 *   - Gated. If OCTO_DOCS_NOTIFY_TOKEN is unset the whole path is a silent no-op.
 */
import { config } from '../../config/env.js'
import { getOctoIdentity } from '../../auth/octoIdentity.js'
import { docMemberRepo } from '../../db/repos/docMemberRepo.js'
import { docMetaRepo } from '../../db/repos/docMetaRepo.js'
import { docAccessNotifyCardRepo, type NotifyCardCoord } from '../../db/repos/docAccessNotifyCardRepo.js'
import { ROLE_ADMIN, roleFromNumber } from '../../permission/role.js'
import { formatCardTimestamp } from '../../util/cardTime.js'
import { SHARE_SCOPE_ANYONE, SHARE_SCOPE_AUTHENTICATED } from '../../permission/shareScope.js'

const INTERNAL_NOTIFY_PATH = '/v1/internal/notify'
const INTERNAL_TOKEN_HEADER = 'X-Internal-Token'
const KIND_ACCESS_REQUESTED = 'access_requested'
const KIND_COMMENTED = 'commented'
/** Abort a single notify POST after this long so a hung octo-server can't pin
 *  the best-effort call open. Comfortably above a healthy server's p99. */
const NOTIFY_TIMEOUT_MS = 5000
/**
 * Hard cap on mention recipients notified per comment (P1 fan-out guard). A ≤1MB
 * comment body could otherwise carry tens of thousands of unique `@[user:id:]`
 * tokens, each firing a concurrent POST at octo-server. Beyond this the extras
 * are dropped + logged; a real comment never legitimately @s this many people.
 */
const MAX_MENTION_RECIPIENTS = 50
/** Bounded concurrency for the notify fan-out so we never open N sockets at once. */
const NOTIFY_CONCURRENCY = 8

/**
 * Inline mention token embedded in a comment body by octo-web: `@[type:id:label]`
 * (see octo-web packages/docs/src/mentions/source.ts). `type` is 'user' | 'doc';
 * only 'user' mentions are notified. Kept in sync with the frontend MENTION_TOKEN_RE.
 *
 * The id and label segments carry BOUNDED quantifiers ({1,128} / {0,256}) rather
 * than open-ended `+`/`*`. The comment body is attacker-controllable (any reader
 * can comment), and an unbounded trailing `[^\]]*` on an unanchored /g scan lets a
 * malformed run like `@[doc:9:\\\\…` (no closing `]`) backtrack to end-of-string
 * from every start position — O(n²) polynomial ReDoS (CodeQL js/polynomial-redos).
 * A real uid/display-name never approaches these caps, so matching is unchanged;
 * over-long tokens simply fail to match (and would never be legitimate mentions).
 */
const MENTION_TOKEN_RE = /@\[(user|doc):([^:\]]{1,128}):([^\]]{0,256})\]/g

/** Unique user uids @-mentioned in a body, excluding the author (never self-notify). */
export function mentionedUserUids(body: string, excludeUid: string): string[] {
  const set = new Set<string>()
  for (const m of body.matchAll(MENTION_TOKEN_RE)) {
    if (m[1] === 'user' && m[2] && m[2] !== excludeUid) set.add(m[2])
  }
  return [...set]
}

/** Body → human-readable excerpt: mention tokens collapse to `@label`; capped for the card. */
function toExcerpt(body: string): string {
  const text = body.replace(MENTION_TOKEN_RE, (_all, _type, _id, label: string) => `@${label}`)
  return text.length > 300 ? text.slice(0, 300) : text
}

/** octo-server DocsCardFields (raw fields only; server owns copy/layout/link). */
interface DocsCardBody {
  doc_id: string
  /** Required by access_requested v2; the docs-domain idempotency/CAS key. When
   *  present (+ OCTO_DOCS_APPROVAL_CARD_ENABLED on the server) the card renders
   *  approve/deny buttons instead of the plain 查看详情 link. */
  request_id: string
  kind: string
  title: string
  /** The uid of the actor (requester / comment author). octo-server resolves the
   *  display name from this uid server-side; actor_name is a client-side fallback. */
  actor_uid: string
  actor_name: string
  /** Free-text reason only. Requested Bots are carried separately. */
  excerpt: string
  requester_space_name?: string
  requested_bot_names?: string[]
  requested_role?: 'reader' | 'commenter' | 'writer' | 'admin'
  updated_at: string
}

/** octo-server DeliveredCard: IM coordinates of one delivered card. message_id
 *  is a decimal STRING (int64 exceeds JS safe-integer range). */
interface DeliveredCard {
  uid: string
  channel_id: string
  channel_type: number
  message_id: string
  client_msg_no: string
}

/** octo-server NotifyResp. delivered_cards is additive (docs-card path only). */
interface NotifyResp {
  delivered: string[]
  filtered: Record<string, string>
  delivered_cards?: DeliveredCard[]
}

export interface AccessRequestNotifyParams {
  docId: string
  /** The access request row id — carried as request_id (approval CAS key). */
  requestId: string
  spaceId: string
  ownerId: string
  /** Space-qualified owner principal. Normally the document's Home Space. */
  ownerSpaceId: string
  title: string
  /** The uid that submitted the request (used as actor). */
  requesterUid: string
  /** Verified Space of the requester principal. Self-exclusion compares uid + Space. */
  requesterSpaceId: string
  /** Free-text reason (already trimmed/capped at 512 by the caller). */
  reason: string
  /** Server-validated requested permission role. */
  requestedRole: 'reader' | 'commenter' | 'writer' | 'admin'
  /** Server-validated bot principals that approval will grant. */
  botUids: string[]
  /** Requester's session token, used only for best-effort Space/Bot display lookup. */
  requesterToken?: string
}

function takeRunes(value: string, limit: number): string {
  return [...value].slice(0, Math.max(0, limit)).join('')
}

async function resolveAccessRequestDisplayContext(
  requesterSpaceId: string,
  botUids: string[],
  requesterToken: string,
): Promise<{ requesterSpaceName: string; requestedBotNames: string[] }> {
  const identity = getOctoIdentity()
  const [spaceName, spaceBots] = await Promise.all([
    typeof identity.getSpaceName === 'function'
      ? identity.getSpaceName(requesterSpaceId, requesterToken).catch(() => '')
      : Promise.resolve(''),
    typeof identity.spaceBots === 'function'
      ? identity.spaceBots(requesterSpaceId, requesterToken).catch(() => null)
      : Promise.resolve(null),
  ])
  const namesByUid = new Map((spaceBots ?? []).map((bot) => [bot.uid, bot.name ?? '']))
  const requestedBotNames = await Promise.all(botUids.map(async (uid) => {
    const fromDirectory = namesByUid.get(uid)?.trim()
    if (fromDirectory) return takeRunes(fromDirectory, 120)
    try {
      const user = await identity.getUser(uid, requesterToken)
      const name = user?.name?.trim()
      return takeRunes(name || uid, 120)
    } catch {
      return takeRunes(uid, 120)
    }
  }))
  return {
    requesterSpaceName: takeRunes(spaceName.trim() || requesterSpaceId, 200),
    requestedBotNames,
  }
}

/**
 * Resolve the doc's approvers = owner + all admins.
 *
 * Authorization principals are Space-qualified: `(uid, principalSpaceId)`. Only
 * the exact requester principal is excluded. The same Octo uid in another Space
 * remains a valid approver (for example, test-Space owner `admin` approving a
 * request from 123-Space `admin`). Delivery is addressed by uid but scoped by
 * Space, so distinct qualifying principals must remain distinct deliveries.
 */
interface NotifyRecipient {
  uid: string
  principalSpaceId: string
}

async function resolveApprovers(
  docId: string,
  owner: NotifyRecipient,
  requester: NotifyRecipient,
): Promise<NotifyRecipient[]> {
  const members = await docMemberRepo.list(docId)
  const principals = new Map<string, NotifyRecipient>()
  const add = (principal: NotifyRecipient) => {
    if (principal.uid && principal.principalSpaceId) {
      principals.set(`${principal.principalSpaceId}\u0000${principal.uid}`, principal)
    }
  }
  add(owner)
  for (const member of members) {
    if (Number(member.role) === ROLE_ADMIN) {
      add({ uid: member.uid, principalSpaceId: member.principal_space_id })
    }
  }

  principals.delete(`${requester.principalSpaceId}\u0000${requester.uid}`)

  return [...principals.values()]
}

async function resolveMentionReaders(docId: string, principalSpaceId: string, targets: string[]): Promise<Set<string> | null> {
  const meta = await docMetaRepo.getByDocId(docId)
  if (!meta || meta.status === 0) return null
  if (meta.share_scope === SHARE_SCOPE_AUTHENTICATED ||
      (meta.share_scope === SHARE_SCOPE_ANYONE && principalSpaceId === meta.space_id)) return new Set(targets)
  const members = await docMemberRepo.list(docId)
  const readers = new Set<string>()
  if (meta.owner_id && meta.owner_space_id === principalSpaceId) readers.add(meta.owner_id)
  for (const member of members) {
    if (member.principal_space_id === principalSpaceId && roleFromNumber(Number(member.role))) readers.add(member.uid)
  }
  return readers
}

/**
 * Run `task` over `items` with bounded concurrency so a large recipient list
 * never opens all sockets at once (P1). Preserves best-effort semantics — each
 * task is expected to resolve (postNotify never rejects).
 */
async function mapWithConcurrency<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      results[i] = await task(items[i]!)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * POST one docs_card notification to a single recipient. Returns whether the
 * server confirmed delivery (for the delivered count — unchanged contract) and,
 * separately, the delivered card's coordinates for persistence when the response
 * carries a locator (absent on the text-fallback path).
 */
async function postNotify(
  spaceId: string,
  recipientUid: string,
  docsCard: DocsCardBody,
  internalToken: string,
): Promise<{ delivered: boolean; card: NotifyCardCoord | null }> {
  const url = `${config.octoIdentity.serverBaseUrl}${INTERNAL_NOTIFY_PATH}`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), NOTIFY_TIMEOUT_MS)
  try {
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'Content-Type': 'application/json',
          [INTERNAL_TOKEN_HEADER]: internalToken,
        },
        body: JSON.stringify({
          space_id: spaceId,
          service: config.notify.service,
          targets: [recipientUid], // contract: single recipient per request
          actor_uid: '',
          docs_card: docsCard,
        }),
      })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[octo-docs] docs-notify send failed (network)', { recipientUid, err: String(err) })
      return { delivered: false, card: null }
    }
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.error('[octo-docs] docs-notify rejected', { recipientUid, status: res.status })
      return { delivered: false, card: null }
    }
    // Only `delivered[]` counts as truly sent; `filtered` entries (not_space_member
    // / busy / dispatch_failed / …) are the caller's to retry per business rules.
    // The body read stays inside the AbortController window so a trickled/hung
    // response body is bounded by the same NOTIFY_TIMEOUT_MS, not just connect.
    const body = (await res.json().catch(() => null)) as NotifyResp | null
    if (!body || !Array.isArray(body.delivered) || !body.delivered.includes(recipientUid)) {
      return { delivered: false, card: null }
    }
    // Locate this recipient's card coordinates for later in-place mutation. A
    // text-fallback delivery carries no card locator → delivered, but nothing to
    // persist. Delivery status is independent of the locator's presence so the
    // delivered count is unchanged from before.
    const found = body.delivered_cards?.find((c) => c.uid === recipientUid)
    const card: NotifyCardCoord | null = found
      ? {
          recipientUid,
          deliverySpaceId: spaceId,
          channelId: found.channel_id,
          channelType: found.channel_type,
          messageId: found.message_id,
          clientMsgNo: found.client_msg_no,
        }
      : null
    return { delivered: true, card }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Notify the doc's owner+admins that a member requested access. Best-effort and
 * self-contained: resolves approvers, resolves the requester's display name once,
 * and fans out one POST per recipient. NEVER throws — all failures are logged and
 * swallowed so the submit route's 201 is unaffected. Returns the number of cards
 * actually delivered (for tests/metrics).
 */
export async function notifyDocAccessRequested(p: AccessRequestNotifyParams): Promise<number> {
  const { docsToken } = config.notify
  if (!docsToken) {
    // Outbound notify not configured — the pull-based pending list still works.
    return 0
  }

  try {
    const approvers = await resolveApprovers(
      p.docId,
      { uid: p.ownerId, principalSpaceId: p.ownerSpaceId },
      { uid: p.requesterUid, principalSpaceId: p.requesterSpaceId },
    )
    if (approvers.length === 0) return 0

    // Requester display name for the "X 申请访问" attribution; empty is allowed
    // (octo-server falls back to 有人/Someone). getUser never throws — it returns
    // null on any lookup failure, including when no service token is configured.
    let actorName = ''
    try {
      const user = await getOctoIdentity().getUser(p.requesterUid)
      actorName = user?.name ?? ''
    } catch {
      actorName = ''
    }

    const displayContext = await resolveAccessRequestDisplayContext(
      p.requesterSpaceId,
      p.botUids,
      p.requesterToken ?? '',
    )
    const docsCard: DocsCardBody = {
      doc_id: p.docId,
      request_id: p.requestId,
      kind: KIND_ACCESS_REQUESTED,
      title: p.title,
      actor_uid: p.requesterUid,
      actor_name: actorName,
      excerpt: takeRunes(p.reason.trim(), 300),
      requester_space_name: displayContext.requesterSpaceName,
      requested_bot_names: displayContext.requestedBotNames,
      requested_role: p.requestedRole,
      updated_at: formatCardTimestamp(new Date()),
    }

    const results = await Promise.all(
      approvers.map((recipient) =>
        postNotify(recipient.principalSpaceId, recipient.uid, docsCard, docsToken),
      ),
    )
    // Persist the delivered cards' coordinates so a later approve/deny can locate
    // and terminalize every approver's card. Best-effort: a persistence failure
    // must not affect the submit 201 or the delivered count (the pull-based flow
    // stays authoritative). Keyed by request_id; the requester is already excluded
    // from `approvers`, so no self-card is recorded.
    const cards = results
      .map((r) => r.card)
      .filter((c): c is NotifyCardCoord => c !== null)
    if (cards.length > 0) {
      try {
        await docAccessNotifyCardRepo.record(p.requestId, cards)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[octo-docs] docs-notify card ledger persist failed', {
          requestId: p.requestId,
          err: String(err),
        })
      }
    }
    // Return the delivered count (unchanged contract): a delivery still counts
    // even when it carried no card locator (text fallback) and thus no ledger row.
    return results.filter((r) => r.delivered).length
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[octo-docs] docs-notify access-request failed', { docId: p.docId, err: String(err) })
    return 0
  }
}

export interface MentionNotifyParams {
  docId: string
  spaceId: string
  principalSpaceId: string
  title: string
  /** The comment author — used as the actor and excluded from recipients (no self-notify). */
  authorUid: string
  /** The comment body (with `@[user:id:label]` tokens). */
  body: string
}

/**
 * Notify each user @-mentioned in a freshly-created comment. Best-effort, self-contained, and
 * NEVER throws — mirrors notifyDocAccessRequested so the 201 create response is unaffected. Uses
 * the docs-notify `commented` card kind (octo-server #584): server owns the "X 在评论中提到你"
 * attribution / layout / deep-link; we send only raw fields. Returns the delivered count.
 */
export async function notifyDocMentioned(p: MentionNotifyParams): Promise<number> {
  const { docsToken } = config.notify

  try {
    const mentioned = mentionedUserUids(p.body, p.authorUid)
    if (mentioned.length === 0) return 0
    if (!docsToken || !p.principalSpaceId) return 0

    // P1: cap the fan-out so a token-stuffed body can't trigger unbounded POSTs.
    let targets = mentioned
    if (targets.length > MAX_MENTION_RECIPIENTS) {
      // eslint-disable-next-line no-console
      console.warn('[octo-docs] docs-notify mention recipients capped', {
        docId: p.docId,
        requested: targets.length,
        cap: MAX_MENTION_RECIPIENTS,
      })
      targets = targets.slice(0, MAX_MENTION_RECIPIENTS)
    }

    const readers = await resolveMentionReaders(p.docId, p.principalSpaceId, targets)
    if (!readers) return 0

    let actorName = ''
    try {
      const user = await getOctoIdentity().getUser(p.authorUid)
      actorName = user?.name ?? ''
    } catch {
      actorName = ''
    }

    const redactedCard: DocsCardBody = {
      doc_id: p.docId,
      request_id: '', // commented kind: no approval CAS key
      kind: KIND_COMMENTED,
      title: '你在一篇文档中被提及',
      actor_uid: p.authorUid,
      actor_name: actorName,
      excerpt: '你暂时没有访问权限，打开文档后可申请访问。',
      updated_at: formatCardTimestamp(new Date()),
    }
    const readableCard: DocsCardBody = {
      ...redactedCard,
      title: p.title.trim() || '无标题文档',
      excerpt: toExcerpt(p.body),
    }

    // P1: bounded concurrency instead of Promise.all over the whole list.
    const results = await mapWithConcurrency(targets, NOTIFY_CONCURRENCY, (uid) =>
      postNotify(p.principalSpaceId, uid, readers.has(uid) ? readableCard : redactedCard, docsToken),
    )
    // commented kind has no request_id, so no card ledger is kept; only the
    // delivered count matters here (postNotify now returns {delivered, card}).
    return results.filter((r) => r.delivered).length
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[octo-docs] docs-notify mention failed', { docId: p.docId, err: String(err) })
    return 0
  }
}
