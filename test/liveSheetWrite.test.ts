import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import {
  ProtectedRangeError,
  SHEET_DEFAULT_COLUMNS,
  SHEET_DEFAULT_ROWS,
  SHEET_DATA_VALIDATIONS_FIELD,
  SHEET_LIST_FIELD,
  SHEET_LEGACY_COLUMNS,
  SHEET_PROTECTION_FIELD,
  SHEET_PROTECTION_GRANTS_FIELD,
  SHEET_YMAP_FIELD,
  type StoredDataValidation,
  type StoredSheetMeta,
} from '../src/agent/sheetConversion.js'

const h = vi.hoisted(() => ({ liveDoc: null as unknown as Y.Doc }))
vi.mock('../src/collab/server.js', () => ({
  getCollabServer: () => ({
    hocuspocus: {
      openDirectConnection: async () => ({
        transact: async (callback: (doc: Y.Doc) => void) => {
          h.liveDoc.transact(() => callback(h.liveDoc))
        },
        disconnect: async () => {},
      }),
    },
  }),
}))

import { commitLiveSheetEdit } from '../src/collab/liveSheetWrite.js'
import { validateSheetDataValidations } from '../src/agent/sheetConversion.js'

const checkbox: StoredDataValidation = {
  uid: 'checkbox-detail',
  type: 'checkbox',
  ranges: [{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 }],
  allowBlank: true,
}

beforeEach(() => {
  h.liveDoc = new Y.Doc()
  h.liveDoc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD).set('detail', { name: 'Detail', order: 0 })
  h.liveDoc.getMap<StoredDataValidation>(SHEET_DATA_VALIDATIONS_FIELD)
    .set('detail!checkbox-detail', checkbox)
})

describe('commitLiveSheetEdit — checkbox lifecycle', () => {
  it('adds a checkbox to the implicit default tab of a V1 sheet', async () => {
    h.liveDoc = new Y.Doc()
    h.liveDoc.getMap('sheet').set('default!0:0', { v: 0 })
    const rule = { ...checkbox, uid: 'checkbox-default' }

    await commitLiveSheetEdit(
      'doc:sheet',
      'u_1',
      Y.encodeStateVector(h.liveDoc),
      {},
      {},
      {},
      {},
      {},
      {},
      { 'default!checkbox-default': rule },
      true,
    )

    expect(h.liveDoc.getMap(SHEET_DATA_VALIDATIONS_FIELD).get('default!checkbox-default')).toEqual(rule)
  })

  it('keeps the implicit default tab addressable when adding the first explicit tab', async () => {
    h.liveDoc = new Y.Doc()
    h.liveDoc.getMap('sheet').set('default!0:0', { v: 0 })
    const rule = { ...checkbox, uid: 'checkbox-default' }

    await commitLiveSheetEdit(
      'doc:sheet',
      'u_1',
      Y.encodeStateVector(h.liveDoc),
      {},
      {},
      {},
      {},
      {},
      { detail: { name: 'Detail', order: 1 } },
      { 'default!checkbox-default': rule },
      true,
    )

    expect(h.liveDoc.getMap(SHEET_LIST_FIELD).toJSON()).toEqual({
      default: {
        name: 'Sheet1', order: 0, rowCount: 1000, columnCount: SHEET_LEGACY_COLUMNS,
      },
      detail: {
        name: 'Detail', order: 1, rowCount: SHEET_DEFAULT_ROWS, columnCount: SHEET_DEFAULT_COLUMNS,
      },
    })
    expect(h.liveDoc.getMap(SHEET_DATA_VALIDATIONS_FIELD).get('default!checkbox-default')).toEqual(rule)
  })

  it('authorizes the implicit default materialization as a protected-sheet write', async () => {
    h.liveDoc = new Y.Doc()
    h.liveDoc.getMap('sheet').set('default!0:0', { v: 0 })
    h.liveDoc.getMap<StoredDataValidation>(SHEET_DATA_VALIDATIONS_FIELD)
      .set('default!checkbox-default', { ...checkbox, uid: 'checkbox-default' })
    h.liveDoc.getMap(SHEET_PROTECTION_FIELD).set('default!w:', {
      kind: 'w',
      permissionId: 'perm-default',
    })
    h.liveDoc.getMap(SHEET_PROTECTION_GRANTS_FIELD).set('perm-default', { allow: [] })

    await expect(commitLiveSheetEdit(
      'doc:sheet',
      'u_1',
      Y.encodeStateVector(h.liveDoc),
      {},
      {},
      {},
      {},
      {},
      { detail: { name: 'Detail', order: 1 } },
      {},
      false,
    )).rejects.toBeInstanceOf(ProtectedRangeError)

    expect(h.liveDoc.getMap(SHEET_LIST_FIELD).size).toBe(0)
  })

  it('deletes a sheet and its checkbox rules in the same transaction', async () => {
    await commitLiveSheetEdit(
      'doc:sheet',
      'u_1',
      Y.encodeStateVector(h.liveDoc),
      {},
      {},
      {},
      {},
      {},
      { detail: null },
      {},
      true,
    )

    expect(h.liveDoc.getMap(SHEET_LIST_FIELD).has('detail')).toBe(false)
    expect(h.liveDoc.getMap(SHEET_DATA_VALIDATIONS_FIELD).has('detail!checkbox-detail')).toBe(false)
  })

  it('commits repeated recovery deletions even while the first result remains over budget', async () => {
    h.liveDoc = new Y.Doc()
    h.liveDoc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD).set('default', { name: 'Sheet1', order: 0 })
    const validations = h.liveDoc.getMap<StoredDataValidation>(SHEET_DATA_VALIDATIONS_FIELD)
    const repeatedColumn = { startRow: 0, startColumn: 0, endRow: 999, endColumn: 0 }
    for (const [index, suffix] of ['a', 'b', 'c', 'd'].entries()) {
      validations.set(`default!${suffix}`, {
        uid: suffix,
        type: 'checkbox',
        ranges: Array.from({ length: 1000 }, () => ({
          ...repeatedColumn,
          startColumn: index,
          endColumn: index,
        })),
      })
    }

    await commitLiveSheetEdit(
      'doc:sheet', 'u_1', Y.encodeStateVector(h.liveDoc), {}, {}, {}, {}, {}, {},
      { 'default!c': null }, false,
    )
    expect(validations.has('default!c')).toBe(false)
    expect(() => validateSheetDataValidations(Object.fromEntries(validations.entries())))
      .toThrow('sheet inspection budget')

    await commitLiveSheetEdit(
      'doc:sheet', 'u_1', Y.encodeStateVector(h.liveDoc), {}, {}, {}, {}, {}, {},
      { 'default!d': null }, false,
    )
    expect(Object.keys(validateSheetDataValidations(Object.fromEntries(validations.entries())))).toEqual([
      'default!a',
      'default!b',
    ])
  })

  it('does not materialize default for an invalid checkbox-looking legacy entry', async () => {
    h.liveDoc = new Y.Doc()
    h.liveDoc.getMap('sheet').set('default!0:0', { v: 0 })
    h.liveDoc.getMap<unknown>(SHEET_DATA_VALIDATIONS_FIELD).set('default!broken', {
      uid: 'broken',
      type: 'checkbox',
      ranges: null,
    })

    await commitLiveSheetEdit(
      'doc:sheet', 'u_1', Y.encodeStateVector(h.liveDoc), {}, {}, {}, {}, {},
      { detail: { name: 'Detail', order: 1 } }, {}, true,
    )

    expect(h.liveDoc.getMap(SHEET_LIST_FIELD).toJSON()).toEqual({
      detail: {
        name: 'Detail', order: 1, rowCount: SHEET_DEFAULT_ROWS, columnCount: SHEET_DEFAULT_COLUMNS,
      },
    })
  })
})

describe('commitLiveSheetEdit — declared grid size', () => {
  it('keeps an implicit V1 default at 1000-by-100 when its first registry write is a rename', async () => {
    h.liveDoc = new Y.Doc()
    h.liveDoc.getMap(SHEET_YMAP_FIELD).set('default!500:0', { v: 'legacy row' })
    h.liveDoc.getMap(SHEET_YMAP_FIELD).set('default!0:50', { v: 'legacy column' })

    await commitLiveSheetEdit(
      'doc:sheet', 'u_1', Y.encodeStateVector(h.liveDoc),
      {}, {}, {}, {}, {}, { default: { name: 'Renamed', order: 0 } }, {}, true,
    )

    expect(h.liveDoc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD).get('default')).toEqual({
      name: 'Renamed', order: 0, rowCount: 1000, columnCount: 100,
    })
    expect(h.liveDoc.getMap(SHEET_YMAP_FIELD).get('default!500:0')).toEqual({ v: 'legacy row' })
    expect(h.liveDoc.getMap(SHEET_YMAP_FIELD).get('default!0:50')).toEqual({ v: 'legacy column' })
  })

  it('grows rowCount atomically with a cell written below the current boundary', async () => {
    h.liveDoc = new Y.Doc()
    h.liveDoc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD).set('default', {
      name: 'Sheet1', order: 0, rowCount: SHEET_DEFAULT_ROWS,
    })

    await commitLiveSheetEdit(
      'doc:sheet', 'u_1', Y.encodeStateVector(h.liveDoc),
      { 'default!299:0': { v: 'visible' } }, {}, {}, {}, {}, {}, {}, true,
    )

    expect(h.liveDoc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD).get('default')).toEqual({
      name: 'Sheet1', order: 0, rowCount: 300, columnCount: SHEET_LEGACY_COLUMNS,
    })
    expect(h.liveDoc.getMap(SHEET_YMAP_FIELD).get('default!299:0')).toEqual({ v: 'visible' })
  })

  it('preserves rowCount when a legacy CLI rename omits it', async () => {
    h.liveDoc = new Y.Doc()
    h.liveDoc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD).set('default', {
      name: 'Sheet1', order: 0, rowCount: 400,
    })

    await commitLiveSheetEdit(
      'doc:sheet', 'u_1', Y.encodeStateVector(h.liveDoc),
      {}, {}, {}, {}, {}, { default: { name: 'Renamed', order: 0 } }, {}, true,
    )

    expect(h.liveDoc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD).get('default')).toEqual({
      name: 'Renamed', order: 0, rowCount: 400, columnCount: SHEET_LEGACY_COLUMNS,
    })
  })

  it('grows columnCount atomically with a cell written in column U', async () => {
    h.liveDoc = new Y.Doc()
    h.liveDoc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD).set('default', {
      name: 'Sheet1',
      order: 0,
      rowCount: SHEET_DEFAULT_ROWS,
      columnCount: SHEET_DEFAULT_COLUMNS,
    })

    await commitLiveSheetEdit(
      'doc:sheet', 'u_1', Y.encodeStateVector(h.liveDoc),
      { [`default!0:${SHEET_DEFAULT_COLUMNS}`]: { v: 'visible' } }, {}, {}, {}, {}, {}, {}, true,
    )

    expect(h.liveDoc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD).get('default')).toEqual({
      name: 'Sheet1',
      order: 0,
      rowCount: SHEET_DEFAULT_ROWS,
      columnCount: SHEET_DEFAULT_COLUMNS + 1,
    })
    expect(h.liveDoc.getMap(SHEET_YMAP_FIELD).get(`default!0:${SHEET_DEFAULT_COLUMNS}`)).toEqual({
      v: 'visible',
    })
  })
})
