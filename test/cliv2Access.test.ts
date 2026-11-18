import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'

vi.mock('../src/db/pool.js', () => ({ query: vi.fn(), getPool: vi.fn(), transaction: vi.fn() }))
vi.mock('../src/api/guard.js', () => ({ requireDocRole: vi.fn() }))
vi.mock('../src/permission/epoch.js', () => ({ refreshAndPublish: vi.fn(), bumpEpoch: vi.fn() }))
vi.mock('../src/api/cliv2/auth.js', async original => ({
  ...await original<typeof import('../src/api/cliv2/auth.js')>(), postCliService: vi.fn(),
}))

import { query, transaction, type Tx } from '../src/db/pool.js'
import { requireDocRole } from '../src/api/guard.js'
import { refreshAndPublish } from '../src/permission/epoch.js'
import { postCliService } from '../src/api/cliv2/auth.js'
import { setCliMember, forwardCliGrant, removeCliMember } from '../src/api/cliv2/access.js'
import { roleFromNumber, roleRank } from '../src/permission/role.js'
import type { DocMeta } from '../src/db/repos/docMetaRepo.js'

const doc: DocMeta = {
  doc_id: 'd1', document_name: 'octo:s1:f_default:d1', title: 'Document',
  owner_id: 'owner', owner_space_id: 's1', space_id: 's1', folder_id: 'f_default',
  doc_type: 'doc', status: 1, permission_epoch: 7, share_scope: 0, share_role: 1,
  discoverability_scope: 0, created_at: new Date(0), updated_at: new Date(0),
  created_by: 'owner', updated_by: 'owner', octo_doc_slug: null, html_idempotency_key_hash: null,
}
const tx = { query: vi.fn(), execute: vi.fn() } satisfies Tx
let meta: DocMeta
let members: Map<string, number>
let notifications: string[]
let events: string[]
let failWrite: string | undefined

function principal(uid: unknown, space: unknown): string { return `${uid}@${space}` }
function request(uid = 'target', role = 'writer'): Request {
  return {
    uid: 'admin', spaceId: 's1', principalSpaceId: 's1',
    params: { docId: 'd1', uid }, query: { principalSpaceId: 's1' }, body: { uid, role },
  } as unknown as Request
}
function response() { return { json: vi.fn() } as unknown as Response }
function directoryResult(uid: string, principalType: unknown = 'human') {
  return {
    status: 200, body: { data: { user: { user_id: uid, principal_type: principalType }, space: { space_id: 's1' } } },
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  meta = { ...doc }
  members = new Map([['admin@s1', 3]])
  notifications = []
  events = []
  failWrite = undefined
  vi.stubEnv('OCTO_SERVER_INTERNAL_URL', 'http://127.0.0.1')
  vi.stubEnv('OCTO_MEMBERSHIP_INTERNAL_TOKEN', 'fixture-internal-secret')
  vi.mocked(requireDocRole).mockImplementation(async () => ({ meta: { ...meta }, role: 'admin' }))
  vi.mocked(postCliService).mockImplementation(async (_url, _headers, input) =>
    directoryResult((input as { user_id: string }).user_id))
  vi.mocked(refreshAndPublish).mockImplementation(async () => { events.push('publish') })
  vi.mocked(transaction).mockImplementation(async action => {
    const before = { meta: { ...meta }, members: new Map(members), notifications: [...notifications] }
    try {
      const result = await action(tx)
      events.push('commit')
      return result
    } catch (error) {
      meta = before.meta
      members = before.members
      notifications = before.notifications
      events.push('rollback')
      throw error
    }
  })
  tx.query.mockImplementation(async (sql: string, args: unknown[] = []) => {
    if (failWrite && sql.includes(failWrite)) throw new Error('write failed')
    if (sql.startsWith('SELECT * FROM doc_meta')) return [{ ...meta }]
    if (sql.startsWith('SELECT role FROM doc_member')) {
      const role = members.get(principal(args[1], args[2]))
      return role === undefined ? [] : [{ role }]
    }
    if (sql.includes('SELECT 1 AS present')) return members.has(principal(args[1], args[2])) ? [{ present: 1 }] : []
    if (sql.startsWith('SELECT uid FROM doc_member')) return members.has(principal(args[1], args[2])) ? [{ uid: args[1] }] : []
    if (sql.includes('INSERT INTO doc_member_notification')) { notifications.push(String(args[0])); return [] }
    if (sql.startsWith('INSERT INTO doc_member ')) { members.set(principal(args[1], args[2]), Number(args[3])); return [] }
    if (sql.startsWith('DELETE FROM doc_member_notification')) { notifications = notifications.filter(uid => uid !== args[1]); return [] }
    if (sql.startsWith('DELETE FROM doc_member WHERE')) { members.delete(principal(args[1], args[2])); return [] }
    if (sql.startsWith('UPDATE doc_meta SET permission_epoch')) { meta.permission_epoch += 1; return [] }
    if (sql.startsWith('SELECT permission_epoch')) return [{ permission_epoch: meta.permission_epoch }]
    throw new Error('Unexpected query ' + sql)
  })
  tx.execute.mockImplementation(async (_sql: string, args: unknown[] = []) => {
    const key = principal(args[1], args[2])
    const current = roleFromNumber(members.get(key) ?? 0) ?? 'none'
    const granted = roleFromNumber(Number(args[3]))!
    if (roleRank(current) >= roleRank(granted)) return { affectedRows: 0 }
    members.set(key, Number(args[3]))
    return { affectedRows: 1 }
  })
})

const grants = [
  ['set', setCliMember, 'admin'],
  ['forward', forwardCliGrant, 'writer'],
] as const

afterEach(() => { vi.unstubAllEnvs() })

describe('CLI access mutations recheck authorization in their write transaction', () => {
  describe.each(grants)('CLI %s recipient eligibility', (_name, grant, role) => {
    it.each([
      ['User Bot', 'user_bot', 'NOT_FOUND'],
      ['App Bot', 'app_bot', 'NOT_FOUND'],
      ['unknown principal', 'unknown', 'UPSTREAM_UNAVAILABLE'],
      ['unrecognized type', 'service_account', 'UPSTREAM_UNAVAILABLE'],
      ['mistyped principal', true, 'UPSTREAM_UNAVAILABLE'],
    ])('rejects a matched Space recipient classified as %s', async (_kind, principalType, code) => {
      vi.mocked(postCliService).mockResolvedValueOnce(directoryResult('target', principalType))
      await expect(grant(request('target', role), response())).rejects.toMatchObject({ code })
      expect(transaction).not.toHaveBeenCalled()
      expect(refreshAndPublish).not.toHaveBeenCalled()
    })

    it('requires the directory response to carry a principal type', async () => {
      vi.mocked(postCliService).mockResolvedValueOnce({
        status: 200, body: { data: { user: { user_id: 'target' }, space: { space_id: 's1' } } },
      })
      await expect(grant(request('target', role), response())).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' })
      expect(transaction).not.toHaveBeenCalled()
      expect(refreshAndPublish).not.toHaveBeenCalled()
    })
  })

  it.each(grants)('rejects %s to self after admin is revoked during identity lookup', async (_name, grant, role) => {
    vi.mocked(postCliService).mockImplementationOnce(async () => {
      members.delete('admin@s1')
      meta.permission_epoch += 1
      return directoryResult('admin')
    })
    const res = response()
    await expect(grant(request('admin', role), res)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
    expect(members.has('admin@s1')).toBe(false)
    expect(meta.permission_epoch).toBe(8)
    expect(notifications).toEqual([])
    expect(tx.execute).not.toHaveBeenCalled()
    expect(tx.query.mock.calls.some(([sql]) => String(sql).startsWith('INSERT'))).toBe(false)
    expect(refreshAndPublish).not.toHaveBeenCalled()
    expect(res.json).not.toHaveBeenCalled()
  })

  it.each(grants)('rejects %s when the epoch changes while the actor remains admin', async (_name, grant, role) => {
    vi.mocked(postCliService).mockImplementationOnce(async () => {
      meta.permission_epoch += 1
      return directoryResult('target')
    })
    await expect(grant(request('target', role), response())).rejects.toMatchObject({
      code: 'CONFLICT', details: { reason: 'epoch_changed' },
    })
    expect(members.has('target@s1')).toBe(false)
    expect(refreshAndPublish).not.toHaveBeenCalled()
  })

  it('rejects a role downgrade even before the revocation epoch is updated', async () => {
    vi.mocked(postCliService).mockImplementationOnce(async () => {
      members.set('admin@s1', 1)
      return directoryResult('admin')
    })
    await expect(setCliMember(request('admin', 'admin'), response())).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(members.get('admin@s1')).toBe(1)
    expect(meta.permission_epoch).toBe(7)
  })

  it('commits a grant, notification and epoch together before publishing', async () => {
    const res = response()
    await setCliMember(request(), res)
    expect(members.get('target@s1')).toBe(2)
    expect(notifications).toEqual(['target'])
    expect(meta.permission_epoch).toBe(8)
    expect(events).toEqual(['commit', 'publish'])
    expect(res.json).toHaveBeenCalledWith({ ok: true, created: true, notified: true })
    const reads = tx.query.mock.calls
    expect(reads[0]![0]).toContain('doc_meta WHERE doc_id = ? FOR UPDATE')
    expect(reads[1]![0]).toContain('doc_member WHERE doc_id = ? AND uid = ? AND principal_space_id = ? LIMIT 1 FOR UPDATE')
    expect(query).not.toHaveBeenCalled()
    expect(refreshAndPublish).toHaveBeenCalledWith(doc.document_name, 8, 'target')
  })

  it.each(['INSERT INTO doc_member_notification', 'UPDATE doc_meta SET permission_epoch'])('rolls back all grant effects if %s fails', async statement => {
    failWrite = statement
    await expect(setCliMember(request(), response())).rejects.toThrow('write failed')
    expect(members.has('target@s1')).toBe(false)
    expect(notifications).toEqual([])
    expect(meta.permission_epoch).toBe(7)
    expect(events).toEqual(['rollback'])
  })

  it('updates an existing member without creating another notification', async () => {
    members.set('target@s1', 2)
    const res = response()
    await setCliMember(request('target', 'reader'), res)
    expect(members.get('target@s1')).toBe(1)
    expect(notifications).toEqual([])
    expect(res.json).toHaveBeenCalledWith({ ok: true, created: false, notified: false })
  })

  it.each([
    [1, 'commenter', 4, true],
    [2, 'commenter', 2, false],
    [4, 'writer', 2, true],
    [3, 'reader', 3, false],
  ] as const)('preserves forward only-up semantics from role %s to %s', async (current, grant, expected, changed) => {
    members.set('target@s1', current)
    const res = response()
    await forwardCliGrant(request('target', grant), res)
    expect(members.get('target@s1')).toBe(expected)
    expect(meta.permission_epoch).toBe(changed ? 8 : 7)
    expect(res.json).toHaveBeenCalledWith({ ok: true, role: roleFromNumber(expected), changed })
    expect(events).toEqual(changed ? ['commit', 'publish'] : ['commit'])
  })

  it('rejects member removal after the caller loses admin', async () => {
    members.set('target@s1', 1)
    vi.mocked(requireDocRole).mockImplementationOnce(async () => {
      const authorized = { ...meta }
      members.delete('admin@s1')
      meta.permission_epoch += 1
      return { meta: authorized, role: 'admin' }
    })
    await expect(removeCliMember(request(), response())).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(members.get('target@s1')).toBe(1)
    expect(refreshAndPublish).not.toHaveBeenCalled()
  })

  it('removes a member and publishes its transaction epoch', async () => {
    members.set('target@s1', 1)
    const res = response()
    await removeCliMember(request(), res)
    expect(members.has('target@s1')).toBe(false)
    expect(meta.permission_epoch).toBe(8)
    expect(events).toEqual(['commit', 'publish'])
    expect(res.json).toHaveBeenCalledWith({ ok: true, removedUids: ['target'] })
  })

  it.each(['owner', 'admin'])('protects removal of %s', async uid => {
    await expect(removeCliMember(request(uid), response())).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(meta.permission_epoch).toBe(7)
  })
})
