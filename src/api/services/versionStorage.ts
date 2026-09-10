import { query } from '../../db/pool.js'
import { docVersionRepo, type DocVersion, type ListVersionsOptions } from '../../db/repos/docVersionRepo.js'
import type { DocMeta } from '../../db/repos/docMetaRepo.js'

/** Metadata is common; the PPT adapter reads its existing immutable payload table. */
export function versionStorage(meta: DocMeta) {
  if (meta.doc_type !== 'html_ppt') return docVersionRepo
  return {
    ...docVersionRepo,
    async listByDoc(docId: string, opts: ListVersionsOptions = {}) {
      const limit = Math.min(100, Math.max(1, Math.trunc(opts.limit ?? 25)))
      if (opts.kind === 'auto') return { items: [] as DocVersion[], nextCursor: null }
      const rows = await query<{ version_seq: number; kind: string; label: string; created_by: string; created_at: Date; size_bytes: number }>(
        `SELECT version_seq, kind, label, created_by, created_at, OCTET_LENGTH(deck_json) AS size_bytes FROM ppt_version
         WHERE doc_id = ? AND version_seq < ? ORDER BY version_seq DESC LIMIT ${limit + 1}`,
        [docId, opts.cursor ?? Number.MAX_SAFE_INTEGER])
      const items: DocVersion[] = rows.slice(0, limit).map(row => ({ id: Number(row.version_seq), docId,
        documentName: meta.document_name, kind: row.kind === 'safety' ? 3 : 2, name: row.label,
        createdAt: row.created_at, createdBy: row.created_by, sizeBytes: Number(row.size_bytes),
        schemaVersion: 1, restoredFrom: null, compressed: 0 }))
      return { items, nextCursor: rows.length > limit ? items[items.length - 1]!.id : null }
    },
    async countsByKind(docId: string) {
      const rows = await query<{ kind: string; count: number }>('SELECT kind, COUNT(*) AS count FROM ppt_version WHERE doc_id = ? GROUP BY kind', [docId])
      const restore = Number(rows.find(row => row.kind === 'safety')?.count ?? 0)
      const total = rows.reduce((sum, row) => sum + Number(row.count), 0)
      return { auto: 0, manual: total - restore, restore, total }
    },
  }
}
