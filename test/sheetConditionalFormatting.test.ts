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
  it('rejects rules for missing restored sheets before any mutation, even when the sheet exists live', () => {
    const live = new Y.Doc()
    const target = new Y.Doc()
    live.getMap('sheetList').set('missing', { name: 'Live only', order: 0 })
    live.getMap('sheet').set('missing!0:0', { v: 'keep' })
    live.getMap(SHEET_CONDITIONAL_FORMATS_FIELD).set('missing!rule-one', stored)
    target.getMap('sheetList').set('restored', { name: 'Restored', order: 0 })
    target.getMap('sheet').set('restored!0:0', { v: 'replace' })
    target.getMap(SHEET_CONDITIONAL_FORMATS_FIELD).set('missing!rule-one', stored)
    const state = Y.encodeStateAsUpdate(target)
    const before = Y.encodeStateAsUpdate(live)
    expect(() => validateSheetMapReconcile(live, state)).toThrow('sheet_snapshot_invalid')
    expect(Y.encodeStateAsUpdate(live)).toEqual(before)
    expect(() => live.transact(() => reconcileSheetMap(live, state))).toThrow('sheet_snapshot_invalid')
    expect(Y.encodeStateAsUpdate(live)).toEqual(before)
    target.getMap(SHEET_CONDITIONAL_FORMATS_FIELD).delete('missing!rule-one')
    target.getMap(SHEET_CONDITIONAL_FORMATS_FIELD).set('restored!rule-one', stored)
    live.transact(() => reconcileSheetMap(live, Y.encodeStateAsUpdate(target)))
    expect(live.getMap(SHEET_CONDITIONAL_FORMATS_FIELD).toJSON()).toEqual({ 'restored!rule-one': stored })
  })

  it.each([
    { type: 'dataBar', isShowValue: true, config: { min: { type: 'num', value: 0 }, max: { type: 'num', value: 10 }, isGradient: true, positiveColor: '#00ff00', nativeColor: '#ff0000' } },
    { type: 'dataBar', isShowValue: false, config: { min: { type: 'num', value: -10 }, max: { type: 'num', value: 0 }, isGradient: false, positiveColor: '#00ff00', nativeColor: '#ff0000' } },
    { type: 'dataBar', isShowValue: true, config: { min: { type: 'min' }, max: { type: 'max' }, isGradient: true, positiveColor: '#00ff00', nativeColor: '#ff0000' } },
    { type: 'dataBar', isShowValue: true, config: { min: { type: 'num', value: '0' }, max: { type: 'formula', value: '=MAX(A1:A10)' }, isGradient: true, positiveColor: '#00ff00', nativeColor: '#ff0000' } },
    { type: 'colorScale', config: [{ index: 0, color: '#ff0000', value: { type: 'min' } }, { index: 1, color: '#00ff00', value: { type: 'num', value: 0 } }] },
    { type: 'iconSet', isShowValue: true, config: [0, 50, 90].map((value, index) => ({ operator: 'greaterThanOrEqual', value: { type: 'percent', value }, iconType: '3Arrows', iconId: String(index) })) },
    { type: 'colorScale', config: [{ index: 0, color: '#ff0000', value: { type: 'percentile', value: 0 } }, { index: 1, color: '#00ff00', value: { type: 'max' } }] },
  ])('round-trips Univer $type configurations including zero thresholds through validation and restore', (config) => {
    const value = { ...stored, priority: -2, rule: { ...stored.rule, rule: config } }
    expect(validateConditionalFormat('default!rule-one', value)).toEqual(value)
    const live = new Y.Doc()
    const target = new Y.Doc()
    target.getMap(SHEET_CONDITIONAL_FORMATS_FIELD).set('default!rule-one', value)
    live.transact(() => reconcileSheetMap(live, Y.encodeStateAsUpdate(target)))
    expect(live.getMap(SHEET_CONDITIONAL_FORMATS_FIELD).get('default!rule-one')).toEqual(value)
  })

  it.each([
    { type: 'dataBar', config: { min: 0, max: 10, positiveColor: '#0f0' } },
    { type: 'dataBar', config: { min: 1, max: 10, positiveColor: '#0f0' } },
    { type: 'dataBar', config: { min: null, max: { type: 'max' }, positiveColor: '#0f0' } },
    { type: 'dataBar', config: { min: { type: 'num', value: 0 }, positiveColor: '#0f0' } },
    { type: 'colorScale', config: [null, null] },
    { type: 'iconSet', config: [{ value: 0 }, { value: { type: 'invalid' } }] },
    { type: 'dataBar', config: { min: { type: 'num', value: false }, max: { type: 'max' }, positiveColor: '#0f0' } },
  ])('rejects malformed $type threshold shapes', (config) => {
    expect(() => validateConditionalFormat('default!rule-one', { ...stored, rule: { ...stored.rule, rule: config } })).toThrow('sheet_snapshot_invalid')
  })

  it('preserves finite signed priorities and bounded extension properties for frontend round-tripping', () => {
    const value = { ...stored, priority: -2.5, extension: { revision: 1 }, rule: { ...stored.rule, extension: { label: 'future' } } }
    expect(validateConditionalFormat('default!rule-one', value)).toEqual(value)
    for (const priority of [NaN, Infinity, -Infinity]) {
      expect(() => validateConditionalFormat('default!rule-one', { ...stored, priority })).toThrow('sheet_snapshot_invalid')
    }
  })

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
