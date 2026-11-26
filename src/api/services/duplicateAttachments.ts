/**
 * Attachment migration for §4.4 复制 (P1-3).
 *
 * A document's body stores only *references* to attachments (`attachId` on the
 * ProseMirror `image` / `fileAttachment` nodes, and `files[fileId].attachId` in
 * a whiteboard scene). The binary lives in object storage and its ownership is
 * the `doc_attachment.doc_id` edge. Copying the Yjs body verbatim therefore left
 * every reference pointing at an attachment registered under the SOURCE doc, and
 * `GET /api/v1/docs/{copyDocId}/attachments/{attachId}` correctly 404'd on the
 * copy (whiteboard images / export images missing).
 *
 * This module walks the ACTUAL body state, copies only the attachments it really
 * references, and rewrites those references to the freshly minted ids. It reuses
 * `copyStoredObject` (the same server-side object-storage copy the markdown
 * import path uses): bytes are copied store-to-store under the target docId and
 * a new `doc_attachment` row is registered for the target.
 *
 * Failure policy: a referenced attachment whose `doc_attachment` row is missing
 * or belongs to a different document is SKIPPED (nothing to copy); a storage copy
 * failure aborts the duplicate and removes what was already copied, so the caller
 * never registers a `doc_meta` row whose body points at attachments that do not
 * exist. The caller cleans up again if the later DB transaction fails.
 */
import * as Y from 'yjs'
import { docAttachmentRepo } from '../../db/repos/docAttachmentRepo.js'
import { cleanupCopiedAttachment, copyStoredObject } from '../routes/attachments.js'
import { COLLAB_FIELD } from '../../schema/index.js'
import { ELEMENTS_FIELD, FILES_FIELD } from '../../whiteboard/schema/index.js'

/**
 * Promote the root types this backend actually stores attachments under.
 *
 * A Y.Doc hydrated from raw update bytes (`Y.applyUpdate`) leaves each root as a
 * bare `AbstractType` placeholder until a typed getter instance-checks it, so a
 * naive `doc.share.values()` walk sees methods-less placeholders and finds no
 * `attachId`. Promotion is type-specific and irreversible, hence the closed set:
 *   · `default`       — the ProseMirror XmlFragment of doc/sheet bodies;
 *   · `elements`/`files` — the whiteboard scene and its FileRef container.
 * Unknown roots are walked as-is (a no-op for attachments); adding a new
 * attachment-bearing root here is a one-line change.
 */
function visitRootTypes(doc: Y.Doc, visit: (root: unknown) => void): void {
  for (const name of doc.share.keys()) {
    if (name === COLLAB_FIELD) visit(doc.getXmlFragment(name))
    else if (name === ELEMENTS_FIELD || name === FILES_FIELD) visit(doc.getMap(name))
    else {
      const root = doc.share.get(name)
      if (root) visit(root)
    }
  }
}

export interface CopiedAttachment {
  sourceAttachId: string
  attachId: string
}

export interface CopyReferencedAttachmentsResult {
  /** Body state with every copied `attachId` rewritten (unchanged when none). */
  state: Uint8Array
  copied: CopiedAttachment[]
}

/**
 * True when a live-state read carries no document content. `readLiveDocState`
 * always encodes the (possibly freshly opened) Y.Doc, and an empty doc encodes
 * to the canonical 2-byte v1 update `[0, 0]`. Treating that as "no body" keeps
 * the historical behaviour of not inserting an empty yjs_document row for a
 * source that was never opened/stored — while still copying every non-empty
 * live state.
 */
export function isEffectivelyEmptyYjsUpdate(state: Uint8Array): boolean {
  return state.length === 0 || (state.length === 2 && state[0] === 0 && state[1] === 0)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Collect every `attachId` referenced anywhere in the Yjs state.
 *
 * Generic by design: it walks every root type, so it covers the ProseMirror XML
 * attributes of a doc, the `files` Y.Map of a whiteboard scene, and any future
 * kind that stores the same field — without a per-doc-type code path that could
 * silently drift from the real body shape.
 */
export function collectReferencedAttachIds(state: Uint8Array): string[] {
  if (state.length === 0) return []
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  const ids = new Set<string>()
  const seen = new Set<unknown>()

  const visit = (value: unknown): void => {
    if (value instanceof Y.Map) {
      if (seen.has(value)) return
      seen.add(value)
      value.forEach((child, key) => {
        if (key === 'attachId') {
          if (typeof child === 'string' && child !== '') ids.add(child)
          return
        }
        visit(child)
      })
      return
    }
    if (value instanceof Y.Array) {
      if (seen.has(value)) return
      seen.add(value)
      for (const child of value.toArray()) visit(child)
      return
    }
    // Y.XmlElement extends Y.XmlFragment: check the element first so its
    // attributes are not lost by the broader branch below.
    if (value instanceof Y.XmlElement) {
      if (seen.has(value)) return
      seen.add(value)
      const attachId = value.getAttribute('attachId')
      if (typeof attachId === 'string' && attachId !== '') ids.add(attachId)
      for (const child of value.toArray()) visit(child)
      return
    }
    if (value instanceof Y.XmlFragment) {
      if (seen.has(value)) return
      seen.add(value)
      for (const child of value.toArray()) visit(child)
      return
    }
    if (Array.isArray(value)) {
      for (const child of value) visit(child)
      return
    }
    if (isPlainObject(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (key === 'attachId') {
          if (typeof child === 'string' && child !== '') ids.add(child)
          continue
        }
        visit(child)
      }
    }
  }

  visitRootTypes(doc, visit)
  return [...ids]
}

/** Replace every `attachId` reference through `mapping` and re-encode the state. */
export function remapReferencedAttachIds(
  state: Uint8Array,
  mapping: ReadonlyMap<string, string>,
): Uint8Array {
  if (state.length === 0 || mapping.size === 0) return state
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  let changed = false

  const remapPlain = (value: unknown, seen: Set<unknown>): { value: unknown; changed: boolean } => {
    if (Array.isArray(value)) {
      let touched = false
      const next = value.map((child) => {
        const result = remapPlain(child, seen)
        if (result.changed) touched = true
        return result.value
      })
      return touched ? { value: next, changed: true } : { value, changed: false }
    }
    if (!isPlainObject(value)) return { value, changed: false }
    if (seen.has(value)) return { value, changed: false }
    seen.add(value)
    let touched = false
    const next: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      if (key === 'attachId' && typeof child === 'string' && mapping.has(child)) {
        next[key] = mapping.get(child)
        touched = true
        continue
      }
      const result = remapPlain(child, seen)
      if (result.changed) touched = true
      next[key] = result.value
    }
    return touched ? { value: next, changed: true } : { value, changed: false }
  }

  const visit = (value: unknown): void => {
    if (value instanceof Y.Map) {
      const attachId = value.get('attachId')
      if (typeof attachId === 'string' && mapping.has(attachId)) {
        value.set('attachId', mapping.get(attachId)!)
        changed = true
      }
      for (const [key, child] of value.entries()) {
        if (key === 'attachId') continue
        if (child instanceof Y.AbstractType) {
          visit(child)
          continue
        }
        const result = remapPlain(child, new Set())
        if (result.changed) {
          value.set(key, result.value)
          changed = true
        }
      }
      return
    }
    if (value instanceof Y.Array) {
      for (let index = 0; index < value.length; index += 1) {
        const child = value.get(index)
        if (child instanceof Y.AbstractType) {
          visit(child)
          continue
        }
        const result = remapPlain(child, new Set())
        if (result.changed) {
          value.delete(index, 1)
          value.insert(index, [result.value])
          changed = true
        }
      }
      return
    }
    if (value instanceof Y.XmlElement) {
      const attachId = value.getAttribute('attachId')
      if (typeof attachId === 'string' && mapping.has(attachId)) {
        value.setAttribute('attachId', mapping.get(attachId)!)
        changed = true
      }
      for (const child of value.toArray()) visit(child)
      return
    }
    if (value instanceof Y.XmlFragment) {
      for (const child of value.toArray()) visit(child)
    }
  }

  doc.transact(() => {
    visitRootTypes(doc, visit)
  })
  return changed ? Y.encodeStateAsUpdate(doc) : state
}

/**
 * Copy the attachments a body state actually references into `targetDocId` and
 * return the rewritten body state. `sourceDocId` is the docId the attachments
 * must currently belong to (anything else is not ours to copy).
 */
export async function copyReferencedAttachments(input: {
  state: Uint8Array
  sourceDocId: string
  targetDocId: string
  uid: string
}): Promise<CopyReferencedAttachmentsResult> {
  const sourceAttachIds = collectReferencedAttachIds(input.state)
  if (sourceAttachIds.length === 0) return { state: input.state, copied: [] }

  const mapping = new Map<string, string>()
  const copied: CopiedAttachment[] = []
  try {
    for (const sourceAttachId of sourceAttachIds) {
      const attachment = await docAttachmentRepo.getById(sourceAttachId)
      // Only an attachment registered under the source doc is part of its body.
      // A stale/foreign reference has no bytes we may copy; leave it untouched.
      if (!attachment || attachment.docId !== input.sourceDocId) continue
      const attachId = await copyStoredObject(attachment, input.targetDocId, input.uid)
      mapping.set(sourceAttachId, attachId)
      copied.push({ sourceAttachId, attachId })
    }
  } catch (err) {
    await cleanupCopiedAttachments(copied.map((item) => item.attachId))
    throw err
  }
  if (mapping.size === 0) return { state: input.state, copied }
  return { state: remapReferencedAttachIds(input.state, mapping), copied }
}

/** Remove attachment rows + stored bytes created for a copy that did not commit. */
export async function cleanupCopiedAttachments(attachIds: readonly string[]): Promise<void> {
  await Promise.allSettled(attachIds.map((attachId) => cleanupCopiedAttachment(attachId)))
}
