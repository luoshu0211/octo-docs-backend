/**
 * doc_access_request repository (§4.4, screen 4c).
 *
 * A no-permission recipient submits an access request; owner/admin pull the
 * pending list and approve/deny (MVP pull-based, no push — §4.2). PK
 * (doc_id, uid, principal_space_id)
 * gives natural idempotency: a repeat request from the same uid refreshes the
 * single row back to pending rather than piling up duplicate rows (mirrors
 * doc_member / doc_invite_redemption dedup范式).
 */
import { query, transaction, type Tx } from '../pool.js'
import { docLibraryEventRepo } from './docLibraryEventRepo.js'
import { newRequestId } from '../../util/ids.js'
import { parseStoredBotUids } from '../../util/botUids.js'

export const REQUEST_STATUS_PENDING = 1
export const REQUEST_STATUS_APPROVED = 2
export const REQUEST_STATUS_DENIED = 3
export const REQUEST_STATUS_CANCELLED = 4

export interface DocAccessRequestRow {
  doc_id: string
  uid: string
  principal_space_id: string
  requested_role: number // 1=reader 2=writer 3=admin 4=commenter
  reason: string
  status: number // 1=pending 2=approved 3=denied 4=cancelled
  request_id: string
  decided_by: string
  /**
   * The winning decider's trusted Space (octo callback `operator_space_id`, or
   * the REST caller's verified current Space). Written atomically with `status`
   * in the pending→terminal CAS. '' for rows decided before the decider-space
   * migration OR never decided — the callback treats an empty value as an
   * optional-Space degradation and never guesses a Space.
   */
  decided_by_space_id: string
  decision_note: string
  /**
   * Authoritative decision time in unix SECONDS (same unit as the callback
   * `acted_at`), written atomically with `status`. `null` for legacy / pending
   * rows — the callback then omits `decided_at` rather than fabricate one.
   */
  decided_at_unix: number | null
  bot_uids: string[] // normalized snapshot of the requester's own Space bots (JSON column); [] when none
  created_at: Date
  updated_at: Date
}

/** Coerce the nullable unix-seconds column (mysql2 may hand back a string) to a number|null. */
function normalizeDecidedAt(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export const docAccessRequestRepo = {
  /**
   * Submit (or re-submit) a request. Idempotent by
   * (doc_id, uid, principal_space_id): a duplicate
   * refreshes the existing row to pending with the new role/reason and clears
   * the previous decision. A re-submit ROTATES request_id to a fresh high-entropy
   * value so every submission is a distinct, addressable snapshot.
   *
   * Why rotate (not keep it stable): an approval card carries only request_id as
   * its decision key. If request_id were reused across re-submits, a stale card
   * minted for an earlier submission (e.g. "reader") could approve a later,
   * different pending row (e.g. re-submitted as "writer"), granting a role the
   * approver never saw on their card. Rotating request_id binds each card to the
   * exact submission it represents: a stale card's request_id no longer matches
   * any row, so the callback resolves it as not_found instead of applying to a
   * newer request. The Space-qualified PK still collapses duplicates per
   * principal while keeping the same uid in different Spaces independent.
   * Returns the row's (now current) request_id and status.
   *
   * `botUids` is the requester's own Space-bot snapshot (already gated by the
   * route to the caller's owned_bots_by_space[doc.space_id] subset). It is
   * re-normalized here and OVERWRITTEN on every (re)submit alongside request_id,
   * so a re-submit's snapshot fully replaces the prior one — an approval always
   * acts on the exact bot set of the submission its (rotated) request_id names.
   * Omitted / empty => stored as `[]` (the zero-bot legacy path).
   */
  async submit(params: {
    docId: string
    uid: string
    principalSpaceId: string
    requestedRoleNum: number
    reason: string
    botUids?: string[]
  }): Promise<{ requestId: string; status: number }> {
    const candidateId = newRequestId()
    // Re-check fail-closed at the DB boundary (the route already strict-validated)
    // and store canonical JSON text so the column value is stable/order-independent.
    const botUidsJson = JSON.stringify(parseStoredBotUids(params.botUids ?? []))
    return transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO doc_access_request (doc_id, uid, principal_space_id, requested_role, reason, status, request_id, bot_uids)
         VALUES (?, ?, ?, ?, ?, ${REQUEST_STATUS_PENDING}, ?, CAST(? AS JSON))
         ON DUPLICATE KEY UPDATE
           requested_role = VALUES(requested_role),
           reason         = VALUES(reason),
           status         = ${REQUEST_STATUS_PENDING},
           decided_by     = '',
           decided_by_space_id = '',
           decision_note  = '',
           decided_at_unix = NULL,
           request_id     = VALUES(request_id),
           bot_uids       = VALUES(bot_uids)`,
        [params.docId, params.uid, params.principalSpaceId, params.requestedRoleNum, params.reason, candidateId, botUidsJson],
      )
      await docLibraryEventRepo.notifyApprovers(tx, {
        docId: params.docId, requestId: candidateId, uid: params.uid, spaceId: params.principalSpaceId,
        requestedRole: params.requestedRoleNum,
      })
      return { requestId: candidateId, status: REQUEST_STATUS_PENDING }
    })
  },

  /** List requests for a doc filtered by status (admin pull; default pending). */
  async listByStatus(docId: string, status: number): Promise<DocAccessRequestRow[]> {
    const rows = await query<DocAccessRequestRow>(
      'SELECT * FROM doc_access_request WHERE doc_id = ? AND status = ? ORDER BY created_at ASC',
      [docId, status],
    )
    // Fail-closed normalize the JSON snapshot on the read path so a corrupt /
    // hand-edited DB value can never authorize a bot downstream.
    return rows.map((r) => ({
      ...r,
      bot_uids: parseStoredBotUids((r as { bot_uids?: unknown }).bot_uids),
      decided_at_unix: normalizeDecidedAt((r as { decided_at_unix?: unknown }).decided_at_unix),
    }))
  },

  async getMine(docId: string, uid: string, spaceId: string): Promise<DocAccessRequestRow | null> {
    const rows = await query<DocAccessRequestRow>(
      'SELECT * FROM doc_access_request WHERE doc_id = ? AND uid = ? AND principal_space_id = ? LIMIT 1',
      [docId, uid, spaceId],
    )
    return rows[0] ?? null
  },

  /** Fetch a single request by (doc_id, request_id) for approve/deny addressing. */
  async getByRequestId(docId: string, requestId: string): Promise<DocAccessRequestRow | null> {
    const rows = await query<DocAccessRequestRow>(
      'SELECT * FROM doc_access_request WHERE doc_id = ? AND request_id = ? LIMIT 1',
      [docId, requestId],
    )
    const row = rows[0]
    if (!row) return null
    return {
      ...row,
      bot_uids: parseStoredBotUids((row as { bot_uids?: unknown }).bot_uids),
      decided_at_unix: normalizeDecidedAt((row as { decided_at_unix?: unknown }).decided_at_unix),
    }
  },

  /**
   * Transition a pending request to approved/denied, recording the authoritative
   * decider identity (uid + trusted Space) and decision time. Only flips rows
   * still pending (guards against double-processing / races). Returns true when a
   * pending row was transitioned.
   */
  async decide(params: {
    docId: string
    requestId: string
    status: number
    decidedBy: string
    decidedBySpaceId: string
    decidedAtUnix: number
    note?: string
  }): Promise<boolean> {
    return transaction(async (tx) => {
      const transitioned = await this.decideTx(tx, params)
      if (transitioned && params.status === REQUEST_STATUS_DENIED) {
        const [row] = await tx.query<{ uid: string; principal_space_id: string }>(
          'SELECT uid, principal_space_id FROM doc_access_request WHERE doc_id = ? AND request_id = ?',
          [params.docId, params.requestId],
        )
        if (!row) throw new Error('Decided access request disappeared')
        await docLibraryEventRepo.record(tx, { uid: row.uid, spaceId: row.principal_space_id }, {
          kind: 'access_denied', docId: params.docId, requestId: params.requestId, actorUid: params.decidedBy,
        })
      }
      return transitioned
    })
  },

  /** Transaction-scoped pending -> terminal CAS. */
  async decideTx(tx: Tx, params: {
    docId: string
    requestId: string
    status: number
    decidedBy: string
    decidedBySpaceId: string
    decidedAtUnix: number
    note?: string
  }): Promise<boolean> {
    const result = await tx.execute(
      `UPDATE doc_access_request
         SET status = ?, decided_by = ?, decided_by_space_id = ?, decided_at_unix = ?, decision_note = ?
       WHERE doc_id = ? AND request_id = ? AND status = ${REQUEST_STATUS_PENDING}`,
      [params.status, params.decidedBy, params.decidedBySpaceId, params.decidedAtUnix, params.note ?? '', params.docId, params.requestId],
    )
    return result.affectedRows > 0
  },
}
