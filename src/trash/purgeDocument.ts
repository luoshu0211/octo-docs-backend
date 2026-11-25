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
 *   2. html 文档（doc_type='html' 且有 octo_doc_slug）先调 octo-docs-html 的
 *      `/internal/html/purge`；未配置时跳过（部署未启用远端回收）。
 *   3. 数据库事务物理删除全部从属行 + doc_meta（docTrashRepo.purgeDoc）。
 *   4. best-effort：删对象存储里的附件二进制、投递一条索引失效信号
 *      （indexer 重读不到行即清理 OS 文档）。
 *
 * 注意：html 远端 purge 发生在 DB 事务之前，极端并发下（同一瞬间 restore）
 * 可能出现「内容已删、doc_meta 被恢复」；彻底删除与恢复本就是互斥的用户操作，
 * 这里不为跨服务调用长期持有 DB 行锁（与改名链路的取舍一致）。
 */
import { docMetaRepo, type DocMeta } from '../db/repos/docMetaRepo.js'
import { docTrashRepo, type PurgeOutcome } from '../db/repos/docTrashRepo.js'
import { getObjectStore } from '../storage/objectStore.js'
import { enqueueDocIndex, isSearchIndexedDoc } from '../search/docIndexQueue.js'
import { HTML_DOC_TYPE } from '../db/docType.js'
import { purgeHtmlDocument, type HtmlPurgeResult } from '../api/services/htmlPurge.js'

export type PurgeMode = 'strict' | 'best_effort'

export interface PurgeDeps {
  getMeta(docId: string): Promise<DocMeta | null>
  purgeHtml(slug: string, docId: string, spaceId: string): Promise<HtmlPurgeResult>
  purgeRepo(docId: string): Promise<PurgeOutcome>
  deleteObject(objectKey: string): Promise<void>
  enqueueIndex(documentName: string): Promise<boolean>
}

const defaultDeps: PurgeDeps = {
  getMeta: (docId) => docMetaRepo.getByDocId(docId),
  purgeHtml: (slug, docId, spaceId) => purgeHtmlDocument(slug, docId, spaceId),
  purgeRepo: (docId) => docTrashRepo.purgeDoc(docId),
  deleteObject: (objectKey) => getObjectStore().delete(objectKey),
  enqueueIndex: (documentName) => enqueueDocIndex(documentName),
}

export type PurgeDocumentResult =
  | { ok: true; documentName: string }
  | { ok: false; status: 404 | 409 | 503; error: 'not_found' | 'doc_archived' | 'not_deleted' | 'html_purge_failed' }

function logHtmlPurgeFailure(slug: string, result: HtmlPurgeResult): void {
  // eslint-disable-next-line no-console
  console.warn('[octo-docs] html purge failed for slug:', slug, result)
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

  if (meta.doc_type === HTML_DOC_TYPE && meta.octo_doc_slug) {
    const purged = await deps.purgeHtml(meta.octo_doc_slug, meta.doc_id, meta.space_id)
    if (!purged.ok || purged.skipped) {
      logHtmlPurgeFailure(meta.octo_doc_slug, purged)
      // Strict (user-triggered purge): an unconfigured HTML backend is NOT a
      // reason to delete only doc_meta — the published content would stay
      // reachable behind its share link. Fail closed; the operator must
      // either configure OCTO_DOCS_HTML_INTERNAL_* or purge after it is set.
      if (opts.mode === 'strict') {
        return { ok: false, status: 503, error: 'html_purge_failed' }
      }
    }
  }

  const outcome = await deps.purgeRepo(docId)
  const mapped = mapOutcome(outcome)
  if (!mapped.ok || !outcome.ok) return mapped
  await cleanupSideEffects(outcome.doc, deps)
  return mapped
}
