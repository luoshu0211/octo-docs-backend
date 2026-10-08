import { gzipSync, gunzipSync } from 'node:zlib'
import { config } from '../config/env.js'
import type { StoredYjsState, YjsEncoding } from '../db/repos/yjsDocumentRepo.js'

export type StorageEncoding = 1 | 2 | 3 | 4

export class StorageBudgetError extends Error {
  constructor(
    readonly dimension: 'decoded' | 'stored',
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(`document ${dimension} state exceeds max size ${limit} bytes (got ${bytes})`)
    this.name = 'StorageBudgetError'
  }
}

export class UnknownEncodingError extends Error {
  constructor(documentName: string, raw: unknown) {
    super(
      `refusing to decode ${documentName}: unknown yjs_document.encoding ${String(raw)} ` +
      '(row written by a newer deploy — do not let this build overwrite it)',
    )
    this.name = 'UnknownEncodingError'
  }
}

export function storageByteLimit(): number {
  return config.maxDocStorageBytes || config.maxDocBytes
}

function assertSize(dimension: 'decoded' | 'stored', bytes: number, limit: number): void {
  if (bytes > limit) throw new StorageBudgetError(dimension, bytes, limit)
}

export function encodeStorageState(
  state: Uint8Array,
  encoding: YjsEncoding,
): { state: Buffer; encoding: StorageEncoding } {
  assertSize('decoded', state.length, config.maxDocBytes)
  let output = Buffer.from(state)
  let storageEncoding: StorageEncoding = encoding
  if (config.yjsStorageGzip) {
    const compressed = gzipSync(output, { level: 6 })
    if (compressed.length < output.length) {
      output = compressed
      storageEncoding = encoding === 1 ? 3 : 4
    }
  }
  assertSize('stored', output.length, storageByteLimit())
  return { state: output, encoding: storageEncoding }
}

export function decodeStorageState(
  state: Uint8Array,
  rawEncoding: unknown,
  documentName: string,
): StoredYjsState {
  const encoding = rawEncoding == null ? 1 : rawEncoding
  if (encoding !== 1 && encoding !== 2 && encoding !== 3 && encoding !== 4) {
    throw new UnknownEncodingError(documentName, rawEncoding)
  }
  if (encoding === 1 || encoding === 2) {
    return { state, encoding }
  }
  const decoded = gunzipSync(state, { maxOutputLength: config.maxDocBytes })
  return { state: decoded, encoding: encoding === 3 ? 1 : 2 }
}
