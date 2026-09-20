/**
 * Bundled PPT gallery families and blank deck; no admin-extensible registry.
 *
 * The shared create flow materializes one accepted `templateId` as a 16:9 deck;
 * unsupported or retired IDs fail with 400 VALIDATION_ERROR. Existing documents
 * use their persisted decks, not this new-document catalogue.
 *
 * Each template is authored as a bento/slides deck carrying the `template`
 * marker AND a `collab` block, so materialization (see instantiateTemplate) is
 * provably exercised: the marker is stripped, a fresh docId is minted, and the
 * collab block is dropped for every created deck. The template objects here are
 * the SHARED source of truth and must never be mutated — `getPptTemplate`
 * returns them by reference for reads and `instantiateTemplate` deep-clones
 * before stripping.
 */
import {
  BENTO_FORMAT,
  BENTO_FORMAT_VERSION,
  type BentoDoc,
} from './bentoDoc.js'
import signal from './gallery/signal.json' with { type: 'json' }
import terra from './gallery/terra.json' with { type: 'json' }
import orbital from './gallery/orbital.json' with { type: 'json' }
import picnic from './gallery/picnic.json' with { type: 'json' }

/** 16:9 slide coordinate space shared by every bundled template. */
const SIZE_16_9 = { width: 1280, height: 720 } as const

const FONT_STACK =
  "'PingFang SC', 'Inter', -apple-system, BlinkMacSystemFont, 'Noto Sans SC', sans-serif"

/** A caller-facing template card (id + display name + scenario blurb). */
export interface PptTemplateSummary {
  id: string
  name: string
  scenario: string
}

/**
 * A placeholder live-collab block. Its ONLY purpose is to prove that
 * instantiation drops `collab`: a materialized deck must never carry these
 * credentials. Values are inert placeholders, never real relay keys.
 */
const TEMPLATE_COLLAB = { room: 'template-room-placeholder', key: 'template-key-placeholder', on: false }

function text(id: string, value: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const heading = id === 'e_title'
  return {
    id, type: 'text', x: 100, y: heading ? 160 : 330, w: 1080, h: heading ? 130 : 220,
    rotation: 0, opacity: 1, html: `<p>${value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`,
    fontSize: heading ? 56 : 32, fontFamily: FONT_STACK, fontWeight: heading ? 700 : 400,
    color: '#1E2A3A', align: 'center', valign: 'middle', lineHeight: 1.25, ...extra,
  }
}

/**
 * Build one bundled template deck. `template: true` + a `collab` block are
 * always present so every materialization strips them.
 */
function template(id: string, title: string, slides: BentoDoc['slides'], accent: string): BentoDoc {
  return {
    format: BENTO_FORMAT,
    version: BENTO_FORMAT_VERSION,
    // A stable authoring-time id; instantiation always replaces it with a fresh
    // uuid, so this value never reaches a created document.
    docId: `template_${id}`,
    title,
    size: { ...SIZE_16_9 },
    theme: {
      background: '#FFFFFF',
      color: '#1E2A3A',
      accent,
      fontFamily: FONT_STACK,
    },
    template: true,
    collab: { ...TEMPLATE_COLLAB },
    slides,
    modified: '1970-01-01T00:00:00.000Z',
  }
}

function slide(id: string, elements: unknown[], name: string): BentoDoc['slides'][number] {
  return { id, background: '#FFFFFF', transition: 'fade', elements, notes: '', name }
}

/**
 * Current creation templates, matching the frontend picker. Old starter decks
 * are deliberately absent; retiring a template does not alter saved documents.
 */
const TEMPLATES: Record<string, BentoDoc> = {
  ...{ signal, terra, orbital, picnic } as unknown as Record<string, BentoDoc>,
  blank: template(
    'blank',
    'Blank',
    [slide('s_blank_1', [text('e_title', 'Title')], 'Title')],
    '#F7A600',
  ),
}

/** The fixed template ids, in picker order. */
export const PPT_TEMPLATE_IDS: readonly string[] = ['blank', 'signal', 'terra', 'orbital', 'picnic']

/** Caller-facing summaries (id + name + scenario), in picker order. */
export const PPT_TEMPLATE_SUMMARIES: readonly PptTemplateSummary[] = [
  { id: 'blank', name: 'Blank', scenario: 'Start from an empty 16:9 deck' },
  { id: 'signal', name: 'Signal', scenario: 'Editorial typography · 7 coordinated page layouts' },
  { id: 'terra', name: 'Terra', scenario: 'Premium product · 5 coordinated page layouts' },
  { id: 'orbital', name: 'Orbital', scenario: 'Immersive technology · 6 coordinated page layouts' },
  { id: 'picnic', name: 'Pixel Picnic', scenario: 'Playful learning · 6 coordinated page layouts' },
]

/** True when `v` is an accepted bundled template ID. */
export function isPptTemplateId(v: unknown): v is string {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(TEMPLATES, v) && PPT_TEMPLATE_IDS.includes(v)
}

/**
 * Return the SHARED template source for `id` (by reference — callers must not
 * mutate it; `instantiateTemplate` clones before stripping). Returns null for an
 * unknown id so the caller can map that to 400 VALIDATION_ERROR.
 */
export function getPptTemplate(id: string): BentoDoc | null {
  return isPptTemplateId(id) ? TEMPLATES[id]! : null
}
