import { beforeEach, expect, it, vi } from 'vitest'
import type { Tx } from '../src/db/pool.js'
import type { BentoDoc } from '../src/ppt/bentoDoc.js'

// Transactional SQL seam: rollback includes the safety snapshot, pointer, ops
// and replay receipt. Real MySQL migration/locking is an integration gate.
const db = vi.hoisted(() => ({ meta: {} as Record<string, unknown>, role: 'writer', seq: 0,
  snapshot: '', state: '', frames: [] as { frame_json: string; frame_bytes: number }[],
  versions: [] as Record<string, unknown>[], receipts: {} as Record<string, Record<string, unknown>>,
  pointer: null as number | null, fail: '', packetBytes:64*1024*1024 }))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({ docMemberRepo: { getRoleTx: async () => db.role } }))
vi.mock('../src/ppt/collabSession.js', () => ({ preparePptCollab: async () => {} }))
vi.mock('../src/ppt/render.js', () => ({ renderPptHtml: async (deck: BentoDoc) => {
  if (db.fail === 'render') throw new Error('render failed')
  return `<html>${deck.title}</html>`
} }))
vi.mock('../src/db/repos/pptCollabFrameRepo.js', () => ({ pptCollabFrameRepo: { insertTx: async () => {} } }))
vi.mock('../src/db/repos/pptRelaySeqRepo.js', () => ({ pptRelaySeqRepo: { nextSeqTx: async () => ++db.seq } }))
vi.mock('../src/db/repos/pptCollabOpRepo.js', () => ({ pptCollabOpRepo: {
  insertTx: async (_tx: Tx, _docId: string, _seq: number, _frameId: string, json: string, bytes: number) => {
    if (db.fail === 'ops') throw new Error('ops failed')
    db.frames.push({ frame_json: json, frame_bytes: bytes })
  },
} }))
vi.mock('../src/db/pool.js', () => {
  const execute = async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith('UPDATE doc_meta')) db.meta.title = params[0]
    if (sql.startsWith('UPDATE ppt_doc_state')) db.pointer = Number(params[0])
    if (sql.startsWith('INSERT INTO ppt_version')) {
      const keys = ['doc_id', 'version_seq', 'kind', 'label', 'base_revision', 'deck_json', 'html', 'content_hash', 'created_by', 'principal_space_id']
      db.versions.push({ ...Object.fromEntries(keys.map((key, index) => [key, params[index]])), created_at: new Date() })
    }
    return { affectedRows: 1 }
  }
  const query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    if (sql.includes('@@max_allowed_packet')) return [{packet_bytes:db.packetBytes}] as T[]
    if (sql.includes('FROM doc_meta')) return [db.meta] as T[]
    if (sql.includes('FROM ppt_collab_seq')) return [{ last_seq: db.seq }] as T[]
    if (sql.includes('FROM ppt_live_snapshot')) return [{ covered_seq: 0, doc_json: db.snapshot, state_json: db.state }] as T[]
    if (sql.includes('SUM(frame_bytes)')) return [{ bytes: db.frames.reduce((sum, row) => sum + row.frame_bytes, 0) }] as T[]
      if (sql.includes('FROM ppt_collab_op')) return db.frames as T[]
    if (sql.includes('FROM ppt_idempotency')) return [db.receipts[JSON.stringify(params)]].filter(Boolean) as T[]
    if (sql.includes('INSERT INTO ppt_idempotency')) {
      db.receipts[JSON.stringify(params.slice(0, 4))] = { request_hash: params[4], response_body: null, response_status: 0 }
      return []
    }
    if (sql.includes('UPDATE ppt_idempotency')) {
      if (db.fail === 'receipt') throw new Error('receipt failed')
      Object.assign(db.receipts[JSON.stringify(params.slice(3))]!, { response_status: params[0], response_body: params[1], doc_id: params[2] })
      return []
    }
    if (sql.includes('FROM ppt_version')) {
      let rows = db.versions.filter(row => row.doc_id === params[0])
      if (sql.includes('JOIN ppt_doc_state')) rows = rows.filter(row => row.version_seq === db.pointer)
      else if (sql.includes('version_seq = ?')) rows = rows.filter(row => row.version_seq === params[1])
      else if (sql.includes('version_seq < ?')) rows = rows.filter(row => Number(row.version_seq) < Number(params[1]))
      return [...rows].sort((a, b) => Number(b.version_seq) - Number(a.version_seq)).slice(0, sql.includes('LIMIT 1 ') ? 1 : 26) as T[]
    }
    throw new Error(`unexpected SQL ${sql}`)
  }
  return { query, transaction: async (fn: (tx: Tx) => Promise<unknown>) => {
    const original = structuredClone(db)
    try { return await fn({ query, execute }) }
    catch (error) { Object.assign(db, original); throw error }
  } }
})

import { changePptVersion, getPptVersion, validateVersionAction } from '../src/ppt/versions.js'
import { editPptLive } from '../src/ppt/liveEdit.js'
import { SyncState } from '../src/ppt/sync/slidesSync.js'
import { getPptTemplate } from '../src/ppt/templates.js'
import { instantiateTemplate } from '../src/ppt/bentoDoc.js'
import { pptRoomEvents } from '../src/ppt/roomCoordinator.js'

const principal = { docId: 'd_1', uid: 'bot1', spaceId: 's1', authorizedEpoch: 1, isBot: true }
const publish = (baseRevision = db.seq, key = 'publish-1') => changePptVersion(principal, 'create', { baseRevision, label: 'Release' }, key)
function current(): BentoDoc {
  const value = JSON.parse(db.snapshot) as BentoDoc
  const sync = SyncState.fromJSON('@reader', JSON.parse(db.state))
  for (const row of db.frames) sync.apply(value, JSON.parse(row.frame_json).ops)
  return value
}
beforeEach(() => {
  const value = instantiateTemplate(getPptTemplate('pitch')!, new Date().toISOString())
  db.snapshot = JSON.stringify(value)
  const sync = new SyncState('@genesis'); sync.adopt(value); db.state = JSON.stringify(sync.toJSON())
  db.seq = 0; db.frames = []; db.role = 'writer'; db.fail = ''; db.versions = []; db.receipts = {}; db.pointer = null
  db.meta = { doc_id: 'd_1', doc_type: 'html_ppt', title: value.title, status: 1, permission_epoch: 1,
    owner_id: 'owner', owner_space_id: 's1', space_id: 's1', share_scope: 0, share_role: 1 }
})

it('creates snapshots immutable source and replays the same receipt after later edits', async () => {
  const original = current(), receipt = await publish()
  const value = current(); value.slides[0]!.notes = 'Later work'
  await editPptLive(principal, { baseRevision: 0, deck: value })
  expect(await publish(0)).toEqual(receipt)
  expect((await getPptVersion('d_1', 'latest'))?.deck).toEqual(original)
  expect(current()).toEqual(value)
  expect(db.versions).toHaveLength(1)
  expect(await getPptVersion('other', 1)).toBeNull()
})
it('conflicts on stale revisions and changed idempotent payloads without a new version', async () => {
  await publish()
  await expect(changePptVersion(principal, 'create', { baseRevision: 0, label: 'Changed' }, 'publish-1')).rejects.toMatchObject({ code: 'CONFLICT' })
  await expect(publish(5, 'stale')).rejects.toMatchObject({ code: 'CONFLICT' })
  expect(db.versions).toHaveLength(1); expect(Object.keys(db.receipts)).toHaveLength(1)
})
it.each(['none', 'reader', 'commenter'])('denies %s creating snapshots', async role => {
  db.role = role
  await expect(publish()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(db.versions).toHaveLength(0)
})
it.each(['reader', 'commenter', 'writer'])('denies %s restoring', async role => {
  await publish(); db.role = role
  await expect(changePptVersion(principal, 'restore', { baseRevision: 0, label: '', versionSeq: 1 }, 'restore')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(db.versions).toHaveLength(1)
})
it('rechecks epoch and current-Space authority even when replaying an old receipt', async () => {
  await publish(); db.meta.permission_epoch = 2
  await expect(publish()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  db.meta.permission_epoch = 1; db.meta.space_id = 'foreign'; db.meta.share_scope = 2; db.meta.share_role = 2; db.role = 'none'
  await expect(publish()).rejects.toMatchObject({ code: 'FORBIDDEN' })
})
it('restores through ordinary CRDT ops, saves current work first and leaves publication fixed', async () => {
  const original = current(); await publish()
  const changed = current(); changed.slides[0]!.notes = 'Before restore'
  await editPptLive(principal, { baseRevision: 0, deck: changed }); db.role = 'admin'
  const listener = vi.fn(() => expect(current()).toEqual(original)); pptRoomEvents.on('changed', listener)
  try {
    const input = { baseRevision: 1, label: '', versionSeq: 1 }
    const receipt = await changePptVersion(principal, 'restore', input, 'restore')
    expect(receipt).toMatchObject({ restoredVersionSeq: 1, safetyVersionSeq: 2, revision: 2 })
    expect((await getPptVersion('d_1', 2))?.deck).toEqual(changed)
    expect((await getPptVersion('d_1', 2))?.kind).toBe('safety')
    expect((await getPptVersion('d_1', 'latest'))?.versionSeq).toBe(1)
    expect(await changePptVersion(principal, 'restore', input, 'restore')).toEqual(receipt)
    expect(listener).toHaveBeenCalledOnce(); expect(listener.mock.calls[0]?.[1]).toMatchObject({ ctl: 'op', q: 2 })
    expect(db.versions).toHaveLength(2)
  } finally { pptRoomEvents.off('changed', listener) }
})
it.each(['render', 'ops', 'receipt'])('rolls back the safety snapshot and op when %s fails', async fail => {
  await publish(); const changed = current(); changed.slides[0]!.notes = 'Keep this work'
  await editPptLive(principal, { baseRevision: 0, deck: changed }); db.role = 'admin'; db.fail = fail
  const listener = vi.fn(); pptRoomEvents.on('changed', listener)
  try {
    await expect(changePptVersion(principal, 'restore', { baseRevision: 1, label: '', versionSeq: 1 }, 'restore')).rejects.toThrow(`${fail} failed`)
    expect(db.versions).toHaveLength(1); expect(db.seq).toBe(1); expect(current()).toEqual(changed)
    expect(db.pointer).toBe(1); expect(Object.keys(db.receipts)).toHaveLength(1); expect(listener).not.toHaveBeenCalled()
  } finally { pptRoomEvents.off('changed', listener) }
})
it('refuses invalid version inputs before persistence', () => {
  for (const body of [null, [], {}, { baseRevision: -1 }, { baseRevision: 1.5 }, { baseRevision: 0, label: 'x'.repeat(257) }, { baseRevision: 0, unknown: true }]) {
    expect(() => validateVersionAction(body)).toThrow()
  }
  expect(() => validateVersionAction({ baseRevision: 0, versionSeq: 0 }, true)).toThrow()
  expect(validateVersionAction({ baseRevision: 0, versionSeq: 1, label: '  v1 ' }, true)).toEqual({ baseRevision: 0, versionSeq: 1, label: 'v1' })
})

it('rolls back version allocation and receipt when the SQL packet budget is too small',async()=>{
 db.packetBytes=1
 try{
 await expect(changePptVersion(principal,'create',{baseRevision:0,label:''},'small-packet')).rejects.toMatchObject({code:'PAYLOAD_TOO_LARGE'})
 expect(db.versions).toHaveLength(0);expect(db.pointer).toBeNull();expect(Object.keys(db.receipts)).toHaveLength(0)
 }finally{db.packetBytes=64*1024*1024}
})
