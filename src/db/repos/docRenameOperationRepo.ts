/**
 * doc_rename_operation repository (OCTO-456 §4.8 HTML two-step rename).
 *
 * One row per LOGICAL html rename. Its `id` is the octo-docs-html idempotency
 * key, which is what makes retries safe without collapsing genuinely separate
 * renames:
 *
 *   A→B (op1) → A→B retry        reuses op1        → html returns the same version
 *   A→B (op1) ... B→A (op2) ...  new op each time  → html publishes v+1 each time
 *
 * A pending row also serializes concurrent renames of the same document: the
 * caller holds a `doc_meta ... FOR UPDATE` row lock while it looks this up, and a
 * second target is rejected instead of racing the first write.
 *
 * status: 0 = pending, 1 = completed, 2 = failed.
 *
 * All functions take the caller's transaction so the journal decision and the
 * doc_meta lock commit or roll back together.
 */
import type { Tx } from '../pool.js'

export const RENAME_OP_PENDING = 0
export const RENAME_OP_COMPLETED = 1
export const RENAME_OP_FAILED = 2

export interface DocRenameOperation {
  id: string
  /** Monotonic per-table order; the commit-phase fence compares this, not created_at. */
  revision: number
  doc_id: string
  from_title: string
  to_title: string
  status: number
  version: number | null
  created_at: Date
  updated_at: Date
}

export const docRenameOperationRepo = {
  /** Latest still-pending operation for a document (at most one is created at a time). */
  async getLatestPendingForDocTx(tx: Tx, docId: string): Promise<DocRenameOperation | null> {
    const rows = await tx.query<DocRenameOperation>(
      `SELECT * FROM doc_rename_operation
        WHERE doc_id = ? AND status = ${RENAME_OP_PENDING}
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [docId],
    )
    return rows[0] ?? null
  },

  /**
   * Latest FAILED operation for a document. Used for half-success recovery: a
   * rename whose html version published but whose local write was refused
   * (permission/epoch changed) can be resumed under the SAME id after access is
   * restored, without publishing another version.
   */
  async getLatestFailedForDocTx(tx: Tx, docId: string): Promise<DocRenameOperation | null> {
    const rows = await tx.query<DocRenameOperation>(
      `SELECT * FROM doc_rename_operation
        WHERE doc_id = ? AND status = ${RENAME_OP_FAILED}
        ORDER BY revision DESC
        LIMIT 1`,
      [docId],
    )
    return rows[0] ?? null
  },

  async getByIdTx(tx: Tx, id: string): Promise<DocRenameOperation | null> {
    const rows = await tx.query<DocRenameOperation>(
      'SELECT * FROM doc_rename_operation WHERE id = ? LIMIT 1',
      [id],
    )
    return rows[0] ?? null
  },

  /** Locking read used by the commit phase's fencing checks. */
  async getByIdForUpdateTx(tx: Tx, id: string): Promise<DocRenameOperation | null> {
    const rows = await tx.query<DocRenameOperation>(
      'SELECT * FROM doc_rename_operation WHERE id = ? FOR UPDATE',
      [id],
    )
    return rows[0] ?? null
  },

  /**
   * Newest COMPLETED rename for this document with a HIGHER revision.
   *
   * Its existence proves this (still pending) operation is superseded: another
   * logical rename already published a later version. Revision — not created_at
   * — is the order: DATETIME(3) cannot distinguish two operations created in the
   * same millisecond.
   */
  async getLatestCompletedAfterTx(
    tx: Tx,
    docId: string,
    revision: number,
  ): Promise<DocRenameOperation | null> {
    const rows = await tx.query<DocRenameOperation>(
      `SELECT * FROM doc_rename_operation
        WHERE doc_id = ? AND status = ${RENAME_OP_COMPLETED} AND revision > ?
        ORDER BY revision DESC
        LIMIT 1`,
      [docId, revision],
    )
    return rows[0] ?? null
  },

  async insertPendingTx(
    tx: Tx,
    op: { id: string; docId: string; fromTitle: string; toTitle: string },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO doc_rename_operation (id, doc_id, from_title, to_title, status)
       VALUES (?, ?, ?, ?, ${RENAME_OP_PENDING})`,
      [op.id, op.docId, op.fromTitle, op.toTitle],
    )
  },

  /**
   * Refresh a reused pending operation's updated_at so operators can see it is
   * still being retried. Same-target retries reuse this row REGARDLESS of age —
   * replacing the id would let html publish a duplicate version.
   */
  async touchPendingTx(tx: Tx, id: string): Promise<void> {
    await tx.query(
      `UPDATE doc_rename_operation SET updated_at = CURRENT_TIMESTAMP(3)
        WHERE id = ? AND status = ${RENAME_OP_PENDING}`,
      [id],
    )
  },

  /** failed → pending: resume the SAME id after a half-success fence. */
  async resumeFailedTx(tx: Tx, id: string): Promise<void> {
    await tx.query(
      `UPDATE doc_rename_operation SET status = ${RENAME_OP_PENDING}, updated_at = CURRENT_TIMESTAMP(3)
        WHERE id = ? AND status = ${RENAME_OP_FAILED}`,
      [id],
    )
  },

  async markFailedTx(tx: Tx, id: string): Promise<void> {
    await tx.query(
      `UPDATE doc_rename_operation SET status = ${RENAME_OP_FAILED}
        WHERE id = ? AND status = ${RENAME_OP_PENDING}`,
      [id],
    )
  },

  /**
   * Mark failed while recording the html version that DID publish. The row keeps
   * that version so a later retry can prove the remote state matches before
   * resuming the same id (half-success recovery).
   */
  async markFailedWithVersionTx(tx: Tx, id: string, version: number | null): Promise<void> {
    await tx.query(
      `UPDATE doc_rename_operation SET status = ${RENAME_OP_FAILED}, version = ?
        WHERE id = ? AND status = ${RENAME_OP_PENDING}`,
      [version, id],
    )
  },

  async markCompletedTx(tx: Tx, id: string, version: number | null): Promise<void> {
    await tx.query(
      `UPDATE doc_rename_operation SET status = ${RENAME_OP_COMPLETED}, version = ?
        WHERE id = ? AND status = ${RENAME_OP_PENDING}`,
      [version, id],
    )
  },
}
