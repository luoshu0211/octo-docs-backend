import { query, type Tx } from '../pool.js'

type Kind = 'access_requested' | 'access_approved' | 'access_denied' | 'member_role_changed' | 'member_removed'

interface EventRow {
  id: string
  doc_id: string
  title: string
  actor_uid: string
  kind: Kind
  request_id: string | null
  previous_role: number | null
  new_role: number | null
  created_at_ms: number
  read_at: Date | null
}

interface Recipient {
  uid: string
  spaceId: string
}

interface Event {
  docId: string
  actorUid: string
  kind: Kind
  requestId?: string
  previousRole?: number
  newRole?: number
}

export const docLibraryEventRepo = {
  async record(tx: Tx, recipient: Recipient, event: Event): Promise<void> {
    await tx.execute(
      `INSERT INTO doc_library_event
         (recipient_uid, recipient_space_id, doc_id, title, actor_uid, kind, request_id, previous_role, new_role)
       SELECT ?, ?, doc_id, title, ?, ?, ?, ?, ? FROM doc_meta WHERE doc_id = ?`,
      [recipient.uid, recipient.spaceId, event.actorUid, event.kind, event.requestId ?? null,
        event.previousRole ?? null, event.newRole ?? null, event.docId],
    )
  },

  async notifyApprovers(tx: Tx, params: { docId: string; requestId: string; uid: string; spaceId: string; requestedRole: number }): Promise<void> {
    await tx.execute(
      `INSERT INTO doc_library_event
         (recipient_uid, recipient_space_id, doc_id, title, actor_uid, kind, request_id, new_role)
       SELECT a.uid, a.space_id, m.doc_id, m.title, ?, 'access_requested', ?, ?
       FROM doc_meta m
       JOIN (
         SELECT owner_id AS uid, owner_space_id AS space_id FROM doc_meta WHERE doc_id = ?
         UNION DISTINCT
         SELECT uid, principal_space_id AS space_id FROM doc_member WHERE doc_id = ? AND role = 3
       ) a ON a.uid <> '' AND a.space_id <> ''
       WHERE m.doc_id = ? AND (a.uid <> ? OR a.space_id <> ?)`,
      [params.uid, params.requestId, params.requestedRole, params.docId, params.docId, params.docId, params.uid, params.spaceId],
    )
  },

  async list(recipient: Recipient, before?: string): Promise<EventRow[]> {
    return query<EventRow>(
      `SELECT CAST(id AS CHAR) AS id, doc_id, title, actor_uid, kind, request_id, previous_role, new_role,
              CAST(UNIX_TIMESTAMP(created_at) * 1000 AS UNSIGNED) AS created_at_ms, read_at
       FROM doc_library_event WHERE recipient_uid = ? AND recipient_space_id = ?
       ${before === undefined ? '' : 'AND id < CAST(? AS UNSIGNED)'}
       ORDER BY doc_library_event.id DESC LIMIT 51`,
      before === undefined ? [recipient.uid, recipient.spaceId] : [recipient.uid, recipient.spaceId, before],
    )
  },

  async markRead(recipient: Recipient, id: string): Promise<void> {
    await query(
      `UPDATE doc_library_event SET read_at = COALESCE(read_at, NOW(3))
       WHERE id = CAST(? AS UNSIGNED) AND recipient_uid = ? AND recipient_space_id = ?`,
      [id, recipient.uid, recipient.spaceId],
    )
  },

  async decision(recipient: Recipient, docId: string, requestId: string): Promise<{
    kind: 'access_approved' | 'access_denied'; new_role: number | null
  } | null> {
    const rows = await query<{ kind: 'access_approved' | 'access_denied'; new_role: number | null }>(
      `SELECT kind, new_role FROM doc_library_event
       WHERE recipient_uid = ? AND recipient_space_id = ? AND doc_id = ? AND request_id = ?
         AND kind IN ('access_approved', 'access_denied') ORDER BY id DESC LIMIT 1`,
      [recipient.uid, recipient.spaceId, docId, requestId],
    )
    return rows[0] ?? null
  },

  async grantedRole(recipient: Recipient, docId: string, requestId: string): Promise<number | null> {
    return (await this.decision(recipient, docId, requestId))?.new_role ?? null
  },
}
