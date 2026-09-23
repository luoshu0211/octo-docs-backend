import type { Request, Response } from 'express'
import { requireDocRole, type DocGuard } from '../guard.js'
import { fetchExternalMedia } from '../../util/fetchExternalImage.js'
import { LinkCardError } from '../../util/ssrfGuard.js'
import { identifyPptMedia } from '../../ppt/ingestMedia.js'
import { PPT_MEDIA_PREFIX, pptMediaLimit } from '../../ppt/media.js'
import { getObjectStore } from '../../storage/objectStore.js'
import { docAttachmentRepo } from '../../db/repos/docAttachmentRepo.js'
import { newAttachId } from '../../util/ids.js'

const MAX_BATCH_BYTES = 100 * 1024 * 1024
const MAX_URLS = 10
interface Mapping { sourceUrl: string; attachId: string; ref: string; mime: string; sizeBytes: number }

/** The shared endpoint retains image-only semantics for non-PPT documents. */
export async function ingestPptMediaUrls(req: Request, res: Response, initial: DocGuard, urls: string[]): Promise<void> {
  if (urls.length > MAX_URLS) { res.status(400).json({ error: 'urls_too_many' }); return }
  const docId = initial.meta.doc_id
  const epoch = Number(initial.meta.permission_epoch)
  const store = getObjectStore()
  const mappings: Mapping[] = []
  const notIngested: Array<{ sourceUrl: string; reason: string }> = []
  const created: Array<{ id: string; key: string }> = []
  let total = 0

  async function authorized(): Promise<boolean> {
    const current = await requireDocRole(req, res, docId, 'writer')
    if (!current) return false
    if (current.meta.doc_type !== 'html_ppt' || Number(current.meta.permission_epoch) !== epoch) {
      res.status(403).json({ error: 'permissions_changed' })
      return false
    }
    return true
  }
  async function cleanup(id: string, key: string): Promise<void> {
    // Random per-attempt IDs ensure compensation cannot erase a concurrent import.
    await Promise.all([store.delete(key), docAttachmentRepo.deleteById(id)])
  }

  try {
    for (const sourceUrl of urls) {
      if (!(await authorized())) return
      if (total >= MAX_BATCH_BYTES) {
        notIngested.push({ sourceUrl, reason: 'batch_size_too_large' }); continue
      }
      let bytes: Buffer
      try {
        const remaining = MAX_BATCH_BYTES - total
        const fetched = await fetchExternalMedia(sourceUrl, Math.min(pptMediaLimit(), remaining))
        bytes = fetched.bytes
        total += bytes.length
        if (bytes.length > pptMediaLimit() || total > MAX_BATCH_BYTES) {
          notIngested.push({ sourceUrl, reason: 'size_too_large' }); continue
        }
      } catch (err) {
        notIngested.push({ sourceUrl, reason: err instanceof LinkCardError ? err.code : 'fetch_failed' })
        continue
      }
      const media = await identifyPptMedia(bytes)
      if (!media) { notIngested.push({ sourceUrl, reason: 'unsupported_media_type' }); continue }
      if (!(await authorized())) return
      const id = newAttachId()
      const key = `${docId}/ppt-media/${id}`
      // Sanitizing SVG may change its byte length; enforce the cap on the stored result too.
      if (media.bytes.length > pptMediaLimit()) {
        notIngested.push({ sourceUrl, reason: 'size_too_large' }); continue
      }
      let stored = false
      try {
        await store.upload(key, media.mime, media.bytes, { signal: AbortSignal.timeout(60000) })
        if (!(await authorized())) return
        await docAttachmentRepo.register({
          attachId: id, docId, objectKey: key, mime: media.mime, sizeBytes: media.bytes.length,
          fileName: `media.${media.mime === 'image/svg+xml' ? 'svg' : media.mime.split('/')[1]}`,
          createdBy: req.uid!,
        })
        if (!(await authorized())) return
        created.push({ id, key })
        stored = true
        mappings.push({ sourceUrl, attachId: id, ref: PPT_MEDIA_PREFIX + id, mime: media.mime, sizeBytes: media.bytes.length })
      } catch {
        notIngested.push({ sourceUrl, reason: 'store_failed' })
      } finally {
        if (!stored) await cleanup(id, key)
      }
    }
    if (!(await authorized())) return
    res.setHeader('Cache-Control', 'private, no-store')
    res.status(200).json({ mappings, notIngested })
    // Only published receipts survive; aborted batches compensate earlier successes.
    created.length = 0
  } finally {
    await Promise.all(created.map(({ id, key }) => cleanup(id, key)))
  }
}
