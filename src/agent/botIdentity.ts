/**
 * Bot identity / permission seams for the @Bot entry points.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * A User Bot that is @-mentioned in a comment acts on the document with ITS OWN
 * token. docs-backend therefore validates the bot's OWN permission, exactly as it
 * would for a human: there is no "the bot borrows its owner's access" path and no
 * temporary ticket. Field evidence: a bot that was not a `doc_member` was
 * @-mentioned, accepted the turn, and only then failed its write with
 * `403 forbidden / bot lacks permission`. The user waited for a task that could
 * never succeed.
 *
 * So the gate belongs at the @ ENTRY POINT, not at the bot's first write. A bot
 * that cannot act on this document is never reported at all.
 *
 * ── Where the data lives ────────────────────────────────────────────────────
 * `doc_member` is docs-backend's OWN table (`octo_docs.doc_member`, PK
 * `(doc_id, uid)`), so this judgement is a local read — no cross-service call.
 * The bot's uid is an ordinary uid in that table, which is why `resolveRole`
 * (owner => admin, else the doc_member row, else none) answers it verbatim and is
 * reused here rather than re-implemented. Reusing it also picks up the case a
 * doc_member-only check would get WRONG: a bot that OWNS the document has no
 * doc_member row at all (owner is implicit admin), and bots do own documents —
 * see docMetaRepo.listForUser's `owner='me'` ownerSet = [uid, ...ownedBots].
 *
 * ── Deliberate fail-closed gap: share_scope ─────────────────────────────────
 * `resolveRole` returns the DIRECT role only; it does not merge the #64
 * share-derived role (`anyone_in_space`), because that requires knowing whether
 * the subject is a member of the Space, which `effectiveRole` takes from the
 * subject's OWN session token. We hold no token for the bot on this path, so a
 * share-derived role is unresolvable and we fail closed to the direct role. The
 * consequence is bounded and safe in the right direction: a bot with no
 * membership row on a doc shared `anyone_in_space` is NOT reported even though it
 * might have succeeded. Under-reporting costs the user one explicit share; the
 * opposite error costs them the silent 403 this gate exists to prevent.
 */
import { resolveRole } from '../permission/resolveRole.js'
import { roleAtLeast, type ResolvedRole } from '../permission/role.js'

/**
 * Minimum document role a mentioned bot must hold to be reported.
 *
 * DECISION: `writer` (the edit floor).
 *
 * 1. The failure this gate exists to stop is a write-path 403. The bot's primary
 *    action on accepting a turn is editing the body via `PATCH /:docId/content`,
 *    which requires `writer`. A `commenter` floor would admit exactly the bots
 *    that reach that endpoint and get refused — reproducing the bug.
 * 2. docs-backend cannot know at @-time WHICH action the bot will take (the
 *    mention carries comment text, not an action plan). With one floor for all
 *    turns, the only fail-closed choice is the highest one the turn may need.
 * 3. Symmetry: the acting human already needs `writer` to trigger a report
 *    (BOT_MENTION_MIN_ROLE in api/services/botMention.ts). Demanding less of the
 *    bot than of the human who summoned it would be incoherent.
 *
 * Known cost, accepted: a genuine "read/comment-only bot" — a bot held at
 * `reader`/`commenter` purely to answer in the thread — is NOT reportable. That
 * product mode needs a PER-CAPABILITY floor, which in turn needs the intended
 * action at @-time. Until that exists, silently relaxing the floor to `commenter`
 * would trade a loud "nothing happened" for the silent mid-flight 403 that this
 * change is undoing, so the floor stays at the edit level.
 */
export const BOT_DOC_ACCESS_MIN_ROLE: ResolvedRole = 'writer'

/**
 * Why a bot was refused, so an audit line distinguishes the refusal CLASSES
 * instead of collapsing them into one silent drop:
 *   bot_no_doc_access          — resolved fine, the bot's role is below the floor
 *                                (includes `none`: not a member of this doc)
 *   bot_doc_access_unavailable — the permission read itself FAILED (DB down, …).
 *                                Fail-closed: refuse, but say so distinctly, since
 *                                this is an infrastructure alarm and not a
 *                                statement about the bot's permission.
 */
export type BotDocAccessDenyReason = 'bot_no_doc_access' | 'bot_doc_access_unavailable'

export type BotDocAccess =
  | { allowed: true; role: ResolvedRole }
  | { allowed: false; reason: BotDocAccessDenyReason; role: ResolvedRole }

/**
 * Does `botUid` itself hold at least `minRole` on `docId`?
 *
 * NEVER THROWS — the callers are best-effort side channels that must not turn a
 * permission read failure into a user-visible error, so a failed read becomes an
 * explicit fail-closed refusal (`bot_doc_access_unavailable`) instead.
 */
export async function resolveBotDocAccess(
  docId: string,
  botUid: string,
  minRole: ResolvedRole = BOT_DOC_ACCESS_MIN_ROLE,
): Promise<BotDocAccess> {
  if (!docId || !botUid) return { allowed: false, reason: 'bot_no_doc_access', role: 'none' }
  let role: ResolvedRole
  try {
    // Owner => admin, else the (doc_id, uid) doc_member row, else none.
    role = await resolveRole(botUid, docId)
  } catch {
    // The error object is not returned or logged here: callers log metadata only,
    // and a DB error string can carry SQL/connection detail.
    return { allowed: false, reason: 'bot_doc_access_unavailable', role: 'none' }
  }
  // roleAtLeast, never a raw numeric compare: the STORED role value is not the
  // privilege ordinal (commenter is stored as 4 but ranks BETWEEN reader and
  // writer), so comparing stored numbers would be a privilege-escalation bug.
  if (!roleAtLeast(role, minRole)) return { allowed: false, reason: 'bot_no_doc_access', role }
  return { allowed: true, role }
}
