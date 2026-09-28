import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'

const harness = vi.hoisted(() => ({ doc: null as unknown as Y.Doc }))
vi.mock('../src/collab/server.js', () => ({ getCollabServer: () => ({ hocuspocus: {
  openDirectConnection: async () => ({ transact: async (callback: (doc: Y.Doc) => void) => harness.doc.transact(() => callback(harness.doc)), disconnect: async () => {} }),
} }) }))

import { commitLiveSheetEdit } from '../src/collab/liveSheetWrite.js'
import { decodeConditionalFormats, type ConditionalFormatChanges } from '../src/agent/sheetConditionalFormatting.js'
import { measureSheetAfterEdit, type SheetCell, type StoredSheetMeta } from '../src/agent/sheetConversion.js'
import { prepareSheetStructuralEdit } from '../src/agent/sheetStructuralEdit.js'
import { reconcileSheetMap } from '../src/collab/versionRestore.js'

const rule = { priority: 0, rule: { cfId: 'one', stopIfTrue: false,
  ranges: [{ startRow: 0, endRow: 20, startColumn: 0, endColumn: 1 }],
  rule: { type: 'highlightCell', subType: 'duplicateValues', style: { bg: { rgb: '#ff0000' } } },
} }
const changes = { 'default!one': rule }
beforeEach(() => { harness.doc = new Y.Doc() })

function commit(formats: ConditionalFormatChanges, cells: Record<string, SheetCell> = {}, sheets: Record<string, StoredSheetMeta | null> = {}) {
  return commitLiveSheetEdit('doc', 'writer', Y.encodeStateVector(harness.doc), cells, {}, {}, {}, {}, sheets, {}, {}, {}, false, undefined, formats)
}

describe('conditional format writes', () => {
  it('creates, updates, deletes and restores compact rules with advancing base versions', async () => {
    const first = await commit(changes)
    const saved = Y.encodeStateAsUpdate(harness.doc)
    expect(decodeConditionalFormats(saved)).toEqual(changes)
    await commit({ 'default!one': { ...rule, priority: 3 } })
    expect(decodeConditionalFormats(Y.encodeStateAsUpdate(harness.doc))['default!one']?.priority).toBe(3)
    const deleted = await commit({ 'default!one': null })
    expect(deleted.newSV).not.toEqual(first.newSV)
    expect(decodeConditionalFormats(Y.encodeStateAsUpdate(harness.doc))).toEqual({})
    harness.doc.transact(() => reconcileSheetMap(harness.doc, saved))
    expect(decodeConditionalFormats(Y.encodeStateAsUpdate(harness.doc))).toEqual(changes)
    expect(harness.doc.getMap('sheet').size).toBe(0)
  })

  it('validates every rule and logical sheet before touching any cells', async () => {
    await expect(commit({ ...changes, 'default!bad': rule }, { 'default!0:0': { v: 'never' } })).rejects.toThrow()
    await expect(commit({ 'missing!one': rule })).rejects.toThrow()
    expect(harness.doc.getMap('sheet').size).toBe(0)
    expect(harness.doc.getMap('sheetConditionalFormats').size).toBe(0)
  })

  it('bounds rule counts, UTF-8 bytes and hostile identifiers before applying a mixed batch', async () => {
    const tooMany = Object.fromEntries(Array.from({ length: 1001 }, (_, index) => {
      const cfId = `rule-${index}`
      return [`default!${cfId}`, { ...rule, rule: { ...rule.rule, cfId } }]
    }))
    await expect(commit(tooMany, { 'default!0:0': { v: 'never' } })).rejects.toThrow('storage limit')
    await expect(commit({ 'default!one': { ...rule, extra: '字'.repeat(22_000) } })).rejects.toThrow()
    await expect(commit({ 'default!one\n': null })).rejects.toThrow()
    expect(harness.doc.getMap('sheet').size).toBe(0)
    expect(harness.doc.getMap('sheetConditionalFormats').size).toBe(0)
  })

  it('honors protections and stale versions in the actual live transaction', async () => {
    const stale = Y.encodeStateVector(harness.doc)
    await commit(changes)
    await expect(commitLiveSheetEdit('doc', 'writer', stale, {}, {}, {}, {}, {}, {}, {}, {}, {}, false, undefined, changes)).rejects.toThrow('base_version_stale')
    harness.doc.getMap('sheetProtection').set('default!lock', { permissionId: 'lock', ranges: rule.rule.ranges })
    await expect(commit({ 'default!one': null })).rejects.toThrow('protected_range')
    expect(harness.doc.getMap('sheetConditionalFormats').has('default!one')).toBe(true)
  })

  it('includes rules in size accounting and removes rules with a deleted worksheet', async () => {
    const state = Y.encodeStateAsUpdate(harness.doc)
    const before = measureSheetAfterEdit(state, {})
    const after = measureSheetAfterEdit(state, {}, {}, {}, {}, {}, {}, {}, {}, {}, undefined, changes)
    expect(after.docBytes).toBeGreaterThan(before.docBytes)
    expect(after.payloadBytes).toBeGreaterThan(before.payloadBytes!)
    await commit(changes)
    await commit({}, {}, { default: null })
    expect(harness.doc.getMap('sheetConditionalFormats').size).toBe(0)
  })

  it.each(['rows.insert', 'rows.delete', 'columns.insert', 'columns.delete'] as const)('refuses %s until rule relocation is supported', async (kind) => {
    await commit(changes)
    const edit = { kind, logicalId: 'default', count: 1, afterRow: 0, startRow: 0, afterColumn: 0, startColumn: 0 }
    const before = Y.encodeStateAsUpdate(harness.doc)
    expect(() => prepareSheetStructuralEdit(harness.doc, edit)).toThrow('sheet_conditional_format_unsupported')
    await expect(commitLiveSheetEdit('doc', 'writer', Y.encodeStateVector(harness.doc), {}, {}, {}, {}, {}, {}, {}, {}, {}, false, edit)).rejects.toMatchObject({ code: 'sheet_conditional_format_unsupported' })
    expect(Y.encodeStateAsUpdate(harness.doc)).toEqual(before)
  })
})
