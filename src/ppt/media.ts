import { docAttachmentRepo } from '../db/repos/docAttachmentRepo.js'
import { getObjectStore } from '../storage/objectStore.js'
import { config } from '../config/env.js'
import { PptApiError } from '../api/ppt/envelope.js'
import type { BentoDoc } from './bentoDoc.js'

export const PPT_MEDIA_PREFIX = 'ppt-media:'
export const PPT_MEDIA_MIMES = new Set(['image/png','image/jpeg','image/webp','image/gif','image/avif','image/bmp','video/mp4','video/webm','video/ogg','video/quicktime','audio/mpeg','audio/mp4','audio/webm','audio/ogg','audio/wav','audio/x-wav','audio/flac'])
export const pptMediaLimit = () => Math.min(config.attachments.maxFileSizeBytes, 50 * 1024 * 1024)
export async function getPptMedia(docId: string, id: string) {
  const row = await docAttachmentRepo.getById(id)
  if (!row || row.docId !== docId || !row.objectKey.startsWith(`${docId}/ppt-media/`) || !PPT_MEDIA_MIMES.has(row.mime)) throw new PptApiError('NOT_FOUND','media not found')
  if (row.sizeBytes > pptMediaLimit()) throw new PptApiError('PAYLOAD_TOO_LARGE','media exceeds size limit')
  return row
}
export async function readPptMedia(docId: string,id: string) {
  const row=await getPptMedia(docId,id)
  const bytes = await getObjectStore().download(row.objectKey,{maxBytes:pptMediaLimit(),signal:AbortSignal.timeout(60000)})
  if (bytes.byteLength !== row.sizeBytes) throw new PptApiError('CONFLICT','media upload incomplete')
  return {row,bytes}
}
/** Only element resource fields are attachments; document text is inert. */
function visitMediaFields(value: unknown, visit: (element: Record<string, unknown>, key: string) => void): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) { for (const child of value) visitMediaFields(child, visit); return }
  const object = value as Record<string, unknown>
  if (object.type === 'image' || object.type === 'media') {
    for (const key of ['src', 'poster']) if (typeof object[key] === 'string') visit(object, key)
  }
  for (const child of Object.values(object)) if (child && typeof child === 'object') visitMediaFields(child, visit)
}
export function pptMediaIds(deck: BentoDoc): string[] {
  const refs = new Set<string>()
  visitMediaFields(deck, (element, key) => {
    const value = element[key] as string
    if (value.startsWith(PPT_MEDIA_PREFIX)) refs.add(value.slice(PPT_MEDIA_PREFIX.length))
  })
  return [...refs]
}
/** Downloads only registered same-document objects, never arbitrary URLs. */
export async function embedPptMedia(deck: BentoDoc, docId: string): Promise<BentoDoc> {
  const values = new Map<string,string>(); let total=0
  for(const id of pptMediaIds(deck)) {
    const {row,bytes}=await readPptMedia(docId,id)
    total+=bytes.byteLength
    if(total>100*1024*1024)throw new PptApiError('PAYLOAD_TOO_LARGE','embedded media export exceeds 100 MB')
    values.set(PPT_MEDIA_PREFIX+id,`data:${row.mime};base64,${Buffer.from(bytes).toString('base64')}`)
  }
  const copy = structuredClone(deck)
  visitMediaFields(copy, (element, key) => { element[key] = values.get(element[key] as string) ?? element[key] })
  return copy
}
