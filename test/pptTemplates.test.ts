import { describe, it, expect } from 'vitest'
import {
  PPT_TEMPLATE_IDS,
  PPT_TEMPLATE_SUMMARIES,
  isPptTemplateId,
  getPptTemplate,
} from '../src/ppt/templates.js'
import { instantiateTemplate, isBentoDoc, BENTO_FORMAT, BENTO_FORMAT_VERSION } from '../src/ppt/bentoDoc.js'

// Current creation catalogue; legacy document compatibility uses stored fixtures.
// The frontend keyboard/preview UX is proven in octo-docs-module; here we prove
// the backend guarantees the picker relies on: accepted bundled 16:9 templates,
// and every materialized deck has a fresh docId/collab identity and no template
// marker.
describe('bundled PPT templates — current gallery', () => {
  it('exposes only blank and the four current gallery IDs', () => {
    expect([...PPT_TEMPLATE_IDS]).toEqual(['blank', 'signal', 'terra', 'orbital', 'picnic'])
    // Summaries (id/name/scenario the picker renders) cover exactly those ids.
    expect(PPT_TEMPLATE_SUMMARIES.map((t) => t.id)).toEqual([...PPT_TEMPLATE_IDS])
    for (const s of PPT_TEMPLATE_SUMMARIES) {
      expect(s.name).toBeTruthy()
      expect(s.scenario).toBeTruthy()
    }
  })

  it('accepts only bundled IDs (isPptTemplateId)', () => {
    for (const id of PPT_TEMPLATE_IDS) expect(isPptTemplateId(id)).toBe(true)
    for (const bad of ['', 'BLANK', 'deck', 'custom', 'toString', '__proto__', 42, null, undefined]) {
      expect(isPptTemplateId(bad as unknown)).toBe(false)
    }
  })

  it('every bundled template is a valid 16:9 bento/slides deck carrying template + collab markers', () => {
    for (const id of PPT_TEMPLATE_IDS) {
      const t = getPptTemplate(id)!
      expect(t).not.toBeNull()
      expect(isBentoDoc(t)).toBe(true)
      expect(t.format).toBe(BENTO_FORMAT)
      expect(t.version).toBe(BENTO_FORMAT_VERSION)
      expect(t.size).toEqual({ width: 1280, height: 720 })
      // The source file is a template with live-collab markers, so that
      // instantiation is provably exercised (both get stripped below).
      expect(t.template).toBe(true)
      expect(t.collab).toBeDefined()
      expect(t.slides.length).toBeGreaterThan(0)
    }
  })

  it('returns null for an unknown id', () => {
    expect(getPptTemplate('nope')).toBeNull()
  })
  it.each(['pitch', 'report', 'lesson'])('rejects retired template %s', id => {
    expect(isPptTemplateId(id)).toBe(false)
    expect(getPptTemplate(id)).toBeNull()
  })
  it.each(['signal', 'terra', 'orbital', 'picnic'])('%s carries independent reusable layouts and self-contained assets', (id) => {
    const source = getPptTemplate(id)!
    const deck = instantiateTemplate(source, '2026-09-16T00:00:00.000Z')
    const layouts = deck.layouts as typeof deck.slides
    expect(layouts.length).toBeGreaterThanOrEqual(5)
    expect(layouts.length).toBe(deck.slides.length)
    expect(new Set(layouts.map(s => s.id)).size).toBe(layouts.length)
    expect(JSON.stringify(deck).length).toBeLessThan(8_000_000)
    for (const slide of [...deck.slides, ...layouts]) {
      const family = layouts.includes(slide) ? layouts : deck.slides
      if (slide.stateOf) expect(family.some(s => s.id === slide.stateOf)).toBe(true)
      expect(slide.name).toBeTruthy()
      for (const value of slide.elements) {
        const el = value as Record<string, unknown>
        if (el.link) expect(family.some(s => s.id === el.link)).toBe(true)
        if (typeof el.src === 'string' && el.src.startsWith('asset:')) {
          expect((deck.assets as Record<string, string>)[el.src.slice(6)]).toMatch(/^data:(image|video|audio)\//)
        }
      }
    }
    layouts[0]!.elements.pop()
    expect((source.layouts as typeof source.slides)[0]!.elements.length).toBe(layouts[0]!.elements.length + 1)
    expect(deck.slides[0]!.elements.length).toBe(layouts[0]!.elements.length + 1)
    expect(deck.templateCredits).toBeDefined()
    const fonts = deck.fonts as Array<{asset: string}>
    expect(fonts.length).toBeGreaterThan(0)
    for (const font of fonts) expect((deck.assets as Record<string, string>)[font.asset]).toMatch(/^data:font\/woff2;base64,/)
    expect(deck.slides.some(slide => slide.themeRefs)).toBe(true)
  })
  it('preserves Orbital interactive states, media and animation', () => {
    const deck = getPptTemplate('orbital')!
    expect(deck.slides.filter(slide => !slide.stateOf)).toHaveLength(6)
    expect(deck.slides.filter(slide => slide.stateOf)).toHaveLength(2)
    const elements = deck.slides.flatMap(slide => slide.elements) as Array<Record<string, unknown>>
    expect(elements.some(el => el.type === 'media')).toBe(true)
    expect(elements.some(el => el.fx)).toBe(true)
    expect(elements.some(el => el.link === 'orb-state-ingest')).toBe(true)
  })
  it('uses distinct Orbital subpage labels in slides and reusable layouts', () => {
    const deck = getPptTemplate('orbital')!
    for (const pages of [deck.slides, deck.layouts as typeof deck.slides]) {
      const headings = pages.filter(s => s.stateOf).flatMap(s => s.elements)
        .map(el => (el as { html?: string }).html).filter(html => html?.includes('CLICK ANYWHERE DIM'))
      expect(headings).toEqual([
        '02a · INGEST — CLICK ANYWHERE DIM TO GO BACK',
        '02b · MODEL — CLICK ANYWHERE DIM TO GO BACK',
      ])
    }
  })
  it('describes Terra morph as a direct cover-to-collection transition, not sequential playback', () => {
    const deck = getPptTemplate('terra')!
    for (const pages of [deck.slides, deck.layouts as typeof deck.slides]) {
      const cover = pages.find(s => s.id.endsWith('ter-cover'))!
      const collection = pages.find(s => s.id.endsWith('ter-collection'))!
      expect(pages.map(s => s.id.split('ter-').pop())).toEqual(['cover', 'craft', 'collection', 'materials', 'end'])
      expect(cover.notes).toContain('Jump directly')
      expect(collection.notes).toContain('Sequential playback')
      // The coloured gradient, not its unused solid fallback, paints each swatch.
      for (const el of collection.elements as Array<{ id: string; fillGradient?: { stops: unknown[] } }>) {
        if (['ter-a', 'ter-b', 'ter-c'].includes(el.id)) expect(el.fillGradient?.stops.length).toBeGreaterThan(1)
      }
    }
  })
})

describe('instantiateTemplate — Bento parseDoc parity (strip template, fresh docId, drop collab)', () => {
  it('strips the template marker, mints a fresh docId, and drops collab for every template', () => {
    for (const id of PPT_TEMPLATE_IDS) {
      const source = getPptTemplate(id)!
      const deck = instantiateTemplate(source, '2026-08-05T00:00:00.000Z')
      expect(deck.template).toBeUndefined()
      expect(deck.collab).toBeUndefined()
      expect(deck.docId).not.toBe(source.docId)
      expect(deck.docId).toMatch(/[0-9a-f-]{36}/) // fresh uuid identity
      expect(deck.format).toBe(BENTO_FORMAT)
      expect(deck.version).toBe(BENTO_FORMAT_VERSION)
      expect(deck.modified).toBe('2026-08-05T00:00:00.000Z')
      expect(deck.slides).toEqual(source.slides) // content preserved
    }
  })

  it('mints a distinct docId on every instantiation (each open is a new document)', () => {
    const source = getPptTemplate('blank')!
    const a = instantiateTemplate(source, '2026-08-05T00:00:00.000Z')
    const b = instantiateTemplate(source, '2026-08-05T00:00:00.000Z')
    expect(a.docId).not.toBe(b.docId)
  })

  it('does not mutate the shared source template (deep clone)', () => {
    const source = getPptTemplate('signal')!
    const beforeDocId = source.docId
    instantiateTemplate(source, '2026-08-05T00:00:00.000Z')
    expect(source.template).toBe(true)
    expect(source.collab).toBeDefined()
    expect(source.docId).toBe(beforeDocId)
  })

  it('rejects a non-bento source', () => {
    expect(() => instantiateTemplate({ format: 'x', slides: [] } as never, 'now')).toThrow()
  })
})
