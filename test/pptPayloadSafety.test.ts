import { expect, it } from 'vitest'
import { validatePptDraft } from '../src/ppt/draft.js'
import { instantiateTemplate } from '../src/ppt/bentoDoc.js'
import { getPptTemplate } from '../src/ppt/templates.js'
import { offlineHostScript } from '../src/ppt/offlineHost.js'
import { buildPptHtml } from '../src/ppt/render.js'
import { JSDOM } from 'jsdom'

const deck = () => instantiateTemplate(getPptTemplate('pitch')!, new Date().toISOString())
it('refuses excessively nested JSON before recursive hashing or CRDT diffing', () => {
  const value = deck(); let object: Record<string, unknown> = value
  for (let i = 0; i < 600; i++) { const next = {}; object.extra = next; object = next }
  expect(() => validatePptDraft({ revision: 0, deck: value })).toThrow('nesting')
})
it.each([NaN, Infinity, -Infinity])('refuses non-finite element values (%s)', n => {
  const value = deck(); value.slides[0]!.elements = [{ id: 'test', type: 'shape', x: n }]
  expect(() => validatePptDraft({ revision: 0, deck: value })).toThrow('finite')
})
it('keeps legitimate additive JSON and medium embedded images', () => {
  const value = deck(); value.assets = { hero: `data:image/png;base64,${'A'.repeat(70000)}` }; value.extra = { compatible: [null, 2, true, 'text'] }
  expect(validatePptDraft({ revision: 0, deck: value }).deck).toEqual(value)
})
it('contains hostile title and slide HTML inside inert JSON in an opaque player', () => {
  const value = deck(); value.title = '</title><script>top.stolen=true</script>'
  value.slides[0]!.notes = '</script><script>top.stolen=true</script>'
  value.ownerId = 'not-exported'; value.docId = 'private-room'
  const html = buildPptHtml('<!doctype html><script id="bento-doc" type="application/json">__OCTO_PPT_DECK__</script>', value)
  const outer = new JSDOM(html); const frame = outer.window.document.querySelector('iframe')!
  expect(outer.window.document.querySelectorAll('script')).toHaveLength(1)
  expect(outer.window.document.querySelector('script')!.textContent).toBe(offlineHostScript)
  expect(outer.window.document.title).toBe(value.title)
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-modals allow-popups')
  expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin')
  expect(frame.getAttribute('allow')).toBe('fullscreen')
  const inner = new JSDOM(frame.getAttribute('srcdoc')!)
  expect(inner.window.document.querySelectorAll('script')).toHaveLength(1)
  const exported = JSON.parse(inner.window.document.getElementById('bento-doc')!.textContent!)
  expect(exported.title).toBe(value.title); expect(exported.slides[0].notes).toBe(value.slides[0]!.notes)
  expect(exported.ownerId).toBeUndefined(); expect(exported.docId).toBeUndefined()
  outer.window.close(); inner.window.close()
})

it.each([200,201,512])('renders the same %s-character title accepted at creation', length => {
  const value=deck();value.title='中'.repeat(length)
  expect(()=>validatePptDraft({revision:0,deck:value})).not.toThrow()
  expect(buildPptHtml('__OCTO_PPT_DECK__',value)).toContain(value.title)
})
it('rejects a title exceeding the shared 512-character contract', () => {
  const value=deck();value.title='x'.repeat(513)
  expect(()=>validatePptDraft({revision:0,deck:value})).toThrow('512')
})
it('allows safe escaped HTML larger than MEDIUMTEXT while enforcing the rendered size cap', () => {
  const value=deck();value.slides[0]!.notes='&'.repeat(3400000)
  const html=buildPptHtml('__OCTO_PPT_DECK__',value)
  expect(Buffer.byteLength(html)).toBeGreaterThan(16777215)
  expect(()=>buildPptHtml('x'.repeat(64*1024*1024)+'__OCTO_PPT_DECK__',deck())).toThrow('HTML size limit')
})
