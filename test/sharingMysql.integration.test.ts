import path from 'node:path'
import '../src/config/loadEnv.ts'
import mysql, { type Connection } from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { connectionMigrationDb, loadMigrationFiles, runMigrations } from '../src/db/migrate.js'

const enabled = process.env.RUN_SHARING_MYSQL_TESTS === '1'
const migrationDatabase = process.env.SHARING_MIGRATION_TEST_DATABASE ?? 'octo_docs_share_migration_test'
const spaceQualifiedDatabase = process.env.SPACE_QUALIFIED_MIGRATION_TEST_DATABASE ?? 'octo_docs_space_qualified_migration_test'
const concurrencyDatabase = process.env.SHARING_CONCURRENCY_TEST_DATABASE ?? 'octo_docs_share_concurrency_test'
const legacyHtmlGrantsDatabase = process.env.LEGACY_HTML_GRANTS_TEST_DATABASE ?? spaceQualifiedDatabase

function connectionOptions(database: string) {
  return {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? 'octo_docs',
    password: process.env.MYSQL_PASSWORD ?? 'octo_docs',
    database,
    multipleStatements: false,
  }
}

async function resetLegacyDocMeta(conn: Connection): Promise<void> {
  await conn.query('DROP TABLE IF EXISTS schema_migrations')
  await conn.query('DROP TABLE IF EXISTS schema_migration_markers')
  await conn.query('DROP TABLE IF EXISTS doc_meta')
  await conn.query(`
    CREATE TABLE doc_meta (
      doc_id VARCHAR(64) NOT NULL PRIMARY KEY,
      document_name VARCHAR(256) NOT NULL,
      share_scope TINYINT NOT NULL DEFAULT 0,
      share_role TINYINT NOT NULL DEFAULT 1,
      permission_epoch BIGINT NOT NULL DEFAULT 0,
      CONSTRAINT chk_doc_meta_share_scope CHECK (share_scope IN (0,1)),
      CONSTRAINT chk_doc_meta_share_role CHECK (share_role IN (1,2))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

async function sharingMigrations() {
  const dir = path.resolve(process.cwd(), 'migrations/upgrades')
  const files = await loadMigrationFiles(dir)
  return files.filter((file) =>
    file.filename === '2026-08-16-capture-sharing-discovery-phase.sql'
    || file.filename === '2026-08-17-expand-doc-sharing.sql'
    || file.filename === '2026-08-18-convert-doc-sharing-policies.sql')
}

async function applySharingMigrations(conn: Connection): Promise<void> {
  const db = connectionMigrationDb(conn)
  await runMigrations(db, await sharingMigrations(), { lockTimeoutSeconds: 5 })
}

const mysqlDescribe = enabled ? describe.sequential : describe.skip

mysqlDescribe('sharing migrations against real MySQL', () => {
  let conn: Connection

  beforeAll(async () => {
    conn = await mysql.createConnection(connectionOptions(migrationDatabase))
  })

  afterAll(async () => {
    await conn?.end()
  })

  it('final schema with existing administrator data survives empty-ledger adoption', async () => {
    await conn.query('DROP TABLE IF EXISTS schema_migrations')
    await conn.query('DROP TABLE IF EXISTS schema_migration_markers')
    await conn.query('DROP TABLE IF EXISTS doc_meta')
    await conn.query(`
      CREATE TABLE doc_meta (
        doc_id VARCHAR(64) NOT NULL PRIMARY KEY,
        document_name VARCHAR(256) NOT NULL,
        share_scope TINYINT NOT NULL DEFAULT 0,
        share_role TINYINT NOT NULL DEFAULT 1,
        permission_epoch BIGINT NOT NULL DEFAULT 0,
        discoverability_scope TINYINT NOT NULL DEFAULT 0,
        CONSTRAINT chk_doc_meta_share_scope CHECK (share_scope IN (0,1,2)),
        CONSTRAINT chk_doc_meta_share_role CHECK (share_role IN (1,2,4))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    await conn.query(
      "INSERT INTO doc_meta(doc_id,document_name,share_scope,share_role,discoverability_scope) VALUES ('admin-hidden','octo:s:f:admin-hidden',1,4,0)",
    )
    await applySharingMigrations(conn)
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      "SELECT discoverability_scope, share_role FROM doc_meta WHERE doc_id='admin-hidden'",
    )
    expect(rows[0]?.discoverability_scope).toBe(0)
    expect(rows[0]?.share_role).toBe(4)
    const [markers] = await conn.query<mysql.RowDataPacket[]>(
      "SELECT marker_value FROM schema_migration_markers WHERE marker_key='sharing_discovery_backfill_v1'",
    )
    expect(markers[0]?.marker_value).toBe('preserve')
  })

  it('backfills historical anyone-in-Space docs on first introduction but not private docs', async () => {
    await resetLegacyDocMeta(conn)
    await conn.query(`
      INSERT INTO doc_meta(doc_id,document_name,share_scope) VALUES
      ('old-open','octo:s:f:old-open',1),
      ('old-private','octo:s:f:old-private',0)
    `)
    await applySharingMigrations(conn)
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      'SELECT doc_id, discoverability_scope FROM doc_meta ORDER BY doc_id',
    )
    expect(rows).toEqual([
      expect.objectContaining({ doc_id: 'old-open', discoverability_scope: 1 }),
      expect.objectContaining({ doc_id: 'old-private', discoverability_scope: 0 }),
    ])
  })

  it('backfills every historical anyone-in-Space row regardless of draft boolean state', async () => {
    await resetLegacyDocMeta(conn)
    await conn.query('ALTER TABLE doc_meta ADD COLUMN space_searchable TINYINT(1) NOT NULL DEFAULT 0')
    await conn.query(`
      INSERT INTO doc_meta(doc_id,document_name,share_scope,space_searchable) VALUES
      ('visible','octo:s:f:visible',1,1),
      ('hidden','octo:s:f:hidden',1,0)
    `)
    await applySharingMigrations(conn)
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      'SELECT doc_id, discoverability_scope FROM doc_meta ORDER BY doc_id',
    )
    expect(rows).toEqual([
      expect.objectContaining({ doc_id: 'hidden', discoverability_scope: 1 }),
      expect.objectContaining({ doc_id: 'visible', discoverability_scope: 1 }),
    ])
  })

  it('keeps a partially migrated enum authoritative', async () => {
    await resetLegacyDocMeta(conn)
    await conn.query('ALTER TABLE doc_meta ADD COLUMN discoverability_scope TINYINT NOT NULL DEFAULT 0')
    await conn.query("INSERT INTO doc_meta(doc_id,document_name,share_scope,discoverability_scope) VALUES ('partial','octo:s:f:partial',1,1)")
    await applySharingMigrations(conn)
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      "SELECT discoverability_scope FROM doc_meta WHERE doc_id='partial'",
    )
    expect(rows[0]?.discoverability_scope).toBe(1)
  })

  it('repeat execution never re-enables a value an admin turned off', async () => {
    await resetLegacyDocMeta(conn)
    await conn.query("INSERT INTO doc_meta(doc_id,document_name,share_scope) VALUES ('old-open','octo:s:f:old-open',1)")
    const files = await sharingMigrations()
    const db = connectionMigrationDb(conn)
    await runMigrations(db, files, { lockTimeoutSeconds: 5 })
    await conn.query("UPDATE doc_meta SET discoverability_scope=0 WHERE doc_id='old-open'")
    // Model the runner's at-least-once window: the predecessor is already recorded, while the
    // successor's DDL committed but its ledger insert was lost. Only the successor re-executes.
    await conn.query("DELETE FROM schema_migrations WHERE filename='2026-08-18-convert-doc-sharing-policies.sql'")
    await runMigrations(db, files, { lockTimeoutSeconds: 5 })
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      "SELECT discoverability_scope FROM doc_meta WHERE doc_id='old-open'",
    )
    expect(rows[0]?.discoverability_scope).toBe(0)
  })
})

mysqlDescribe('Space-qualified permission migration against real MySQL', () => {
  let conn: Connection

  beforeAll(async () => {
    conn = await mysql.createConnection(connectionOptions(spaceQualifiedDatabase))
  })

  afterAll(async () => {
    await conn?.end()
  })

  it('backfills authoritative Spaces, enforces NOT NULL, and installs compound primary keys', async () => {
    await conn.query('DROP TABLE IF EXISTS schema_migrations')
    await conn.query('DROP TABLE IF EXISTS doc_invite_redemption')
    await conn.query('DROP TABLE IF EXISTS doc_invite')
    await conn.query('DROP TABLE IF EXISTS doc_access_request')
    await conn.query('DROP TABLE IF EXISTS doc_member')
    await conn.query('DROP TABLE IF EXISTS doc_meta')
    await conn.query(`
      CREATE TABLE doc_meta (
        doc_id VARCHAR(64) NOT NULL PRIMARY KEY,
        owner_id VARCHAR(64) NOT NULL,
        space_id VARCHAR(64) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    await conn.query(`
      CREATE TABLE doc_member (
        doc_id VARCHAR(64) NOT NULL,
        uid VARCHAR(64) NOT NULL,
        role TINYINT NOT NULL,
        PRIMARY KEY(doc_id,uid)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    await conn.query(`
      CREATE TABLE doc_access_request (
        doc_id VARCHAR(64) NOT NULL,
        uid VARCHAR(64) NOT NULL,
        status TINYINT NOT NULL,
        PRIMARY KEY(doc_id,uid)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    await conn.query(`
      CREATE TABLE doc_invite (
        invite_token VARCHAR(64) NOT NULL PRIMARY KEY,
        doc_id VARCHAR(64) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    await conn.query(`
      CREATE TABLE doc_invite_redemption (
        invite_token VARCHAR(64) NOT NULL,
        uid VARCHAR(64) NOT NULL,
        PRIMARY KEY(invite_token,uid)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    await conn.query("INSERT INTO doc_meta(doc_id,owner_id,space_id) VALUES ('d1','owner','space-a')")
    await conn.query("INSERT INTO doc_member(doc_id,uid,role) VALUES ('d1','member',1)")
    await conn.query("INSERT INTO doc_access_request(doc_id,uid,status) VALUES ('d1','requester',0)")
    await conn.query("INSERT INTO doc_invite(invite_token,doc_id) VALUES ('invite-1','d1')")
    await conn.query("INSERT INTO doc_invite_redemption(invite_token,uid) VALUES ('invite-1','invitee')")

    const files = await loadMigrationFiles(path.resolve(process.cwd(), 'migrations/upgrades'))
    const migration = files.filter((file) => file.filename === '2026-08-13-space-qualified-permissions.sql')
    await runMigrations(connectionMigrationDb(conn), migration, { lockTimeoutSeconds: 5 })

    const [meta] = await conn.query<mysql.RowDataPacket[]>("SELECT owner_space_id FROM doc_meta WHERE doc_id='d1'")
    expect(meta[0]?.owner_space_id).toBe('space-a')
    for (const [table, expectedKey] of [
      ['doc_member', 'doc_id,uid,principal_space_id'],
      ['doc_access_request', 'doc_id,uid,principal_space_id'],
      ['doc_invite_redemption', 'invite_token,uid,principal_space_id'],
    ] as const) {
      const [columns] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT is_nullable AS nullable_state FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name='principal_space_id'`,
        [table],
      )
      expect(columns[0]?.nullable_state).toBe('NO')
      const [keys] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',') AS key_columns
           FROM information_schema.statistics
          WHERE table_schema=DATABASE() AND table_name=? AND index_name='PRIMARY'`,
        [table],
      )
      expect(keys[0]?.key_columns).toBe(expectedKey)
    }
    const [spaces] = await conn.query<mysql.RowDataPacket[]>(`
      SELECT principal_space_id FROM doc_member WHERE doc_id='d1'
      UNION ALL SELECT principal_space_id FROM doc_access_request WHERE doc_id='d1'
      UNION ALL SELECT principal_space_id FROM doc_invite_redemption WHERE invite_token='invite-1'
    `)
    expect(spaces.map((row) => row.principal_space_id)).toEqual(['space-a', 'space-a', 'space-a'])

    await conn.query("INSERT INTO doc_member(doc_id,uid,principal_space_id,role) VALUES ('d1','member','space-b',1)")
    const [members] = await conn.query<mysql.RowDataPacket[]>("SELECT principal_space_id FROM doc_member WHERE doc_id='d1' AND uid='member' ORDER BY principal_space_id")
    expect(members.map((row) => row.principal_space_id)).toEqual(['space-a', 'space-b'])
  })
})

vi.mock('../src/api/guard.js', () => ({ requireDocRole: vi.fn() }))
vi.mock('../src/permission/epoch.js', () => ({
  refreshAndPublish: vi.fn(async () => undefined),
  bumpEpoch: vi.fn(),
}))

mysqlDescribe('legacy HTML grants migration against real MySQL', () => {
  let conn: Connection

  beforeAll(async () => {
    conn = await mysql.createConnection(connectionOptions(legacyHtmlGrantsDatabase))
  })

  afterAll(async () => {
    await conn?.end()
  })

  it('copies only safe missing grants into the document Home Space and reruns as a no-op', async () => {
    await conn.query('DROP TABLE IF EXISTS schema_migrations')
    await conn.query('DROP TABLE IF EXISTS schema_migration_markers')
    await conn.query('DROP TABLE IF EXISTS doc_member')
    await conn.query('DROP TABLE IF EXISTS doc_meta')
    await conn.query('DROP TABLE IF EXISTS meta')
    await conn.query(`
      CREATE TABLE doc_meta (
        doc_id VARCHAR(64) NOT NULL PRIMARY KEY,
        owner_id VARCHAR(64) NOT NULL,
        space_id VARCHAR(64) NOT NULL,
        doc_type VARCHAR(32) NOT NULL,
        octo_doc_slug VARCHAR(128) NULL,
        status TINYINT NOT NULL DEFAULT 1,
        permission_epoch BIGINT NOT NULL DEFAULT 0
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    await conn.query(`
      CREATE TABLE doc_member (
        doc_id VARCHAR(64) NOT NULL,
        uid VARCHAR(64) NOT NULL,
        principal_space_id VARCHAR(64) NOT NULL,
        role TINYINT NOT NULL,
        granted_by VARCHAR(64) NOT NULL,
        source TINYINT NOT NULL DEFAULT 1,
        invite_token VARCHAR(64) NOT NULL DEFAULT '',
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY(doc_id,uid,principal_space_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    await conn.query(`
      CREATE TABLE meta (
        slug VARCHAR(255) NOT NULL PRIMARY KEY,
        json JSON NOT NULL,
        updated_at BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    await conn.query(`
      INSERT INTO doc_meta(doc_id,owner_id,space_id,doc_type,octo_doc_slug,status,permission_epoch) VALUES
      ('d1','owner','space-a','html','legacy-slug',1,5),
      ('d2','owner-2','space-b','html','canonical-slug',1,7),
      ('d-deleted','owner','space-a','html','deleted-slug',0,9)
    `)
    await conn.query(`
      INSERT INTO doc_member(doc_id,uid,principal_space_id,role,granted_by,source,invite_token)
      VALUES ('d1','existing','space-a',2,'current-admin',1,'')
    `)
    await conn.query(
      `INSERT INTO meta(slug,json,updated_at) VALUES
       ('legacy-slug', ?, 1),
       ('canonical-slug', ?, 1),
       ('deleted-slug', ?, 1)`,
      [
        JSON.stringify({
          slug: 'legacy-slug', space_id: 'space-a', creator_uid: 'owner',
          grants: {
            reader: { role: 'reader', granted_by: 'grantor' },
            commenter: { role: 'commenter', granted_by: 'grantor' },
            writer: { role: 'writer', granted_by: 'grantor' },
            existing: { role: 'reader', granted_by: 'legacy-grantor' },
            owner: { role: 'reader', granted_by: 'grantor' },
            invalid: { role: 'admin', granted_by: 'grantor' },
          },
        }),
        JSON.stringify({
          slug: 'canonical-slug', canonical_doc_id: 'd2', creator_uid: 'owner-2',
          grants: { canonicalReader: { role: 'reader', granted_by: '' } },
        }),
        JSON.stringify({
          slug: 'deleted-slug', space_id: 'space-a',
          grants: { deletedReader: { role: 'reader', granted_by: 'grantor' } },
        }),
      ],
    )

    const files = await loadMigrationFiles(path.resolve(process.cwd(), 'migrations/upgrades'))
    const migration = files.filter((file) => file.filename === '2026-08-21-migrate-legacy-html-grants.sql')
    expect(migration).toHaveLength(1)
    const db = connectionMigrationDb(conn)
    await runMigrations(db, migration, { lockTimeoutSeconds: 5 })

    const [members] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT doc_id,uid,principal_space_id,role,granted_by
       FROM doc_member ORDER BY doc_id,uid,principal_space_id`,
    )
    expect(members).toEqual([
      expect.objectContaining({ doc_id: 'd1', uid: 'commenter', principal_space_id: 'space-a', role: 4, granted_by: 'grantor' }),
      expect.objectContaining({ doc_id: 'd1', uid: 'existing', principal_space_id: 'space-a', role: 2, granted_by: 'current-admin' }),
      expect.objectContaining({ doc_id: 'd1', uid: 'reader', principal_space_id: 'space-a', role: 1, granted_by: 'grantor' }),
      expect.objectContaining({ doc_id: 'd1', uid: 'writer', principal_space_id: 'space-a', role: 2, granted_by: 'grantor' }),
      expect.objectContaining({ doc_id: 'd2', uid: 'canonicalReader', principal_space_id: 'space-b', role: 1, granted_by: 'owner-2' }),
    ])
    const [epochs] = await conn.query<mysql.RowDataPacket[]>(
      'SELECT doc_id,permission_epoch FROM doc_meta ORDER BY doc_id',
    )
    expect(epochs).toEqual([
      expect.objectContaining({ doc_id: 'd-deleted', permission_epoch: 9 }),
      expect.objectContaining({ doc_id: 'd1', permission_epoch: 6 }),
      expect.objectContaining({ doc_id: 'd2', permission_epoch: 8 }),
    ])

    // Simulate a legitimate post-migration revoke followed by loss of only the
    // runner ledger. The durable business marker must prevent stale meta.grants
    // from resurrecting the revoked principal.
    await conn.query("DELETE FROM doc_member WHERE doc_id='d1' AND uid='reader' AND principal_space_id='space-a'")
    await conn.query("DELETE FROM schema_migrations WHERE filename='2026-08-21-migrate-legacy-html-grants.sql'")
    await runMigrations(db, migration, { lockTimeoutSeconds: 5 })
    const [rerunMembers] = await conn.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS count FROM doc_member')
    expect(Number(rerunMembers[0]?.count)).toBe(4)
    const [revoked] = await conn.query<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM doc_member WHERE doc_id='d1' AND uid='reader' AND principal_space_id='space-a'",
    )
    expect(Number(revoked[0]?.count)).toBe(0)
    const [rerunEpochs] = await conn.query<mysql.RowDataPacket[]>(
      'SELECT doc_id,permission_epoch FROM doc_meta ORDER BY doc_id',
    )
    expect(rerunEpochs).toEqual(epochs)

    const [legacy] = await conn.query<mysql.RowDataPacket[]>(
      "SELECT JSON_CONTAINS_PATH(json, 'one', '$.grants') AS keeps_grants FROM meta ORDER BY slug",
    )
    expect(legacy.every((row) => Number(row.keeps_grants) === 1)).toBe(true)
  })
})

mysqlDescribe('share-setting CAS against real MySQL', () => {
  let conn: Connection

  beforeAll(async () => {
    // The repository pool reads MYSQL_DATABASE when it is first imported below; point it at the
    // disposable CAS database while the direct setup connection uses the same target explicitly.
    process.env.MYSQL_DATABASE = concurrencyDatabase
    conn = await mysql.createConnection(connectionOptions(concurrencyDatabase))
    await conn.query('DROP TABLE IF EXISTS doc_meta')
    await conn.query(`
      CREATE TABLE doc_meta (
        doc_id VARCHAR(64) NOT NULL PRIMARY KEY,
        document_name VARCHAR(256) NOT NULL,
        share_scope TINYINT NOT NULL DEFAULT 0,
        share_role TINYINT NOT NULL DEFAULT 1,
        discoverability_scope TINYINT NOT NULL DEFAULT 0,
        permission_epoch BIGINT NOT NULL DEFAULT 7
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    await conn.query("INSERT INTO doc_meta(doc_id,document_name) VALUES ('d_race','octo:s:f:d_race')")
  })

  afterAll(async () => {
    await conn?.end()
    const { closePool } = await import('../src/db/pool.js')
    await closePool()
  })

  it('two simultaneous epoch-N requests yield one 200, one 409, one bump and one invalidation', async () => {
    await conn.query("UPDATE doc_meta SET share_scope=0, share_role=1, discoverability_scope=0, permission_epoch=7 WHERE doc_id='d_race'")
    const { requireDocRole } = await import('../src/api/guard.js')
    const { refreshAndPublish } = await import('../src/permission/epoch.js')
    const { putShareHandler } = await import('../src/api/routes/docs.js')
    vi.mocked(requireDocRole).mockResolvedValue({
      meta: {
        doc_id: 'd_race',
        document_name: 'octo:s:f:d_race',
        share_scope: 0,
        share_role: 1,
        discoverability_scope: 0,
        permission_epoch: 7,
      },
      role: 'admin',
    } as never)
    vi.mocked(refreshAndPublish).mockClear()

    const response = () => ({
      statusCode: 0,
      body: undefined as unknown,
      status(code: number) { this.statusCode = code; return this },
      json(body: unknown) { this.body = body; return this },
    })
    const makeReq = (scope: 'anyone_in_space' | 'authenticated') => ({
      params: { docId: 'd_race' },
      body: { shareScope: scope, shareRole: 'edit', permissionEpoch: 7 },
    }) as never
    const first = response()
    const second = response()
    await Promise.all([
      putShareHandler(makeReq('anyone_in_space'), first as never),
      putShareHandler(makeReq('authenticated'), second as never),
    ])

    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409])
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      "SELECT permission_epoch FROM doc_meta WHERE doc_id='d_race'",
    )
    expect(rows[0]?.permission_epoch).toBe(8)
    expect(vi.mocked(refreshAndPublish)).toHaveBeenCalledTimes(1)
  })
})
