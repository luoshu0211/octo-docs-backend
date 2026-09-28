import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { SHEET_CONDITIONAL_FORMATS_FIELD, validateConditionalFormat } from '../src/agent/sheetConditionalFormatting.js'
import { reconcileSheetMap, validateSheetMapReconcile } from '../src/collab/versionRestore.js'

const stored = {
  priority: 0,
  rule: {
    cfId: 'rule-one', stopIfTrue: false,
    ranges: [{ startRow: 0, endRow: 9999, startColumn: 0, endColumn: 19 }],
    rule: { type: 'highlightCell', subType: 'duplicateValues', style: { bg: { rgb: '#ff0000' } } },
  },
}

describe('conditional formatting history', () => {
  it('restores compact rules and removes live-only entries', () => {
    const live = new Y.Doc()
    const target = new Y.Doc()
    live.getMap(SHEET_CONDITIONAL_FORMATS_FIELD).set('default!old', { ...stored, rule: { ...stored.rule, cfId: 'old' } })
    target.getMap(SHEET_CONDITIONAL_FORMATS_FIELD).set('default!rule-one', stored)
    live.transact(() => reconcileSheetMap(live, Y.encodeStateAsUpdate(target)))
    expect(live.getMap(SHEET_CONDITIONAL_FORMATS_FIELD).toJSON()).toEqual({ 'default!rule-one': stored })
    live.transact(() => reconcileSheetMap(live, Y.encodeStateAsUpdate(new Y.Doc())))
    expect(live.getMap(SHEET_CONDITIONAL_FORMATS_FIELD).size).toBe(0)
  })

  it('rejects malformed rules before changing cells or any other live state', () => {
    const live = new Y.Doc()
    const target = new Y.Doc()
    live.getMap('sheet').set('default!0:0', { v: 'keep' })
    target.getMap('sheet').set('default!0:0', { v: 'replace' })
    target.getMap(SHEET_CONDITIONAL_FORMATS_FIELD).set('default!rule-one', { ...stored, rule: { ...stored.rule, ranges: 'A1' } })
    const state = Y.encodeStateAsUpdate(target)
    expect(() => validateSheetMapReconcile(live, state)).toThrow('sheet_snapshot_invalid')
    expect(() => live.transact(() => reconcileSheetMap(live, state))).toThrow('sheet_snapshot_invalid')
    expect(live.getMap('sheet').get('default!0:0')).toEqual({ v: 'keep' })
  })

  it('rejects hostile keys, mismatched ids, invalid coordinates and oversized rules', () => {
    expect(() => validateConditionalFormat('__proto__!rule-one', stored)).toThrow()
    expect(() => validateConditionalFormat('default!other', stored)).toThrow()
    expect(() => validateConditionalFormat('default!rule-one', { ...stored, rule: { ...stored.rule, ranges: [{ startRow: -1, endRow: 1, startColumn: 0, endColumn: 1 }] } })).toThrow()
    expect(() => validateConditionalFormat('default!rule-one', { ...stored, extra: 'x'.repeat(70_000) })).toThrow()
    expect(validateConditionalFormat('default!rule-one', stored)).toEqual(stored)
  })
})
