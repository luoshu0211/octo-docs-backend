/**
 * yjs_document repository (§3.2 / §3.4).
 *
 * Y.Doc binary authoritative state, single merged row per document_name
 * (uk_document_name). store() uses UPSERT + merge-on-write; see persistence.ts
 * for the full read-modify-write transaction (the merge logic lives there
 * because it needs Y.Doc decode/encode).
 *
 * Rows carry the Yjs update format that produced `state` (see the
 * 2026-08-21-yjs-document-encoding-v2 migration). Reads MUST honour it — the two
 * encodings are not interchangeable, and feeding v2 bytes to the v1 decoder does
 * not fail cleanly. Legacy rows predate the column and are v1 by definition,
 * which is exactly what the column's DEFAULT 1 records.
 */
import { query, type Tx } from '../pool.js'

/** Yjs update format of a persisted `state` blob. */
export type YjsEncoding = 1 | 2

/** A persisted state blob together with the encoder that produced it. */
export interface StoredYjsState {
  state: Uint8Array
  encoding: YjsEncoding
}

/**
 * Narrow the DB's TINYINT to a format this process can decode.
 *
 * An unrecognised value means the row was written by a NEWER deploy than the one
 * reading it (mixed-version rollout, or a rollback). We must not decode it — the
 * two encodings are not interchangeable and feeding v2 bytes to the v1 decoder
 * yields an empty document rather than an error (verified against yjs directly).
 *
 * We must not report it as "no row" either, tempting as that is: the caller then
 * loads an empty document, and the first edit persists that empty state straight
 * over the row via the UPSERT below — turning an unreadable row into a destroyed
 * one. Throwing keeps the document unavailable but intact, which is the only
 * recoverable outcome of the three.
 */
function toEncoding(raw: unknown, documentName: string): YjsEncoding {
  if (raw == null || raw === 1) return 1
  if (raw === 2) return 2
  throw new UnknownEncodingError(documentName, raw)
}

/** A persisted row whose `encoding` this build does not understand. */
export class UnknownEncodingError extends Error {
  constructor(documentName: string, raw: unknown) {
    super(
      `refusing to decode ${documentName}: unknown yjs_document.encoding ${String(raw)} ` +
        '(row written by a newer deploy — do not let this build overwrite it)',
    )
    this.name = 'UnknownEncodingError'
  }
}

export const yjsDocumentRepo = {
  /** Fetch state bytes + the encoding that produced them (§3.2 fetch). */
  async fetchState(documentName: string): Promise<StoredYjsState | null> {
    // db.query returns []; must index [0] before reading state, else
    // new Uint8Array(undefined) reads garbage (§3.2 P2-1).
    const rows = await query<{ state: Buffer; encoding: number }>(
      'SELECT state, encoding FROM yjs_document WHERE document_name = ? LIMIT 1',
      [documentName],
    )
    const row = rows[0]
    if (!row) return null
    return { state: new Uint8Array(row.state), encoding: toEncoding(row.encoding, documentName) }
  },

  /** SELECT ... FOR UPDATE inside the store transaction (§3.2 step 1). */
  async selectForUpdateTx(tx: Tx, documentName: string): Promise<StoredYjsState | null> {
    const rows = await tx.query<{ state: Buffer; encoding: number }>(
      'SELECT state, encoding FROM yjs_document WHERE document_name = ? FOR UPDATE',
      [documentName],
    )
    const row = rows[0]
    if (!row) return null
    return { state: new Uint8Array(row.state), encoding: toEncoding(row.encoding, documentName) }
  },

  /** UPSERT the single authoritative row (§3.2 step 3). */
  async upsertStateTx(
    tx: Tx,
    documentName: string,
    state: Buffer,
    encoding: YjsEncoding,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO yjs_document (document_name, state, size_bytes, encoding, updated_at)
       VALUES (?, ?, ?, ?, NOW(3))
       ON DUPLICATE KEY UPDATE state = VALUES(state),
                               size_bytes = VALUES(size_bytes),
                               encoding = VALUES(encoding),
                               updated_at = NOW(3)`,
      [documentName, state, state.length, encoding],
    )
  },
}
