import type { Tx } from '../src/db/pool.js'
import { expect,it,vi } from 'vitest'
vi.mock('../src/db/pool.js',()=>({query:async()=>[],transaction:vi.fn(),getPool:vi.fn()}))
import { lockPptLive, appendPptEditTx } from '../src/ppt/liveEdit.js'
import { config } from '../src/config/env.js'
import { SyncState } from '../src/ppt/sync/slidesSync.js'
import { instantiateTemplate } from '../src/ppt/bentoDoc.js'
import { getPptTemplate } from '../src/ppt/templates.js'
it('counts covered but unpruned storage before admitting a new REST frame',async()=>{
 const deck=instantiateTemplate(getPptTemplate('blank')!,new Date().toISOString());const sync=new SyncState('@genesis');sync.adopt(deck)
 const execute=vi.fn().mockResolvedValue({affectedRows:1})
 const tx:Tx={execute,query:async<T>(sql:string)=>{
 if(sql.includes('FROM ppt_collab_seq'))return [{last_seq:10}] as T[]
 if(sql.includes('FROM ppt_live_snapshot'))return [{covered_seq:10,doc_json:JSON.stringify(deck),state_json:JSON.stringify(sync.toJSON())}] as T[]
 if(sql.includes('SUM(frame_bytes)'))return [{bytes:config.ppt.relay.maxRoomFrameBytes}] as T[]
 if(sql.includes('FROM ppt_collab_op'))return []
 throw new Error(sql)
 }}
 const live=await lockPptLive(tx,'doc');expect(live.bytes).toBe(config.ppt.relay.maxRoomFrameBytes)
 const after=structuredClone(deck);after.slides[0]!.notes='New edit';execute.mockClear()
 await expect(appendPptEditTx(tx,{docId:'doc',uid:'writer',spaceId:'space',authorizedEpoch:1},live,after)).rejects.toThrow('room is full')
 expect(execute).not.toHaveBeenCalled()
})
