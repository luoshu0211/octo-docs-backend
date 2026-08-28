/**
 * doc_member repository (§3.4 / §4.2 / §8.4).
 *
 * Document-autonomous membership. resolveRole queries this table + owner only
 * (§4.2); no group inheritance. PK (doc_id, uid, principal_space_id) => at most one row per compound principal.
 */
import { query, getPool, transaction, type Tx } from '../pool.js'
import { roleFromNumber, type Role } from '../../permission/role.js'

export interface DocMemberRow {
  doc_id: string
  uid: string
  principal_space_id: string
  role: number
  granted_by: string
  source: number // 1=direct 2=invite
  invite_token: string
  created_at: Date
  updated_at: Date
}

export const SOURCE_DIRECT = 1
export const SOURCE_INVITE = 2

/**
 * SQL rank of a stored role value — mirrors roleRank() in permission/role.ts.
 * The stored TINYINT (1=reader 2=writer 3=admin 4=commenter) is NOT ordered by
 * privilege because commenter was added as value 4 without renumbering, yet it
 * ranks BETWEEN reader and writer. FIELD() maps each stored value to its
 * privilege position (reader<commenter<writer<admin), so the "never downgrade"
 * max-merge below compares by rank instead of by the raw value — otherwise a
 * commenter (4) would out-rank a writer (2) under a plain GREATEST. `$col` is
 * substituted with the column/expression to rank (e.g. `role` or `VALUES(role)`).
 */
const roleRankSql = (col: string): string => `FIELD(${col}, 1, 4, 2, 3)`

export const docMemberRepo = {
  /** Read a single member row's role (§4.2 resolveRole). Returns undefined if no row. */
  async getRole(docId: string, uid: string, principalSpaceId: string): Promise<Role | undefined> {
    const rows = await query<{ role: number }>(
      'SELECT role FROM doc_member WHERE doc_id = ? AND uid = ? AND principal_space_id = ? LIMIT 1',
      [docId, uid, principalSpaceId],
    )
    if (rows.length === 0) return undefined
    return roleFromNumber(Number(rows[0]!.role))
  },

  async list(docId: string): Promise<DocMemberRow[]> {
    return query<DocMemberRow>(
      'SELECT * FROM doc_member WHERE doc_id = ? ORDER BY created_at ASC',
      [docId],
    )
  },

  /** Direct add / update role (§8.4 PUT members). Upsert by (doc_id, uid). */
  async upsertDirect(params: {
    docId: string
    uid: string
    principalSpaceId: string
    roleNum: number
    grantedBy: string
  }): Promise<void> {
    await query(
      `INSERT INTO doc_member (doc_id, uid, principal_space_id, role, granted_by, source, invite_token)
       VALUES (?, ?, ?, ?, ?, ${SOURCE_DIRECT}, '')
       ON DUPLICATE KEY UPDATE role = VALUES(role), granted_by = VALUES(granted_by)`,
      [params.docId, params.uid, params.principalSpaceId, params.roleNum, params.grantedBy],
    )
  },

  /**
   * Precisely change an existing Space-qualified grant without creating one.
   * Used for non-home-Space rows: cross-Space principals may be managed after
   * they already exist, but this endpoint must never become an arbitrary grant
   * creation path. Returns false when the exact compound principal is absent.
   */
  async updateExistingDirect(params: {
    docId: string
    uid: string
    principalSpaceId: string
    roleNum: number
    grantedBy: string
  }): Promise<boolean> {
    const result = await query<{ affectedRows?: number }>(
      `UPDATE doc_member
         SET role = ?, granted_by = ?
       WHERE doc_id = ? AND uid = ? AND principal_space_id = ?`,
      [params.roleNum, params.grantedBy, params.docId, params.uid, params.principalSpaceId],
    )
    if ((result as unknown as { affectedRows?: number }).affectedRows! > 0) return true

    // MySQL reports affectedRows=0 when the exact row already has these values.
    // Distinguish that idempotent success from absence without ever INSERTing.
    const rows = await query<{ present: number }>(
      `SELECT 1 AS present FROM doc_member
       WHERE doc_id = ? AND uid = ? AND principal_space_id = ? LIMIT 1`,
      [params.docId, params.uid, params.principalSpaceId],
    )
    return rows.length > 0
  },

  /** Atomically remove exactly one Space-qualified principal and bump epoch on change. */
  async removePrincipalExact(params: {
    docId: string
    principalSpaceId: string
    uid: string
  }): Promise<{ changed: boolean; removedUids: string[]; newEpoch?: number }> {
    return transaction(async (tx) => {
      const present = await tx.query<{ uid: string }>(
        `SELECT uid FROM doc_member
         WHERE doc_id = ? AND uid = ? AND principal_space_id = ?
         FOR UPDATE`,
        [params.docId, params.uid, params.principalSpaceId],
      )
      if (present.length === 0) return { changed: false, removedUids: [] }

      await tx.query(
        'DELETE FROM doc_member WHERE doc_id = ? AND uid = ? AND principal_space_id = ?',
        [params.docId, params.uid, params.principalSpaceId],
      )
      await tx.query(
        'UPDATE doc_meta SET permission_epoch = permission_epoch + 1 WHERE doc_id = ?',
        [params.docId],
      )
      const epochRows = await tx.query<{ permission_epoch: number }>(
        'SELECT permission_epoch FROM doc_meta WHERE doc_id = ? LIMIT 1',
        [params.docId],
      )
      return {
        changed: true,
        removedUids: [params.uid],
        newEpoch: Number(epochRows[0]?.permission_epoch ?? 0),
      }
    })
  },

  /**
   * Atomically remove a Human plus the already-resolved set of Bots created by
   * that Human in the same Space. The caller must complete the authoritative
   * Bot-directory lookup before entering this write transaction.
   */
  async removePrincipalWithBots(params: {
    docId: string
    principalSpaceId: string
    uid: string
    botUids: string[]
  }): Promise<{ changed: boolean; removedUids: string[]; newEpoch?: number }> {
    const uids = [...new Set([params.uid, ...params.botUids].filter((uid) => uid !== ''))]
    return transaction(async (tx) => {
      const placeholders = uids.map(() => '?').join(', ')
      const present = await tx.query<{ uid: string }>(
        `SELECT uid FROM doc_member
         WHERE doc_id = ? AND principal_space_id = ? AND uid IN (${placeholders})
         FOR UPDATE`,
        [params.docId, params.principalSpaceId, ...uids],
      )
      const removedUids = [...new Set(present.map((row) => row.uid))]
      if (removedUids.length === 0) return { changed: false, removedUids: [] }

      const removedPlaceholders = removedUids.map(() => '?').join(', ')
      await tx.query(
        `DELETE FROM doc_member
         WHERE doc_id = ? AND principal_space_id = ? AND uid IN (${removedPlaceholders})`,
        [params.docId, params.principalSpaceId, ...removedUids],
      )
      await tx.query(
        'UPDATE doc_meta SET permission_epoch = permission_epoch + 1 WHERE doc_id = ?',
        [params.docId],
      )
      const epochRows = await tx.query<{ permission_epoch: number }>(
        'SELECT permission_epoch FROM doc_meta WHERE doc_id = ? LIMIT 1',
        [params.docId],
      )
      return {
        changed: true,
        removedUids,
        newEpoch: Number(epochRows[0]?.permission_epoch ?? 0),
      }
    })
  },

  /**
   * Forward-grant upsert — "grant only, never downgrade" (max-merge).
   *
   * The forward-to-chat flow authorizes a recipient at the chosen level but must
   * NEVER lower an existing higher role (권한 matrix §7 "不降级" / AC-12). Uses a
   * single atomic statement, comparing by PRIVILEGE RANK (roleRankSql) rather
   * than the raw stored value — commenter's stored value (4) is not its rank
   * position, so a plain GREATEST would misorder it against writer (2):
   *
   *   role       = IF(rank(VALUES(role)) > rank(role), VALUES(role), role)        -- only up
   *   granted_by = IF(rank(VALUES(role)) > rank(role), VALUES(granted_by), ...)   -- audit only on real upgrade
   *
   * This is a DISTINCT method from upsertDirect (admin precise set, downgradable,
   * reused by PUT /members) and upsertFromInviteTx (invite, no-upgrade). The three
   * write paths are physically isolated so their opposite semantics never leak
   * into one another. source=direct, invite_token=''.
   *
   * Returns true when the row was inserted or genuinely upgraded (affectedRows>0),
   * false when it was already >= the target level (no-op). Callers bump the epoch
   * only on a real change. Because the rank compare is monotonic and single-statement,
   * the op is atomic and idempotent under concurrent/duplicate forwards (E-13).
   *
   * NOTE: never call this for an owner (owner has no doc_member row); doing so
   * would INSERT a misleading low-role row. Callers resolveRole first and skip
   * owners / existing admins.
   */
  async upsertGrantMax(params: {
    docId: string
    uid: string
    principalSpaceId: string
    roleNum: number
    grantedBy: string
  }): Promise<boolean> {
    const [result] = await getPool().execute(
      `INSERT INTO doc_member (doc_id, uid, principal_space_id, role, granted_by, source, invite_token)
       VALUES (?, ?, ?, ?, ?, ${SOURCE_DIRECT}, '')
       ON DUPLICATE KEY UPDATE
         granted_by = IF(${roleRankSql('VALUES(role)')} > ${roleRankSql('role')}, VALUES(granted_by), granted_by),
         role       = IF(${roleRankSql('VALUES(role)')} > ${roleRankSql('role')}, VALUES(role), role)`,
      [params.docId, params.uid, params.principalSpaceId, params.roleNum, params.grantedBy] as never[],
    )
    // mysql2 ResultSetHeader.affectedRows: insert => 1, real update => 2,
    // "no change" (already >= target) => 0. Non-zero means a genuine grant/upgrade.
    return (result as unknown as { affectedRows?: number }).affectedRows! > 0
  },

  /** Transaction-scoped only-up grant used by atomic access-request approval. */
  async upsertGrantMaxTx(tx: Tx, params: {
    docId: string
    uid: string
    principalSpaceId: string
    roleNum: number
    grantedBy: string
  }): Promise<boolean> {
    const result = await tx.execute(
      `INSERT INTO doc_member (doc_id, uid, principal_space_id, role, granted_by, source, invite_token)
       VALUES (?, ?, ?, ?, ?, ${SOURCE_DIRECT}, '')
       ON DUPLICATE KEY UPDATE
         granted_by = IF(${roleRankSql('VALUES(role)')} > ${roleRankSql('role')}, VALUES(granted_by), granted_by),
         role       = IF(${roleRankSql('VALUES(role)')} > ${roleRankSql('role')}, VALUES(role), role)`,
      [params.docId, params.uid, params.principalSpaceId, params.roleNum, params.grantedBy],
    )
    return result.affectedRows > 0
  },

  // ── transaction-scoped variants for the invite accept flow (§4.6) ──────────

  async getRoleTx(tx: Tx, docId: string, uid: string, principalSpaceId: string): Promise<Role | undefined> {
    const rows = await tx.query<{ role: number }>(
      'SELECT role FROM doc_member WHERE doc_id = ? AND uid = ? AND principal_space_id = ? LIMIT 1',
      [docId, uid, principalSpaceId],
    )
    if (rows.length === 0) return undefined
    return roleFromNumber(Number(rows[0]!.role))
  },

  /** Insert/rebuild a member row from an accepted invite (§4.6 branch c/d). */
  async upsertFromInviteTx(
    tx: Tx,
    params: { docId: string; uid: string; principalSpaceId: string; roleNum: number; grantedBy: string; inviteToken: string },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO doc_member (doc_id, uid, principal_space_id, role, granted_by, source, invite_token)
       VALUES (?, ?, ?, ?, ?, ${SOURCE_INVITE}, ?)
       ON DUPLICATE KEY UPDATE role = VALUES(role), granted_by = VALUES(granted_by),
                               source = VALUES(source), invite_token = VALUES(invite_token)`,
      [params.docId, params.uid, params.principalSpaceId, params.roleNum, params.grantedBy, params.inviteToken],
    )
  },

  /**
   * Transaction-scoped twin of {@link upsertDirect}: direct-grant a member role
   * on the tx connection so it participates in the caller's atomic create (PPT
   * human create grants the owner admin in the same transaction as the doc_meta
   * insert, so a partial failure rolls both back — no orphan membership).
   */
  async upsertDirectTx(
    tx: Tx,
    params: { docId: string; uid: string; principalSpaceId: string; roleNum: number; grantedBy: string },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO doc_member (doc_id, uid, principal_space_id, role, granted_by, source, invite_token)
       VALUES (?, ?, ?, ?, ?, ${SOURCE_DIRECT}, '')
       ON DUPLICATE KEY UPDATE role = VALUES(role), granted_by = VALUES(granted_by)`,
      [params.docId, params.uid, params.principalSpaceId, params.roleNum, params.grantedBy],
    )
  },

}
