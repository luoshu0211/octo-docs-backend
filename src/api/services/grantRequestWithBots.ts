/**
 * Grant an approved access request to the requester AND their carried Space-bot
 * snapshot, via the shared only-up max-merge path (grantForwardAccess).
 *
 * Boundary: the requester grant is the primary op and its failure propagates
 * (the caller's 503 path owns it). Each carried bot is granted INDEPENDENTLY in
 * a per-item try/catch — a single bot failure is isolated and never fails the
 * approval; we return { succeeded, failed } so the caller
 * can report the partial outcome. No cross-bot transaction/rollback (grants are
 * additive + idempotent, so a replay re-grants nothing). Zero bots => the loop
 * is empty and only the human is granted (legacy single-grant behavior).
 */
import { grantForwardAccess } from './grantForward.js'
import { logBotGrantFailure } from './botGrantAudit.js'

export interface GrantWithBotsParams {
  docId: string
  requestId: string
  documentName: string
  /** The human requester's uid. */
  uid: string
  /** Verified current Space shared by the requester and every carried Bot. */
  principalSpaceId: string
  /** Human role number (1=reader, 2=writer, 3=admin, 4=commenter). */
  roleNum: number
  /** Optional Bot role; omitted preserves the legacy unified-role behavior. */
  botRoleNum?: number
  /** Access-request approvals explicitly permit human admin; unrelated forward grants do not. */
  allowAdmin?: boolean
  /** Access-request approvals explicitly permit Bot admin independently. */
  allowBotAdmin?: boolean
  grantedBy: string
  /** Already-normalized, already-admissible bot uids (the stored snapshot). */
  botUids: string[] | undefined
}

export interface GrantWithBotsResult {
  /** The human requester's effective role after the (idempotent) grant. */
  requesterRole: string
  /** Bot uids that were granted (or were already >= target: idempotent success). */
  botsSucceeded: string[]
  /** Bot uids whose grant threw; the approval still stands. */
  botsFailed: string[]
}

export async function grantRequestWithBots(
  params: GrantWithBotsParams,
): Promise<GrantWithBotsResult> {
  // Requester first (primary op; errors propagate).
  const requester = await grantForwardAccess({
    docId: params.docId,
    documentName: params.documentName,
    uid: params.uid,
    principalSpaceId: params.principalSpaceId,
    roleNum: params.roleNum,
    ...(params.allowAdmin === true ? { allowAdmin: true } : {}),
    grantedBy: params.grantedBy,
  })

  const botsSucceeded: string[] = []
  const botsFailed: string[] = []

  for (const botUid of params.botUids ?? []) {
    // Skip a self-collision so the human is never double-counted as a bot.
    if (botUid === params.uid) continue
    try {
      await grantForwardAccess({
        docId: params.docId,
        documentName: params.documentName,
        uid: botUid,
        principalSpaceId: params.principalSpaceId,
        roleNum: params.botRoleNum ?? params.roleNum,
        ...(params.allowBotAdmin === true || (params.botRoleNum === undefined && params.allowAdmin === true)
          ? { allowAdmin: true }
          : {}),
        grantedBy: params.grantedBy,
      })
      botsSucceeded.push(botUid)
    } catch (error) {
      botsFailed.push(botUid)
      logBotGrantFailure({
        docId: params.docId,
        requestId: params.requestId,
        botUid,
        error,
      })
    }
  }

  return { requesterRole: requester.finalRole, botsSucceeded, botsFailed }
}

/** Fan out only the non-primary Bot grants after an atomic Human approval. */
export async function grantApprovedRequestBots(
  params: GrantWithBotsParams,
  requesterRole: string,
): Promise<GrantWithBotsResult> {
  const botsSucceeded: string[] = []
  const botsFailed: string[] = []
  for (const botUid of params.botUids ?? []) {
    if (botUid === params.uid) continue
    try {
      await grantForwardAccess({
        docId: params.docId,
        documentName: params.documentName,
        uid: botUid,
        principalSpaceId: params.principalSpaceId,
        roleNum: params.botRoleNum ?? params.roleNum,
        ...(params.allowBotAdmin === true || (params.botRoleNum === undefined && params.allowAdmin === true)
          ? { allowAdmin: true }
          : {}),
        grantedBy: params.grantedBy,
      })
      botsSucceeded.push(botUid)
    } catch (error) {
      botsFailed.push(botUid)
      logBotGrantFailure({ docId: params.docId, requestId: params.requestId, botUid, error })
    }
  }
  return { requesterRole, botsSucceeded, botsFailed }
}
