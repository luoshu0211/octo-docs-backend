import type { Request, Response } from 'express'
import { pptPrincipal } from './live.js'
import { PptApiError, sendPptData } from './envelope.js'
import { PPT_MEDIA_MIMES, PPT_MEDIA_PREFIX, pptMediaLimit, readPptMedia, getPptMedia } from '../../ppt/media.js'
import { getObjectStore } from '../../storage/objectStore.js'
import { docAttachmentRepo } from '../../db/repos/docAttachmentRepo.js'
import { newAttachId } from '../../util/ids.js'

export async function uploadPptMedia(req: Request, res: Response) {
  const principal=await pptPrincipal(req,res,true);if(!principal)return
  const mime=req.header('X-Media-Type')?.toLowerCase() ?? ''
  if(!PPT_MEDIA_MIMES.has(mime))throw new PptApiError('VALIDATION_ERROR','unsupported image, audio or video type')
  const limit=pptMediaLimit(),declared=Number(req.header('Content-Length'))
  if(declared>limit)throw new PptApiError('PAYLOAD_TOO_LARGE','media exceeds 50 MB')
  let size=0; const chunks:Buffer[]=[]
  for await(const chunk of req){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>limit)throw new PptApiError('PAYLOAD_TOO_LARGE','media exceeds 50 MB');chunks.push(bytes)}
  if(!size)throw new PptApiError('VALIDATION_ERROR','empty media')
  const id=newAttachId(),key=`${principal.docId}/ppt-media/${id}`
  let name='media';try{name=decodeURIComponent(req.header('X-File-Name')??name).split(/[/\\]/).at(-1)!.slice(0,200)}catch{/* safe default */}
  const store=getObjectStore()
  try {
    await store.upload(key,mime,Buffer.concat(chunks,size),{signal:AbortSignal.timeout(60000)})
    const again=await pptPrincipal(req,res,true)
    if(!again){await store.delete(key);return}
    if(again.authorizedEpoch!==principal.authorizedEpoch)throw new PptApiError('FORBIDDEN','permissions changed during upload')
    await docAttachmentRepo.register({attachId:id,docId:principal.docId,objectKey:key,mime,sizeBytes:size,fileName:name,createdBy:principal.uid})
  }catch(error){await store.delete(key).catch(()=>{});throw error}
  res.setHeader('Cache-Control','private, no-store');sendPptData(res,{ref:PPT_MEDIA_PREFIX+id,attachId:id,mime,sizeBytes:size},201)
}
export async function downloadPptMedia(req: Request,res: Response) {
  const principal=await pptPrincipal(req,res);if(!principal)return
  if(req.query.metadata === '1'){const row=await getPptMedia(principal.docId,req.params.attachId!);res.setHeader('Cache-Control','private, no-store');sendPptData(res,{mime:row.mime,sizeBytes:row.sizeBytes});return}
  const {row,bytes}=await readPptMedia(principal.docId,req.params.attachId!)
  const again=await pptPrincipal(req,res);if(!again)return
  if(again.authorizedEpoch!==principal.authorizedEpoch)throw new PptApiError('FORBIDDEN','permissions changed during download')
  res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff')
  res.setHeader('Content-Disposition','attachment');res.type(row.mime).send(Buffer.from(bytes))
}
