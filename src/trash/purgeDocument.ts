/**
 * 在线文档「彻底删除」的共用服务（OCTO-456 P1）。
 *
 * 两个入口共用同一段逻辑，保证前端手动彻底删除与保留期到期自动清理的行为
 * 不会分叉：
 *   - `POST /api/v1/docs/{docId}/purge`（strict：html 内容删失败 => 503，且
 *     **不删 doc_meta**，用户可重试）；
 *   - `src/trash/cleanupJob.ts`（best_effort：html 内容尽力删除，失败也继续删
 *     doc_meta，避免清理任务被一篇坏文档永久卡住）。
 *
 * 顺序：
 *   1. 读 doc_meta，只接受 `status=0`（回收站）。active => not_deleted，
 *      archived => doc_archived。
 *   2. **先**在行锁内持久化清理认领（`doc_meta.purge_state=1`）。远端调用之前
 *      落库是关键：恢复在锁内看到该状态会拒绝，重试看到该状态会继续，因此不会
 *      出现「元数据被恢复、正文已删」或「正文已删但没人再重试」。
 *   3. html 文档（doc_type='html' 且有 octo_doc_slug）调 octo-docs-html 的
 *      `/internal/html/purge`。任何失败（含未配置）都**保留 doc_meta**：行是唯一
 *      的重试依据，下一轮清理任务或用户重试还能沿这条链路继续。
 *   4. 数据库事务物理删除全部从属行 + doc_meta（docTrashRepo.purgeDoc）。
 *   5. best-effort：删对象存储里的附件二进制、投递一条索引失效信号
 *      （indexer 重读不到行即清理 OS 文档）。
 */
import { docMetaRepo, type DocMeta } from '../db/repos/docMetaRepo.js'
import { docTrashRepo, type PurgeClaimOutcome, type PurgeOutcome } from '../db/repos/docTrashRepo.js'
import { getObjectStore } from '../storage/objectStore.js'
import { enqueueDocIndex, isSearchIndexedDoc } from '../search/docIndexQueue.js'
import { HTML_DOC_TYPE } from '../db/docType.js'
import { htmlPurgeConfigured, purgeHtmlDocument, type HtmlPurgeResult } from '../api/services/htmlPurge.js'

export type PurgeMode = 'strict' | 'best_effort'

export interface PurgeDeps {
  getMeta(docId: string): Promise<DocMeta | null>
  /** 远端 html purge 是否配置（URL + token）。在认领前就要判断。 */
  htmlPurgeConfigured(): boolean
  claimPurge(docId: string): Promise<PurgeClaimOutcome>
  releasePurgeClaim(docId: string): Promise<void>
  purgeHtml(slug: string, docId: string, spaceId: string): Promise<HtmlPurgeResult>
  purgeRepo(docId: string): Promise<PurgeOutcome>
  deleteObject(objectKey: string): Promise<void>
  enqueueIndex(documentName: string): Promise<boolean>
}

const defaultDeps: PurgeDeps = {
  getMeta: (docId) => docMetaRepo.getByDocId(docId),
  htmlPurgeConfigured: () => htmlPurgeConfigured(),
  claimPurge: (docId) => docTrashRepo.claimPurge(docId),
  releasePurgeClaim: (docId) => docTrashRepo.releasePurgeClaim(docId),
  purgeHtml: (slug, docId, spaceId) => purgeHtmlDocument(slug, docId, spaceId),
  purgeRepo: (docId) => docTrashRepo.purgeDoc(docId),
  deleteObject: (objectKey) => getObjectStore().delete(objectKey),
  enqueueIndex: (documentName) => enqueueDocIndex(documentName),
}

export type PurgeDocumentResult =
  | { ok: true; documentName: string }
  | {
    ok: false
    status: 404 | 409 | 503
    error: 'not_found' | 'doc_archived' | 'not_deleted' | 'html_purge_failed'
  }

function logHtmlPurgeFailure(slug: string, result: HtmlPurgeResult): void {
  // eslint-disable-next-line no-console
  console.warn('[octo-docs] html purge failed for slug:', slug, result)
}

function mapClaim(claim: Extract<PurgeClaimOutcome, { ok: false }>): PurgeDocumentResult {
  switch (claim.reason) {
    case 'archived':
      return { ok: false, status: 409, error: 'doc_archived' }
    case 'not_deleted':
      return { ok: false, status: 409, error: 'not_deleted' }
    default:
      return { ok: false, status: 404, error: 'not_found' }
  }
}

function mapOutcome(outcome: PurgeOutcome): PurgeDocumentResult {
  if (outcome.ok) return { ok: true, documentName: outcome.doc.documentName }
  switch (outcome.reason) {
    case 'archived':
      return { ok: false, status: 409, error: 'doc_archived' }
    case 'not_deleted':
      return { ok: false, status: 409, error: 'not_deleted' }
    default:
      return { ok: false, status: 404, error: 'not_found' }
  }
}

/**
 * best-effort 的收尾：附件对象删除与索引信号都不允许把一次已经提交的彻底
 * 删除变成失败（DB 行已不可回滚，报错只会诱导客户端重试一个 404）。
 */
async function cleanupSideEffects(
  doc: { documentName: string; attachObjectKeys: readonly string[] },
  deps: PurgeDeps,
): Promise<void> {
  for (const objectKey of doc.attachObjectKeys) {
    try {
      await deps.deleteObject(objectKey)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[octo-docs] failed to delete purged attachment object:', objectKey, err)
    }
  }
  if (isSearchIndexedDoc(doc.documentName)) {
    await deps.enqueueIndex(doc.documentName).catch(() => false)
  }
}

export async function purgeDocument(
  docId: string,
  opts: { mode: PurgeMode; deps?: Partial<PurgeDeps> },
): Promise<PurgeDocumentResult> {
  const deps: PurgeDeps = { ...defaultDeps, ...opts.deps }
  const meta = await deps.getMeta(docId)
  if (!meta) return { ok: false, status: 404, error: 'not_found' }
  if (meta.status === 2) return { ok: false, status: 409, error: 'doc_archived' }
  if (meta.status !== 0) return { ok: false, status: 409, error: 'not_deleted' }

  const htmlSlug = meta.doc_type === HTML_DOC_TYPE ? meta.octo_doc_slug : null
  const htmlDoc = Boolean(htmlSlug)
  // Check the instance configuration BEFORE taking the claim. A claim we cannot
  // discharge would leave the row un-restorable, and — worse — a retry that hit
  // this branch used to release the marker a previous run left behind, so a
  // document whose content may already be gone became restorable again.
  if (htmlDoc && !deps.htmlPurgeConfigured()) {
    return { ok: false, status: 503, error: 'html_purge_failed' }
  }

  // Persist the claim BEFORE the remote call. Restore refuses a claimed row, and a
  // retry resumes it, so the two operations can never interleave into
  // "restored metadata + deleted content".
  const claim = await deps.claimPurge(docId)
  if (!claim.ok) return mapClaim(claim)

  if (htmlDoc) {
    const purged = await deps.purgeHtml(htmlSlug!, meta.doc_id, meta.space_id)
    if (!purged.ok || purged.skipped) {
      logHtmlPurgeFailure(htmlSlug!, purged)
      if (purged.ok && purged.skipped && !claim.resumed) {
        // Nothing was deleted remotely and THIS run created the claim, so the
        // document is still intact and must stay restorable. A RESUMED claim is
        // different: an earlier run may already have removed the content, so the
        // marker has to survive and the user must not be able to restore a
        // record without a body.
        await deps.releasePurgeClaim(docId).catch(() => undefined)
      }
      // BOTH modes keep doc_meta. For strict it is fail-closed for the caller; for
      // best_effort the row is the only thing that lets the next cleanup run find
      // this document again. Physically deleting it here would strand the remote
      // versions/assets with nothing left to retry from.
      return { ok: false, status: 503, error: 'html_purge_failed' }
    }
  }

  const outcome = await deps.purgeRepo(docId)
  const mapped = mapOutcome(outcome)
  if (!mapped.ok || !outcome.ok) return mapped
  await cleanupSideEffects(outcome.doc, deps)
  return mapped
}
