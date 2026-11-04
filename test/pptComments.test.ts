import { beforeEach, expect, it, vi } from 'vitest'
import type { Tx } from '../src/db/pool.js'

const db = vi.hoisted(() => ({ role: 'commenter', epoch: 1, rows: [] as Record<string, unknown>[],
  receipts: {} as Record<string, Record<string, unknown>>, seq: 0, fail: false }))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({ docMemberRepo: { getRoleTx: async () => db.role } }))
vi.mock('../src/ppt/collabSession.js', () => ({ preparePptCollab: async () => {} }))
vi.mock('../src/ppt/liveEdit.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/ppt/liveEdit.js')>(),
  lockPptLive: async () => ({ revision: 7, deck: { slides: [{ id: 'slide-1', elements: [{ id: 'element-1' }, { id: 'element-2' }] }] } }),
}))
vi.mock('../src/db/pool.js', () => {
  const query = async <T>(sql: string, p: unknown[] = []): Promise<T[]> => {
    if (sql.includes('FROM doc_meta')) return [{ doc_id: p[0], doc_type: 'html_ppt', status: 1, permission_epoch: db.epoch,
      owner_id: 'owner', owner_space_id: 's1', space_id: 's1', share_scope: 0 }] as T[]
    if (sql.includes('FROM ppt_idempotency')) return [db.receipts[JSON.stringify(p)]].filter(Boolean) as T[]
    if (sql.includes('INSERT INTO ppt_idempotency')) {
      db.receipts[JSON.stringify(p.slice(0, 4))] = { request_hash: p[4], response_status: 0 }; return []
    }
    if (sql.includes('UPDATE ppt_idempotency')) {
      if (db.fail) throw new Error('receipt unavailable')
      Object.assign(db.receipts[JSON.stringify(p.slice(3))]!, { response_status: p[0], response_body: p[1] }); return []
    }
    if (sql.includes('LAST_INSERT_ID')) return [{ id: db.seq }] as T[]
    if (sql.includes('FROM ppt_version')) return p[1] === 1 ? [{ deck_json: JSON.stringify({ slides: [{ id: 'old-slide', elements: [{ id: 'old-element' }] }] }) }] as T[] : []
    if (sql.includes('FROM ppt_comment')) {
      let rows = db.rows.filter(r => r.doc_id === p[0])
      if (sql.includes('AND id = ?')) rows = rows.filter(r => r.id === p[1])
      else if (sql.includes('parent_id IS NULL')) rows = rows.filter(r => r.parent_id === null && Number(r.id) > Number(p[1]))
      else rows = rows.filter(r => r.parent_id === p[1] && Number(r.id) > Number(p[2]))
      return rows.slice(0, 26) as T[]
    }
    throw new Error(`Unexpected SQL: ${sql}`)
  }
  const execute = async (sql: string, p: unknown[] = []) => {
    if (sql.startsWith('INSERT INTO ppt_comment')) {
      const keys = ['doc_id', 'parent_id', 'author_uid', 'author_space_id', 'body', 'anchor_json']
      db.rows.push({ ...Object.fromEntries(keys.map((key, i) => [key, p[i]])), id: ++db.seq,
        revision: 1, resolved: 0, deleted: 0, created_at: new Date(), updated_at: new Date() })
    } else if (sql.startsWith('UPDATE ppt_comment')) {
      const row = db.rows.find(r => r.doc_id === p[p.length - 2] && r.id === p[p.length - 1])!
      row.revision = Number(row.revision) + 1
      if (sql.includes('SET body = ?')) row.body = p[0]
      else if (sql.includes('SET resolved = ?')) row.resolved = p[0]
      else { row.deleted = 1; row.body = '' }
    } else if (sql.startsWith('DELETE FROM ppt_comment')) {
      db.rows = db.rows.filter(r => r.doc_id !== p[0] || (r.id !== p[1] && r.parent_id !== p[1]))
    } else throw new Error(`Unexpected SQL: ${sql}`)
    return { affectedRows: 1 }
  }
  return { query, transaction: async (fn: (tx: Tx) => Promise<unknown>) => {
    const before = structuredClone(db)
    try { return await fn({ query, execute }) } catch (error) { Object.assign(db, before); throw error }
  } }
})

import { createPptComment, getPptComment, listPptComments, mutatePptComment, validatePptComment } from '../src/ppt/comments.js'
import { setDriveDerivedAccess, type DriveDerivedAccess, type DerivedRole } from '../src/drive/derivedAccessClient.js'

const principal = { docId: 'd1', uid: 'u1', spaceId: 's1', authorizedEpoch: 1 }
const input = () => validatePptComment({ body: 'Review this slide', anchor: { kind: 'slide', slideId: 'slide-1', versionSeq: null, baseRevision: 7 } })
const create = (key = 'request-1') => createPptComment(principal, input(), key)

function driveAccess(role: DerivedRole | ((docId: string, uid: string, principalSpaceId: string) => DerivedRole)): DriveDerivedAccess {
  return {
    async derivedAccess(docId, uid, principalSpaceId) {
      const resolved = typeof role === 'function' ? role(docId, uid, principalSpaceId) : role
      return { docId, uid, principalSpaceId, role: resolved, sourceRevision: 'sha256:test',
        validForMs: 15_000, expiresAt: performance.now() + 15_000 }
    },
    async versions(bindings) {
      return bindings.map(binding => ({ ...binding, sourceRevision: 'sha256:test',
        validForMs: 15_000, expiresAt: performance.now() + 15_000 }))
    },
  }
}
beforeEach(() => {
  db.role = 'commenter'; db.epoch = 1; db.rows = []; db.seq = 0; db.receipts = {}; db.fail = false
  setDriveDerivedAccess(driveAccess('none'))
})

it('dispatches only after a new committed comment and never after rollback or replay', async () => {
  const after = vi.fn()
  db.fail = true
  await expect(createPptComment(principal, input(), 'key', after)).rejects.toThrow()
  expect(after).not.toHaveBeenCalled()
  db.fail = false
  const saved = await createPptComment(principal, input(), 'key', after)
  expect(after).toHaveBeenCalledTimes(1)
  expect(after).toHaveBeenCalledWith(saved.id)
  await createPptComment(principal, input(), 'key', after)
  expect(after).toHaveBeenCalledTimes(1)
})
it('reads a reply with its root anchor under the same document and live authority', async () => {
  const root = await create()
  const reply = await createPptComment(principal, { body: 'Reply', parentId: root.id }, 'reply')
  expect(await getPptComment(principal, reply.id)).toMatchObject({ comment: { id: reply.id, parentId: root.id }, root: { id: root.id, anchor: input().anchor } })
  await expect(getPptComment({ ...principal, docId: 'other' }, reply.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  db.epoch++
  await expect(getPptComment(principal, reply.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
})

it('creates slide comments outside Yjs and replays without duplication', async () => {
  const result = await create()
  expect(await create()).toEqual(result); expect(db.rows).toHaveLength(1)
  expect((await listPptComments(principal)).items[0]).toMatchObject({ authorUid: 'u1', authorSpaceId: 's1',
    anchor: { kind: 'slide', slideId: 'slide-1', versionSeq: null, baseRevision: 7 } })
  await expect(createPptComment(principal, { ...input(), body: 'Different' }, 'request-1')).rejects.toMatchObject({ code: 'CONFLICT' })
})
it.each(['reader', 'none'])('refuses %s creating, replying or deleting', async role => {
  const { id } = await create(); db.role = role
  await expect(create('second')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await expect(createPptComment(principal, validatePptComment({ parentId: id, body: 'Reply' }), 'reply')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await expect(mutatePptComment(principal, id, { action: 'delete', revision: 1 })).rejects.toMatchObject({ code: 'FORBIDDEN' })
})
it('lets a Drive-authorized reader list comments without a direct grant', async () => {
  db.role = 'none'
  setDriveDerivedAccess(driveAccess((docId, uid, principalSpaceId) =>
    docId === 'd1' && uid === 'u1' && principalSpaceId === 's1' ? 'reader' : 'none'))
  await expect(listPptComments(principal)).resolves.toMatchObject({ items: [], nextCursor: null })
})
it('does not let a Drive-authorized reader create comments', async () => {
  db.role = 'none'
  setDriveDerivedAccess(driveAccess((docId, uid, principalSpaceId) =>
    docId === 'd1' && uid === 'u1' && principalSpaceId === 's1' ? 'reader' : 'none'))
  await expect(createPptComment(principal, input(), 'drive-reader')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(db.rows).toHaveLength(0)
})
it('rechecks epoch and principal Space before replay, read and author operations', async () => {
  const { id } = await create(); db.epoch = 2
  await expect(create()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await expect(listPptComments(principal)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  db.epoch = 1
  await expect(mutatePptComment({ ...principal, spaceId: 's2' }, id, { action: 'delete', revision: 1 })).rejects.toMatchObject({ code: 'FORBIDDEN' })
})
it('keeps commenter below body-edit/resolve and writer below admin hard-delete', async () => {
  const { id } = await create()
  for (const change of [{ action: 'edit' as const, body: 'Edit', revision: 1 }, { action: 'resolve' as const, resolved: true, revision: 1 }]) {
    await expect(mutatePptComment(principal, id, change)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  }
  db.role = 'writer'
  await expect(mutatePptComment({ ...principal, uid: 'u2' }, id, { action: 'edit', body: 'Overwrite', revision: 1 })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await mutatePptComment(principal, id, { action: 'edit', body: 'Edited', revision: 1 })
  await expect(mutatePptComment(principal, id, { action: 'resolve', resolved: true, revision: 1 })).rejects.toMatchObject({ code: 'CONFLICT' })
  await mutatePptComment(principal, id, { action: 'resolve', resolved: true, revision: 2 })
  await expect(mutatePptComment(principal, id, { action: 'delete', hard: true, revision: 3 })).rejects.toMatchObject({ code: 'FORBIDDEN' })
})
it('preserves replies after author deletion and scopes admin removal to the document', async () => {
  const { id } = await create()
  await createPptComment(principal, validatePptComment({ parentId: id, body: 'Reply' }), 'reply')
  await mutatePptComment(principal, id, { action: 'delete', revision: 1 })
  expect((await listPptComments(principal)).items[0]).toMatchObject({ deleted: true, body: '' })
  expect((await listPptComments(principal, 0, id)).items).toHaveLength(1)
  await expect(createPptComment(principal, validatePptComment({ parentId: id, body: 'Late' }), 'late')).rejects.toMatchObject({ code: 'CONFLICT' })
  db.role = 'admin'
  await expect(mutatePptComment({ ...principal, docId: 'other' }, id, { action: 'delete', hard: true, revision: 2 })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  await mutatePptComment(principal, id, { action: 'delete', hard: true, revision: 2 })
  expect(db.rows).toHaveLength(0); expect(await create()).toEqual({ id }); expect(db.rows).toHaveLength(0)
})
it('rejects stale live anchors, missing slides, nested replies and missing published versions', async () => {
  for (const anchor of [{ kind: 'slide', slideId: 'slide-1', versionSeq: null, baseRevision: 6 },
    { kind: 'slide', slideId: 'missing', versionSeq: null, baseRevision: 7 }, { kind: 'slide', slideId: 'old-slide', versionSeq: 2 }]) {
    await expect(createPptComment(principal, validatePptComment({ body: 'Text', anchor }), 'bad')).rejects.toThrow()
  }
  const root = await createPptComment(principal, validatePptComment({ body: 'Old version', anchor: { kind: 'slide', slideId: 'old-slide', versionSeq: 1 } }), 'old')
  const reply = await createPptComment(principal, validatePptComment({ body: 'Reply', parentId: root.id }), 'reply')
  await expect(createPptComment(principal, validatePptComment({ body: 'Nested', parentId: reply.id }), 'nested')).rejects.toMatchObject({ code: 'NOT_FOUND' })
})
it('rolls back creation when its replay receipt cannot commit', async () => {
  db.fail = true; await expect(create()).rejects.toThrow('receipt unavailable')
  expect(db.rows).toHaveLength(0); expect(db.receipts).toEqual({})
})
it('validates bounded text and strictly separates root/reply/element anchors', () => {
  for (const body of [null, [], {}, { body: ' ' }, { body: 'x'.repeat(10001), parentId: 1 },
    { body: 'x', parentId: 1, anchor: input().anchor }, { body: 'x', parentId: -1 },
    { body: 'x', anchor: { kind: 'element', slideId: 's', versionSeq: 1 } },
    { body: 'x', anchor: { kind: 'slide', slideId: 's', versionSeq: null } }, { ...input(), uid: 'spoof' }]) {
    expect(() => validatePptComment(body)).toThrow()
  }
})
it.each([
  { kind: 'document' }, { kind: 'slide', slideId: 'slide-1' },
  { kind: 'element', slideId: 'slide-1', elementId: 'element-1' },
  { kind: 'point', slideId: 'slide-1', x: 0, y: 1 },
])('persists a validated $kind target without legacy Yjs anchors', async target => {
  const anchor = { ...target, versionSeq: null, baseRevision: 7 }
  await createPptComment(principal, validatePptComment({ body: 'Scoped', anchor }), 'scoped')
  expect((await listPptComments(principal)).items[0]!.anchor).toEqual(anchor)
})
it('validates element IDs against the selected live or immutable slide', async () => {
  for (const [slideId, elementId, versionSeq] of [['slide-1', 'old-element', null], ['old-slide', 'element-1', 1]] as const) {
    const anchor = { kind: 'element', slideId, elementId, versionSeq, ...(versionSeq === null ? { baseRevision: 7 } : {}) }
    await expect(createPptComment(principal, validatePptComment({ body: 'Wrong element', anchor }), 'bad-element')).rejects.toMatchObject({ code: 'CONFLICT' })
  }
  await createPptComment(principal, validatePptComment({ body: 'Pinned element', anchor: { kind: 'element', slideId: 'old-slide', elementId: 'old-element', versionSeq: 1 } }), 'pinned')
  expect(db.rows).toHaveLength(1)
})
it('rejects malformed targets, nonfinite/out-of-slide points and extra identities', () => {
  for (const target of [
    { kind: 'document', slideId: 'slide-1' }, { kind: 'document', elementId: 'element-1' },
    { kind: 'point', slideId: 'slide-1', x: -0.1, y: 0.5 },
    { kind: 'point', slideId: 'slide-1', x: 0.5, y: 1.1 },
    { kind: 'point', slideId: 'slide-1', x: Infinity, y: 0.5 },
    { kind: 'point', slideId: 'slide-1', x: '0.5', y: 0.5 },
    { kind: 'element', slideId: 'slide-1', elementId: '' },
  ]) expect(() => validatePptComment({ body: 'Invalid', anchor: { ...target, versionSeq: null, baseRevision: 7 } })).toThrow()
})

it('validates every member of a multi-element anchor against its authoritative slide', async () => {
  const anchor = {kind:'element',slideId:'slide-1',elementId:'element-1',elementIds:['element-1','element-2'],versionSeq:null,baseRevision:7}
  await createPptComment(principal, validatePptComment({body:'Both',anchor}), 'multi')
  expect((await listPptComments(principal)).items[0]!.anchor).toEqual(anchor)
  await expect(createPptComment(principal, validatePptComment({body:'Missing',anchor:{...anchor,elementIds:['element-1','missing']}}), 'missing')).rejects.toMatchObject({code:'CONFLICT'})
  for (const elementIds of [[], ['element-1','element-1'], ['element-2'], ['element-1',null], Array.from({length:101},(_,i)=>`element-${i}`)]) {
    expect(() => validatePptComment({body:'Invalid',anchor:{...anchor,elementIds}})).toThrow()
  }
})
