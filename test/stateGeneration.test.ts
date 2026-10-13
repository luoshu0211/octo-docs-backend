import { describe,it,expect } from 'vitest'
import * as Y from 'yjs'
import { bindStateGeneration,assertStateGeneration,parseGenerationToken } from '../src/collab/stateGeneration.js'
import { captureDurableSnapshot,recordDurableReceipt,durableReceipt } from '../src/collab/durableReceipt.js'
const generation='00000000-0000-4000-8000-000000000001'
describe('sheet state generation and durable snapshot',()=>{
  it('rejects an unbound or old loaded document at the storage fence',()=>{
    const doc=new Y.Doc();expect(()=>assertStateGeneration(doc,generation)).toThrow()
    bindStateGeneration(doc,generation);expect(()=>assertStateGeneration(doc,generation)).not.toThrow()
    expect(()=>assertStateGeneration(doc,null)).toThrow()
    expect(()=>assertStateGeneration(doc,'00000000-0000-4000-8000-000000000002')).toThrow()
  })
  it('unwraps only the explicit protocol and leaves JWT authority to the normal verifier',()=>{
    expect(parseGenerationToken('jwt')).toEqual({token:'jwt',generation:null})
    expect(parseGenerationToken(JSON.stringify({protocol:'octo-sheet-generation-v1',token:'jwt',generation}))).toEqual({token:'jwt',generation})
    expect(()=>parseGenerationToken(JSON.stringify({token:'jwt',generation}))).toThrow()
    expect(()=>parseGenerationToken(JSON.stringify({protocol:'octo-sheet-generation-v1',token:'jwt',generation:'new'}))).toThrow()
  })
  it('acknowledges only the captured state, including deletions, not later live edits',()=>{
    const doc=new Y.Doc();bindStateGeneration(doc,generation);doc.getMap('sheet').set('a',1)
    const captured=captureDurableSnapshot(doc);doc.getMap('sheet').delete('a')
    recordDurableReceipt(doc,captured)
    const receipt=JSON.parse(durableReceipt(doc)!);const snapshot=Y.decodeSnapshot(Buffer.from(receipt.snapshot,'base64'))
    expect(snapshot.ds.clients.size).toBe(0);expect(Y.snapshot(doc).ds.clients.size).toBe(1)
    expect(receipt.generation).toBe(generation)
    recordDurableReceipt(doc,captureDurableSnapshot(doc))
    expect(Y.decodeSnapshot(Buffer.from(JSON.parse(durableReceipt(doc)!).snapshot,'base64')).ds.clients.size).toBe(1)
  })
})
