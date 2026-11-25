/**
 * 在线文档原件回收（OCTO-456 P1）—— 人类 API，挂在 `/api/v1/docs`。
 *
 *   GET  /api/v1/docs/trash?cursor=&page_size=20&q=
 *   POST /api/v1/docs/{docId}/restore
 *   POST /api/v1/docs/{docId}/purge            { confirm: true }
 *   POST /api/v1/docs/trash/restore            { doc_ids: [...] }   // ≤50
 *   POST /api/v1/docs/trash/purge              { doc_ids: [...] }   // ≤50
 *
 * 权限：调用者必须是文档 **owner（uid + owner Space 复合主体）或 admin**
 * （`doc_member.role=3`）——与 `canDeleteOriginal` 的 admin 语义一致；被软删文档的
 * reader/writer/commenter 观察者不可见、不可操作（列表 403 / 逐项 forbidden）。
 *
 * 恢复：`status=1, deleted_at=NULL` + bump permission_epoch，并广播失效事件
 * （软删时 live 会话已被切断，恢复后需要重新校验权限）。已归档（status=2）
 * 返回 409 `doc_archived`：归档/取消归档是另一条链路。
 *
 * 彻底删除：先删 html 远端内容（strict，失败 503 且不删 doc_meta），再在一个
 * 事务里物理删除 doc_meta 及全部从属行。只允许回收站里的 `status=0` 文档。
 *
 * 保留期：`expireAt = deletedAt + 30d`；`deletedAt` 为 NULL 的历史行
 * `expireAt:null`（期限未知、不自动清理），但仍可 restore/purge。
 *
 * 路由注册顺序是承重的：`/trash`、`/trash/restore`、`/trash/purge` 必须在
 * `/:docId/...` 之前，否则 `trash` 会被当成 docId。
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import { documentAsync } from '../services/documentRoute.js'
import { docMetaRepo, type DocMeta } from '../../db/repos/docMetaRepo.js'
import { docMemberRepo } from '../../db/repos/docMemberRepo.js'
import {
  docTrashRepo,
  MAX_TRASH_BATCH,
  TRASH_PAGE_SIZE_DEFAULT,
  TRASH_PAGE_SIZE_MAX,
  type TrashListRow,
} from '../../db/repos/docTrashRepo.js'
import { resolveHumanCurrentSpace } from '../middleware/docSpaceScope.js'
import { resolveRequestPrincipalSpace } from '../../permission/principalSpace.js'
import { roleAtLeast, type ResolvedRole } from '../../permission/role.js'
import { refreshAndPublish } from '../../permission/epoch.js'
import { enqueueDocIndex, isSearchIndexedDoc } from '../../search/docIndexQueue.js'
import { TRASH_RETENTION_DAYS, trashExpireAtIso } from '../../permission/docRetention.js'
import { purgeDocument } from '../../trash/purgeDocument.js'
import { isTrashExpired } from '../../permission/docRetention.js'

export const docsTrashRouter: ExpressRouter = Router()

interface TrashActor {
  uid: string
  principalSpaceId: string
}

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/**
 * 解析操作主体：先证明当前 Space 的成员身份（人类链路的既有要求），再用它作为
 * Space-qualified principal。缺失 X-Space-Id => 400 space_required；成员校验失败
 * => 404 not_found（与其它人类集合接口一致，不泄露 Space 是否存在）。
 */
async function resolveTrashActor(req: Request, res: Response): Promise<TrashActor | null> {
  const current = await resolveHumanCurrentSpace(req)
  if (!current.verified) {
    res.status(current.status).json({ error: current.error })
    return null
  }
  const principalSpaceId = await resolveRequestPrincipalSpace(req)
  if (!principalSpaceId) {
    res.status(403).json({ error: 'principal_space_unverified' })
    return null
  }
  return { uid: req.uid!, principalSpaceId }
}

/** 直接角色（owner => admin，否则 doc_member.role），不递归 drive 派生读权限。 */
async function directRole(
  meta: Pick<DocMeta, 'doc_id' | 'owner_id' | 'owner_space_id'>,
  actor: TrashActor,
): Promise<ResolvedRole> {
  if (actor.uid === meta.owner_id && actor.principalSpaceId === meta.owner_space_id) return 'admin'
  return (await docMemberRepo.getRole(meta.doc_id, actor.uid, actor.principalSpaceId)) ?? 'none'
}

/**
 * 单文档操作前解析 + 授权。不存在 => 404；存在但非 owner/admin => 403。
 * 返回 null 时已写响应。
 */
async function loadAdminDoc(req: Request, res: Response, docId: string, actor: TrashActor) {
  const meta = await docMetaRepo.getByDocId(docId)
  if (!meta) {
    res.status(404).json({ error: 'not_found' })
    return null
  }
  const role = await directRole(meta, actor)
  if (!roleAtLeast(role, 'admin')) {
    res.status(403).json({ error: 'forbidden' })
    return null
  }
  return meta
}

/** 恢复成功后的副作用：epoch 失效广播 + 搜索索引重投（best-effort）。 */
async function afterRestored(documentName: string, permissionEpoch: number): Promise<void> {
  await refreshAndPublish(documentName, permissionEpoch)
  if (isSearchIndexedDoc(documentName)) {
    await enqueueDocIndex(documentName).catch(() => false)
  }
}

/** 列表项 wire 形状（camelCase，与草案 B2 一致）。 */
function trashItem(row: TrashListRow): Record<string, unknown> {
  const deletedAt = isoOrNull(row.deleted_at)
  return {
    docId: row.doc_id,
    title: row.title,
    docType: row.doc_type,
    owner: { uid: row.owner_id },
    // 列表只包含 owner/admin（SQL 已限定），角色恒为 admin。
    role: 'admin',
    deletedAt,
    expireAt: trashExpireAtIso(row.deleted_at),
    retentionDays: TRASH_RETENTION_DAYS,
    canRestore: true,
    canPurge: true,
  }
}

function parsePageSize(raw: unknown): number {
  // 缺省/空串按默认 20；非法值同样回落默认，而不是把客户端手滑当成 1。
  if (raw === undefined || raw === '') return TRASH_PAGE_SIZE_DEFAULT
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return TRASH_PAGE_SIZE_DEFAULT
  return Math.min(TRASH_PAGE_SIZE_MAX, Math.max(1, Math.floor(n)))
}

/** GET /api/v1/docs/trash */
export async function listTrashHandler(req: Request, res: Response): Promise<void> {
  const actor = await resolveTrashActor(req, res)
  if (!actor) return
  let page
  try {
    page = await docTrashRepo.listTrash({
      uid: actor.uid,
      principalSpaceId: actor.principalSpaceId,
      q: typeof req.query.q === 'string' ? req.query.q : undefined,
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
      pageSize: parsePageSize(req.query.page_size),
    })
  } catch (err) {
    if (err instanceof Error && err.message === 'invalid_cursor') {
      res.status(400).json({ error: 'invalid_cursor' })
      return
    }
    throw err
  }
  res.status(200).json({ items: page.items.map(trashItem), next_cursor: page.nextCursor })
}

/**
 * One restore, shared by the single and batch entry points so they cannot
 * diverge on the state machine:
 *
 *   missing            → 404 not_found
 *   archived           → 409 doc_archived
 *   already active     → 404 not_found  (final contract: repeated restore 404)
 *   purge claimed      → 409 purge_in_progress
 *   past retention     → 410 trash_expired
 *
 * The purge claim and the retention check are evaluated under the SAME row lock
 * as the write (restoreDoc), so a document whose content deletion already started
 * can never be reactivated by the batch path.
 */
type RestoreOneResult =
  | { ok: true }
  | { ok: false; status: 400 | 403 | 404 | 409 | 410; error: string }

async function restoreOne(
  docId: string,
  actor: TrashActor,
  opts: { meta?: DocMeta; role?: ResolvedRole } = {},
): Promise<RestoreOneResult> {
  const meta = opts.meta ?? (await docMetaRepo.getByDocId(docId))
  if (!meta) return { ok: false, status: 404, error: 'not_found' }
  const role = opts.role ?? (await directRole(meta, actor))
  if (!roleAtLeast(role, 'admin')) return { ok: false, status: 403, error: 'forbidden' }
  if (meta.status === 2) return { ok: false, status: 409, error: 'doc_archived' }
  if (isTrashExpired(meta.deleted_at)) return { ok: false, status: 410, error: 'trash_expired' }
  if (meta.status === 1) return { ok: false, status: 404, error: 'not_found' }
  const restored = await docTrashRepo.restoreDoc(docId)
  if (!restored.ok) {
    switch (restored.reason) {
      case 'archived':
        return { ok: false, status: 409, error: 'doc_archived' }
      case 'purging':
        return { ok: false, status: 409, error: 'purge_in_progress' }
      case 'expired':
        return { ok: false, status: 410, error: 'trash_expired' }
      default:
        return { ok: false, status: 404, error: 'not_found' }
    }
  }
  if (restored.doc.changed) {
    await afterRestored(restored.doc.documentName, restored.doc.permissionEpoch)
  }
  return { ok: true }
}

/** POST /api/v1/docs/{docId}/restore */
export async function restoreDocHandler(req: Request, res: Response): Promise<void> {
  const actor = await resolveTrashActor(req, res)
  if (!actor) return
  const docId = req.params.docId!
  const meta = await loadAdminDoc(req, res, docId, actor)
  if (!meta) return
  // Reuse the row the authorization step already loaded: a second read could see
  // a different state and contradict the 403/409 the handler just decided.
  const result = await restoreOne(docId, actor, { meta })
  if (!result.ok) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.status(200).json({
    docId,
    status: 'restored',
    restoredAt: new Date().toISOString(),
  })
}

/** POST /api/v1/docs/{docId}/purge — body {confirm:true} */
export async function purgeDocHandler(req: Request, res: Response): Promise<void> {
  const actor = await resolveTrashActor(req, res)
  if (!actor) return
  const docId = req.params.docId!
  const meta = await loadAdminDoc(req, res, docId, actor)
  if (!meta) return
  if ((req.body ?? {}).confirm !== true) {
    res.status(400).json({ error: 'confirm_required' })
    return
  }
  const result = await purgeDocument(docId, { mode: 'strict' })
  if (!result.ok) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.status(204).end()
}

interface BatchItem {
  docId: string
  status: string
  error: string | null
}

/**
 * 批量 body 校验：`{doc_ids:[...]}`，≤50，去重保序。
 * 非法 => 400 invalid_request；超限 => 400 too_many_doc_ids。
 */
function parseBatchDocIds(req: Request, res: Response): string[] | null {
  const raw = (req.body ?? {}).doc_ids
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string')) {
    res.status(400).json({ error: 'invalid_request' })
    return null
  }
  const seen = new Set<string>()
  const docIds: string[] = []
  for (const item of raw as string[]) {
    const id = item.trim()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    docIds.push(id)
  }
  if (docIds.length > MAX_TRASH_BATCH) {
    res.status(400).json({ error: 'too_many_doc_ids' })
    return null
  }
  return docIds
}

function failed(docId: string, error: string): BatchItem {
  return { docId, status: 'failed', error }
}

/** POST /api/v1/docs/trash/restore — body {doc_ids:[...]} */
export async function batchRestoreHandler(req: Request, res: Response): Promise<void> {
  const actor = await resolveTrashActor(req, res)
  if (!actor) return
  const docIds = parseBatchDocIds(req, res)
  if (!docIds) return

  const items: BatchItem[] = []
  for (const docId of docIds) {
    // Same checks as the single entry point: an expired document or one whose
    // content purge already started must be refused per item, never reactivated.
    const restored = await restoreOne(docId, actor)
    items.push(restored.ok ? { docId, status: 'restored', error: null } : failed(docId, restored.error))
  }
  res.status(200).json({ items })
}

/** POST /api/v1/docs/trash/purge — body {doc_ids:[...]}（逐项彻底删除） */
export async function batchPurgeHandler(req: Request, res: Response): Promise<void> {
  const actor = await resolveTrashActor(req, res)
  if (!actor) return
  const docIds = parseBatchDocIds(req, res)
  if (!docIds) return

  const items: BatchItem[] = []
  for (const docId of docIds) {
    const meta = await docMetaRepo.getByDocId(docId)
    if (!meta) {
      items.push(failed(docId, 'not_found'))
      continue
    }
    const role = await directRole(meta, actor)
    if (!roleAtLeast(role, 'admin')) {
      items.push(failed(docId, 'forbidden'))
      continue
    }
    const result = await purgeDocument(docId, { mode: 'strict' })
    items.push(result.ok ? { docId, status: 'purged', error: null } : failed(docId, result.error))
  }
  res.status(200).json({ items })
}

docsTrashRouter.get('/trash', documentAsync(listTrashHandler))
docsTrashRouter.post('/trash/restore', documentAsync(batchRestoreHandler))
docsTrashRouter.post('/trash/purge', documentAsync(batchPurgeHandler))
docsTrashRouter.post('/:docId/restore', documentAsync(restoreDocHandler))
docsTrashRouter.post('/:docId/purge', documentAsync(purgeDocHandler))
