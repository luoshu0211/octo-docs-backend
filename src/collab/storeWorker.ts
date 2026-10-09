/** Stateless CPU worker: decode, merge, enforce both budgets, then compress once. */
import { parentPort } from 'node:worker_threads'
import * as Y from 'yjs'
import type { RawYjsState, YjsEncoding } from '../db/repos/yjsDocumentRepo.js'
import { decodeStorageState, encodeStorageState, StorageBudgetError, type EncodedStorageState, type StorageCodecOptions } from './storageCodec.js'

export interface StoreJob {
  documentName: string
  existing: RawYjsState | null
  update: Uint8Array
  encoding: YjsEncoding
  /** The last committed state this delta depends on; null means a full update. */
  baseVector: Uint8Array | null
  targetVector: Uint8Array
  codec: StorageCodecOptions
}

export type StoreResult =
  | { kind: 'stored'; stored: EncodedStorageState }
  | { kind: 'needs-full-state' }

export interface StoreWorkerFailure {
  name: string
  message: string
  dimension?: 'decoded' | 'stored'
  bytes?: number
  limit?: number
}

export type StoreReply = { id: number } & (
  | { ok: true; result: StoreResult }
  | { ok: false; error: StoreWorkerFailure }
)

export function dominates(actual: Uint8Array, required: Uint8Array): boolean {
  const clocks = Y.decodeStateVector(actual)
  for (const [client, clock] of Y.decodeStateVector(required)) {
    if ((clocks.get(client) ?? 0) < clock) return false
  }
  return true
}

export function prepareStoredState(job: StoreJob): StoreResult {
  const doc = new Y.Doc()
  try {
    if (job.existing) {
      const existing = decodeStorageState(job.existing.state, job.existing.encoding, job.documentName, job.codec)
      if (existing.encoding === 2) Y.applyUpdateV2(doc, existing.state)
      else Y.applyUpdate(doc, existing.state)
    }
    // A compaction, restore, or missing row can invalidate the cached base.
    // Never apply a dependent delta to an incomplete base and save an empty doc.
    if (job.baseVector && !dominates(Y.encodeStateVector(doc), job.baseVector)) {
      return { kind: 'needs-full-state' }
    }
    if (job.encoding === 2) Y.applyUpdateV2(doc, job.update)
    else Y.applyUpdate(doc, job.update)
    if (!dominates(Y.encodeStateVector(doc), job.targetVector)) {
      throw new Error('Yjs store update has missing causal dependencies')
    }
    // Delete sets are applied even when the state vector has not advanced.
    const state = job.encoding === 2 ? Y.encodeStateAsUpdateV2(doc) : Y.encodeStateAsUpdate(doc)
    const stored = encodeStorageState(state, job.encoding, job.codec)
    return { kind: 'stored', stored: { ...stored, decodedBytes: state.length } }
  } finally {
    doc.destroy()
  }
}

if (parentPort) {
  const port = parentPort
  port.on('message', ({ id, job }: { id: number; job: StoreJob }) => {
    try {
      const result = prepareStoredState(job)
      // Copy into an owned, exactly-sized allocation before transfer: a Node
      // Buffer can share a slab with unrelated data and must not be detached.
      if (result.kind === 'stored') result.stored.state = Uint8Array.from(result.stored.state)
      port.postMessage({ id, ok: true, result } satisfies StoreReply,
        result.kind === 'stored' ? [result.stored.state.buffer as ArrayBuffer] : [])
    } catch (error) {
      const failure: StoreWorkerFailure = {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
      }
      if (error instanceof StorageBudgetError) {
        Object.assign(failure, { dimension: error.dimension, bytes: error.bytes, limit: error.limit })
      }
      port.postMessage({ id, ok: false, error: failure } satisfies StoreReply)
    }
  })
}
