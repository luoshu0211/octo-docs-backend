import { randomUUID } from 'node:crypto'
import { isTransactionOrigin } from '@hocuspocus/server'
import { messageYjsUpdate } from 'y-protocols/sync'
import * as Y from 'yjs'
import type { AuthContext } from './authenticate.js'
import { COLLAB_FIELD } from '../schema/index.js'
import { stateGenerationOf } from './stateGeneration.js'
import type { DocumentEditProof, PendingDocumentEdit } from '../drive/documentActivity.js'

type Editor = Pick<PendingDocumentEdit, 'actorUid' | 'principalSpaceId'>
type TrackedEdit = Omit<PendingDocumentEdit, 'proof'> & {
  captured: boolean
  proof?: DocumentEditProof
}

interface DocumentEdits {
  pending: Map<string, TrackedEdit>
  evidenceWrites: Set<Promise<void>>
}

const editsByDoc = new WeakMap<Y.Doc, DocumentEdits>()
const liveUpdates = new WeakSet<object>()

function editorKey(editor: Editor): string {
  return JSON.stringify([editor.principalSpaceId, editor.actorUid])
}

// An initial SyncStep2 can contain other authors' cached edits. The
// authenticated uploader is an editor only on a live update frame.
export function markDocumentSyncFrame(connection: object, type: number): void {
  if (type === messageYjsUpdate) liveUpdates.add(connection)
  else liveUpdates.delete(connection)
}

function documentEditor(origin: unknown): Editor | undefined {
  if (!isTransactionOrigin(origin)) return
  if (origin.source === 'local') {
    const actor = (origin.context as { documentEditActor?: Editor } | undefined)?.documentEditActor
    if (actor?.actorUid && actor.principalSpaceId) return actor
  }
  if (origin.source !== 'connection' || origin.connection.readOnly || !liveUpdates.has(origin.connection)) return
  const actor = origin.connection.context as AuthContext | undefined
  if (actor?.user.id && actor.principal_space_id && actor.kind === 'document') {
    return { actorUid: actor.user.id, principalSpaceId: actor.principal_space_id }
  }
}

// A proof records only CRDT clocks and deletion ranges. No document content
// is duplicated into the outbox. Delete-only transactions need a delete set
// because they need not advance any client clock.
function editProof(update: Uint8Array, doc: Y.Doc): DocumentEditProof {
  const { structs, ds } = Y.decodeUpdate(update)
  const clocks = new Map<number, number>()
  for (const { id, length } of structs) clocks.set(id.client, Math.max(clocks.get(id.client) ?? 0, id.clock + length))
  return {
    generation: stateGenerationOf(doc) ?? null,
    clocks: [...clocks],
    deletes: [...ds.clients].flatMap(([client, ranges]) =>
      ranges.map(({ clock, len }): [number, number, number] => [client, clock, clock + len]),
    ),
  }
}

export function snapshotIncludesDocumentEdit(snapshot: Y.Snapshot, generation: string | null, proof: DocumentEditProof): boolean {
  return proof.generation === generation &&
    proof.clocks.every(([client, end]) => (snapshot.sv.get(client) ?? 0) >= end) &&
    proof.deletes.every(([client, start, end]) =>
      snapshot.ds.clients.get(client)?.some(range => range.clock <= start && range.clock + range.len >= end),
    )
}

// Observe after load so applying the stored snapshot can never create activity.
export function trackDocumentBodyEdits(doc: Y.Doc, stageEvidence?: (edit: PendingDocumentEdit) => Promise<void>): void {
  const body = doc.getXmlFragment(COLLAB_FIELD)
  const pending = new Map<string, TrackedEdit>()
  const evidenceWrites = new Set<Promise<void>>()
  const editsByTransaction = new WeakMap<Y.Transaction, TrackedEdit>()
  editsByDoc.set(doc, { pending, evidenceWrites })
  body.observeDeep((_, transaction) => {
    const editor = documentEditor(transaction.origin)
    if (!editor) return
    const key = editorKey(editor)
    const current = pending.get(key)
    if (current && !current.captured) return
    const edit: TrackedEdit = { ...editor, eventId: randomUUID(), occurredAtMs: Date.now(), captured: false }
    pending.set(key, edit)
    editsByTransaction.set(transaction, edit)
  })
  doc.on('update', (update: Uint8Array, _origin: unknown, _doc: Y.Doc, tx: Y.Transaction) => {
    const edit = editsByTransaction.get(tx)
    if (!edit) return
    const proof = editProof(update, doc)
    edit.proof = proof
    if (stageEvidence) {
      const write = stageEvidence({ ...edit, proof }).catch(() => {
        // eslint-disable-next-line no-console -- the SQL store retries local evidence
        console.warn('[document-activity] staging edit evidence failed')
      }).finally(() => evidenceWrites.delete(write))
      evidenceWrites.add(write)
    }
  })
}

// Wait before the Redis extension supplies a peer with any of these edits.
// Evidence lives in MySQL, so a replica after failover can still confirm it.
export async function waitForDocumentEditEvidence(doc: Y.Doc): Promise<void> {
  // Hocuspocus registers its Yjs update listener before our observer. Yield
  // once so both listeners for this update have run before reading the set.
  await Promise.resolve()
  const writes = editsByDoc.get(doc)?.evidenceWrites
  while (writes?.size) await Promise.all(writes)
}

export function captureDocumentActivitySnapshot(doc: Y.Doc) {
  if (!editsByDoc.has(doc)) return
  return {
    edits: captureDocumentBodyEdits(doc),
    snapshot: Y.snapshot(doc),
    generation: stateGenerationOf(doc) ?? null,
  }
}

export function captureDocumentBodyEdits(doc: Y.Doc): Array<TrackedEdit & PendingDocumentEdit> {
  const captured = [...(editsByDoc.get(doc)?.pending.values() ?? [])]
    .filter((edit): edit is TrackedEdit & PendingDocumentEdit => edit.proof !== undefined)
  for (const edit of captured) edit.captured = true
  return captured
}

export function confirmDocumentBodyEdits(doc: Y.Doc, captured: readonly TrackedEdit[]): void {
  const pending = editsByDoc.get(doc)?.pending
  if (!pending) return
  for (const edit of captured) {
    const key = editorKey(edit)
    if (pending.get(key) === edit) pending.delete(key)
  }
}
