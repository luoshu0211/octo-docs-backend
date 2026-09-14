import { commentMutationRole, isCommentAuthor, isCommentBody, isReplyRoot } from '../comments/policy.js'
import { transaction, type Tx } from '../db/pool.js'
import { pptIdempotencyRepo } from '../db/repos/pptIdempotencyRepo.js'
import { PptApiError } from '../api/ppt/envelope.js'
import { lockPptAuthority, lockPptLive, type PptPrincipal } from './liveEdit.js'
import { preparePptCollab } from './collabSession.js'
import { hashCanonicalPayload } from './idempotency.js'
import type { BentoDoc } from './bentoDoc.js'

/** Coordinates are fractions of the slide, independent of viewport zoom. */
export type PptCommentTarget = { kind: 'document' } | { kind: 'slide'; slideId: string } |
  { kind: 'element'; slideId: string; elementId: string; elementIds?: string[] } | { kind: 'point'; slideId: string; x: number; y: number }
export type PptCommentAnchor = PptCommentTarget & { versionSeq: number | null; baseRevision?: number }
export interface PptCommentInput { body: string; parentId?: number; anchor?: PptCommentAnchor }
interface CommentRow {
  id: number; doc_id: string; parent_id: number | null; author_uid: string; author_space_id: string;
  body: string; anchor_json: string | null; revision: number; resolved: number; deleted: number;
  created_at: Date; updated_at: Date;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PptApiError('VALIDATION_ERROR', 'expected an object')
  return value as Record<string, unknown>
}
export function pptCommentId(value: unknown, allowZero = false): number {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < (allowZero ? 0 : 1)) {
    throw new PptApiError('VALIDATION_ERROR', 'expected a positive integer')
  }
  return number
}
function bodyText(value: unknown): string {
  if (!isCommentBody(value, 10000) || Buffer.byteLength(value) > 40000) {
    throw new PptApiError('VALIDATION_ERROR', 'comment body must contain 1 to 10000 characters')
  }
  return value.trim()
}
export function validatePptComment(value: unknown): PptCommentInput {
  const input = object(value)
  if (Object.keys(input).some(key => !['body', 'parentId', 'anchor'].includes(key))) throw new PptApiError('VALIDATION_ERROR', 'unexpected comment field')
  const body = bodyText(input.body)
  if (input.parentId !== undefined) {
    if (input.anchor !== undefined) throw new PptApiError('VALIDATION_ERROR', 'replies cannot carry anchors')
    return { body, parentId: pptCommentId(input.parentId) }
  }
  const anchor = object(input.anchor)
  const fields = anchor.kind === 'document' ? [] : anchor.kind === 'slide' ? ['slideId']
    : anchor.kind === 'element' ? ['slideId', 'elementId', 'elementIds'] : anchor.kind === 'point' ? ['slideId', 'x', 'y'] : null
  const id = (value: unknown) => typeof value === 'string' && !!value.trim() && value.length <= 128
  if (!fields || Object.keys(anchor).some(key => !['kind', 'versionSeq', 'baseRevision', ...fields].includes(key)) ||
    (anchor.kind !== 'document' && !id(anchor.slideId)) || (anchor.kind === 'element' && (!id(anchor.elementId) || (anchor.elementIds !== undefined && (!Array.isArray(anchor.elementIds) || !anchor.elementIds.length || anchor.elementIds.length > 100 || !anchor.elementIds.every(id) || new Set(anchor.elementIds).size !== anchor.elementIds.length || !anchor.elementIds.includes(anchor.elementId))))) ||
    (anchor.kind === 'point' && [anchor.x, anchor.y].some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1))) {
    throw new PptApiError('VALIDATION_ERROR', 'invalid PPT comment target')
  }
  const target = Object.fromEntries(['kind', ...fields].filter(key => anchor[key] !== undefined).map(key => [key, anchor[key]])) as PptCommentTarget
  if (anchor.versionSeq === null) return { body, anchor: { ...target, versionSeq: null, baseRevision: pptCommentId(anchor.baseRevision, true) } }
  if (anchor.baseRevision !== undefined) throw new PptApiError('VALIDATION_ERROR', 'published anchors cannot carry baseRevision')
  return { body, anchor: { ...target, versionSeq: pptCommentId(anchor.versionSeq) } }
}
function serialize(row: CommentRow) {
  return { id: Number(row.id), docId: row.doc_id, parentId: row.parent_id === null ? null : Number(row.parent_id),
    authorUid: row.author_uid, authorSpaceId: row.author_space_id, body: row.deleted ? '' : row.body,
    anchor: row.anchor_json ? JSON.parse(row.anchor_json) as PptCommentAnchor : null,
    revision: Number(row.revision), resolved: !!row.resolved, deleted: !!row.deleted,
    createdAt: row.created_at, updatedAt: row.updated_at }
}
async function getRow(tx: Tx, docId: string, id: number): Promise<CommentRow> {
  const [row] = await tx.query<CommentRow>('SELECT * FROM ppt_comment WHERE doc_id = ? AND id = ? FOR UPDATE', [docId, id])
  if (!row) throw new PptApiError('NOT_FOUND', 'comment not found')
  return row
}
export async function listPptComments(principal: PptPrincipal, cursor = 0, parentId?: number, limit = 25, includeResolved = true) {
  pptCommentId(cursor, true)
  if (parentId !== undefined) pptCommentId(parentId)
  return transaction(async tx => {
    await lockPptAuthority(tx, principal, 'reader')
    if (parentId !== undefined && (await getRow(tx, principal.docId, parentId)).parent_id !== null) {
      throw new PptApiError('NOT_FOUND', 'thread not found')
    }
    // Root pages and reply pages are independently bounded. Never fetch an
    // unbounded thread behind a bounded roots query.
    const size = Math.min(100, Math.max(1, Math.trunc(limit)))
    const rows = await tx.query<CommentRow>(parentId === undefined
      ? `SELECT * FROM ppt_comment WHERE doc_id = ? AND parent_id IS NULL${includeResolved ? '' : ' AND resolved = 0'} AND id > ? ORDER BY id LIMIT ${size + 1}`
      : `SELECT * FROM ppt_comment WHERE doc_id = ? AND parent_id = ? AND id > ? ORDER BY id LIMIT ${size + 1}`,
    parentId === undefined ? [principal.docId, cursor] : [principal.docId, parentId, cursor])
    return { items: rows.slice(0, size).map(serialize), nextCursor: rows.length > size ? Number(rows[size - 1]!.id) : null }
  })
}
/** One locked read for the whole visible root page; each thread stays bounded. */
export async function listPptRepliesForRoots(principal: PptPrincipal, ids: number[]) {
  if (!ids.length) return []
  if (ids.length > 100) throw new PptApiError('VALIDATION_ERROR', 'too many thread roots')
  ids.forEach(id => pptCommentId(id))
  return transaction(async tx => {
    await lockPptAuthority(tx, principal, 'reader')
    const rows = await tx.query<CommentRow>(`SELECT * FROM (
      SELECT c.*, ROW_NUMBER() OVER (PARTITION BY parent_id ORDER BY id) AS reply_row
      FROM ppt_comment c WHERE doc_id = ? AND parent_id IN (${ids.map(() => '?').join(',')})
    ) replies WHERE reply_row <= 25 ORDER BY parent_id, id`, [principal.docId, ...ids])
    return rows.map(serialize)
  })
}
export async function getPptComment(principal: PptPrincipal, id: number) {
  return transaction(async tx => {
    await lockPptAuthority(tx, principal, 'reader')
    const comment = await getRow(tx, principal.docId, pptCommentId(id))
    const root = comment.parent_id === null ? comment : await getRow(tx, principal.docId, Number(comment.parent_id))
    return { comment: serialize(comment), root: serialize(root) }
  })
}

export async function createPptComment(principal: PptPrincipal, raw: PptCommentInput, key: string, afterCreate?: (id: number) => void): Promise<{ id: number }> {
  const input = validatePptComment(raw)
  if (!key || key.length > 128 || !/^[\x21-\x7e]+$/.test(key)) throw new PptApiError('VALIDATION_ERROR', 'Idempotency-Key is required')
  // Genesis preparation does not authorize the write. The transaction checks
  // current ACL before both normal execution and any receipt replay.
  if (input.anchor?.versionSeq === null) await preparePptCollab(principal.docId, principal.authorizedEpoch)
  let created = false
  const saved = await transaction(async tx => {
    await lockPptAuthority(tx, principal, 'commenter')
    const scope = 'comment', hash = hashCanonicalPayload({ docId: principal.docId, ...input })
    const [prior] = await tx.query<{ request_hash: string; response_body: string | null }>(
      'SELECT request_hash, response_body FROM ppt_idempotency WHERE space_id = ? AND scope = ? AND uid = ? AND idempotency_key = ? FOR UPDATE',
      [principal.spaceId, scope, principal.uid, key])
    if (prior) {
      if (prior.request_hash !== hash || !prior.response_body) throw new PptApiError('CONFLICT', 'idempotency key already in use')
      // Receipt contains only the created id, never a body later edited/deleted.
      return JSON.parse(prior.response_body) as { id: number }
    }
    if (!(await pptIdempotencyRepo.reserveTx(tx, principal.spaceId, scope, principal.uid, key, hash)).reserved) throw new PptApiError('CONFLICT', 'request in progress')
    if (input.parentId !== undefined) {
      const parent = await getRow(tx, principal.docId, input.parentId)
      if (!isReplyRoot({ parentId: parent.parent_id, deleted: false })) throw new PptApiError('NOT_FOUND', 'thread not found')
      if (parent.deleted || parent.resolved) throw new PptApiError('CONFLICT', 'thread is deleted or resolved')
    } else {
      const anchor = input.anchor!
      let deck: BentoDoc
      if (anchor.versionSeq === null) {
        const live = await lockPptLive(tx, principal.docId)
        if (live.revision !== anchor.baseRevision) throw new PptApiError('CONFLICT', 'PPT changed; refresh the slide selection')
        deck = live.deck
      } else {
        const [version] = await tx.query<{ deck_json: string }>('SELECT deck_json FROM ppt_version WHERE doc_id = ? AND version_seq = ?', [principal.docId, anchor.versionSeq])
        if (!version) throw new PptApiError('NOT_FOUND', 'version not found')
        deck = JSON.parse(version.deck_json) as BentoDoc
      }
      if (anchor.kind !== 'document') {
        const slides = deck.slides.filter(slide => slide.id === anchor.slideId)
        if (slides.length !== 1) throw new PptApiError('CONFLICT', 'slide is missing or ambiguous')
        if (anchor.kind === 'element' && (anchor.elementIds ?? [anchor.elementId]).some(id => slides[0]!.elements.filter(element => element && typeof element === 'object' && (element as { id?: unknown }).id === id).length !== 1)) {
          throw new PptApiError('CONFLICT', 'element is missing or ambiguous')
        }
      }
    }
    await tx.execute('INSERT INTO ppt_comment (doc_id, parent_id, author_uid, author_space_id, body, anchor_json) VALUES (?, ?, ?, ?, ?, ?)',
      [principal.docId, input.parentId ?? null, principal.uid, principal.spaceId, input.body, input.anchor ? JSON.stringify(input.anchor) : null])
    const [row] = await tx.query<{ id: number }>('SELECT LAST_INSERT_ID() AS id')
    const result = { id: pptCommentId(Number(row!.id)) }
    await pptIdempotencyRepo.completeTx(tx, principal.spaceId, scope, principal.uid, key, 201, result, principal.docId)
    created = true
    return result
  })
  // Side effects start only after commit, never on receipt replay or rollback.
  // An unavailable mention service must not turn a committed comment into an error.
  if (created && afterCreate) {
    try { afterCreate(saved.id) } catch {
      // eslint-disable-next-line no-console
      console.warn('[octo-docs] PPT comment after-create failed', { docId: principal.docId, commentId: saved.id })
    }
  }
  return saved
}

type CommentMutation = { revision: number } & (
  { action: 'edit'; body: string } | { action: 'resolve'; resolved: boolean } | { action: 'delete'; hard?: boolean })
export function validatePptCommentMutation(value: unknown): CommentMutation {
  const input = object(value), revision = pptCommentId(input.revision)
  const keys = input.action === 'edit' ? ['action', 'revision', 'body'] : input.action === 'resolve' ? ['action', 'revision', 'resolved'] : ['action', 'revision', 'hard']
  if (Object.keys(input).some(key => !keys.includes(key))) throw new PptApiError('VALIDATION_ERROR', 'unexpected mutation field')
  if (input.action === 'edit') return { action: 'edit', revision, body: bodyText(input.body) }
  if (input.action === 'resolve' && typeof input.resolved === 'boolean') return { action: 'resolve', revision, resolved: input.resolved }
  if (input.action === 'delete' && (input.hard === undefined || typeof input.hard === 'boolean')) return { action: 'delete', revision, hard: input.hard === true }
  throw new PptApiError('VALIDATION_ERROR', 'invalid comment mutation')
}
export async function mutatePptComment(principal: PptPrincipal, id: number, raw: CommentMutation) {
  pptCommentId(id)
  const change = validatePptCommentMutation(raw)
  return transaction(async tx => {
    await lockPptAuthority(tx, principal, commentMutationRole(change.action, change.action === 'delete' && change.hard))
    const row = await getRow(tx, principal.docId, id)
    if ((change.action === 'edit' || (change.action === 'delete' && !change.hard)) &&
        !isCommentAuthor({ authorUid: row.author_uid, authorSpaceId: row.author_space_id }, principal)) throw new PptApiError('FORBIDDEN', 'only the author may change this comment')
    if (Number(row.revision) !== change.revision) throw new PptApiError('CONFLICT', 'comment changed; refresh before retrying')
    if (change.action === 'delete' && change.hard) {
      await tx.execute('DELETE FROM ppt_comment WHERE doc_id = ? AND (id = ? OR parent_id = ?)', [principal.docId, id, id])
    } else {
      if (row.deleted) throw new PptApiError('NOT_FOUND', 'comment deleted')
      if (change.action === 'resolve' && row.parent_id !== null) throw new PptApiError('VALIDATION_ERROR', 'only a root can be resolved')
      const update = change.action === 'edit' ? 'body = ?' : change.action === 'resolve' ? 'resolved = ?' : "deleted = 1, body = ''"
      const params = change.action === 'edit' ? [change.body] : change.action === 'resolve' ? [change.resolved ? 1 : 0] : []
      await tx.execute(`UPDATE ppt_comment SET ${update}, revision = revision + 1, updated_at = CURRENT_TIMESTAMP(3) WHERE doc_id = ? AND id = ?`, [...params, principal.docId, id])
    }
    return { id, revision: change.revision + 1 }
  })
}
