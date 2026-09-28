import { query } from '../pool.js'

export interface DocMemberNotificationRow {
  doc_id: string
  document_name: string
  title: string
  owner_id: string
  doc_type: string
  octo_doc_slug: string | null
  granted_by: string
  role: number
  event_at: Date
}

export const docMemberNotificationRepo = {
  async listUnread(params: {
    recipientUid: string
    recipientSpaceId: string
    limit?: number
  }): Promise<{ unreadCount: number; rows: DocMemberNotificationRow[] }> {
    const limit = Math.min(100, Math.max(1, Math.floor(params.limit ?? 20)))
    const rows = await query<DocMemberNotificationRow & { unread_count: number | string }>(
      `SELECT n.doc_id, m.document_name, m.title, m.owner_id, m.doc_type, m.octo_doc_slug,
              n.granted_by, n.role, n.event_at, COUNT(*) OVER () AS unread_count
       FROM doc_member_notification n
       JOIN doc_meta m ON m.doc_id = n.doc_id AND m.status = 1
       JOIN doc_member dm
         ON dm.doc_id = n.doc_id
        AND dm.uid = n.recipient_uid
        AND dm.principal_space_id = n.recipient_space_id
       WHERE n.recipient_uid = ?
         AND n.recipient_space_id = ?
         AND n.read_at IS NULL
       ORDER BY n.event_at DESC, n.doc_id DESC
       LIMIT ${limit}`,
      [params.recipientUid, params.recipientSpaceId],
    )
    // The window count and rows share one statement snapshot, before LIMIT.
    return { unreadCount: Number(rows[0]?.unread_count ?? 0), rows }
  },

  async markRead(params: {
    recipientUid: string
    recipientSpaceId: string
    docId: string
  }): Promise<void> {
    await query(
      `UPDATE doc_member_notification n
       JOIN doc_member dm
         ON dm.doc_id = n.doc_id
        AND dm.uid = n.recipient_uid
        AND dm.principal_space_id = n.recipient_space_id
       JOIN doc_meta m ON m.doc_id = n.doc_id AND m.status = 1
       SET n.read_at = COALESCE(n.read_at, NOW(3))
       WHERE n.recipient_uid = ?
         AND n.recipient_space_id = ?
         AND n.doc_id = ?`,
      [params.recipientUid, params.recipientSpaceId, params.docId],
    )
  },
}
