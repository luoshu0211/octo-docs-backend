/**
 * Access-decision card sync (task docs-access-decision-card-sync).
 *
 * When an access request is approved/denied, drive EVERY approver's notification
 * card to a terminal state — not just the one the decider clicked. octo-server's
 * DocsActionFinalizer already terminalizes the clicked card; this closes the gap
 * for the sibling cards other approvers still hold.
 *
 * Primary path: in-place edit each sibling card via octo-server
 * POST /v1/internal/cards/mutate (server renders the SAME terminal card as the
 * finalizer, byte-identical). The mutate carries the AUTHORITATIVE decider
 * identity by id — `decider_uid` / `decider_space_id` / `decided_at` (unix
 * seconds) — and octo-server resolves the operator's name and Space label itself.
 * docs-backend resolves no user/Space profiles here.
 *
 * Fallback: NONE. A failed mutate leaves the original (still-actionable) card in
 * place and is logged; docs does NOT mint a second terminal card, so a decision
 * can never fan out duplicate outcome cards to a requester.
 *
 * INVARIANTS (spec §Invariants):
 *   - Called only AFTER doc_access_request.decide() commits the transition, so a
 *     card can never show a terminal state while the row is still pending.
 *   - Best-effort: never throws; all failures are logged and swallowed so the
 *     decision's HTTP response and the grant are unaffected.
 *   - The 409 not_pending guard on approve/deny stays the authoritative safety
 *     net; this sync is an enhancement, not the sole protection.
 *   - On the card-callback path the decider's clicked card is terminalized by
 *     octo-server's finalizer, so it is skipped here. On the REST path there is
 *     no finalizer, so the decider is an approver holding a live card and IS
 *     terminalized here too (deciderCardHandledExternally distinguishes them).
 */
import { config } from '../../config/env.js'
import {
  docAccessNotifyCardRepo,
  type DocAccessNotifyCardRow,
} from '../../db/repos/docAccessNotifyCardRepo.js'

const INTERNAL_MUTATE_PATH = '/v1/internal/cards/mutate'
const INTERNAL_TOKEN_HEADER = 'X-Internal-Token'
const KIND_ACCESS_GRANTED = 'access_granted'
const KIND_ACCESS_DENIED = 'access_denied'
/** Bound each best-effort POST so a hung octo-server can't pin the sync open. */
const SYNC_TIMEOUT_MS = 5000

export interface DecisionCardSyncParams {
  requestId: string
  /** Document origin/home Space. Kept for call-site clarity; never used for delivery. */
  spaceId: string
  docId: string
  title: string
  /** The admin who approved/denied (authoritative `decided_by`). */
  deciderUid: string
  /**
   * Whether the decider's own card was already terminalized by an external actor
   * (octo-server's DocsActionFinalizer on the card-callback path). When true, the
   * exact `(deciderUid, clickedCardSpaceId)` row is skipped to avoid a double
   * mutate; another card for that uid in another Space remains a sibling. When false/omitted
   * (the REST decision path — manage-members panel — where no finalizer runs), the
   * decider IS an approver and holds a live card, so it must be terminalized here
   * too, otherwise their own card stays actionable after they decide.
   */
  deciderCardHandledExternally?: boolean
  /** Delivery Space of the exact card clicked and finalized by octo-server. */
  clickedCardSpaceId?: string
  denied: boolean
  /** Reviewer deny reason surfaced on the terminal card; empty on approve. */
  denyReason?: string
  /**
   * The decider's authoritative trusted Space (persisted `decided_by_space_id`).
   * Forwarded by id so octo-server renders the Space label itself. Omitted/empty
   * => octo-server renders without a Space (never a guessed one).
   */
  deciderSpaceId?: string
  /**
   * The authoritative decision time (unix SECONDS) — the same value the decider's
   * own card renders, so every card shows one time. Omitted => octo-server keeps
   * its own copy rather than docs stamping a sync-time clock.
   */
  decidedAtSeconds?: number
}

/** POST helper with a bounded timeout. Returns the Response or null on network error. */
async function postJson(path: string, token: string, body: unknown): Promise<Response | null> {
  const url = `${config.octoIdentity.serverBaseUrl}${path}`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), SYNC_TIMEOUT_MS)
  try {
    return await fetch(url, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'Content-Type': 'application/json',
        [INTERNAL_TOKEN_HEADER]: token,
      },
      body: JSON.stringify(body),
    })
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** In-place mutate one sibling card to terminal. Returns true when applied. */
async function mutateOneCard(
  p: DecisionCardSyncParams,
  kind: string,
  card: DocAccessNotifyCardRow,
  token: string,
): Promise<boolean> {
  const res = await postJson(INTERNAL_MUTATE_PATH, token, {
    // Mutation routing is the card's delivery Space, not document origin Space
    // and not necessarily the decider's trusted operator Space.
    space_id: card.delivery_space_id,
    channel_id: card.channel_id,
    channel_type: card.channel_type,
    message_id: card.message_id,
    kind,
    doc_id: p.docId,
    title: p.title,
    deny_reason: p.denied ? (p.denyReason ?? '') : '',
    // Authoritative decider identity/time by id — octo-server resolves the
    // display name and Space label. An empty Space / undefined time simply omits
    // that hint; octo-server never receives a guessed value.
    decider_uid: p.deciderUid,
    decider_space_id: p.deciderSpaceId ?? '',
    ...(p.decidedAtSeconds !== undefined ? { decided_at: p.decidedAtSeconds } : {}),
  })
  return res !== null && res.ok
}

/**
 * Drive all sibling approver cards for a decided request to terminal. Best-effort
 * and never throws — safe to fire-and-forget from the decision route.
 */
export async function syncDecisionCards(p: DecisionCardSyncParams): Promise<void> {
  const { docsToken } = config.notify
  if (!docsToken) return // outbound notify not configured — nothing to sync

  try {
    const kind = p.denied ? KIND_ACCESS_DENIED : KIND_ACCESS_GRANTED
    const cards = await docAccessNotifyCardRepo.listByRequest(p.requestId)
    // On the card-callback path octo-server's finalizer already terminalized the
    // decider's clicked card, so skip that exact delivery principal here. On the
    // REST path (manage-members panel) there is no finalizer, so the decider —
    // who is an approver holding a live card — must be terminalized too.
    const siblings = p.deciderCardHandledExternally
      ? cards.filter((c) => !(
          c.recipient_uid === p.deciderUid &&
          c.delivery_space_id === p.clickedCardSpaceId
        ))
      : cards
    if (siblings.length === 0) return

    await Promise.all(
      siblings.map(async (card) => {
        try {
          const applied = await mutateOneCard(p, kind, card, docsToken)
          if (!applied) {
            // Do not create a second terminal card. The original card remains
            // authoritative; mutation failures are observable and retryable.
            // eslint-disable-next-line no-console
            console.error('[octo-docs] decision card mutate was not applied', {
              requestId: p.requestId,
              recipientUid: card.recipient_uid,
            })
            return
          }
          // Best-effort audit; a failure here is harmless.
          await docAccessNotifyCardRepo
            .markTerminalized(p.requestId, card.recipient_uid, card.delivery_space_id)
            .catch(() => {})
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[octo-docs] decision card sync failed for one card', {
            requestId: p.requestId,
            err: String(err),
          })
        }
      }),
    )
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[octo-docs] decision card sync failed', { requestId: p.requestId, err: String(err) })
  }
}
