/**
 * 在线文档原件回收的仓储层（OCTO-456 P1）。
 *
 * 三件事集中在这里，路由与定时任务都不直接写 SQL：
 *   1. `listTrash` —— 调用者 owner/admin 的 `status=0` 文档，按
 *      `deleted_at DESC, doc_id DESC` 游标分页（`deleted_at` 为 NULL 的历史行
 *      排在最后，仍可见、仍可恢复）。
 *   2. `restoreDoc` —— 置 `status=1, deleted_at=NULL` 并**同一事务**内 bump
 *      `permission_epoch`（软删时被切断的 live 会话需要收到一次失效事件才会
 *      重新校验权限）。
 *   3. `purgeDoc` —— 物理删除文档及其全部从属行（成员、邀请、申请、通知、
 *      附件引用、评论、版本、浏览记录、PPT/协同态、Yjs 持久化态…）。顺序上
 *      先删子表、最后删 `doc_meta`，整段在一个事务里；html 正文的远端删除由
 *      `trash/purgeDocument.ts` 在调用本方法**之前**完成。
 *
 * 为什么单独一个 repo 文件：本任务要与未合并的 !208 并行推进，尽量不往
 * `docMetaRepo` 里塞新方法，减少合并冲突；查询语义仍沿用那边既有约定
 * （owner 是 (uid, owner Space) 复合主体、admin = doc_member.role 3）。
 */
import { query, transaction } from '../pool.js'
import { docMetaRepo, escapeLikeSubstring } from './docMetaRepo.js'
import { ROLE_ADMIN } from '../../permission/role.js'

/** 回收站列表默认/最大页大小。 */
export const TRASH_PAGE_SIZE_DEFAULT = 20
export const TRASH_PAGE_SIZE_MAX = 100
/** 批量恢复/彻底删除的单次上限（PRD 建议 50）。 */
export const MAX_TRASH_BATCH = 50

export interface TrashListRow {
  doc_id: string
  title: string
  doc_type: string
  owner_id: string
  deleted_at: Date | null
}

export interface TrashPage {
  items: TrashListRow[]
  nextCursor: string | null
}

export interface RestoredDoc {
  documentName: string
  permissionEpoch: number
  /** false = 行本来就是 active，重复恢复是幂等 no-op（不要重复 bump epoch）。 */
  changed: boolean
}

export type RestoreOutcome =
  | { ok: true; doc: RestoredDoc }
  | { ok: false; reason: 'not_found' | 'archived' | 'purging' | 'expired' }

export interface PurgedDoc {
  documentName: string
  attachObjectKeys: string[]
}

export type PurgeClaimOutcome =
  | { ok: true; doc: PurgedDoc; resumed: boolean }
  | { ok: false; reason: 'not_found' | 'archived' | 'not_deleted' }

export type PurgeOutcome =
  | { ok: true; doc: PurgedDoc }
  | { ok: false; reason: 'not_found' | 'archived' | 'not_deleted' }

/** 游标：deleted_at（可空）+ doc_id。只有服务端读写，base64url(JSON) 不透明。 */
export interface TrashCursor {
  deletedAt: string | null
  docId: string
}

export function encodeTrashCursor(deletedAt: Date | string | null, docId: string): string {
  const t = deletedAt === null ? null : (deletedAt instanceof Date ? deletedAt : new Date(deletedAt)).toISOString()
  return Buffer.from(JSON.stringify({ t, d: docId }), 'utf8').toString('base64url')
}

/** 非法游标抛 'invalid_cursor'，路由映射 400（不要静默回到第一页）。 */
export function decodeTrashCursor(raw: string | undefined): TrashCursor | null {
  if (raw === undefined || raw === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    throw new Error('invalid_cursor')
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('invalid_cursor')
  const { t, d } = parsed as { t?: unknown; d?: unknown }
  if (typeof d !== 'string' || d === '') throw new Error('invalid_cursor')
  if (t === null) return { deletedAt: null, docId: d }
  if (typeof t !== 'string' || Number.isNaN(new Date(t).getTime())) throw new Error('invalid_cursor')
  return { deletedAt: t, docId: d }
}

/** 保留期到期的候选行（定时清理任务读取）。 */
export interface ExpiredTrashRow {
  doc_id: string
  document_name: string
  doc_type: string
  octo_doc_slug: string | null
}

export const docTrashRepo = {
  /**
   * 回收站第一页/后续页。可见性：owner（uid + owner Space）或 admin
   * （`doc_member.role = 3`）——只读观察者（reader/writer/commenter）不在列表里，
   * 更不能操作。`q` 是对标题的大小写不敏感子串匹配（`%`/`_`/`\` 按字面量）。
   */
  async listTrash(params: {
    uid: string
    principalSpaceId: string
    q?: string
    cursor?: string
    pageSize?: number
  }): Promise<TrashPage> {
    const pageSize = Math.min(
      TRASH_PAGE_SIZE_MAX,
      Math.max(
        1,
        Number.isInteger(params.pageSize) ? params.pageSize! : TRASH_PAGE_SIZE_DEFAULT,
      ),
    )
    const cursor = decodeTrashCursor(params.cursor)

    const args: unknown[] = [params.uid, params.principalSpaceId, params.uid, params.principalSpaceId]
    const q = (params.q ?? '').trim()
    let qSql = ''
    if (q !== '') {
      qSql = "AND m.title LIKE ? ESCAPE '\\\\'"
      args.push(`%${escapeLikeSubstring(q)}%`)
    }
    let cursorSql = ''
    if (cursor) {
      if (cursor.deletedAt === null) {
        // NULL 段排最后，段内按 doc_id DESC。
        cursorSql = 'AND m.deleted_at IS NULL AND m.doc_id < ?'
        args.push(cursor.docId)
      } else {
        // 非 NULL 段之后还跟着整个 NULL 段，必须一并纳入后续页。
        cursorSql = 'AND (m.deleted_at IS NULL OR m.deleted_at < ? OR (m.deleted_at = ? AND m.doc_id < ?))'
        const at = new Date(cursor.deletedAt)
        args.push(at, at, cursor.docId)
      }
    }

    const rows = await query<TrashListRow>(
      `SELECT m.doc_id, m.title, m.doc_type, m.owner_id, m.deleted_at
       FROM doc_meta m
       LEFT JOIN doc_member dm
         ON dm.doc_id = m.doc_id AND dm.uid = ? AND dm.principal_space_id = ?
       WHERE m.status = 0
         AND ((m.owner_id = ? AND m.owner_space_id = ?) OR dm.role = ${ROLE_ADMIN})
         ${qSql}
         ${cursorSql}
       ORDER BY m.deleted_at DESC, m.doc_id DESC
       LIMIT ${pageSize + 1}`,
      args,
    )
    const hasMore = rows.length > pageSize
    const items = hasMore ? rows.slice(0, pageSize) : rows
    const last = items[items.length - 1]
    const nextCursor = hasMore && last
      ? encodeTrashCursor(last.deleted_at, last.doc_id)
      : null
    return { items, nextCursor }
  },

  /**
   * 恢复一篇已软删文档。归档（status=2）不在这里处理 —— 返回 `archived` 让路由
   * 映射 409 doc_archived（恢复归档需要走取消归档链路，不是回收站恢复）。
   * 已经是 active 的行按幂等成功处理（重复恢复不报错，也不重复 bump epoch）。
   */
  /**
   * Claim one document for a physical purge: `purge_state=1` marks that its
   * remote content deletion may be in flight. It is persisted BEFORE the html
   * call so a concurrent restore (or a retry after a crash) sees the same state
   * under the row lock — otherwise a restore could commit and the purge would
   * still delete the content, leaving an ACTIVE document with no body.
   *
   * A row that is already claimed resumes (`resumed=true`), which is what makes
   * a failed remote deletion retryable instead of leaving the document stuck.
   */
  async claimPurge(docId: string): Promise<PurgeClaimOutcome> {
    return transaction(async (tx) => {
      const [meta] = await tx.query<{ status: number; document_name: string; purge_state: number | null }>(
        'SELECT status, document_name, purge_state FROM doc_meta WHERE doc_id = ? FOR UPDATE',
        [docId],
      )
      if (!meta) return { ok: false, reason: 'not_found' } as const
      const status = Number(meta.status)
      if (status === 2) return { ok: false, reason: 'archived' } as const
      if (status !== 0) return { ok: false, reason: 'not_deleted' } as const
      const resumed = Number(meta.purge_state ?? 0) === 1
      if (!resumed) {
        await tx.query('UPDATE doc_meta SET purge_state = 1 WHERE doc_id = ?', [docId])
      }
      return {
        ok: true,
        resumed,
        doc: { documentName: String(meta.document_name), attachObjectKeys: [] },
      } as const
    })
  },

  /**
   * Release a purge claim that never got as far as deleting remote content (for
   * example the HTML backend is not configured). Without it, a deployment with
   * content purge switched off would leave every expired document permanently
   * un-restorable.
   */
  async releasePurgeClaim(docId: string): Promise<void> {
    await query('UPDATE doc_meta SET purge_state = 0 WHERE doc_id = ? AND purge_state = 1', [docId])
  },

  async restoreDoc(docId: string): Promise<RestoreOutcome> {
    return transaction(async (tx) => {
      const [meta] = await tx.query<{ status: number; document_name: string; purge_state: number | null }>(
        'SELECT status, document_name, purge_state FROM doc_meta WHERE doc_id = ? FOR UPDATE',
        [docId],
      )
      if (!meta) return { ok: false, reason: 'not_found' } as const
      const status = Number(meta.status)
      if (status === 2) return { ok: false, reason: 'archived' } as const
      // A purge has claimed this document: its content may already be gone, so it
      // must never be reactivated. The caller answers 409 instead.
      if (Number(meta.purge_state ?? 0) === 1) return { ok: false, reason: 'purging' } as const
      const changed = status === 0
      if (changed) {
        await tx.query('UPDATE doc_meta SET status = 1, deleted_at = NULL WHERE doc_id = ?', [docId])
        // 软删时 bump 过一次；恢复同样 bump，让断开期间的 live 连接重新校验。
        await docMetaRepo.bumpEpochTx(tx, docId)
      }
      const [row] = await tx.query<{ document_name: string; permission_epoch: number }>(
        'SELECT document_name, permission_epoch FROM doc_meta WHERE doc_id = ? LIMIT 1',
        [docId],
      )
      if (!row) return { ok: false, reason: 'not_found' } as const
      return {
        ok: true,
        doc: {
          documentName: row.document_name,
          permissionEpoch: Number(row.permission_epoch),
          changed,
        },
      } as const
    })
  },

  /**
   * 物理删除。只允许 `status=0`（回收站）的文档：active 一律 `not_deleted`，
   * archived 一律 `archived`。调用前必须已完成 html 远端 purge。
   * 返回附件 object key 供调用方尽力删除对象存储里的二进制。
   */
  async purgeDoc(docId: string): Promise<PurgeOutcome> {
    return transaction(async (tx) => {
      const [meta] = await tx.query<{ status: number; document_name: string }>(
        'SELECT status, document_name FROM doc_meta WHERE doc_id = ? FOR UPDATE',
        [docId],
      )
      if (!meta) return { ok: false, reason: 'not_found' } as const
      const status = Number(meta.status)
      if (status === 2) return { ok: false, reason: 'archived' } as const
      if (status !== 0) return { ok: false, reason: 'not_deleted' } as const
      const documentName = meta.document_name

      const attachments = await tx.query<{ object_key: string }>(
        'SELECT object_key FROM doc_attachment WHERE doc_id = ?',
        [docId],
      )

      // 子表先删，doc_meta 最后删。所有表都按 doc_id；Yjs/overcap/代际表按
      // document_name（它们的键不是 doc_id）。PPT 系列是 html_ppt 文档的从属态。
      await tx.query(
        'DELETE FROM doc_comment_task_event WHERE task_key IN (SELECT task_key FROM doc_comment_task WHERE doc_id = ?)',
        [docId],
      )
      await tx.query('DELETE FROM doc_comment_task WHERE doc_id = ?', [docId])
      await tx.query(
        'DELETE FROM doc_access_notify_card WHERE request_id IN (SELECT request_id FROM doc_access_request WHERE doc_id = ?)',
        [docId],
      )
      await tx.query('DELETE FROM doc_access_request WHERE doc_id = ?', [docId])
      await tx.query(
        'DELETE FROM doc_invite_redemption WHERE invite_token IN (SELECT invite_token FROM doc_invite WHERE doc_id = ?)',
        [docId],
      )
      await tx.query('DELETE FROM doc_invite WHERE doc_id = ?', [docId])
      await tx.query('DELETE FROM doc_member_notification WHERE doc_id = ?', [docId])
      await tx.query('DELETE FROM doc_member WHERE doc_id = ?', [docId])
      await tx.query('DELETE FROM doc_rename_operation WHERE doc_id = ?', [docId])
      await tx.query('DELETE FROM doc_comment WHERE doc_id = ?', [docId])
      await tx.query('DELETE FROM doc_version WHERE doc_id = ?', [docId])
      await tx.query('DELETE FROM doc_view_history WHERE doc_id = ?', [docId])
      await tx.query('DELETE FROM doc_library_event WHERE doc_id = ?', [docId])
      await tx.query('DELETE FROM doc_legacy_visible WHERE doc_id = ?', [docId])
      await tx.query('DELETE FROM doc_attachment WHERE doc_id = ?', [docId])
      await tx.query('DELETE FROM ppt_comment WHERE doc_id = ?', [docId])
      await tx.query('DELETE FROM ppt_version WHERE doc_id = ?', [docId])
      await tx.query('DELETE FROM ppt_collab_actor_seq WHERE doc_id = ?', [docId])
      await tx.query('DELETE FROM ppt_collab_frame WHERE doc_id = ?', [docId])
      await tx.query('DELETE FROM ppt_collab_op WHERE doc_id = ?', [docId])
      await tx.query('DELETE FROM ppt_live_snapshot WHERE doc_id = ?', [docId])
      await tx.query('DELETE FROM ppt_collab_seq WHERE doc_id = ?', [docId])
      await tx.query('DELETE FROM ppt_doc_state WHERE doc_id = ?', [docId])
      await tx.query('DELETE FROM ppt_idempotency WHERE doc_id = ?', [docId])
      await tx.query('DELETE FROM doc_state_generation WHERE document_name = ?', [documentName])
      await tx.query('DELETE FROM yjs_update_log WHERE document_name = ?', [documentName])
      await tx.query('DELETE FROM yjs_snapshot WHERE document_name = ?', [documentName])
      await tx.query('DELETE FROM overcap_unrestored WHERE document_name = ?', [documentName])
      await tx.query('DELETE FROM yjs_document WHERE document_name = ?', [documentName])
      await tx.query('DELETE FROM doc_meta WHERE doc_id = ?', [docId])

      return {
        ok: true,
        doc: {
          documentName,
          attachObjectKeys: attachments.map((row) => row.object_key),
        },
      } as const
    })
  },

  /**
   * 保留期到期的候选（`deleted_at` 非 NULL 且严格早于 cutoff）。
   * `deleted_at IS NULL` 的历史行期限未知，**永不自动清理**（与灰行契约一致）。
   */
  async listExpiredForCleanup(cutoff: Date, limit: number): Promise<ExpiredTrashRow[]> {
    const bounded = Number.isInteger(limit) ? Math.min(1000, Math.max(1, limit)) : 100
    return query<ExpiredTrashRow>(
      `SELECT doc_id, document_name, doc_type, octo_doc_slug
       FROM doc_meta
       WHERE status = 0
         AND deleted_at IS NOT NULL
         AND deleted_at < ?
       ORDER BY deleted_at ASC, doc_id ASC
       LIMIT ${bounded}`,
      [cutoff],
    )
  },
}
