import * as Y from 'yjs'
import { persistedEncoding } from './persistedEncoding.js'

const committed = new WeakMap<Y.Doc, { name: string; vector: Uint8Array }>()

/** Only call after loading a durable row, or after the SQL commit succeeds. */
export function recordStoreCheckpoint(name: string, doc: Y.Doc, vector = Y.encodeStateVector(doc)): void {
  committed.set(doc, { name, vector })
}

export function captureStoreUpdate(name: string, doc: Y.Doc, incremental: boolean) {
  const previous = committed.get(doc)
  const baseVector = incremental && previous?.name === name ? previous.vector : null
  const encoding = persistedEncoding()
  // No await between the update and its vector. Later live changes must not be
  // acknowledged or excluded from the next delta by this save's checkpoint.
  const state = encoding === 2
    ? Y.encodeStateAsUpdateV2(doc, baseVector ?? undefined)
    : Y.encodeStateAsUpdate(doc, baseVector ?? undefined)
  const vector = Y.encodeStateVector(doc)
  const stateMap: Record<string, number> = {}
  for (const [client, clock] of Y.decodeStateVector(vector)) stateMap[String(client)] = clock
  return { state, encoding, vector, stateMap, baseVector }
}
