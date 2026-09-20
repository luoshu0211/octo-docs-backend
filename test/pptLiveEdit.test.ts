import { beforeEach, expect, it, vi } from 'vitest'
import type { Tx } from '../src/db/pool.js'
import type { BentoDoc } from '../src/ppt/bentoDoc.js'
import type { Op } from '../src/ppt/sync/slidesSync.js'

const db = vi.hoisted(() => ({ meta: {} as Record<string, unknown>, role: 'writer', seq: 0,
  snapshot: '', state: '', frames: [] as { frame_json: string; frame_bytes: number }[], fail: false }))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({ docMemberRepo: { getRoleTx: async () => db.role } }))
vi.mock('../src/ppt/collabSession.js', () => ({ preparePptCollab: async () => {} }))
vi.mock('../src/db/repos/pptCollabFrameRepo.js', () => ({ pptCollabFrameRepo: { insertTx: async () => {} } }))
vi.mock('../src/db/repos/pptRelaySeqRepo.js', () => ({ pptRelaySeqRepo: { nextSeqTx: async () => ++db.seq } }))
vi.mock('../src/db/repos/pptCollabOpRepo.js', () => ({ pptCollabOpRepo: {
  insertTx: async (_tx: Tx, _docId: string, _seq: number, _frameId: string, json: string, bytes: number) => {
    if (db.fail) throw new Error('storage unavailable')
    db.frames.push({ frame_json: json, frame_bytes: bytes })
  },
} }))
vi.mock('../src/db/pool.js', () => ({ query: async () => [], transaction: async (fn: (tx: Tx) => Promise<unknown>) => {
  const original = structuredClone(db)
  try { return await fn({
    query: async <T>(sql: string) => {
      if (sql.includes('FROM doc_meta')) return [db.meta] as T[]
      if (sql.includes('FROM ppt_collab_seq')) return [{ last_seq: db.seq }] as T[]
      if (sql.includes('FROM ppt_live_snapshot')) return [{ covered_seq: 0, doc_json: db.snapshot, state_json: db.state }] as T[]
      if (sql.includes('SUM(frame_bytes)')) return [{ bytes: db.frames.reduce((sum, row) => sum + row.frame_bytes, 0) }] as T[]
      if (sql.includes('FROM ppt_collab_op')) return db.frames as T[]
      throw new Error(`unexpected SQL ${sql}`)
    },
    execute: async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('UPDATE doc_meta')) db.meta.title = params![0]
      return { affectedRows: 1 }
    },
  }) } catch (error) { Object.assign(db, original); throw error }
} }))

import { editPptLive, validatePptEdit } from '../src/ppt/liveEdit.js'
import { SyncState } from '../src/ppt/sync/slidesSync.js'
import { legacyPptDeck } from './fixtures/pptLegacyDeck.js'
import { pptRoomEvents } from '../src/ppt/roomCoordinator.js'
import { diffPpt } from '../src/ppt/diff.js'

const principal = { docId: 'd_1', uid: 'bot1', spaceId: 's1', authorizedEpoch: 1, isBot: true }
function deck(): BentoDoc { return JSON.parse(db.snapshot) }
function current(): BentoDoc {
  const value = deck(); const sync = SyncState.fromJSON('@reader', JSON.parse(db.state))
  for (const row of db.frames) sync.apply(value, JSON.parse(row.frame_json).ops)
  return value
}
beforeEach(() => {
  const value = legacyPptDeck()
  db.snapshot = JSON.stringify(value)
  const sync = new SyncState('@genesis'); sync.adopt(value); db.state = JSON.stringify(sync.toJSON())
  db.seq = 0; db.frames = []; db.role = 'writer'; db.fail = false
  db.meta = { doc_id: 'd_1', doc_type: 'html_ppt', title: value.title, status: 1, permission_epoch: 1,
    owner_id: 'owner', owner_space_id: 's1', space_id: 's1', share_scope: 0, share_role: 1 }
})
it.each(['pitch', 'report', 'lesson'] as const)('reads and edits an existing retired %s deck as live content', async id => {
  const value = legacyPptDeck(id)
  db.snapshot = JSON.stringify(value)
  const sync = new SyncState('@genesis'); sync.adopt(value); db.state = JSON.stringify(sync.toJSON())
  expect(current()).toEqual(value)
  value.slides[0]!.notes = 'Edited after template retirement'
  expect(await editPptLive(principal, { baseRevision: 0, deck: value })).toMatchObject({ revision: 1, changed: true })
  expect(current()).toEqual(value)
})
it('commits a content edit as replayable ops and broadcasts only after durability', async () => {
  const value = deck(); value.slides[0]!.notes = 'Bot wrote this'
  const listener = vi.fn(() => { expect(current().slides[0]!.notes).toBe('Bot wrote this') })
  pptRoomEvents.on('changed', listener)
  try {
    expect(await editPptLive(principal, { baseRevision: 0, deck: value })).toMatchObject({ revision: 1, changed: true })
    expect(current()).toEqual(value)
    expect(listener).toHaveBeenCalledOnce()
  } finally { pptRoomEvents.off('changed', listener) }
})
it('exactly one of two concurrent full-deck edits with the same revision commits', async () => {
  const a = deck(), b = deck(); a.slides[0]!.notes = 'A'; b.slides[0]!.notes = 'B'
  const results = await Promise.allSettled([editPptLive(principal, { baseRevision: 0, deck: a }), editPptLive(principal, { baseRevision: 0, deck: b })])
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
  expect(current().slides[0]!.notes).toBe('A'); expect(db.seq).toBe(1)
})
it.each(['reader', 'commenter', 'none'])('refuses %s content writes', async role => {
  db.role = role
  await expect(editPptLive(principal, { baseRevision: 0, deck: deck() })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(db.seq).toBe(0)
})
it('requires admin to rename and keeps the new title through later content edits', async () => {
  await expect(editPptLive(principal, { title: 'New title' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  db.role = 'admin'; await editPptLive(principal, { title: 'New title' })
  const value = current(); value.slides[0]!.notes = 'Later edit'; db.role = 'writer'
  await editPptLive(principal, { baseRevision: 1, deck: value })
  expect(current().title).toBe('New title'); expect(db.meta.title).toBe('New title')
})
it('fails closed on changed epoch and foreign-Space sharing without a direct grant', async () => {
  db.meta.permission_epoch = 2
  await expect(editPptLive(principal, { baseRevision: 0, deck: deck() })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  db.meta.permission_epoch = 1; db.meta.space_id = 'foreign'; db.meta.share_scope = 2; db.meta.share_role = 2; db.role = 'none'
  await expect(editPptLive(principal, { baseRevision: 0, deck: deck() })).rejects.toMatchObject({ code: 'FORBIDDEN' })
})
it('storage failure rolls back and never broadcasts an uncommitted edit', async () => {
  db.fail = true; const value = deck(); value.slides[0]!.notes = 'Not committed'
  const listener = vi.fn(); pptRoomEvents.on('changed', listener)
  try {
    await expect(editPptLive(principal, { baseRevision: 0, deck: value })).rejects.toThrow('storage unavailable')
    expect(db.seq).toBe(0); expect(listener).not.toHaveBeenCalled()
  } finally { pptRoomEvents.off('changed', listener) }
})
it('rejects missing revision, credentials and replacement identity', async () => {
  expect(() => validatePptEdit({ deck: deck() })).toThrow()
  expect(() => validatePptEdit({ baseRevision: 0, deck: { ...deck(), collab: { token: 'forged' } } })).toThrow()
  await expect(editPptLive(principal, { baseRevision: 0, deck: { ...deck(), docId: 'other' } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
})
it('syncs assets above the upstream inline cutoff instead of silently omitting them', async () => {
  const value = deck(); value.assets = { hero: `data:image/png;base64,${'A'.repeat(70000)}` }
  await editPptLive(principal, { baseRevision: 0, deck: value })
  expect(current().assets).toEqual(value.assets)
})
it('atomically splits a large edit into bounded ordinary frames', async () => {
  const value = deck()
  value.slides[0]!.elements = Array.from({ length: 700 }, (_, i) => ({ id: `new-${i}`, type: 'shape', x: i, y: 0, w: 10, h: 10 }))
  const result = await editPptLive(principal, { baseRevision: 0, deck: value })
  expect(db.frames.length).toBeGreaterThan(1)
  expect(result.revision).toBe(db.frames.length)
  expect(db.frames.every(row => JSON.parse(row.frame_json).ops.length <= 512)).toBe(true)
  expect(current()).toEqual(value)
})
it('converges a pending browser edit and an independent Bot edit in either delivery order', () => {
  const original = deck(), a = structuredClone(original), b = structuredClone(original)
  const sa = SyncState.fromJSON('browser', JSON.parse(db.state)), sb = SyncState.fromJSON('@rest:test', JSON.parse(db.state))
  a.slides[0]!.notes = 'browser'; b.slides[1]!.notes = 'bot'
  const ao = diffPpt(sa, original, a), bo = diffPpt(sb, original, b)
  sa.apply(a, bo as Op[]); sb.apply(b, ao as Op[])
  expect(a).toEqual(b); expect(a.slides[0]!.notes).toBe('browser'); expect(a.slides[1]!.notes).toBe('bot')
})

it('replays prior REST writes and reuses one server actor across repeated edits',async()=>{
 for(let i=1;i<=100;i++){
   const value=current();value.slides[0]!.notes=`edit ${i}`
   await editPptLive(principal,{baseRevision:db.seq,deck:value})
 }
 expect(current().slides[0]!.notes).toBe('edit 100')
 const actors=new Set(db.frames.flatMap(row=>JSON.parse(row.frame_json).ops.map((op:Op)=>op.a)))
 expect([...actors]).toEqual(['@rest-v1'])
})
