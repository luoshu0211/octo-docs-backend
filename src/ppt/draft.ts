import { transaction } from '../db/pool.js'
import { docMemberRepo } from '../db/repos/docMemberRepo.js'
import type { DocMeta } from '../db/repos/docMetaRepo.js'
import { effectiveRole } from '../permission/shareScope.js'
import { roleAtLeast } from '../permission/role.js'
import { PptApiError } from '../api/ppt/envelope.js'
import type { BentoDoc } from './bentoDoc.js'
import { hashBentoDeck } from './source.js'
import { config } from '../config/env.js'

function invalid(message: string): never {
  throw new PptApiError('VALIDATION_ERROR', message)
}

/** Validate the persisted envelope without stripping additive Bento fields. */
export function validatePptDraft(body: unknown): { revision: number; deck: BentoDoc } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('expected a draft object')
  const input = body as Record<string, unknown>
  if (Object.keys(input).some(key => key !== 'revision' && key !== 'deck')) invalid('unexpected draft field')
  if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 0) invalid('revision must be a non-negative integer')
  const deck = input.deck as BentoDoc | undefined
  if (!deck || deck.format !== 'bento/slides' || deck.version !== 1) invalid('unsupported Bento document format')
  if (typeof deck.docId !== 'string' || !deck.docId) invalid('document identity is required')
  if (typeof deck.title !== 'string' || !deck.title.trim() || deck.title.length > 512) invalid('title must contain 1 to 512 characters')
  if (deck.template || deck.collab || deck.readonly) invalid('templates, external collaboration and readonly payloads cannot replace a draft')
  if (!deck.size || ![deck.size.width, deck.size.height].every(n => Number.isFinite(n) && n > 0 && n <= 16384)) invalid('invalid slide dimensions')
  if (!deck.theme || typeof deck.theme !== 'object') invalid('theme is required')
  if (!Array.isArray(deck.slides) || deck.slides.length < 1 || deck.slides.length > 500) invalid('expected 1 to 500 slides')
  const slides = new Set<string>()
  let elements = 0
  for (const slide of deck.slides) {
    if (!slide || typeof slide.id !== 'string' || !slide.id || slides.has(slide.id)) invalid('slide IDs must be nonempty and unique')
    slides.add(slide.id)
    if (!Array.isArray(slide.elements)) invalid('slide elements must be an array')
    const ids = new Set<string>()
    for (const value of slide.elements) {
      const el = value as Record<string, unknown> | null
      if (!el || typeof el !== 'object' || typeof el.id !== 'string' || !el.id || ids.has(el.id)) invalid('element IDs must be unique within each slide')
      ids.add(el.id)
      if (typeof el.type !== 'string') invalid('element type is required')
      if (++elements > 10000) invalid('too many elements')
    }
  }
  const pending: { value: unknown; depth: number }[] = [{ value: deck, depth: 0 }]
  let nodes = 0
  while (pending.length) {
    const { value, depth } = pending.pop()!
    if (depth > 100) invalid('document nesting exceeds 100 levels')
    if (++nodes > 250000) invalid('document has too many values')
    if (typeof value === 'number' && !Number.isFinite(value)) invalid('document numbers must be finite')
    if (['bigint', 'function', 'symbol', 'undefined'].includes(typeof value)) invalid('document must contain only JSON values')
    if (!value || typeof value !== 'object') continue
    for (const [key, child] of Object.entries(value)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') invalid('unsafe document property')
      pending.push({ value: child, depth: depth + 1 })
    }
  }
  if (Buffer.byteLength(JSON.stringify(deck)) > config.ppt.relay.maxSingleBlobBytes) invalid('document exceeds the size limit')
  return { revision: Number(input.revision), deck }
}

/** Draft-only CAS. Live snapshots and relay history are never replaced. */
export async function savePptDraft(input: {
  docId: string; uid: string; spaceId: string; authorizedEpoch: number;
  revision: number; deck: BentoDoc;
}): Promise<{ revision: number; contentHash: string }> {
  return transaction(async tx => {
    const rows = await tx.query<DocMeta>('SELECT * FROM doc_meta WHERE doc_id = ? FOR UPDATE', [input.docId])
    const meta = rows[0]
    if (!meta || meta.status === 0) throw new PptApiError('NOT_FOUND', 'document not found')
    if (meta.status !== 1) throw new PptApiError('CONFLICT', 'document is archived')
    if (meta.doc_type !== 'html_ppt') throw PptApiError.unsupportedDocumentType('document is not an html_ppt deck')
    if (Number(meta.permission_epoch) !== input.authorizedEpoch) throw new PptApiError('FORBIDDEN', 'document permissions changed; reload before saving')
    const direct = meta.owner_id === input.uid && meta.owner_space_id === input.spaceId
      ? 'admin' : ((await docMemberRepo.getRoleTx(tx, input.docId, input.uid, input.spaceId)) ?? 'none')
    // Active current-Space membership was proved by the route. Re-read the role
    // and share settings under the lock used by permission mutations.
    if (!roleAtLeast(effectiveRole(direct, input.spaceId === meta.space_id, meta.share_scope, meta.share_role), 'writer')) {
      throw new PptApiError('FORBIDDEN', 'writer role required')
    }
    const live = await tx.query('SELECT doc_id FROM ppt_live_snapshot WHERE doc_id = ? FOR UPDATE', [input.docId])
    if (live.length) throw new PptApiError('CONFLICT', 'live collaboration owns this draft; reopen the editor')
    const states = await tx.query<{ draft_revision: number; draft_doc: string }>(
      'SELECT draft_revision, draft_doc FROM ppt_doc_state WHERE doc_id = ? FOR UPDATE', [input.docId],
    )
    const state = states[0]
    if (!state) throw new PptApiError('NOT_FOUND', 'draft not found')
    if (Number(state.draft_revision) !== input.revision) {
      throw new PptApiError('CONFLICT', 'draft changed; reload before saving', { details: { revision: Number(state.draft_revision) } })
    }
    const previous = typeof state.draft_doc === 'string' ? JSON.parse(state.draft_doc) as BentoDoc : state.draft_doc as unknown as BentoDoc
    if (direct !== 'admin' && previous.title !== input.deck.title) {
      throw new PptApiError('FORBIDDEN', 'admin role required to rename a document')
    }
    if (previous.docId !== input.deck.docId) invalid('draft document identity cannot change')
    const deck = { ...input.deck, modified: new Date().toISOString() }
    await tx.execute('UPDATE ppt_doc_state SET draft_doc = ?, draft_revision = draft_revision + 1 WHERE doc_id = ?', [JSON.stringify(deck), input.docId])
    await tx.execute('UPDATE doc_meta SET title = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE doc_id = ?', [deck.title.trim(), input.uid, input.docId])
    return { revision: input.revision + 1, contentHash: hashBentoDeck(deck) }
  })
}
