import { withPptCompaction } from './compaction.js'
import { query, transaction, type Tx } from '../db/pool.js'
import { pptIdempotencyRepo } from '../db/repos/pptIdempotencyRepo.js'
import { PptApiError } from '../api/ppt/envelope.js'
import { appendPptEditTx, lockPptAuthority, lockPptLive, type PptPrincipal } from './liveEdit.js'
import { preparePptCollab } from './collabSession.js'
import { inPptRoom, pptRoomEvents } from './roomCoordinator.js'
import { hashBentoDeck } from './source.js'
import { hashCanonicalPayload } from './idempotency.js'
import { renderPptHtml } from './render.js'
import { withStoreRetry } from './relay/store.js'
import type { BentoDoc } from './bentoDoc.js'

interface VersionRow {
  version_seq: number; kind: string; label: string; base_revision: number;
  deck_json: string; html: string; content_hash: string; created_by: string; created_at: Date;
}
const summary = (row: VersionRow) => ({ versionSeq: Number(row.version_seq), kind: row.kind, label: row.label,
  baseRevision: Number(row.base_revision), contentHash: row.content_hash, createdBy: row.created_by, createdAt: row.created_at })

export async function getPptVersion(docId: string, version: 'latest' | number) {
  const rows = await query<VersionRow>(version === 'latest'
    ? 'SELECT v.* FROM ppt_version v JOIN ppt_doc_state s ON s.doc_id = v.doc_id AND s.published_version_seq = v.version_seq WHERE v.doc_id = ?'
    : 'SELECT * FROM ppt_version WHERE doc_id = ? AND version_seq = ?', version === 'latest' ? [docId] : [docId, version])
  const row = rows[0]
  if (!row) return null
  return { ...summary(row), deck: JSON.parse(row.deck_json) as BentoDoc, html: row.html }
}

export interface VersionAction { baseRevision: number; label: string; versionSeq?: number }
export function validateVersionAction(body: unknown, restore = false): VersionAction {
  const value = body as Record<string, unknown> | null
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['baseRevision', 'label', ...(restore ? ['versionSeq'] : [])].includes(key)) ||
      !Number.isSafeInteger(value.baseRevision) || Number(value.baseRevision) < 0 ||
      (value.label !== undefined && (typeof value.label !== 'string' || value.label.length > 256)) ||
      (restore && (!Number.isSafeInteger(value.versionSeq) || Number(value.versionSeq) < 1))) {
    throw new PptApiError('VALIDATION_ERROR', 'expected baseRevision, optional label, and a positive versionSeq for restore')
  }
  return { baseRevision: Number(value.baseRevision), label: typeof value.label === 'string' ? value.label.trim() : '',
    ...(restore ? { versionSeq: Number(value.versionSeq) } : {}) }
}

async function insertVersion(tx: Tx, principal: PptPrincipal, deck: BentoDoc, revision: number, kind: string, label: string) {
  const [last] = await tx.query<{ version_seq: number }>('SELECT version_seq FROM ppt_version WHERE doc_id = ? ORDER BY version_seq DESC LIMIT 1 FOR UPDATE', [principal.docId])
  const versionSeq = Number(last?.version_seq ?? 0) + 1
  const contentHash = hashBentoDeck(deck)
  const html = await renderPptHtml(deck)
  const deckJson = JSON.stringify(deck)
  const [packet] = await tx.query<{ packet_bytes: number }>('SELECT @@max_allowed_packet AS packet_bytes')
  const packetBytes = Number(packet?.packet_bytes)
  // The prepared execute packet carries both strings plus identity/label fields.
  // Leave 64 KiB for SQL/protocol metadata and fail before any version write.
  if (!Number.isFinite(packetBytes) || Buffer.byteLength(deckJson) + Buffer.byteLength(html) + 65536 > packetBytes) {
    throw new PptApiError('PAYLOAD_TOO_LARGE', 'PPT version exceeds the database packet limit')
  }
  await tx.execute('INSERT INTO ppt_version (doc_id, version_seq, kind, label, base_revision, deck_json, html, content_hash, created_by, principal_space_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [principal.docId, versionSeq, kind, label, revision, deckJson, html, contentHash, principal.uid, principal.spaceId])
  return { versionSeq, contentHash }
}

/** Snapshot/restore are one transaction: lock authority + live, compare revision,
 * allocate immutable version, update pointer, then commit the replay receipt.
 * Restore adds a safety version and emits ordinary ops, never a CRDT reset. */
export async function changePptVersion(principal: PptPrincipal, action: 'create' | 'restore', input: VersionAction, key: string): Promise<Record<string, unknown>> {
  if (!key.trim() || key.length > 255) throw new PptApiError('VALIDATION_ERROR', 'Idempotency-Key is required (1 to 255 characters)')
  const scope = action === 'create' ? 'version-create' : 'restore'
  return inPptRoom(principal.docId, async () => {
    await preparePptCollab(principal.docId, principal.authorizedEpoch)
    const result = await withPptCompaction(principal.docId, () => withStoreRetry('ppt-version', () => transaction(async tx => {
      await lockPptAuthority(tx, principal, action === 'restore' ? 'admin' : 'writer')
      const hash = hashCanonicalPayload({ docId: principal.docId, action, ...input })
      const [prior] = await tx.query<{ request_hash: string; response_body: string }>(
        'SELECT request_hash, response_body FROM ppt_idempotency WHERE space_id = ? AND scope = ? AND uid = ? AND idempotency_key = ? FOR UPDATE',
        [principal.spaceId, scope, principal.uid, key])
      if (prior) {
        if (prior.request_hash !== hash) throw new PptApiError('CONFLICT', 'Idempotency-Key reused with a different payload')
        return { data: JSON.parse(prior.response_body) as Record<string, unknown> }
      }
      if (!(await pptIdempotencyRepo.reserveTx(tx, principal.spaceId, scope, principal.uid, key, hash)).reserved) {
        throw new PptApiError('CONFLICT', 'request in progress; retry with the same key')
      }
      const live = await lockPptLive(tx, principal.docId)
      if (live.revision !== input.baseRevision) throw new PptApiError('CONFLICT', 'PPT changed; read again before creating a version or restoring', { details: { revision: live.revision } })
      if (action === 'create') {
        const data = { ...await insertVersion(tx, principal, live.deck, live.revision, 'named', input.label), revision: live.revision }
        await tx.execute('UPDATE ppt_doc_state SET published_version_seq = ? WHERE doc_id = ?', [data.versionSeq, principal.docId])
        await pptIdempotencyRepo.completeTx(tx, principal.spaceId, scope, principal.uid, key, 201, data, principal.docId)
        return { data }
      }
      const [target] = await tx.query<VersionRow>('SELECT * FROM ppt_version WHERE doc_id = ? AND version_seq = ? FOR UPDATE', [principal.docId, input.versionSeq])
      if (!target) throw new PptApiError('NOT_FOUND', 'version not found')
      const safety = await insertVersion(tx, principal, live.deck, live.revision, 'safety', 'Before restore')
      const edit = await appendPptEditTx(tx, principal, live, JSON.parse(target.deck_json) as BentoDoc)
      const data = { restoredVersionSeq: input.versionSeq, safetyVersionSeq: safety.versionSeq, revision: edit.revision, contentHash: edit.contentHash }
      await pptIdempotencyRepo.completeTx(tx, principal.spaceId, scope, principal.uid, key, 200, data, principal.docId)
      return { data, frames: edit.frames, roomBytesAfter: edit.roomBytesAfter }
    })))
    for (const item of result.frames ?? []) pptRoomEvents.emit('changed', principal.docId, { ctl: 'op', q: item.revision, frame: item.frame })
    return result.data
  })
}
