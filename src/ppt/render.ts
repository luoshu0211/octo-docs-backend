import { PptApiError } from '../api/ppt/envelope.js'
import { embedPptMedia } from './media.js'
import { offlineHostScript } from './offlineHost.js'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { BentoDoc } from './bentoDoc.js'
import { validatePptDraft } from './draft.js'

let player: Promise<string> | undefined
const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Only the server-packaged, version-pinned player is executable. Deck JSON
 * travels as inert data in a no-network, opaque-origin sandbox. */
export function buildPptHtml(shell: string, deck: BentoDoc): string {
  validatePptDraft({ revision: 0, deck })
  return containedHtml(shell,deck)
}
export const MAX_PPT_VERSION_HTML_BYTES = 32 * 1024 * 1024
export const MAX_PPT_EXPORT_HTML_BYTES = 160 * 1024 * 1024
function containedHtml(shell: string, deck: BentoDoc, maxBytes = MAX_PPT_VERSION_HTML_BYTES): string {
  const data = Object.fromEntries(['format', 'version', 'title', 'size', 'theme', 'present', 'assets', 'fonts', 'layouts', 'slides']
    .filter(key => deck[key] !== undefined).map(key => [key, deck[key]]))
  if (deck.meta && typeof deck.meta === 'object') {
    const meta = deck.meta as Record<string, unknown>
    data.meta = Object.fromEntries(['author', 'company', 'subject', 'event', 'keywords'].filter(key => typeof meta[key] === 'string').map(key => [key, meta[key]]))
  }
  if (shell.split('__OCTO_PPT_DECK__').length !== 2) throw new Error('invalid packaged PPT player')
  const inner = shell.replace('__OCTO_PPT_DECK__', () => JSON.stringify(data).replace(/</g, '\\u003c'))
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escape(deck.title)}</title><style>html,body,iframe{width:100%;height:100%;margin:0;border:0;display:block}</style></head><body><iframe sandbox="allow-scripts allow-modals allow-popups" allow="fullscreen" allowfullscreen title="${escape(deck.title)}" srcdoc="${escape(inner)}"></iframe><script>${offlineHostScript}</script></body></html>`
  if (Buffer.byteLength(html, 'utf8') > maxBytes) throw new PptApiError('PAYLOAD_TOO_LARGE', 'rendered PPT exceeds the HTML size limit')
  return html
}

export async function renderPptHtml(deck: BentoDoc, exportDocId?: string): Promise<string> {
  player ??= readFile(resolve('assets/ppt/player.html'), 'utf8').catch(error => { player = undefined; throw error })
  validatePptDraft({revision:0,deck})
  return containedHtml(await player, exportDocId ? await embedPptMedia(deck,exportDocId) : deck, exportDocId ? MAX_PPT_EXPORT_HTML_BYTES : MAX_PPT_VERSION_HTML_BYTES)
}
