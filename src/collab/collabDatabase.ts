/**
 * Yjs persistence extension (replaces @hocuspocus/extension-database).
 *
 * The stock extension hardcodes the v1 update format on both sides:
 *
 *   onLoadDocument:  Y.applyUpdate(doc, await fetch(...))
 *   onStoreDocument: store({ state: Buffer.from(Y.encodeStateAsUpdate(doc)) })
 *
 * We persist v2 (see the 2026-08-21-yjs-document-encoding-v2 migration), so the
 * load side must pick its decoder from the row's recorded encoding, and the
 * store side must hand the live document to `persistence.store` rather than a
 * v1 encoding of it. Both are one-line differences from the stock extension, but
 * neither is configurable there — hence this file rather than a wrapper.
 *
 * Two properties are preserved exactly:
 *   - a fetch that returns null leaves the document empty (new document), and
 *   - a store that throws propagates, so extension-level rejection still reaches
 *     Hocuspocus's own error handling (this is how the oversize guard surfaces).
 */
import type { Extension, onLoadDocumentPayload, onStoreDocumentPayload } from '@hocuspocus/server'
import * as Y from 'yjs'
import { bindStateGeneration } from './stateGeneration.js'
import { captureDurableSnapshot, recordDurableReceipt } from './durableReceipt.js'
import type { StoredYjsState } from '../db/repos/yjsDocumentRepo.js'
import { loadAdmission } from './loadAdmission.js'

export interface CollabDatabaseConfiguration {
  fetch(documentName: string): Promise<StoredYjsState | null>
  store(documentName: string, doc: Y.Doc, context?: { user?: { id?: string } }): Promise<void>
  loaded?(documentName: string, doc: Y.Doc): void
}

/**
 * Apply a persisted state to a document using the decoder that matches the
 * encoder which produced it. Feeding v2 bytes to `Y.applyUpdate` does not throw
 * cleanly — it decodes garbage — so this dispatch is a correctness boundary, not
 * an optimisation.
 */
export function applyStoredState(doc: Y.Doc, stored: StoredYjsState): void {
  if (stored.encoding === 2) Y.applyUpdateV2(doc, stored.state)
  else Y.applyUpdate(doc, stored.state)
}

export class CollabDatabase implements Extension {
  constructor(private readonly configuration: CollabDatabaseConfiguration) {}

  async onLoadDocument(data: onLoadDocumentPayload): Promise<void> {
    try {
      await loadAdmission.run(async () => {
        const stored = await this.configuration.fetch(data.documentName)
        // Fetch/decompression and concurrent saves may have consumed headroom.
        loadAdmission.assertHeadroom()
        if (stored) {
          bindStateGeneration(data.document, stored.generation ?? null)
          applyStoredState(data.document, stored)
          this.configuration.loaded?.(data.documentName, data.document)
          recordDurableReceipt(data.document, captureDurableSnapshot(data.document))
        }
      })
    } catch (error) {
      // Hocuspocus has not yet put a failed load in its documents map, so its
      // normal unload path may not destroy this temporary Document.
      if (!data.document.isDestroyed) data.document.destroy()
      throw error
    }
  }

  async onStoreDocument(data: onStoreDocumentPayload): Promise<void> {
    // Hand over the live document, not an encoding of it: `persistence.store`
    // captures an incremental update and validates the complete snapshot on
    // the background worker before committing it.
    await this.configuration.store(
      data.documentName,
      data.document,
      data.lastContext as { user?: { id?: string } } | undefined,
    )
  }
}

/**
 * A persisted state as a v1 update, for the few call sites that still speak v1
 * (version restore reconciles against `doc_version` blobs, which are v1).
 *
 * Converting costs a full re-encode, so this is deliberately NOT on the collab
 * hot path — only on rare, explicitly-triggered operations.
 */
export function storedStateAsV1(stored: StoredYjsState | null): Uint8Array | null {
  if (!stored) return null
  return stored.encoding === 2 ? Y.convertUpdateFormatV2ToV1(stored.state) : stored.state
}
