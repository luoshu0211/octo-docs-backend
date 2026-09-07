import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import {
  ProtectedRangeError,
  SHEET_DATA_VALIDATIONS_FIELD,
  SHEET_LIST_FIELD,
  SHEET_PROTECTION_FIELD,
  SHEET_PROTECTION_GRANTS_FIELD,
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
      default: { name: 'Sheet1', order: 0 },
      detail: { name: 'Detail', order: 1 },
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
      detail: { name: 'Detail', order: 1 },
    })
  })
})
