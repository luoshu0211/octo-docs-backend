import { randomUUID } from 'node:crypto'
import { isTransactionOrigin } from '@hocuspocus/server'
import type * as Y from 'yjs'
import type { AuthContext } from './authenticate.js'
import { COLLAB_FIELD } from '../schema/index.js'
import type { PendingDocumentEdit } from '../drive/documentActivity.js'

interface TrackedEdit extends PendingDocumentEdit {
  captured: boolean
}

const editsByDoc = new WeakMap<Y.Doc, Map<string, TrackedEdit>>()

// Observe after load so applying the stored snapshot can never create activity.
export function trackDocumentBodyEdits(doc: Y.Doc): void {
  const body = doc.getXmlFragment(COLLAB_FIELD)
  const pending = new Map<string, TrackedEdit>()
  editsByDoc.set(doc, pending)
  body.observeDeep((_, transaction) => {
    const origin = transaction.origin
    if (!isTransactionOrigin(origin) || origin.source !== 'connection' || origin.connection.readOnly) return
    const actor = origin.connection.context as AuthContext | undefined
    if (!actor?.user.id || !actor.principal_space_id || actor.kind !== 'document') return

    const key = JSON.stringify([actor.principal_space_id, actor.user.id])
    const occurredAtMs = Date.now()
    const current = pending.get(key)
    if (current && !current.captured) {
      current.occurredAtMs = occurredAtMs
      return
    }
    pending.set(key, {
      eventId: randomUUID(),
      actorUid: actor.user.id,
      principalSpaceId: actor.principal_space_id,
      occurredAtMs,
      captured: false,
    })
  })
}

// Called alongside the content snapshot. Subsequent edits must stay pending
// even when they were made by the same editor during the SQL commit.
export function captureDocumentBodyEdits(doc: Y.Doc): TrackedEdit[] {
  const captured = [...(editsByDoc.get(doc)?.values() ?? [])]
  for (const edit of captured) edit.captured = true
  return captured
}

export function confirmDocumentBodyEdits(doc: Y.Doc, captured: readonly TrackedEdit[]): void {
  const pending = editsByDoc.get(doc)
  if (!pending) return
  for (const edit of captured) {
    const key = JSON.stringify([edit.principalSpaceId, edit.actorUid])
    if (pending.get(key) === edit) pending.delete(key)
  }
}

export function hasPendingDocumentBodyEdits(doc: Y.Doc): boolean {
  return (editsByDoc.get(doc)?.size ?? 0) > 0
}
