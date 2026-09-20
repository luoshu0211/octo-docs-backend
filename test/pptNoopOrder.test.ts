import { expect, it, vi } from 'vitest'
import type { Tx } from '../src/db/pool.js'
import { appendPptEditTx } from '../src/ppt/liveEdit.js'
import { SyncState } from '../src/ppt/sync/slidesSync.js'
import { instantiateTemplate } from '../src/ppt/bentoDoc.js'
import { getPptTemplate } from '../src/ppt/templates.js'
import { config } from '../src/config/env.js'

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,sorted(v)]))
  return value
}
it('does not write or mint CRDT sequence numbers when a CLI only sorts object keys',async()=>{
 const deck=instantiateTemplate(getPptTemplate('blank')!,new Date().toISOString())
 deck.theme.extra={z:1,a:{z:2,a:3}}
 const sync=new SyncState('@server');sync.adopt(deck)
 const before=sync.toJSON();const tx={query:vi.fn(),execute:vi.fn()} as unknown as Tx
 const after=sorted(deck) as typeof deck
 expect(JSON.stringify(after)).not.toBe(JSON.stringify(deck))
 const result=await appendPptEditTx(tx,{docId:'doc',uid:'writer',spaceId:'space',authorizedEpoch:1},{deck,sync,revision:12,bytes:0},after)
 expect(result).toMatchObject({revision:12,changed:false,frames:[]})
 expect(sync.toJSON()).toEqual(before);expect(tx.execute).not.toHaveBeenCalled();expect(tx.query).not.toHaveBeenCalled()
})

it('rejects the actual CRDT result above the cap even when the submitted deck fits', async () => {
  const deck = instantiateTemplate(getPptTemplate('blank')!, new Date().toISOString())
  deck.padding = ''
  deck.padding = 'x'.repeat(config.ppt.write.maxDocumentBytes - Buffer.byteLength(JSON.stringify(deck)))
  const sync = new SyncState('@server'); sync.adopt(deck)
  const after = structuredClone(deck)
  delete (after as Partial<typeof after>).modified
  after.extra = 'small'
  expect(Buffer.byteLength(JSON.stringify(after))).toBeLessThan(config.ppt.write.maxDocumentBytes)
  const tx = { query: vi.fn(), execute: vi.fn() } as unknown as Tx
  await expect(appendPptEditTx(tx, { docId: 'doc', uid: 'writer', spaceId: 'space', authorizedEpoch: 1 },
    { deck, sync, revision: 12, bytes: 0 }, after)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' })
  expect(tx.execute).not.toHaveBeenCalled()
  expect(tx.query).not.toHaveBeenCalled()
})
