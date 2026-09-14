import { transaction } from '../db/pool.js'
import { pptLiveSnapshotRepo } from '../db/repos/pptLiveSnapshotRepo.js'
import { PptApiError } from '../api/ppt/envelope.js'
import { SyncState } from './sync/slidesSync.js'
import type { BentoDoc } from './bentoDoc.js'

/** Serialize the one-way draft -> live handoff with draft saves and ACL changes. */
export async function preparePptCollab(docId: string, epoch: number): Promise<void> {
  await transaction(async tx => {
    const [meta] = await tx.query<{ permission_epoch: number; status: number; title: string }>(
      'SELECT permission_epoch, status, title FROM doc_meta WHERE doc_id = ? FOR UPDATE', [docId])
    if (!meta || meta.status !== 1 || Number(meta.permission_epoch) !== epoch) {
      throw new PptApiError('FORBIDDEN', 'document permissions changed')
    }
    const existing = await tx.query('SELECT doc_id FROM ppt_live_snapshot WHERE doc_id = ? FOR UPDATE', [docId])
    if (existing.length) return
    const [row] = await tx.query<{ draft_doc: string }>('SELECT draft_doc FROM ppt_doc_state WHERE doc_id = ? FOR UPDATE', [docId])
    if (!row) throw new PptApiError('NOT_FOUND', 'draft not found')
    const deck: BentoDoc = typeof row.draft_doc === 'string' ? JSON.parse(row.draft_doc) : row.draft_doc
    deck.title = meta.title
    // Adopt the same renderable shape on server and browser for original R2 decks.
    for (const slide of deck.slides) {
      slide.elements = slide.elements.map((value, index) => {
        const el = value as Record<string, unknown>
        if (el.type !== 'text' || typeof el.html === 'string' || typeof el.text !== 'string') return el
        const { text, ...rest } = el
        const heading = index === 0
        return { x: 100, y: heading ? 160 : 330, w: 1080, h: heading ? 130 : 220,
          rotation: 0, opacity: 1, fontSize: heading ? 56 : 32,
          fontFamily: "'Inter', 'PingFang SC', 'Microsoft YaHei', Arial, sans-serif",
          fontWeight: heading ? 700 : 400, color: '#1E2A3A', align: 'center', valign: 'middle', lineHeight: 1.25,
          ...rest, html: `<p>${String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>` }
      })
    }
    const state = new SyncState('@relay')
    state.adopt(deck)
    await pptLiveSnapshotRepo.upsertAdvanceTx(tx, docId, 0, deck, state.toJSON())
  })
}
