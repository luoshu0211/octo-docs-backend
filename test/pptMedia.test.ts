import {beforeEach,expect,it,vi} from 'vitest'
const m=vi.hoisted(()=>({get:vi.fn(),download:vi.fn(),upload:vi.fn(),remove:vi.fn(),register:vi.fn(),principal:vi.fn()}))
vi.mock('../src/db/repos/docAttachmentRepo.js',()=>({docAttachmentRepo:{getById:m.get,register:m.register}}))
vi.mock('../src/storage/objectStore.js',()=>({getObjectStore:()=>({download:m.download,upload:m.upload,delete:m.remove})}))
vi.mock('../src/api/ppt/live.js',()=>({pptPrincipal:m.principal}))
import {embedPptMedia,readPptMedia} from '../src/ppt/media.js'
import {uploadPptMedia} from '../src/api/ppt/media.js'
import {Readable} from 'node:stream'
import type {Request,Response} from 'express'
import {instantiateTemplate} from '../src/ppt/bentoDoc.js'
import {getPptTemplate} from '../src/ppt/templates.js'
import { MAX_SANITIZED_SVG_BYTES, sanitizeSvg } from '../src/util/sanitizeSvg.js'
const row={attachId:'att_test',docId:'doc',objectKey:'doc/ppt-media/att_test',mime:'video/mp4',sizeBytes:3,fileName:'movie.mp4'}
beforeEach(()=>{vi.resetAllMocks();m.get.mockResolvedValue(row);m.download.mockResolvedValue(new Uint8Array([1,2,3]));m.remove.mockResolvedValue(undefined);m.principal.mockResolvedValue({docId:'doc',uid:'human',spaceId:'space',authorizedEpoch:1})})
it('rejects cross-document, ordinary attachment and active-type references before storage reads',async()=>{
 for(const replacement of [{...row,docId:'another'},{...row,objectKey:'doc/ordinary/file'},{...row,mime:'text/html'}]){
  m.get.mockResolvedValue(replacement);await expect(readPptMedia('doc','att_test')).rejects.toThrow('media not found')
 }
 expect(m.download).not.toHaveBeenCalled()
})
it('rejects incomplete media, and exports embedded bytes without mutating the persisted reference',async()=>{
 m.download.mockResolvedValueOnce(new Uint8Array([1]));await expect(readPptMedia('doc','att_test')).rejects.toThrow('incomplete')
 const deck=instantiateTemplate(getPptTemplate('blank')!,new Date().toISOString());deck.slides[0]!.elements=[{id:'media',type:'media',src:'ppt-media:att_test'}]
 const embedded=await embedPptMedia(deck,'doc')
 expect(embedded.slides[0]!.elements[0]!.src).toBe('data:video/mp4;base64,AQID')
 expect(deck.slides[0]!.elements[0]!.src).toBe('ppt-media:att_test')
 expect(m.download).toHaveBeenLastCalledWith(row.objectKey,expect.objectContaining({maxBytes:50*1024*1024}))
})
const request=(headers:Record<string,string>,bytes=Buffer.from([1,2,3]))=>Object.assign(Readable.from([bytes]),{header:(name:string)=>headers[name]}) as unknown as Request
const response=()=>{const res={setHeader:vi.fn(),status:vi.fn(),json:vi.fn()};res.status.mockReturnValue(res);return res as unknown as Response}
it('sanitizes SVG before storage and exports the same safe bytes',async()=>{
 const raw=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" onload="alert(1)"><script>alert(1)</script><rect width="100" height="100" fill="red"/><image href="https://evil.invalid/x"/></svg>')
 const clean=sanitizeSvg(raw),res=response()
 await uploadPptMedia(request({'X-Media-Type':'image/svg+xml','X-File-Name':'diagram.svg'},raw),res)
 expect(m.upload).toHaveBeenCalledWith(expect.any(String),'image/svg+xml',clean,expect.anything())
 expect(m.register).toHaveBeenCalledWith(expect.objectContaining({mime:'image/svg+xml',sizeBytes:clean.length}))
 const stored=m.register.mock.calls[0]![0];m.get.mockResolvedValue(stored);m.download.mockResolvedValue(clean)
 const deck=instantiateTemplate(getPptTemplate('blank')!,new Date().toISOString());deck.slides[0]!.elements=[{id:'svg-image',type:'image',src:`ppt-media:${stored.attachId}`}]
 const exported=await embedPptMedia(deck,'doc')
 expect(exported.slides[0]!.elements[0]!.src).toBe(`data:image/svg+xml;base64,${clean.toString('base64')}`)
 expect(clean.toString()).not.toMatch(/script|onload|evil.invalid/)
})
it('preserves local SVG use references across upload, read and export',async()=>{
 const raw=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><defs><path id="p" d="M0 0h10v10z"/></defs><use href="#p"/></svg>')
 await uploadPptMedia(request({'X-Media-Type':'image/svg+xml'},raw),response())
 const stored=m.register.mock.calls[0]![0],bytes=m.upload.mock.calls[0]![2]
 expect(bytes.toString()).toContain('<use href="#p"')
 m.get.mockResolvedValue(stored);m.download.mockResolvedValue(bytes)
 expect((await readPptMedia('doc',stored.attachId)).bytes).toEqual(bytes)
 const deck=instantiateTemplate(getPptTemplate('blank')!,new Date().toISOString())
 deck.slides[0]!.elements=[{id:'logo',type:'image',src:`ppt-media:${stored.attachId}`}]
 expect((await embedPptMedia(deck,'doc')).slides[0]!.elements[0]!.src).toBe(`data:image/svg+xml;base64,${bytes.toString('base64')}`)
})
it.each(['<use href="#missing"/>','<use href="https://evil.invalid/a.svg#p"/>','<use id="p" href="#p"/>'])('rejects unsafe SVG use before storage: %s',async body=>{
 await expect(uploadPptMedia(request({'X-Media-Type':'image/svg+xml'},Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`)),response())).rejects.toMatchObject({code:'VALIDATION_ERROR'})
 expect(m.upload).not.toHaveBeenCalled();expect(m.register).not.toHaveBeenCalled()
})
it('rejects invalid, complex and oversized SVG before allocating objects',async()=>{
 for(const raw of [Buffer.from('<html>not an svg</html>'),Buffer.from('<!DOCTYPE svg><svg/>'),Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'+'<g>'.repeat(130)+'</g>'.repeat(130)+'</svg>')]) {
  await expect(uploadPptMedia(request({'X-Media-Type':'image/svg+xml'},raw),response())).rejects.toMatchObject({code:'VALIDATION_ERROR',details:{reason:expect.stringMatching(/^invalid_svg|svg_too_complex$/)}})
 }
 for(const headers of [{'X-Media-Type':'image/svg+xml','Content-Length':String(MAX_SANITIZED_SVG_BYTES+1)},{'X-Media-Type':'image/svg+xml'}]) {
  await expect(uploadPptMedia(request(headers,Buffer.alloc(MAX_SANITIZED_SVG_BYTES+1)),response())).rejects.toMatchObject({code:'PAYLOAD_TOO_LARGE',details:{reason:'svg_too_large',limit:MAX_SANITIZED_SVG_BYTES}})
 }
 expect(m.upload).not.toHaveBeenCalled();expect(m.register).not.toHaveBeenCalled()
})
it('uploads independently of collaboration and records only an object reference',async()=>{
 const res=response();await uploadPptMedia(request({'X-Media-Type':'video/mp4','X-File-Name':'movie.mp4'}),res)
 expect(m.upload).toHaveBeenCalledWith(expect.stringMatching(/^doc\/ppt-media\/att_/),'video/mp4',Buffer.from([1,2,3]),expect.anything())
 expect(m.register).toHaveBeenCalledWith(expect.objectContaining({docId:'doc',mime:'video/mp4',sizeBytes:3,createdBy:'human'}))
 expect(res.status).toHaveBeenCalledWith(201)
})
it('rejects excess size and unsupported types without allocating objects',async()=>{
 await expect(uploadPptMedia(request({'X-Media-Type':'text/html'}),response())).rejects.toThrow('unsupported')
 await expect(uploadPptMedia(request({'X-Media-Type':'video/mp4','Content-Length':String(51*1024*1024)}),response())).rejects.toThrow('50 MB')
 expect(m.upload).not.toHaveBeenCalled()
})
it('removes the uploaded object if authority changes before registering',async()=>{
 m.principal.mockResolvedValueOnce({docId:'doc',uid:'human',authorizedEpoch:1}).mockResolvedValueOnce({docId:'doc',uid:'human',authorizedEpoch:2})
 await expect(uploadPptMedia(request({'X-Media-Type':'video/mp4'}),response())).rejects.toThrow('permissions changed')
 expect(m.remove).toHaveBeenCalled();expect(m.register).not.toHaveBeenCalled()
})

it('treats media-like text as text and replaces only image/media src and poster', async()=>{
 const deck=instantiateTemplate(getPptTemplate('blank')!,new Date().toISOString())
 deck.title='ppt-media:ordinary-title';deck.slides[0]!.notes='ppt-media:att_test'
 deck.slides[0]!.elements=[{id:'text',type:'text',html:'ppt-media:missing'}, {id:'code',type:'code',content:'ppt-media:missing'}, {id:'image',type:'image',src:'ppt-media:att_test'}, {id:'video',type:'media',poster:'ppt-media:att_test',src:''}]
 const original=structuredClone(deck);const embedded=await embedPptMedia(deck,'doc')
 expect(m.get).toHaveBeenCalledTimes(1)
 expect(embedded.title).toBe(deck.title);expect(embedded.slides[0]!.notes).toBe(deck.slides[0]!.notes)
 expect(embedded.slides[0]!.elements[0]!.html).toBe('ppt-media:missing')
 expect(embedded.slides[0]!.elements[2]!.src).toBe('data:video/mp4;base64,AQID')
 expect(embedded.slides[0]!.elements[3]!.poster).toBe('data:video/mp4;base64,AQID')
 expect(deck).toEqual(original)
})
