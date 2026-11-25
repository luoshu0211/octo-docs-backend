/**
 * Verified-or-skip recent-view write (remove-sp §7.1).
 *
 * Phase-1 decouples the "recent view" side effect from doc opening and stops
 * trusting an unverified viewer Space:
 *
 *   - Human: the write lands ONLY under a viewer Space whose ACTIVE membership
 *     is confirmed server-side (isSpaceMember). A missing header, a Space the
 *     caller is not a member of, or a membership lookup failure => SKIP the
 *     write (the doc still opens / the token is still issued). There is NO
 *     fallback to the document's home Space and NO trust of an arbitrary header.
 *   - Bot: unchanged — the server-resolved Space (verifyBot reverse lookup) is
 *     authoritative, so the write lands under it directly.
 *
 * Best-effort by contract: a write/lookup failure never propagates to the caller
 * (token issuance / open must not fail on a recent-view hiccup). Returns the
 * viewedAt AND the Space the row was actually written under, or null when the
 * write was skipped.
 *
 * The returned `spaceId` is authoritative for downstream mirrors (OCTO-456
 * §4.5: the Drive 最近访问 forward). The human principal Space and the viewer
 * Space are NOT the same thing — the caller's identity defaults to Space S1
 * while `X-Space-Id: S2` opens the doc — so a forward that used the principal
 * Space would write S2 history in docs but S1 history in Drive. Callers must
 * propagate this `spaceId`, never re-derive it.
 */
import { getOctoIdentity } from '../../auth/octoIdentity.js'
import { docViewHistoryRepo } from '../../db/repos/docViewHistoryRepo.js'
import { config } from '../../config/env.js'
import type { DocSpaceScope } from '../middleware/docSpaceScope.js'

export interface RecordRecentViewInput {
  /** Per-mount policy: bot writes under its resolved Space; human must verify. */
  scope: DocSpaceScope
  uid: string
  docId: string
  /** Human only: the UNVERIFIED viewer Space from X-Space-Id (trimmed, optional). */
  viewerSpaceId?: string
  /** Human session token, used to confirm viewer-Space membership. */
  token?: string
  /** Request-local proof produced by the mandatory Human current-Space verification. */
  verifiedViewerSpaceId?: string
}

async function writeRow(uid: string, docId: string, spaceId: string): Promise<Date> {
  return docViewHistoryRepo.upsertViewWithPrune({
    uid,
    docId,
    spaceId,
    retainCount: config.docView.retainCount,
    retainDays: config.docView.retainDays,
  })
}

export interface RecordedRecentView {
  viewedAt: Date
  /** The Space the recent-view row was actually written under (never a guess). */
  spaceId: string
}

export async function recordVerifiedRecentView(input: RecordRecentViewInput): Promise<RecordedRecentView | null> {
  const { scope, uid, docId } = input
  try {
    if (scope.mode === 'bot') {
      // Bot Space is server-resolved (anti-spoof); write directly under it.
      return { viewedAt: await writeRow(uid, docId, scope.spaceId), spaceId: scope.spaceId }
    }
    // Human: only a confirmed active member of the supplied viewer Space may
    // record history there — otherwise skip (no home-Space fallback, §7.1).
    const viewerSpaceId = typeof input.viewerSpaceId === 'string' ? input.viewerSpaceId.trim() : ''
    if (viewerSpaceId === '') return null
    const member = input.verifiedViewerSpaceId === viewerSpaceId
      || await getOctoIdentity().isSpaceMember(uid, viewerSpaceId, input.token ?? '').catch(() => false)
    if (!member) return null
    return { viewedAt: await writeRow(uid, docId, viewerSpaceId), spaceId: viewerSpaceId }
  } catch {
    // Best-effort: a recent-view write must never fail the open/token path.
    return null
  }
}
