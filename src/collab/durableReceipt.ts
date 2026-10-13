import * as Y from 'yjs'
import { stateGenerationOf } from './stateGeneration.js'
const receipts = new WeakMap<Y.Doc, { generation: string; snapshot: Y.Snapshot; payload: string }>()
/** V1 snapshot wire format, paired with the frontend's Y.decodeSnapshot (not decodeSnapshotV2).
 * Contains BOTH clocks and deletions; a state vector alone cannot acknowledge deletes. */
export function captureDurableSnapshot(doc: Y.Doc): Uint8Array { return Y.encodeSnapshot(Y.snapshot(doc)) }
export function recordDurableReceipt(doc: Y.Doc, snapshot: Uint8Array): void {
  const generation = stateGenerationOf(doc)
  if (!generation) return
  let saved = Y.decodeSnapshot(snapshot)
  const previous = receipts.get(doc)
  if (previous?.generation === generation) {
    // Independent commits and out-of-order Redis delivery must never retract coverage.
    const clocks = new Map(previous.snapshot.sv)
    for (const [client, clock] of saved.sv) clocks.set(client, Math.max(clocks.get(client) ?? 0, clock))
    saved = Y.createSnapshot(Y.mergeDeleteSets([previous.snapshot.ds, saved.ds]), clocks)
  }
  receipts.set(doc, { generation, snapshot: saved, payload: JSON.stringify({
    type: 'doc.persisted', generation, snapshot: Buffer.from(Y.encodeSnapshot(saved)).toString('base64'),
  }) })
}

/** Only call for messages from our fenced, trusted peer Redis transport. Never snapshot the
 * receiving live document: it can contain edits that no node has committed yet. */
export function retainPeerDurableReceipt(doc: Y.Doc, payload: string): void {
  try {
    const frame = JSON.parse(payload)
    // The sender has already committed a document within its storage budget.
    // A separate receiver-only receipt cap can reject valid coverage when many
    // CRDT identities remain; match the sender and validate the complete snapshot.
    if (frame?.type !== 'doc.persisted' || !frame.generation || frame.generation !== stateGenerationOf(doc) ||
        typeof frame.snapshot !== 'string') return
    const encoded = Buffer.from(frame.snapshot, 'base64')
    if (encoded.toString('base64') !== frame.snapshot) return
    // Reject trailing/truncated or otherwise non-canonical snapshots before extending coverage.
    if (!Buffer.from(Y.encodeSnapshot(Y.decodeSnapshot(encoded))).equals(encoded)) return
    recordDurableReceipt(doc, encoded)
  } catch { /* unrelated or malformed peer payloads cannot acknowledge local work */ }
}

export function durableReceipt(doc: Y.Doc): string | undefined {
  const receipt = receipts.get(doc)
  return receipt?.generation === stateGenerationOf(doc) ? receipt?.payload : undefined
}
