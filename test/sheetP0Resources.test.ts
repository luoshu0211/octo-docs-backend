import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  SHEET_FREEZE_FIELD,
  SHEET_FILTERS_FIELD,
  SHEET_DATA_VALIDATIONS_FIELD,
  SheetSnapshotInvalidError,
  applySheetFreezeToYMap,
  applySheetFiltersToYMap,
  applySheetDataValidationsToYMap,
  measureSheetAfterEdit,
  validateSheetDataValidationBatch,
  validateSheetFilterBatch,
  validateSheetFreezeBatch,
  type StoredFreeze,
  type StoredFilter,
  type StoredDataValidationRule,
} from '../src/agent/sheetConversion.js'
import {
  decodeSheetFreezeSnapshot,
  decodeSheetFiltersSnapshot,
  decodeSheetDataValidationsSnapshot,
  reconcileSheetMap,
} from '../src/collab/versionRestore.js'

const range = { startRow: 0, startColumn: 0, endRow: 9, endColumn: 1 }
const freeze = { default: { startRow: 1, startColumn: -1, xSplit: 0, ySplit: 1 } }
const filters = {
  default: { ref: range, filterColumns: [{ colId: 1, filters: { blank: false, filters: ['open'] } }] },
}
const validations = {
  default: [{
    uid: 'bot-status',
    type: 'listMultiple',
    operator: 'equal',
    formula1: '["待处理","处理中"]',
    formula2: '#9ec5fe,#ffd8a8',
    showDropDown: true,
    renderMode: 2,
    ranges: [range],
  }],
}

function stateWithResources(
  freezeValue: Record<string, StoredFreeze | null> = freeze,
  filterValue: Record<string, StoredFilter | null> = filters,
  validationValue: Record<string, StoredDataValidationRule[] | null> = validations,
): Uint8Array {
  const doc = new Y.Doc()
  doc.transact(() => {
    applySheetFreezeToYMap(doc.getMap(SHEET_FREEZE_FIELD), freezeValue)
    applySheetFiltersToYMap(doc.getMap(SHEET_FILTERS_FIELD), filterValue)
    applySheetDataValidationsToYMap(doc.getMap(SHEET_DATA_VALIDATIONS_FIELD), validationValue)
  })
  return Y.encodeStateAsUpdate(doc)
}

describe('P0 worksheet resource contract', () => {
  it('round-trips freeze, filter, and colored multi-select dropdown data', () => {
    const state = stateWithResources()

    expect(decodeSheetFreezeSnapshot(state)).toEqual(freeze)
    expect(decodeSheetFiltersSnapshot(state)).toEqual(filters)
    expect(decodeSheetDataValidationsSnapshot(state)).toEqual({
      default: [{
        uid: 'bot-status',
        type: 'listMultiple',
        formula1: '["待处理","处理中"]',
        formula2: '#9ec5fe,#ffd8a8',
        showDropDown: true,
        renderMode: 2,
        ranges: [range],
      }],
    })
  })

  it('merges distinct rules authored concurrently because each uid owns its Y.Map key', () => {
    const first = new Y.Doc()
    const second = new Y.Doc()
    applySheetDataValidationsToYMap(first.getMap(SHEET_DATA_VALIDATIONS_FIELD), {
      default: [{ ...validations.default[0]!, uid: 'first' }],
    })
    applySheetDataValidationsToYMap(second.getMap(SHEET_DATA_VALIDATIONS_FIELD), {
      default: [{ ...validations.default[0]!, uid: 'second' }],
    })

    const firstUpdate = Y.encodeStateAsUpdate(first)
    const secondUpdate = Y.encodeStateAsUpdate(second)
    Y.applyUpdate(first, secondUpdate)
    Y.applyUpdate(second, firstUpdate)

    expect(new Set(first.getMap(SHEET_DATA_VALIDATIONS_FIELD).keys())).toEqual(
      new Set(['default!first', 'default!second']),
    )
    expect(decodeSheetDataValidationsSnapshot(Y.encodeStateAsUpdate(first)).default?.map((rule) => rule.uid))
      .toEqual(['first', 'second'])
    expect(decodeSheetDataValidationsSnapshot(Y.encodeStateAsUpdate(second))).toEqual(
      decodeSheetDataValidationsSnapshot(Y.encodeStateAsUpdate(first)),
    )
  })

  it('decodes dropdown and checkbox entries from the shared per-rule key schema', () => {
    const doc = new Y.Doc()
    doc.getMap(SHEET_DATA_VALIDATIONS_FIELD).set('default!dropdown', {
      ...validations.default[0],
      uid: 'dropdown',
    })
    doc.getMap(SHEET_DATA_VALIDATIONS_FIELD).set('default!checkbox', {
      uid: 'checkbox',
      type: 'checkbox',
      formula1: '1',
      formula2: '0',
      allowBlank: true,
      ranges: [range],
    })

    const decoded = decodeSheetDataValidationsSnapshot(Y.encodeStateAsUpdate(doc))
    expect(decoded.default?.map((rule) => rule.uid)).toEqual(['checkbox', 'dropdown'])
  })

  it('treats an empty validation array as deletion and normalizes LIST operators', () => {
    const normalized = validateSheetDataValidationBatch(validations)
    expect(normalized.toSet).toHaveLength(1)
    expect(normalized.toSet[0]![0]).toBe('default!bot-status')
    expect(normalized.toSet[0]![1]).not.toHaveProperty('operator')
    expect(validateSheetDataValidationBatch({ default: [] })).toEqual({
      toDelete: ['default'],
      toSet: [],
    })
  })

  it('rejects resources outside the browser grid', () => {
    expect(() => validateSheetFreezeBatch({
      default: { startRow: 1000, startColumn: -1, xSplit: 0, ySplit: 1 },
    })).toThrow(SheetSnapshotInvalidError)
    expect(() => validateSheetFreezeBatch({
      default: { startRow: 0, startColumn: -1, xSplit: 0, ySplit: 1 },
    })).toThrow(SheetSnapshotInvalidError)
    expect(() => validateSheetFilterBatch({
      default: { ref: { ...range, endColumn: 100 } },
    })).toThrow(SheetSnapshotInvalidError)
    expect(() => validateSheetDataValidationBatch({
      default: [{ uid: 'bad', ranges: [{ ...range, endRow: 1000 }] }],
    })).toThrow(SheetSnapshotInvalidError)
  })

  it('counts compact resources in both persisted and read-payload size gates', () => {
    const empty = Y.encodeStateAsUpdate(new Y.Doc())
    const baseline = measureSheetAfterEdit(empty, {})
    const withResources = measureSheetAfterEdit(
      empty,
      {}, {}, {}, {}, {}, {}, freeze, filters, validations,
    )
    expect(withResources.docBytes).toBeGreaterThan(baseline.docBytes)
    expect(withResources.payloadBytes).toBeGreaterThan(baseline.payloadBytes)
  })

  it('version restore reconciles all three resource maps, including deletions', () => {
    const targetState = stateWithResources()
    const live = new Y.Doc()
    live.transact(() => {
      live.getMap(SHEET_FREEZE_FIELD).set('other', { startRow: 1, startColumn: -1, xSplit: 0, ySplit: 2 })
      live.getMap(SHEET_FILTERS_FIELD).set('other', { ref: range })
      live.getMap(SHEET_DATA_VALIDATIONS_FIELD).set('other!old', { uid: 'old', ranges: [range] })
    })

    live.transact(() => reconcileSheetMap(live, targetState))

    expect([...live.getMap(SHEET_FREEZE_FIELD).keys()]).toEqual(['default'])
    expect([...live.getMap(SHEET_FILTERS_FIELD).keys()]).toEqual(['default'])
    expect([...live.getMap(SHEET_DATA_VALIDATIONS_FIELD).keys()]).toEqual(['default!bot-status'])
    expect(decodeSheetDataValidationsSnapshot(Y.encodeStateAsUpdate(live)).default?.[0]).not.toHaveProperty('operator')
  })
})
