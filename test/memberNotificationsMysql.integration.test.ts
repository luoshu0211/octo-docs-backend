import '../src/config/loadEnv.ts'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closePool, getPool, query, transaction } from '../src/db/pool.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import { docMemberNotificationRepo } from '../src/db/repos/docMemberNotificationRepo.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'

const mysqlDescribe = process.env.RUN_MEMBER_NOTIFICATION_MYSQL_TESTS === '1' ? describe.sequential : describe.skip
const principal = { recipientUid: 'recipient', recipientSpaceId: 'space' }
const grant = (docId: string, uid = principal.recipientUid, principalSpaceId = principal.recipientSpaceId) => ({
  docId, uid, principalSpaceId, roleNum: 2, grantedBy: 'admin', notifyRecipient: true,
})
async function document(docId: string) {
  await query(`INSERT INTO doc_meta (doc_id, document_name, owner_id, owner_space_id, space_id, created_by)
    VALUES (?, ?, 'admin', 'space', 'space', 'admin')`, [docId, `octo:space:f_default:${docId}`])
}

mysqlDescribe('member notifications against isolated MySQL 8', () => {
  beforeAll(async () => {
    // This suite intentionally truncates its fixtures: never run against a shared database.
    if (!process.env.MYSQL_DATABASE?.startsWith('member_notification_test_')) throw new Error('isolated test database required')
    const schema = readFileSync(new URL('../migrations/schema.sql', import.meta.url), 'utf8')
    for (const table of ['doc_meta', 'doc_member', 'doc_member_notification', 'doc_library_event']) {
      const sql = schema.match(new RegExp(`CREATE TABLE ${table} \\([\\s\\S]*?\\) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`))?.[0]
      if (!sql) throw new Error(`missing schema: ${table}`)
      await query(sql)
    }
    const [rows] = await getPool().query('SELECT @@transaction_isolation AS isolation_level')
    expect((rows as Array<{ isolation_level: string }>)[0]?.isolation_level).toBe('REPEATABLE-READ')
  })
  beforeEach(async () => {
    for (const table of ['doc_library_event', 'doc_member_notification', 'doc_member', 'doc_meta']) await query(`TRUNCATE TABLE ${table}`)
  })
  afterAll(async () => { await closePool() })

  it('reproduces the old absent-member lock deadlock with two real connections', async () => {
    const connections = await Promise.all([getPool().getConnection(), getPool().getConnection()])
    try {
      for (const connection of connections) {
        await connection.beginTransaction()
        await connection.query("SELECT 1 FROM doc_member WHERE doc_id='old' AND uid='recipient' AND principal_space_id='space' FOR UPDATE")
      }
      const results = await Promise.allSettled(connections.map(async connection => {
        try {
          await connection.query("INSERT INTO doc_member (doc_id,uid,principal_space_id,role,granted_by) VALUES ('old','recipient','space',2,'admin') ON DUPLICATE KEY UPDATE role=2")
          await connection.commit()
        } catch (error) { await connection.rollback(); throw error }
      }))
      expect(results.some(result => result.status === 'rejected' && result.reason.code === 'ER_LOCK_DEADLOCK')).toBe(true)
    } finally {
      for (const connection of connections) { await connection.rollback(); connection.release() }
    }
  })

  it('commits simultaneous first additions once and preserves the original reminder on role edits', async () => {
    for (let i = 0; i < 24; i += 1) {
      const docId = `same_${i}`
      await document(docId)
      const results = await Promise.all(Array.from({ length: 3 }, () => docMemberRepo.upsertDirectWithNotification(grant(docId))))
      expect(results.filter(result => result.created)).toHaveLength(1)
      const before = await query<{ event_at: Date }>('SELECT event_at FROM doc_member_notification WHERE doc_id=?', [docId])
      expect(before).toHaveLength(1)
      await docMemberNotificationRepo.markRead({ ...principal, docId })
      expect(await docMemberRepo.upsertDirectWithNotification({ ...grant(docId), roleNum: 1 })).toEqual({ created: false })
      const after = await query<{ event_at: Date; read_at: Date }>('SELECT event_at, read_at FROM doc_member_notification WHERE doc_id=?', [docId])
      expect(after[0]?.event_at).toEqual(before[0]?.event_at)
      expect(after[0]?.read_at).not.toBeNull()
      expect(await query('SELECT kind, previous_role, new_role FROM doc_library_event WHERE doc_id=?', [docId]))
        .toEqual([{ kind: 'member_role_changed', previous_role: 2, new_role: 1 }])
    }
  }, 30_000)

  it('commits distinct first additions that share an index gap', async () => {
    await document('batch')
    for (let round = 0; round < 16; round += 1) {
      const results = await Promise.all(Array.from({ length: 4 }, (_, i) => docMemberRepo.upsertDirectWithNotification(grant('batch', `user_${round}_${i}`))))
      expect(results.every(result => result.created)).toBe(true)
    }
    expect(await query('SELECT 1 FROM doc_member_notification')).toHaveLength(64)
  }, 30_000)

  it('rolls back a transactional role change if its library event fails', async () => {
    await document('role_event')
    await docMemberRepo.upsertDirectWithNotification(grant('role_event'))
    await getPool().query("CREATE TRIGGER fail_role_event BEFORE INSERT ON doc_library_event FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='forced event failure'")
    try {
      await expect(transaction(tx => docMemberRepo.upsertDirectWithNotificationTx(tx, {
        ...grant('role_event'), roleNum: 1,
      }))).rejects.toThrow('forced event failure')
      expect(await docMemberRepo.getRole('role_event', principal.recipientUid, principal.recipientSpaceId)).toBe('writer')
    } finally { await getPool().query('DROP TRIGGER fail_role_event') }
  })

  it('drops the member-added unread badge when the doc is soft-deleted, exactly once (§3.3)', async () => {
    await document('deleted_doc')
    await document('kept_doc')
    await docMemberRepo.upsertDirectWithNotification(grant('deleted_doc'))
    await docMemberRepo.upsertDirectWithNotification(grant('kept_doc'))
    expect((await docMemberNotificationRepo.listUnread(principal)).unreadCount).toBe(2)

    await docMetaRepo.softDelete('deleted_doc')
    const afterDelete = await docMemberNotificationRepo.listUnread(principal)
    expect(afterDelete.unreadCount).toBe(1)
    expect(afterDelete.rows.map((row) => row.doc_id)).toEqual(['kept_doc'])
    // The reminder row itself is consumed, not merely filtered by status=1.
    expect(await query('SELECT 1 FROM doc_member_notification WHERE doc_id=?', ['deleted_doc'])).toHaveLength(0)
    expect(await query<{ deleted_at: Date | null }>('SELECT deleted_at FROM doc_meta WHERE doc_id=?', ['deleted_doc']))
      .toEqual([{ deleted_at: expect.any(Date) }])

    // Re-entrant: a repeated delete changes neither the count nor the row.
    await docMetaRepo.softDelete('deleted_doc')
    expect((await docMemberNotificationRepo.listUnread(principal)).unreadCount).toBe(1)
    expect(await query('SELECT deleted_at FROM doc_meta WHERE doc_id=?', ['deleted_doc']))
      .toHaveLength(1)
  })

  it('returns a consistent count while additions commit, including totals above the page limit', async () => {
    const writer = (async () => {
      for (let i = 0; i < 105; i += 1) {
        await document(`count_${i}`)
        await docMemberRepo.upsertDirectWithNotification(grant(`count_${i}`))
      }
    })()
    for (let i = 0; i < 120; i += 1) {
      const result = await docMemberNotificationRepo.listUnread({ ...principal, limit: 100 })
      expect(result.rows).toHaveLength(Math.min(100, result.unreadCount))
    }
    await writer
    const result = await docMemberNotificationRepo.listUnread({ ...principal, limit: 100 })
    expect(result.unreadCount).toBe(105)
    expect(result.rows).toHaveLength(100)
    expect(await docMemberNotificationRepo.listUnread({ ...principal, recipientSpaceId: 'other' })).toEqual({ unreadCount: 0, rows: [] })
  }, 30_000)

  it.each(['link', 'forward'] as const)('does not resurrect a removed reminder after a %s grant', async mode => {
    await document('regrant')
    await docMemberRepo.upsertDirectWithNotification(grant('regrant'))
    await docMemberRepo.removePrincipalExact({ docId: 'regrant', uid: principal.recipientUid, principalSpaceId: principal.recipientSpaceId })
    expect(await query('SELECT 1 FROM doc_member_notification')).toHaveLength(0)
    if (mode === 'link') await transaction(tx => docMemberRepo.upsertFromInviteTx(tx, { ...grant('regrant'), inviteToken: 'test-link' }))
    else await docMemberRepo.upsertGrantMax(grant('regrant'))
    expect(await docMemberRepo.getRole('regrant', principal.recipientUid, principal.recipientSpaceId)).toBe('writer')
    expect(await docMemberNotificationRepo.listUnread(principal)).toEqual({ unreadCount: 0, rows: [] })
    await docMemberRepo.removePrincipalExact({ docId: 'regrant', uid: principal.recipientUid, principalSpaceId: principal.recipientSpaceId })
    expect(await docMemberRepo.upsertDirectWithNotification(grant('regrant'))).toEqual({ created: true })
    expect((await docMemberNotificationRepo.listUnread(principal)).unreadCount).toBe(1)
  })

  it('clears cascade reminders without deleting another Space or document, including historical orphans', async () => {
    await document('cascade'); await document('untouched')
    await docMemberRepo.upsertDirectWithNotification(grant('cascade'))
    await docMemberRepo.upsertDirectWithNotification(grant('cascade', 'bot'))
    await docMemberRepo.upsertDirectWithNotification(grant('cascade', principal.recipientUid, 'other'))
    await docMemberRepo.upsertDirectWithNotification(grant('untouched'))
    await query("DELETE FROM doc_member WHERE doc_id='cascade' AND uid='bot'")
    await docMemberRepo.removePrincipalWithBots({ docId: 'cascade', uid: principal.recipientUid, principalSpaceId: 'space', botUids: ['bot'] })
    const remaining = await query<{ doc_id: string; recipient_space_id: string }>('SELECT doc_id, recipient_space_id FROM doc_member_notification ORDER BY doc_id')
    expect(remaining).toEqual([{ doc_id: 'cascade', recipient_space_id: 'other' }, { doc_id: 'untouched', recipient_space_id: 'space' }])
  })

  it('rolls back reminder deletion if membership deletion fails', async () => {
    await document('rollback')
    await docMemberRepo.upsertDirectWithNotification(grant('rollback'))
    await getPool().query("CREATE TRIGGER fail_member_delete BEFORE DELETE ON doc_member FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='forced failure'")
    try {
      await expect(docMemberRepo.removePrincipalExact({ docId: 'rollback', uid: principal.recipientUid, principalSpaceId: 'space' })).rejects.toThrow('forced failure')
      expect((await docMemberNotificationRepo.listUnread(principal)).unreadCount).toBe(1)
    } finally { await getPool().query('DROP TRIGGER fail_member_delete') }
  })
})
