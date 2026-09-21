import { PptRoomCapacityError, withPptCompaction } from './compaction.js'
import { randomUUID } from 'node:crypto'
import { transaction, type Tx } from '../db/pool.js'
import type { DocMeta } from '../db/repos/docMetaRepo.js'
import { docMemberRepo } from '../db/repos/docMemberRepo.js'
import { pptRelaySeqRepo } from '../db/repos/pptRelaySeqRepo.js'
import { pptCollabFrameRepo } from '../db/repos/pptCollabFrameRepo.js'
import { pptCollabOpRepo } from '../db/repos/pptCollabOpRepo.js'
import { effectiveRole } from '../permission/shareScope.js'
import { roleAtLeast, type Role } from '../permission/role.js'
import { PptApiError } from '../api/ppt/envelope.js'
import { config } from '../config/env.js'
import { SyncState, type SyncStateJSON } from './sync/slidesSync.js'
import type { BentoDoc } from './bentoDoc.js'
import { validatePptDraft } from './draft.js'
import { hashBentoDeck } from './source.js'
import { preparePptCollab } from './collabSession.js'
import { canonicalPayloadHash, withStoreRetry } from './relay/store.js'
import { opsOfFrame } from './relay/snapshotter.js'
import { inPptRoom, pptRoomEvents } from './roomCoordinator.js'
import { diffPpt } from './diff.js'
import { assertPptDocumentBudget } from './documentBudget.js'

export interface PptPrincipal {
  docId: string
  uid: string
  spaceId: string
  authorizedEpoch: number
  isBot?: boolean
}

/** The caller proves its current Space at the HTTP boundary; recheck ACL under
 * the same doc row lock used by membership mutations before any durable write. */
export async function lockPptAuthority(tx: Tx, input: PptPrincipal, minimum: Role): Promise<DocMeta> {
  const [meta] = await tx.query<DocMeta>('SELECT * FROM doc_meta WHERE doc_id = ? FOR UPDATE', [input.docId])
  if (!meta || meta.status === 0) throw new PptApiError('NOT_FOUND', 'document not found')
  if (meta.doc_type !== 'html_ppt') throw PptApiError.unsupportedDocumentType('document is not a PPT')
  if (Number(meta.permission_epoch) !== input.authorizedEpoch) throw new PptApiError('FORBIDDEN', 'permissions changed; read again')
  const direct = meta.owner_id === input.uid && meta.owner_space_id === input.spaceId
    ? 'admin' : ((await docMemberRepo.getRoleTx(tx, input.docId, input.uid, input.spaceId)) ?? 'none')
  const role = input.isBot && input.spaceId !== meta.space_id ? direct
    : effectiveRole(direct, input.spaceId === meta.space_id, meta.share_scope, meta.share_role)
  if (!roleAtLeast(role, minimum)) throw new PptApiError('FORBIDDEN', `${minimum} role required`)
  if (meta.status !== 1) throw new PptApiError('CONFLICT', 'document is archived')
  return meta
}

/** Room counter first, then snapshot and tail: concurrent appends cannot slip
 * between a base-revision check and the resulting write. Never reset CRDT state. */
export async function lockPptLive(tx: Tx, docId: string) {
  await tx.execute('INSERT IGNORE INTO ppt_collab_seq (doc_id, last_seq) VALUES (?, 0)', [docId])
  const [counter] = await tx.query<{ last_seq: number }>('SELECT last_seq FROM ppt_collab_seq WHERE doc_id = ? FOR UPDATE', [docId])
  const [snapshot] = await tx.query<{ covered_seq: number; doc_json: string; state_json: string }>(
    'SELECT covered_seq, doc_json, state_json FROM ppt_live_snapshot WHERE doc_id = ? FOR UPDATE', [docId])
  if (!snapshot?.state_json) throw new PptApiError('CONFLICT', 'live snapshot unavailable')
  const deck = JSON.parse(snapshot.doc_json) as BentoDoc
  const sync = SyncState.fromJSON('@rest-replay', JSON.parse(snapshot.state_json) as SyncStateJSON)
  const tail = await tx.query<{ frame_json: string; frame_bytes: number }>(
    'SELECT frame_json, frame_bytes FROM ppt_collab_op WHERE doc_id = ? AND seq > ? ORDER BY seq FOR UPDATE',
    [docId, Number(snapshot.covered_seq)])
  const [budget] = await tx.query<{ bytes: number }>('SELECT COALESCE(SUM(frame_bytes), 0) AS bytes FROM ppt_collab_op WHERE doc_id = ?', [docId])
  const bytes = Number(budget?.bytes ?? 0)
  for (const row of tail) {
    sync.apply(deck, opsOfFrame(JSON.parse(row.frame_json)))
  }
  if (sync.bufferedOps.length) throw new PptApiError('CONFLICT', 'live operations are still catching up; retry')
  return { deck, sync: SyncState.fromJSON('@rest-v1', sync.toJSON()), revision: Number(counter!.last_seq), bytes }
}

export function validatePptEdit(body: unknown): { baseRevision: number; deck: BentoDoc } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PptApiError('VALIDATION_ERROR', 'expected an edit object')
  const input = body as Record<string, unknown>
  if (Object.keys(input).some(key => key !== 'baseRevision' && key !== 'deck')) throw new PptApiError('VALIDATION_ERROR', 'unexpected edit field')
  const { revision, deck } = validatePptDraft({ revision: input.baseRevision, deck: input.deck })
  return { baseRevision: revision, deck }
}

export async function appendPptEditTx(tx: Tx, principal: PptPrincipal, live: Awaited<ReturnType<typeof lockPptLive>>, after: BentoDoc) {
  validatePptDraft({ revision: live.revision, deck: after })
  if (after.docId !== live.deck.docId) throw new PptApiError('VALIDATION_ERROR', 'Bento document identity cannot change')
  if (after.title !== live.deck.title) await lockPptAuthority(tx, principal, 'admin')
  // JSON object order is not document content (Go clients sort object keys).
  // Avoid minting CRDT stamps or revisions for a read-back submitted unchanged.
  const contentHash = hashBentoDeck(after)
  if (contentHash === hashBentoDeck(live.deck)) return { revision: live.revision, contentHash, changed: false, frames: [] }
  // Replay with a distinct actor and the pre-diff vector: minting advances the
  // originating actor, so replaying on live.sync would skip its own operations.
  const replay = SyncState.fromJSON('@rest-budget-replay', live.sync.toJSON())
  const ops = diffPpt(live.sync, live.deck, after)
  const frames: { revision: number; frame: { t: 'ops'; pv: number; frameId: string; ops: typeof ops } }[] = []
  if (!ops.length) return { revision: live.revision, contentHash: hashBentoDeck(live.deck), changed: false, frames }
  const materialized = structuredClone(live.deck)
  replay.apply(materialized, ops)
  assertPptDocumentBudget(materialized)
  // A restore can contain more than one wire frame. Pack it before any write,
  // then append every frame in one transaction; a failed chunk rolls back all.
  const packed: { frame: (typeof frames)[number]['frame']; json: string; bytes: number }[] = []
  const makeFrame = (): (typeof frames)[number]['frame'] => ({ t: 'ops', pv: config.ppt.relay.protocolVersion, frameId: randomUUID(), ops: [] })
  let frame = makeFrame()
  const overhead = Buffer.byteLength(JSON.stringify(frame))
  let bytes = overhead
  const flush = () => {
    if (!frame.ops.length) return
    const json = JSON.stringify(frame)
    packed.push({ frame, json, bytes: Buffer.byteLength(json) })
    frame = makeFrame(); bytes = overhead
  }
  for (const op of ops) {
    const size = Buffer.byteLength(JSON.stringify(op))
    if (overhead + size > config.ppt.relay.maxFrameBytes) throw new PptApiError('PAYLOAD_TOO_LARGE', 'a PPT operation exceeds the frame limit')
    if (frame.ops.length >= config.ppt.relay.maxOpsPerFrame || bytes + size + 1 > config.ppt.relay.maxFrameBytes) flush()
    bytes += size + (frame.ops.length ? 1 : 0)
    frame.ops.push(op)
  }
  flush()
  if (live.bytes + packed.reduce((sum, item) => sum + item.bytes, 0) > config.ppt.relay.maxRoomFrameBytes) throw new PptRoomCapacityError()
  let revision = live.revision
  for (const item of packed) {
    revision = await pptRelaySeqRepo.nextSeqTx(tx, principal.docId)
    await pptCollabFrameRepo.insertTx(tx, principal.docId, item.frame.frameId, revision, canonicalPayloadHash(item.frame))
    await pptCollabOpRepo.insertTx(tx, principal.docId, revision, item.frame.frameId, item.json, item.bytes)
    frames.push({ revision, frame: item.frame })
  }
  await tx.execute('UPDATE doc_meta SET title = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE doc_id = ?',
    [after.title.trim(), principal.uid, principal.docId])
  return { revision, contentHash: hashBentoDeck(materialized), changed: true, frames, roomBytesAfter: live.bytes + packed.reduce((sum, item) => sum + item.bytes, 0) }
}

/** Whole JSON input is compiled into ordinary Bento ops. A stale full document
 * is rejected, never silently applied over edits that the caller has not read. */
export async function editPptLive(principal: PptPrincipal, input: { baseRevision: number; deck: BentoDoc } | { title: string }) {
  return inPptRoom(principal.docId, async () => {
    await preparePptCollab(principal.docId, principal.authorizedEpoch)
    const result = await withPptCompaction(principal.docId, () => withStoreRetry('ppt-rest-edit', () => transaction(async tx => {
      await lockPptAuthority(tx, principal, 'title' in input ? 'admin' : 'writer')
      const live = await lockPptLive(tx, principal.docId)
      if ('baseRevision' in input && live.revision !== input.baseRevision) {
        throw new PptApiError('CONFLICT', 'PPT changed; read the current deck and reapply your changes', { details: { revision: live.revision } })
      }
      const after = 'title' in input ? { ...structuredClone(live.deck), title: input.title } : structuredClone(input.deck)
      return appendPptEditTx(tx, principal, live, after)
    })))
    for (const item of result.frames) pptRoomEvents.emit('changed', principal.docId, { ctl: 'op', q: item.revision, frame: item.frame })
    return { revision: result.revision, contentHash: result.contentHash, changed: result.changed }
  })
}
