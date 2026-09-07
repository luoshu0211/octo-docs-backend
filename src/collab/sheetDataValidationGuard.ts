import * as Y from 'yjs'
import { isDeepStrictEqual } from 'node:util'
import {
  SHEET_DATA_VALIDATIONS_FIELD,
  SHEET_DIMS_FIELD,
  SHEET_DRAWINGS_FIELD,
  SHEET_FILTERS_FIELD,
  SHEET_FREEZE_FIELD,
  SHEET_HYPERLINKS_FIELD,
  SHEET_LIST_FIELD,
  SHEET_MERGES_FIELD,
  SHEET_PROTECTION_FIELD,
  SHEET_PROTECTION_GRANTS_FIELD,
  SHEET_YMAP_FIELD,
  sheetLogicalIdsWithLegacyDefault,
  measureSheetDataValidationStorage,
  parseSheetDataValidationKey,
  validateSheetDataValidationRule,
  validateSheetDataValidations,
  validateSheetFilter,
  validateSheetFreeze,
  type SheetDataValidationStorageLimits,
} from '../agent/sheetConversion.js'

/** Origin used by the server's compensating transaction; observers must not repair their own repair. */
export const SHEET_DATA_VALIDATION_GUARD_ORIGIN = Symbol('sheet-data-validation-guard')

type KeyChange = { action: 'add' | 'update' | 'delete'; oldValue: unknown }

const UNBOUNDED_STORAGE = {
  maxRules: Number.POSITIVE_INFINITY,
  maxBytes: Number.POSITIVE_INFINITY,
}

const SHEET_ATOMIC_ROOT_MAP_FIELDS = [
  SHEET_YMAP_FIELD,
  SHEET_DIMS_FIELD,
  SHEET_DRAWINGS_FIELD,
  SHEET_HYPERLINKS_FIELD,
  SHEET_MERGES_FIELD,
  SHEET_LIST_FIELD,
  SHEET_PROTECTION_FIELD,
  SHEET_PROTECTION_GRANTS_FIELD,
  'sheetPermissionPoints',
  'sheetCommentAnchors',
  SHEET_FREEZE_FIELD,
  SHEET_FILTERS_FIELD,
  SHEET_DATA_VALIDATIONS_FIELD,
] as const

function transactionEvents(transaction: Y.Transaction, type: object): unknown[] {
  return (transaction.changedParentTypes as unknown as Map<object, unknown[]>).get(type) ?? []
}

function logicalIds(doc: Y.Doc): Set<string> {
  return sheetLogicalIdsWithLegacyDefault(doc.getMap(SHEET_LIST_FIELD).keys())
}

function isServerAuthoritativeOrigin(origin: unknown): boolean {
  if (origin === null || typeof origin !== 'object' || !('source' in origin)) return false
  const source = (origin as { source?: unknown }).source
  // DirectConnection transactions are local. Their Redis replay has only the redis source tag,
  // so both forms must retain restore/REST type replacements that were validated before mutation.
  return source === 'local' || source === 'redis'
}

function changedValuesAreValidRules(
  map: Y.Map<unknown>,
  changes: ReadonlyMap<string, KeyChange>,
  allowedLogicalIds: ReadonlySet<string>,
  allowTypeReplacement: boolean,
): boolean {
  for (const [key, change] of changes) {
    if (change.action === 'delete') continue
    const value = map.get(key)
    try {
      const { logicalId, uid } = parseSheetDataValidationKey(key)
      if (!allowedLogicalIds.has(logicalId)) return false
      const rule = validateSheetDataValidationRule(logicalId, value, 0)
      if (rule.uid !== uid) return false
      if (!allowTypeReplacement && change.action === 'update') {
        const oldType = change.oldValue !== null && typeof change.oldValue === 'object' &&
          !Array.isArray(change.oldValue)
          ? (change.oldValue as Record<string, unknown>).type
          : undefined
        if (typeof oldType === 'string' && oldType !== rule.type) return false
      }
    } catch {
      return false
    }
  }
  return true
}

function changedFreezeValuesAreValid(
  map: Y.Map<unknown>,
  changes: ReadonlyMap<string, KeyChange>,
  allowedLogicalIds: ReadonlySet<string>,
): boolean {
  for (const [key, change] of changes) {
    if (change.action === 'delete') continue
    try {
      if (!allowedLogicalIds.has(key)) return false
      validateSheetFreeze(key, map.get(key))
    } catch {
      return false
    }
  }
  return true
}

function changedFilterValuesAreValid(
  map: Y.Map<unknown>,
  changes: ReadonlyMap<string, KeyChange>,
  allowedLogicalIds: ReadonlySet<string>,
): boolean {
  for (const [key, change] of changes) {
    if (change.action === 'delete') continue
    try {
      if (!allowedLogicalIds.has(key)) return false
      validateSheetFilter(key, map.get(key))
    } catch {
      return false
    }
  }
  return true
}

function changesForMap(transaction: Y.Transaction, map: Y.Map<unknown>): Map<string, KeyChange> {
  const changes = new Map<string, KeyChange>()
  for (const event of transactionEvents(transaction, map)) {
    if (!(event instanceof Y.YMapEvent) || event.target !== map) continue
    for (const [key, change] of event.changes.keys) changes.set(key, change as KeyChange)
  }
  return changes
}

function restoreChangedValues(
  doc: Y.Doc,
  map: Y.Map<unknown>,
  changes: ReadonlyMap<string, KeyChange>,
  transaction: Y.Transaction,
  atomicRootMaps: readonly Y.Map<unknown>[],
): void {
  const changedMaps: Array<{ map: Y.Map<unknown>; changes: ReadonlyMap<string, KeyChange> }> = [
    { map, changes },
  ]
  // Preserve validation deletions as repair progress, but roll back direct writes to other root
  // maps from the same client transaction so a rejected checkbox edit cannot leave cells behind.
  for (const sharedType of atomicRootMaps) {
    if (sharedType === map) continue
    for (const event of transactionEvents(
      transaction,
      sharedType,
    )) {
      if (event instanceof Y.YMapEvent && event.target === sharedType && event.changes.keys.size > 0) {
        changedMaps.push({
          map: sharedType as Y.Map<unknown>,
          changes: new Map(event.changes.keys as Map<string, KeyChange>),
        })
      }
    }
  }
  const restores = changedMaps.flatMap(({ map: changedMap, changes: mapChanges }) =>
    [...mapChanges.entries()]
      .filter(([, change]) => changedMap !== map || change.action !== 'delete')
      .filter(([key, change]) => change.action === 'add'
        ? changedMap.has(key)
        : !isDeepStrictEqual(changedMap.get(key), change.oldValue))
      .map(([key, change]) => ({ map: changedMap, key, change })))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  // A repair relayed by another server can already leave this replica at the target value. Opening
  // another transaction in that state would create a new Yjs struct and make two guards ping-pong.
  if (restores.length === 0) return
  doc.transact(() => {
    for (const restore of restores) {
      if (restore.change.action === 'add') restore.map.delete(restore.key)
      else restore.map.set(restore.key, restore.change.oldValue)
    }
  }, SHEET_DATA_VALIDATION_GUARD_ORIGIN)
}

function snapshotBefore(map: Y.Map<unknown>, changes: ReadonlyMap<string, KeyChange>): Map<string, unknown> {
  const before = new Map(map.entries())
  for (const [key, change] of changes) {
    if (change.action === 'add') before.delete(key)
    else before.set(key, change.oldValue)
  }
  return before
}

function withinStorageLimits(
  usage: ReturnType<typeof measureSheetDataValidationStorage>,
  limits: SheetDataValidationStorageLimits,
): boolean {
  return usage.unmeasurableRules === 0 && usage.rules <= limits.maxRules && usage.bytes <= limits.maxBytes
}

function nonGrowingStorageRepair(
  before: ReturnType<typeof measureSheetDataValidationStorage>,
  after: ReturnType<typeof measureSheetDataValidationStorage>,
): boolean {
  if (before.unmeasurableRules > 0 || after.unmeasurableRules > 0) {
    return after.unmeasurableRules < before.unmeasurableRules &&
      after.rules <= before.rules && after.bytes <= before.bytes
  }
  return after.rules <= before.rules && after.bytes <= before.bytes
}

function affectedSheetSnapshot(
  map: Y.Map<unknown>,
  changes: ReadonlyMap<string, KeyChange>,
  allowedLogicalIds: ReadonlySet<string>,
): Record<string, unknown> {
  const affected = new Set<string>()
  for (const key of changes.keys()) {
    const separator = key.indexOf('!')
    if (separator > 0) affected.add(key.slice(0, separator))
  }
  const result: Record<string, unknown> = Object.create(null)
  for (const [key, value] of map.entries()) {
    const separator = key.indexOf('!')
    if (separator > 0 && affected.has(key.slice(0, separator))) result[key] = value
  }
  validateSheetDataValidations(result, allowedLogicalIds, false, UNBOUNDED_STORAGE)
  return result
}

/**
 * Guard backend-owned worksheet resource maps against unvalidated WebSocket writes.
 *
 * Hocuspocus applies a Yjs frame before an observer can inspect it, so rejection is represented by
 * one synchronous compensating transaction. The repair is value-idempotent across Redis relays.
 * Validation deletions survive a rejected mixed transaction so legacy state remains repairable.
 * Adds/updates must be valid rules for a live sheet, freeze/filter entries must pass the same strict
 * validators as REST, and a client cannot replace an existing rule with another validation type.
 * Server-authoritative REST/restore transactions and their Redis replay may perform that deliberate
 * type replacement because both paths validate the complete target before mutation.
 */
export function attachSheetDataValidationGuard(
  doc: Y.Doc,
  limits: SheetDataValidationStorageLimits,
): () => void {
  // A root loaded through Y.applyUpdate remains an AbstractType until getMap() materializes it.
  // Materialize every known Sheet map before observing transactions so one rejected remote frame
  // cannot leave sibling cell/dimension/protection writes partially applied.
  const atomicRootMaps = SHEET_ATOMIC_ROOT_MAP_FIELDS.map((field) => doc.getMap<unknown>(field))
  const map = doc.getMap<unknown>(SHEET_DATA_VALIDATIONS_FIELD)
  const freezeMap = doc.getMap<unknown>(SHEET_FREEZE_FIELD)
  const filterMap = doc.getMap<unknown>(SHEET_FILTERS_FIELD)
  const observer = (transaction: Y.Transaction): void => {
    if (transaction.origin === SHEET_DATA_VALIDATION_GUARD_ORIGIN) return
    const changes = changesForMap(transaction, map)
    const freezeChanges = changesForMap(transaction, freezeMap)
    const filterChanges = changesForMap(transaction, filterMap)
    if (changes.size === 0 && freezeChanges.size === 0 && filterChanges.size === 0) return
    const allowedLogicalIds = logicalIds(doc)
    try {
      if (!changedValuesAreValidRules(
        map,
        changes,
        allowedLogicalIds,
        isServerAuthoritativeOrigin(transaction.origin),
      )) throw new Error('invalid data-validation write')
      if (!changedFreezeValuesAreValid(freezeMap, freezeChanges, allowedLogicalIds)) {
        throw new Error('invalid freeze write')
      }
      if (!changedFilterValuesAreValid(filterMap, filterChanges, allowedLogicalIds)) {
        throw new Error('invalid filter write')
      }
      if (changes.size > 0) {
        const beforeUsage = measureSheetDataValidationStorage(snapshotBefore(map, changes))
        const afterUsage = measureSheetDataValidationStorage(map.entries())
        if (!withinStorageLimits(afterUsage, limits) && !nonGrowingStorageRepair(beforeUsage, afterUsage)) {
          throw new Error('data-validation storage limit exceeded')
        }
        affectedSheetSnapshot(map, changes, allowedLogicalIds)
      }
    } catch {
      restoreChangedValues(doc, map, changes, transaction, atomicRootMaps)
    }
  }
  // afterTransaction runs after every changed type has produced its event, so a rejected
  // validation write can compensate sibling root-map writes from the same atomic client update.
  doc.on('afterTransaction', observer)
  return () => doc.off('afterTransaction', observer)
}
