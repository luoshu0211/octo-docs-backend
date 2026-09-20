import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { galleryTextLines } from '../scripts/pptGalleryText.mjs'

it('decodes named and numeric entities exactly once while preserving line breaks', () => {
  expect(galleryTextLines('<b>toys &amp; websites</b><br>&lt;tag&gt; &#169; &#x1F680; &quot;hi&quot; &apos;x&apos;&nbsp;&amp;lt;'))
    .toEqual(['toys & websites', '<tag> © 🚀 "hi" \'x\'\u00a0&lt;'])
})

it('does not execute gallery markup or turn encoded tags into markup', () => {
  expect(galleryTextLines('<img src=x onerror="throw 1">&lt;img src=x&gt;')).toEqual(['<img src=x>'])
})

it('keeps generated gallery font licenses equal to their controlled source files', () => {
  for (const id of ['signal', 'terra', 'orbital', 'picnic']) {
    const deck = JSON.parse(readFileSync(new URL(`../src/ppt/gallery/${id}.json`, import.meta.url), 'utf8')) as { templateCredits: { fonts: Record<string, string> } }
    for (const [font, license] of Object.entries(deck.templateCredits.fonts)) {
      expect(license).toBe(readFileSync(new URL(`../docs/ppt-gallery/OFL-${font}.txt`, import.meta.url), 'utf8'))
    }
  }
})

it('round-trips decoded preview text through XML without visible entity spelling', () => {
  const text = galleryTextLines('toys &amp; gloriously useless websites')[0]
  const escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  const document = new JSDOM(`<svg xmlns="http://www.w3.org/2000/svg"><text>${escaped}</text></svg>`, { contentType: 'image/svg+xml' }).window.document
  expect(document.querySelector('text')?.textContent).toBe('toys & gloriously useless websites')
})
