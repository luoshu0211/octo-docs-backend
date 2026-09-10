import { beforeEach, expect, it, vi } from 'vitest'
const advance=vi.hoisted(()=>vi.fn())
vi.mock('../src/ppt/relay/snapshotter.js',()=>({PptSnapshotter:class { advance=advance }}))
vi.mock('../src/ppt/relay/dbStore.js',()=>({DbPptRelayStore:class {}}))
vi.mock('../src/db/repos/pptDocStateRepo.js',()=>({pptDocStateRepo:{getSource:vi.fn()}}))
import { withPptCompaction, PptRoomCapacityError } from '../src/ppt/compaction.js'
import { inPptRoom, pptRoomEvents } from '../src/ppt/roomCoordinator.js'
beforeEach(()=>{advance.mockReset().mockResolvedValue({freedBytes:100})})
it('retries the entire rolled-back transaction after forced compaction', async()=>{
 let attempts=0;const receipt:string[]=[];const events:string[]=[]
 advance.mockImplementation(async()=>{events.push('compact');expect(receipt).toEqual([])})
 const result=await inPptRoom('hard',()=>withPptCompaction('hard',async()=>{
   attempts++;events.push('attempt')
   if(attempts===1)throw new PptRoomCapacityError()
   receipt.push('one safety version and receipt');return {frames:[],revision:7}
 }))
 expect(result.revision).toBe(7);expect(events).toEqual(['attempt','compact','attempt']);expect(receipt).toHaveLength(1)
 expect(advance).toHaveBeenCalledWith('hard',expect.any(Function),{forceUnfreeze:true})
})
it('does not compact arbitrary transaction failures or retry forever', async()=>{
 const failed=vi.fn().mockRejectedValue(new Error('denied'))
 await expect(withPptCompaction('forbidden',failed)).rejects.toThrow('denied');expect(advance).not.toHaveBeenCalled()
 const full=vi.fn().mockRejectedValue(new PptRoomCapacityError())
 await expect(withPptCompaction('still-full',full)).rejects.toBeInstanceOf(PptRoomCapacityError)
 expect(full).toHaveBeenCalledTimes(2);expect(advance).toHaveBeenCalledOnce()
})
it('compacts many tiny REST frames outside the transaction and invalidates live room budgets', async()=>{
 let inTransaction=false;const compacted=vi.fn();pptRoomEvents.on('compacted',compacted)
 advance.mockImplementation(async()=>{expect(inTransaction).toBe(false)})
 try{
 for(let i=0;i<256;i++)await inPptRoom('tiny',()=>withPptCompaction('tiny',async()=>{inTransaction=true;inTransaction=false;return {frames:[{}],roomBytesAfter:1000}}))
 await inPptRoom('tiny',async()=>{})
 expect(advance).toHaveBeenCalledOnce();expect(compacted).toHaveBeenCalledWith('tiny')
 }finally{pptRoomEvents.off('compacted',compacted)}
})
it('keeps a committed REST response successful if subsequent soft compaction fails', async()=>{
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});advance.mockRejectedValue(new Error('snapshot unavailable'))
 try{
 await expect(inPptRoom('soft',()=>withPptCompaction('soft',async()=>({frames:[{}],roomBytesAfter:96*1024*1024,revision:8})))).resolves.toMatchObject({revision:8})
 await inPptRoom('soft',async()=>{})
 expect(warn).toHaveBeenCalled()
 }finally{warn.mockRestore()}
})
