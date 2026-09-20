import { beforeEach, afterEach, expect, it, vi } from 'vitest'
const db=vi.hoisted(()=>({seq:0,watermarks:new Map<string,number>(),frames:[] as {seq:number;frame_json:string}[],ledger:new Map<string,{seq:number;payloadHash:string}>(),snapshot:{} as {covered_seq:number;doc_json:string;state_json:string},logs:[] as string[],title:''}))
vi.mock('../src/db/pool.js',()=>({getPool:vi.fn(),query:async()=>[],transaction:async(fn:(tx:unknown)=>Promise<unknown>)=>{
 const saved=structuredClone(db)
 try{return await fn({query:async(sql:string,args:(string|number)[])=>{
 db.logs.push(sql)
 if(sql.includes('AS snapshot_bytes'))return [{snapshot_bytes:db.snapshot.state_json == null ? null : Buffer.byteLength(db.snapshot.doc_json)+Buffer.byteLength(db.snapshot.state_json),covered_seq:db.snapshot.covered_seq}]
 if(sql.includes('AS tail_bytes'))return [{tail_bytes:db.frames.filter(f=>f.seq>db.snapshot.covered_seq).reduce((n,f)=>n+Buffer.byteLength(f.frame_json)+1024,0)}]
 if(sql.includes('FROM ppt_collab_actor_seq'))return db.watermarks.has(String(args[1]))?[{last_s:db.watermarks.get(String(args[1]))}]:[]
 if(sql.includes('FROM ppt_live_snapshot'))return [db.snapshot]
 if(sql.includes('FROM ppt_collab_op'))return db.frames.filter(f=>f.seq>Number(args[1])&&f.seq<Number(args[2]))
 throw new Error(sql)
 },execute:async(sql:string,args:(string|number)[])=>{
 if(sql.startsWith('INSERT INTO ppt_collab_actor_seq'))db.watermarks.set(String(args[1]),Number(args[2]))
 else if(sql.startsWith('UPDATE doc_meta'))db.title=String(args[0])
 else throw new Error(sql)
 return {affectedRows:1}
 }})}catch(error){Object.assign(db,saved);throw error}
}}))
vi.mock('../src/db/repos/pptRelaySeqRepo.js',()=>({pptRelaySeqRepo:{nextSeqTx:async()=>++db.seq}}))
vi.mock('../src/db/repos/pptCollabFrameRepo.js',()=>({pptCollabFrameRepo:{getByFrameIdTx:async(_tx:unknown,_doc:string,id:string)=>db.ledger.get(id)??null,insertTx:async(_tx:unknown,_doc:string,id:string,seq:number,payloadHash:string)=>{db.ledger.set(id,{seq,payloadHash})}}}))
vi.mock('../src/db/repos/pptCollabOpRepo.js',()=>({pptCollabOpRepo:{insertTx:async(_tx:unknown,_doc:string,seq:number,_id:string,json:string)=>db.frames.push({seq,frame_json:json})}}))
import { DbPptRelayStore, MAX_PPT_SESSION_ACTORS } from '../src/ppt/relay/dbStore.js'
import { SyncState } from '../src/ppt/sync/slidesSync.js'
import { instantiateTemplate } from '../src/ppt/bentoDoc.js'
import { getPptTemplate } from '../src/ppt/templates.js'
import { config } from '../src/config/env.js'
const documentLimit = config.ppt.write.maxDocumentBytes
afterEach(() => { config.ppt.write.maxDocumentBytes = documentLimit })
beforeEach(()=>{
 const deck=instantiateTemplate(getPptTemplate('blank')!,new Date().toISOString());const sync=new SyncState('@genesis');sync.adopt(deck)
 Object.assign(db,{seq:0,watermarks:new Map(),frames:[],ledger:new Map(),logs:[],title:deck.title,snapshot:{covered_seq:0,doc_json:JSON.stringify(deck),state_json:JSON.stringify(sync.toJSON())}})
})
const frame=(s:number,k='custom',v:unknown=s)=>({t:'ops',ops:[{op:'set',a:'actor',s,l:s+100,k,v}]})
it('does not treat a NULL legacy snapshot byte sum as a safe fast-path bound',async()=>{
 const store=new DbPptRelayStore(true)
 await store.appendOp('doc','first',frame(1))
 Object.assign(db.snapshot,{state_json:null})
 await expect(store.appendOp('doc','legacy-null',frame(2))).rejects.toThrow('live snapshot required')
 expect(db.seq).toBe(1);expect(db.ledger.has('legacy-null')).toBe(false);expect(db.frames).toHaveLength(1);expect(db.watermarks.get('actor')).toBe(1)
})
it('checks accumulated document growth and rolls back rejected frames, ledger and actor sequence',async()=>{
 const store=new DbPptRelayStore(true)
 await store.appendOp('doc','first',frame(1,'custom','a'.repeat(1500)))
 const deck=JSON.parse(db.snapshot.doc_json);const state=SyncState.fromJSON('@relay',JSON.parse(db.snapshot.state_json))
 state.apply(deck,frame(1,'custom','a'.repeat(1500)).ops)
 config.ppt.write.maxDocumentBytes=Buffer.byteLength(JSON.stringify(deck))
 const before=structuredClone(db)
 await expect(store.appendOp('doc','over',frame(2,'other','b'.repeat(500)))).rejects.toMatchObject({code:'PAYLOAD_TOO_LARGE'})
 expect(db.seq).toBe(before.seq);expect(db.ledger.has('over')).toBe(false);expect(db.watermarks.get('actor')).toBe(1)
 await expect(store.appendOp('doc','shrink',frame(2,'custom','small'))).resolves.toMatchObject({duplicate:false})
})
it('seeds old sessions once and avoids full-tail replay on subsequent small frames',async()=>{
 const store=new DbPptRelayStore(true)
 for(let i=1;i<=512;i++)await store.appendOp('doc',`f${i}`,frame(i))
 expect(db.watermarks.get('actor')).toBe(512)
 expect(db.logs.filter(sql=>sql.includes('SELECT frame_json FROM ppt_collab_op'))).toHaveLength(1)
 await expect(new DbPptRelayStore(true).appendOp('doc','restart',frame(513))).resolves.toMatchObject({seq:513})
 expect(db.logs.filter(sql=>sql.includes('SELECT frame_json FROM ppt_collab_op'))).toHaveLength(1)
})
it('rolls back frame, ledger and watermark together on a sequence gap',async()=>{
 const store=new DbPptRelayStore(true);await store.appendOp('doc','first',frame(1))
 await expect(store.appendOp('doc','gap',frame(3))).rejects.toThrow('contiguous')
 expect(db.seq).toBe(1);expect(db.ledger.has('gap')).toBe(false);expect(db.watermarks.get('actor')).toBe(1)
 await expect(store.appendOp('doc','second',frame(2))).resolves.toMatchObject({seq:2})
})
it('accepts a 512-character winning title, rejects 513 without advancing state',async()=>{
 const store=new DbPptRelayStore(true)
 await store.appendOp('doc','title',frame(1,'title','中'.repeat(512)));expect(db.title).toBe('中'.repeat(512))
 await expect(store.appendOp('doc','bad-title',frame(2,'title','中'.repeat(513)))).rejects.toThrow('title')
 expect(db.watermarks.get('actor')).toBe(1);expect(db.title.length).toBe(512)
})

it('re-acks duplicate frames before sequence validation and independently tracks actors',async()=>{
 const store=new DbPptRelayStore(true);const original=frame(1)
 await store.appendOp('doc','one',original)
 await expect(store.appendOp('doc','one',original)).resolves.toMatchObject({seq:1,duplicate:true})
 expect(db.watermarks.get('actor')).toBe(1)
 await store.appendOp('doc','other',{t:'ops',ops:[{op:'set',a:'other',s:1,l:1,k:'custom',v:1}]})
 expect(db.watermarks.get('other')).toBe(1);expect(db.watermarks.get('actor')).toBe(1)
})
it('keeps actor continuity after a covered tail is pruned and the store restarts',async()=>{
 const store=new DbPptRelayStore(true);await store.appendOp('doc','one',frame(1))
 const deck=JSON.parse(db.snapshot.doc_json);const state=SyncState.fromJSON('@relay',JSON.parse(db.snapshot.state_json))
 state.apply(deck,JSON.parse(JSON.stringify(frame(1).ops)))
 db.snapshot={covered_seq:1,doc_json:JSON.stringify(deck),state_json:JSON.stringify(state.toJSON())};db.frames=[]
 await expect(new DbPptRelayStore(true).appendOp('doc','two',frame(2))).resolves.toMatchObject({seq:2})
 expect(db.watermarks.get('actor')).toBe(2)
})
it('does not replace metadata with a losing LWW title frame',async()=>{
 const store=new DbPptRelayStore(true);await store.appendOp('doc','winner',frame(1,'title','Winning title'))
 const loser=frame(2,'title','Losing title');loser.ops[0]!.l=1
 await store.appendOp('doc','loser',loser)
 expect(db.title).toBe('Winning title');expect(db.watermarks.get('actor')).toBe(2)
})

it('bounds new session actors while allowing existing sessions to reconnect',async()=>{
 const json=JSON.parse(db.snapshot.state_json)
 json.vv=Object.fromEntries(Array.from({length:MAX_PPT_SESSION_ACTORS},(_,i)=>[`session${i}`,1]))
 db.snapshot.state_json=JSON.stringify(json)
 const store=new DbPptRelayStore(true)
 await expect(store.appendOp('doc','new',frame(1))).rejects.toThrow('session actor limit')
 await expect(store.appendOp('doc','known',{t:'ops',ops:[{op:'set',a:'session0',s:2,l:100,k:'custom',v:2}]})).resolves.toMatchObject({duplicate:false})
})
