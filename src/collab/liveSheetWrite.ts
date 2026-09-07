/**
 * Live-document side of a bot/agent spreadsheet edit (design §7.3, mirrors
 * liveRestore.ts).
 *
 * A bot edits a sheet by writing cells onto the SAME live in-memory Y.Doc the
 * connected human clients are editing, so they see the change in real time and
 * the write is the single authoritative content write (never clobbered by a
 * stale client union — see liveRestore.ts for the full union-direction rationale).
 *
 * openDirectConnection bypasses onAuthenticate (server-internal, carries no
 * client ctx — beforeHandleMessage's `if (!ctx) return` lets it through). So the
 * CALLER must enforce authorization before invoking this (the agent layer decides
 * which bot may write which sheet), exactly as the restore service does.
 */
import type { Document } from '@hocuspocus/server'
import * as Y from 'yjs'
import { getCollabServer } from './server.js'
import {
  validateSheetCellBatch,
  validateSheetDimBatch,
  validateSheetDrawingBatch,
  validateSheetHyperLinkBatch,
  validateSheetMergeBatch,
  validateSheetListBatch,
  validateSheetFreezeBatch,
  validateSheetFilterBatch,
  materializeLegacyDefaultSheet,
  hasLegacyDefaultDataValidationRule,
  validateSheetDataValidationResourceBatch,
  validateSheetDataValidationResourceDeletionRepairBatch,
  sheetLogicalIdsWithLegacyDefault,
  assertSheetWriteAllowed,
  SHEET_YMAP_FIELD,
  SHEET_DIMS_FIELD,
  SHEET_DRAWINGS_FIELD,
  SHEET_HYPERLINKS_FIELD,
  SHEET_MERGES_FIELD,
  SHEET_LIST_FIELD,
  SHEET_FREEZE_FIELD,
  SHEET_FILTERS_FIELD,
  SHEET_DATA_VALIDATIONS_FIELD,
  type SheetCell,
  type StoredDrawing,
  type StoredHyperLink,
  type StoredSheetMeta,
  type StoredFreeze,
  type StoredFilter,
  type StoredDataValidation,
  type SheetDataValidationResourceChanges,
} from '../agent/sheetConversion.js'
import { advanceEditVersion } from './liveDocWrite.js'
import { stateVectorsEqual, BaseVersionStaleError } from './docBodyEdit.js'
import { persistedByteLength } from './persistedEncoding.js'
import { config } from '../config/env.js'

/**
 * Read the live sheet document for a content read (mirrors readLiveForEdit).
 *
 * Returns the current authoritative Y.Doc binary state and its state vector,
 * read inside a single transact for a consistent view. Read-only: opens a
 * direct connection, snapshots, and disconnects without mutating. The caller
 * decodes the state with the shared sheetConversion primitives (so the HTTP read
 * and the version-restore preview share one validated decoder) and returns the
 * state vector as the baseVersion for a later optimistic-concurrency write.
 *
 * @param documentName canonical persistence/connection key for the sheet
 * @returns state — Y.Doc binary update; baseSV — its state vector
 */
export async function readLiveSheet(
  documentName: string,
): Promise<{ state: Uint8Array; baseSV: Uint8Array }> {
  const server = getCollabServer()
  const connection = await server.hocuspocus.openDirectConnection(documentName, { user: { id: 'system' } })
  let state!: Uint8Array
  let baseSV!: Uint8Array
  try {
    await connection.transact((doc: Document) => {
      state = Y.encodeStateAsUpdate(doc)
      baseSV = Y.encodeStateVector(doc)
    })
  } finally {
    await connection.disconnect()
  }
  return { state, baseSV }
}

/**
 * Commit a bot/human cell-edit batch onto the live sheet document under the
 * client base-version guard, and broadcast it. The write counterpart of
 * commitLiveEdit (doc body) — the same fail-closed optimistic-concurrency shape,
 * applied to the flat 'sheet' Y.Map instead of the ProseMirror fragment.
 *
 * The state-vector guard is the FIRST statement inside the transact and the cell
 * mutation is the LAST, so a drift between the caller's GET /:docId/sheet and
 * this commit throws BaseVersionStaleError BEFORE any mutation or broadcast
 * (never a silent last-writer-wins). The compared token is `clientBaseVersion` —
 * the value the caller read — not a re-read of this run's own SV.
 *
 * advanceEditVersion (shared with the doc path) bumps a doc-private counter so a
 * delete-only cell batch also moves the state vector forward; without it a
 * delete records only a tombstone and the base-version token would be reusable.
 *
 * openDirectConnection bypasses onAuthenticate (server-internal, carries no
 * client ctx). So the CALLER must enforce authorization before invoking this —
 * editDocSheet rechecks role + permission_epoch under the row lock, exactly as
 * the doc-body write service does.
 *
 * @param documentName      canonical persistence/connection key for the sheet
 * @param uid               acting user id (becomes doc_meta.updated_by on store)
 * @param clientBaseVersion the state vector the caller read from GET /:docId/sheet
 * @param cells             keyed cells to set; a null value deletes that cell
 * @returns newSV — the post-commit state vector; bytes — the stored Y.Doc size
 */
export async function commitLiveSheetEdit(
  documentName: string,
  uid: string,
  clientBaseVersion: Uint8Array,
  cells: Record<string, SheetCell | null>,
  dims: Record<string, number | null> = {},
  drawings: Record<string, StoredDrawing | null> = {},
  hyperlinks: Record<string, StoredHyperLink | null> = {},
  merges: Record<string, boolean | null> = {},
  sheets: Record<string, StoredSheetMeta | null> = {},
  freeze: Record<string, StoredFreeze | null> = {},
  filters: Record<string, StoredFilter | null> | boolean = {},
  dataValidations: SheetDataValidationResourceChanges = {},
  /**
   * Whether the caller resolved `uid` as a doc admin, under the SAME doc_meta
   * lock that authorized the write. Defaults to false so an uninformed caller
   * gets the safe answer (protection enforced) rather than a bypass.
   */
  isAdmin = false,
): Promise<{ newSV: Uint8Array; bytes: number }> {
  // Compatibility with !124's short-lived positional signature, where the
  // argument now named `freeze` carried flat checkbox changes and `filters`
  // carried isAdmin. The public route uses the grouped signature below.
  if (typeof filters === 'boolean') {
    isAdmin = filters
    dataValidations = freeze as unknown as SheetDataValidationResourceChanges
    freeze = {}
    filters = {}
  }
  const server = getCollabServer()
  const connection = await server.hocuspocus.openDirectConnection(documentName, { user: { id: uid } })
  let newSV!: Uint8Array
  let bytes = 0
  try {
    await connection.transact((doc: Document) => {
      // (1) PRIMARY guard — first statement, before any mutation. A drift since
      //     the caller's read throws with no write/broadcast (fail-closed).
      const currentSV = Y.encodeStateVector(doc)
      if (!stateVectorsEqual(clientBaseVersion, currentSV)) {
        throw new BaseVersionStaleError()
      }
      // Prepare the effective sheet-list batch before authorization. Legacy V1 checkbox state can
      // implicitly materialize `default`; the guard must see that server-added write too, not only
      // the caller's literal `sheets` payload.
      const listMap = doc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD)
      const validationMap = doc.getMap<StoredDataValidation>(SHEET_DATA_VALIDATIONS_FIELD)
      const validationDeletionOnly = Object.keys(dataValidations).length > 0 &&
        Object.values(dataValidations).every((value) => value === null || (Array.isArray(value) && value.length === 0)) &&
        Object.keys(cells).length === 0 && Object.keys(dims).length === 0 &&
        Object.keys(drawings).length === 0 && Object.keys(hyperlinks).length === 0 &&
        Object.keys(merges).length === 0 && Object.keys(sheets).length === 0 &&
        Object.keys(freeze).length === 0 && Object.keys(filters).length === 0
      const requestedListBatch = validateSheetListBatch(sheets)
      const listBatch = materializeLegacyDefaultSheet(
        listMap.keys(),
        requestedListBatch,
        listMap.size === 0 &&
          requestedListBatch.toSet.length > 0 &&
          hasLegacyDefaultDataValidationRule(validationMap.entries(), dataValidations),
      )
      const protectedSheetChanges: Record<string, StoredSheetMeta | null> = Object.create(null)
      for (const key of listBatch.toDelete) protectedSheetChanges[key] = null
      for (const [key, meta] of listBatch.toSet) protectedSheetChanges[key] = meta

      const nextLogicalIds = sheetLogicalIdsWithLegacyDefault(listMap.keys())
      for (const key of listBatch.toDelete) nextLogicalIds.delete(key)
      for (const [key] of listBatch.toSet) nextLogicalIds.add(key)
      const validationBatch = validationDeletionOnly
        ? validateSheetDataValidationResourceDeletionRepairBatch(validationMap.entries(), dataValidations)
        : validateSheetDataValidationResourceBatch(
          validationMap.entries(), dataValidations, nextLogicalIds, new Set(listBatch.toDelete),
          {
            maxRules: config.sheetWrite.maxDataValidations,
            maxBytes: config.sheetWrite.maxDataValidationBytes,
          },
        )
      const protectedCheckboxChanges: Record<string, StoredDataValidation | null> = Object.create(null)
      for (const key of validationBatch.toDelete) {
        const current = validationMap.get(key)
        if (current?.type === 'checkbox') protectedCheckboxChanges[key] = null
      }
      for (const [key, rule] of validationBatch.toSet) {
        if (rule.type === 'checkbox') protectedCheckboxChanges[key] = rule
      }
      const resourceSheets = new Set([...Object.keys(freeze), ...Object.keys(filters)])
      for (const key of Object.keys(dataValidations)) {
        if (!key.includes('!')) resourceSheets.add(key)
      }

      // (1b) PROTECTION guard — still before any mutation. Reads the protection
      //      rules + grant lists off the SAME live doc, so a non-admin writing
      //      into a protected range is rejected with nothing applied and nothing
      //      broadcast (same fail-closed shape as the stale-version guard above).
      //      openDirectConnection bypasses onAuthenticate, so this is the only
      //      place the bot/REST path can be held to the protection contract.
      //      the effective sheet batch is passed too: the route allows sheets-only PATCHes, and a
      //      tab delete destroys every protected cell on that tab, so omitting it
      //      left a strictly-worse bypass than the cell write this guard refuses.
      assertSheetWriteAllowed(
        doc,
        cells,
        uid,
        isAdmin,
        dims,
        merges,
        protectedSheetChanges,
        protectedCheckboxChanges,
        [...resourceSheets],
      )
      // (2) The single, last content mutation. Validate ALL NINE batches FIRST
      //     (validate* return the split batches without mutating), THEN apply —
      //     so a bad dim/drawing can't leave cells half-applied. Yjs does NOT roll
      //     back a thrown transact callback and disconnect flushes onStore, so a
      //     per-map validate-then-mutate would broadcast a partial write on a
      //     mixed { good cells, bad dim } batch. Cross-map atomicity requires the
      //     validate-all-then-apply-all shape here (each apply* alone is only
      //     atomic within its own map).
      const cellBatch = validateSheetCellBatch(cells)
      const dimBatch = validateSheetDimBatch(dims)
      const drawingBatch = validateSheetDrawingBatch(drawings)
      const linkBatch = validateSheetHyperLinkBatch(hyperlinks)
      const mergeBatch = validateSheetMergeBatch(merges)
      const freezeBatch = validateSheetFreezeBatch(freeze)
      const filterBatch = validateSheetFilterBatch(filters)
      const ymap = doc.getMap<SheetCell>(SHEET_YMAP_FIELD)
      for (const key of cellBatch.toDelete) ymap.delete(key)
      for (const [key, cell] of cellBatch.toSet) ymap.set(key, cell)
      const dimsMap = doc.getMap<number>(SHEET_DIMS_FIELD)
      for (const key of dimBatch.toDelete) dimsMap.delete(key)
      for (const [key, px] of dimBatch.toSet) dimsMap.set(key, px)
      const drawingMap = doc.getMap<StoredDrawing>(SHEET_DRAWINGS_FIELD)
      for (const key of drawingBatch.toDelete) drawingMap.delete(key)
      for (const [key, d] of drawingBatch.toSet) drawingMap.set(key, d)
      const linkMap = doc.getMap<StoredHyperLink>(SHEET_HYPERLINKS_FIELD)
      for (const key of linkBatch.toDelete) linkMap.delete(key)
      for (const [key, link] of linkBatch.toSet) linkMap.set(key, link)
      const mergeMap = doc.getMap<boolean>(SHEET_MERGES_FIELD)
      for (const key of mergeBatch.toDelete) mergeMap.delete(key)
      for (const [key, v] of mergeBatch.toSet) mergeMap.set(key, v)
      for (const key of listBatch.toDelete) listMap.delete(key)
      for (const [key, meta] of listBatch.toSet) listMap.set(key, meta)
      const freezeMap = doc.getMap<StoredFreeze>(SHEET_FREEZE_FIELD)
      for (const key of freezeBatch.toDelete) freezeMap.delete(key)
      for (const [key, value] of freezeBatch.toSet) freezeMap.set(key, value)
      const filterMap = doc.getMap<StoredFilter>(SHEET_FILTERS_FIELD)
      for (const key of filterBatch.toDelete) filterMap.delete(key)
      for (const [key, value] of filterBatch.toSet) filterMap.set(key, value)
      for (const key of validationBatch.toDelete) validationMap.delete(key)
      for (const [key, rule] of validationBatch.toSet) validationMap.set(key, rule)
      // (3) Advance the edit-version counter so a delete-only batch also moves
      //     the state vector forward; the token is read AFTER this bump.
      advanceEditVersion(doc)
      newSV = Y.encodeStateVector(doc)
      // Same dimension the store caps/writes (persistedEncoding), so the size we
      // report back to the caller can be compared against maxDocBytes at all.
      bytes = persistedByteLength(doc)
    })
  } finally {
    // Flushes the final store (awaited) and releases the direct connection.
    await connection.disconnect()
  }
  return { newSV, bytes }
}
