import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'

// Exercise commitLiveSheetEdit itself against a real Y.Doc. Route tests mock
// this boundary, so they cannot prove the validated worksheet resources are
// actually written to the collaboration document.
const harness = vi.hoisted(() => ({
  liveDoc: null as unknown as Y.Doc,
  disposeGuard: null as null | (() => void),
}))
vi.mock('../src/collab/server.js', () => ({
  getCollabServer: () => ({
    hocuspocus: {
      openDirectConnection: async () => ({
        transact: async (callback: (doc: Y.Doc) => void) => {
          harness.liveDoc.transact(
            () => callback(harness.liveDoc),
            { source: 'local', context: { user: { id: 'u_1' } } },
          )
        },
        disconnect: async () => {},
      }),
    },
  }),
}))

import {
  SHEET_DATA_VALIDATIONS_FIELD,
  SHEET_FILTERS_FIELD,
  SHEET_FREEZE_FIELD,
  SHEET_LIST_FIELD,
  SHEET_YMAP_FIELD,
} from '../src/agent/sheetConversion.js'
import { commitLiveSheetEdit, readLiveSheet } from '../src/collab/liveSheetWrite.js'
import { applyRestoreToLiveDoc } from '../src/collab/liveRestore.js'
import { attachSheetDataValidationGuard } from '../src/collab/sheetDataValidationGuard.js'
import {
  decodeSheetDataValidationsSnapshot,
  decodeSheetFiltersSnapshot,
  decodeSheetFreezeSnapshot,
} from '../src/collab/versionRestore.js'

const range = { startRow: 0, startColumn: 0, endRow: 20, endColumn: 1 }
const freeze = { default: { startRow: 1, startColumn: 1, xSplit: 1, ySplit: 1 } }
const filters = {
  default: {
    ref: range,
    filterColumns: [{ colId: 1, filters: { filters: ['待处理'] } }],
    enabledColumns: [0, 1],
  },
}
const dataValidations = {
  default: [
    {
      uid: 'single',
      type: 'list',
      operator: 'equal',
      formula1: '["待处理","已完成"]',
      formula2: '#E4F4FE,#EFFBD0',
      showDropDown: true,
      renderMode: 2,
      ranges: [{ startRow: 1, startColumn: 0, endRow: 20, endColumn: 0 }],
    },
    {
      uid: 'multiple',
      type: 'listMultiple',
      formula1: '["待处理","已完成"]',
      formula2: '#E4F4FE,#EFFBD0',
      showDropDown: true,
      renderMode: 2,
      ranges: [{ startRow: 1, startColumn: 1, endRow: 20, endColumn: 1 }],
    },
  ],
}

beforeEach(() => {
  harness.liveDoc = new Y.Doc()
  harness.disposeGuard = attachSheetDataValidationGuard(harness.liveDoc, {
    maxRules: 100,
    maxBytes: 100_000,
  })
})

afterEach(() => harness.disposeGuard?.())

describe('commitLiveSheetEdit — P0 worksheet resources', () => {
  it('writes freeze, shared filter, and single/multi dropdowns into the live Y.Doc', async () => {
    const before = Y.encodeStateVector(harness.liveDoc)
    const result = await commitLiveSheetEdit(
      'octo:s1:f_default:d_p0',
      'u_1',
      before,
      { 'default!0:0': { v: 'persisted' } },
      {},
      {},
      {},
      {},
      {},
      freeze,
      filters,
      dataValidations,
    )

    expect(result.newSV).not.toEqual(before)
    expect(harness.liveDoc.getMap(SHEET_YMAP_FIELD).get('default!0:0')).toEqual({ v: 'persisted' })
    expect(harness.liveDoc.getMap(SHEET_FREEZE_FIELD).get('default')).toEqual(freeze.default)
    expect(harness.liveDoc.getMap(SHEET_FILTERS_FIELD).get('default')).toEqual(filters.default)
    const rules = harness.liveDoc.getMap<Record<string, unknown>>(SHEET_DATA_VALIDATIONS_FIELD)
    expect([...rules.keys()].sort()).toEqual(['default!multiple', 'default!single'])
    expect(rules.get('default!single')).not.toHaveProperty('operator')

    const read = await readLiveSheet('octo:s1:f_default:d_p0')
    expect(decodeSheetFreezeSnapshot(read.state)).toEqual(freeze)
    expect(decodeSheetFiltersSnapshot(read.state)).toEqual(filters)
    expect(decodeSheetDataValidationsSnapshot(read.state).default?.sort((a, b) => a.uid.localeCompare(b.uid))).toEqual([
      { ...dataValidations.default[0], operator: undefined },
      dataValidations.default[1],
    ].map(({ operator: _operator, ...rule }) => rule).sort((a, b) => a.uid.localeCompare(b.uid)))
  })

  it('removes all three resource entries with null or an empty rule list', async () => {
    const first = await commitLiveSheetEdit(
      'octo:s1:f_default:d_p0', 'u_1', Y.encodeStateVector(harness.liveDoc),
      {}, {}, {}, {}, {}, {}, freeze, filters, dataValidations,
    )
    await commitLiveSheetEdit(
      'octo:s1:f_default:d_p0', 'u_1', first.newSV,
      {}, {}, {}, {}, {}, {}, { default: null }, { default: null }, { default: [] },
    )

    expect(harness.liveDoc.getMap(SHEET_FREEZE_FIELD).has('default')).toBe(false)
    expect(harness.liveDoc.getMap(SHEET_FILTERS_FIELD).has('default')).toBe(false)
    expect([...harness.liveDoc.getMap(SHEET_DATA_VALIDATIONS_FIELD).keys()]).toEqual([])
  })

  it('restores cells and P0 resources through a real guard-attached direct connection', async () => {
    harness.liveDoc.getMap(SHEET_LIST_FIELD).set('default', { name: 'Sheet1', order: 0 })
    harness.liveDoc.getMap(SHEET_YMAP_FIELD).set('default!9:9', { v: 'live-only' })
    const target = new Y.Doc()
    target.getMap(SHEET_LIST_FIELD).set('default', { name: 'Sheet1', order: 0 })
    target.getMap(SHEET_YMAP_FIELD).set('default!0:0', { v: 'restored' })
    target.getMap(SHEET_FREEZE_FIELD).set('default', freeze.default)
    target.getMap(SHEET_FILTERS_FIELD).set('default', filters.default)
    for (const rule of dataValidations.default) {
      target.getMap(SHEET_DATA_VALIDATIONS_FIELD).set(`default!${rule.uid}`, rule)
    }

    await applyRestoreToLiveDoc('octo:s1:f_default:d_p0', 'u_1', Y.encodeStateAsUpdate(target))

    expect(harness.liveDoc.getMap(SHEET_YMAP_FIELD).toJSON()).toEqual({ 'default!0:0': { v: 'restored' } })
    expect(harness.liveDoc.getMap(SHEET_FREEZE_FIELD).get('default')).toEqual(freeze.default)
    expect(harness.liveDoc.getMap(SHEET_FILTERS_FIELD).get('default')).toEqual(filters.default)
    expect([...harness.liveDoc.getMap(SHEET_DATA_VALIDATIONS_FIELD).keys()].sort()).toEqual([
      'default!multiple',
      'default!single',
    ])
  })
})
