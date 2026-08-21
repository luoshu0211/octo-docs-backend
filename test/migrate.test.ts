import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  connectionMigrationDb,
  loadMigrationFiles,
  runMigrations,
  sha256,
  splitSqlStatements,
  type MigrationConnection,
  type MigrationDb,
} from '../src/db/migrate.js'

class FakeDb implements MigrationDb {
  readonly ledger = new Map<string, string>()
  readonly executed: string[] = []

  async query(sql: string, params: unknown[] = []): Promise<unknown> {
    const normalized = sql.trim().replace(/\s+/g, ' ')
    if (/^SELECT GET_LOCK/i.test(normalized)) return [{ acquired: 1 }]
    if (/^SELECT RELEASE_LOCK/i.test(normalized)) return [{ released: 1 }]
    if (/^CREATE TABLE IF NOT EXISTS schema_migrations/i.test(normalized)) return []
    if (/^SELECT checksum FROM schema_migrations WHERE filename = \?/i.test(normalized)) {
      const filename = String(params[0])
      const checksum = this.ledger.get(filename)
      return checksum ? [{ checksum }] : []
    }
    if (/^INSERT INTO schema_migrations/i.test(normalized)) {
      this.ledger.set(String(params[0]), String(params[1]))
      return []
    }
    this.executed.push(sql.trim())
    return []
  }
}

describe('migration runner', () => {
  it('splits MySQL scripts with DELIMITER blocks', () => {
    const statements = splitSqlStatements(`
CREATE TABLE demo (id INT);
DELIMITER //
CREATE PROCEDURE add_demo()
BEGIN
  INSERT INTO demo VALUES (1);
END //
DELIMITER ;
CALL add_demo();
DROP PROCEDURE add_demo;
`)

    expect(statements).toEqual([
      'CREATE TABLE demo (id INT)',
      'CREATE PROCEDURE add_demo()\nBEGIN\n  INSERT INTO demo VALUES (1);\nEND',
      'CALL add_demo()',
      'DROP PROCEDURE add_demo',
    ])
  })

  it('loads migration files in filename order', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'octo-migrations-'))
    await writeFile(path.join(dir, '2026-07-02-b.sql'), 'SELECT 2;')
    await writeFile(path.join(dir, '2026-07-01-a.sql'), 'SELECT 1;')
    await writeFile(path.join(dir, 'README.md'), 'not sql')

    const files = await loadMigrationFiles(dir)
    expect(files.map((f) => f.filename)).toEqual(['2026-07-01-a.sql', '2026-07-02-b.sql'])
  })

  it('applies new migrations and records checksums', async () => {
    const db = new FakeDb()
    const files = [
      {
        filename: '2026-07-01-a.sql',
        path: '/tmp/a.sql',
        sql: 'SELECT 1;',
        checksum: sha256('SELECT 1;'),
      },
      {
        filename: '2026-07-02-b.sql',
        path: '/tmp/b.sql',
        sql: 'SELECT 2;',
        checksum: sha256('SELECT 2;'),
      },
    ]

    const result = await runMigrations(db, files)
    expect(result).toEqual({
      applied: ['2026-07-01-a.sql', '2026-07-02-b.sql'],
      skipped: [],
    })
    expect(db.executed).toEqual(['SELECT 1', 'SELECT 2'])
    expect(db.ledger.get('2026-07-01-a.sql')).toBe(sha256('SELECT 1;'))
  })

  it('skips an already recorded migration with the same checksum', async () => {
    const db = new FakeDb()
    const sql = 'SELECT 1;'
    db.ledger.set('2026-07-01-a.sql', sha256(sql))

    const result = await runMigrations(db, [
      { filename: '2026-07-01-a.sql', path: '/tmp/a.sql', sql, checksum: sha256(sql) },
    ])

    expect(result).toEqual({ applied: [], skipped: ['2026-07-01-a.sql'] })
    expect(db.executed).toEqual([])
  })

  it('fails fast when an already recorded migration checksum changed', async () => {
    const db = new FakeDb()
    db.ledger.set('2026-07-01-a.sql', sha256('SELECT 1;'))

    await expect(
      runMigrations(db, [
        {
          filename: '2026-07-01-a.sql',
          path: '/tmp/a.sql',
          sql: 'SELECT changed;',
          checksum: sha256('SELECT changed;'),
        },
      ]),
    ).rejects.toThrow(/checksum mismatch/)
    expect(db.executed).toEqual([])
  })
})

// Regression: the FakeDb suite above never feeds the runner the ACTUAL shipped
// migration files, which is how the `DELIMITER`-after-comment crash and the
// `;`-inside-a-comment mis-split slipped past CI. Exercise the real files.
describe('shipped migration files parse cleanly', () => {
  const upgradesDir = fileURLToPath(new URL('../migrations/upgrades', import.meta.url))

  it('splits every real upgrade file without throwing or leaking comments', async () => {
    const files = await loadMigrationFiles(upgradesDir)
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const statements = splitSqlStatements(file.sql)
      expect(statements.length, `${file.filename} produced no statements`).toBeGreaterThan(0)
      for (const statement of statements) {
        const firstCodeLine = statement
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l.length > 0)
        // A statement must start with real SQL, never a stray `--`/`#` comment
        // fragment (which is what the missing comment handling used to emit).
        expect(firstCodeLine, `${file.filename}: empty/comment-only statement`).toBeTruthy()
        expect(
          /^(--|#)/.test(firstCodeLine!),
          `${file.filename}: comment leaked into a statement: ${statement.slice(0, 60)}`,
        ).toBe(false)
      }
    }
  })

  it('handles a comment preamble before DELIMITER and a ; inside a comment', () => {
    const sql = [
      '-- header line 1',
      '-- header line 2 mentions a semicolon; still just a comment',
      '',
      'DELIMITER //',
      'CREATE PROCEDURE p()',
      'BEGIN',
      '  SELECT 1;',
      'END //',
      'DELIMITER ;',
      'CALL p();',
    ].join('\n')
    expect(() => splitSqlStatements(sql)).not.toThrow()
    expect(splitSqlStatements(sql)).toEqual([
      'CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\nEND',
      'CALL p()',
    ])
  })

  it('does not split on a delimiter char inside a string literal or trailing comment', () => {
    expect(splitSqlStatements("INSERT INTO t VALUES ('a;b'); -- trailing; note")).toEqual([
      "INSERT INTO t VALUES ('a;b')",
    ])
  })

  it('keeps the applied sharing-v3 migration byte-for-byte immutable', async () => {
    const files = await loadMigrationFiles(upgradesDir)
    const migration = files.find((f) => f.filename === '2026-08-17-expand-doc-sharing.sql')
    expect(migration).toBeTruthy()
    expect(migration!.checksum).toBe('99b48dbf294177f35fa1918099476e6af6bca1e801220fe15603b46b769d44a1')
    expect(migration!.sql).toMatch(/ADD COLUMN allow_external_applications TINYINT\(1\) NOT NULL DEFAULT 1/)
    expect(migration!.sql).toMatch(/ADD COLUMN space_searchable TINYINT\(1\) NOT NULL DEFAULT 0/)
    expect(migration!.sql).not.toContain('external_application_policy')
    expect(migration!.sql).not.toContain('discoverability_scope')
    expect(() => splitSqlStatements(migration!.sql)).not.toThrow()
  })

  it('captures discovery migration state before draft columns can be recreated', async () => {
    const files = await loadMigrationFiles(upgradesDir)
    const marker = files.find((f) => f.filename === '2026-08-16-capture-sharing-discovery-phase.sql')
    const expandAt = files.findIndex((f) => f.filename === '2026-08-17-expand-doc-sharing.sql')
    const markerAt = files.findIndex((f) => f.filename === '2026-08-16-capture-sharing-discovery-phase.sql')
    expect(marker).toBeTruthy()
    expect(markerAt).toBeGreaterThanOrEqual(0)
    expect(markerAt).toBeLessThan(expandAt)
    expect(marker!.sql).toMatch(/CREATE TABLE IF NOT EXISTS schema_migration_markers/)
    expect(marker!.sql).toMatch(/column_name='discoverability_scope'[\s\S]*'preserve'[\s\S]*'backfill'/)
    expect(() => splitSqlStatements(marker!.sql)).not.toThrow()
  })

  it('finalizes historical discovery and removes abandoned draft controls repeatably', async () => {
    const files = await loadMigrationFiles(upgradesDir)
    const migration = files.find((f) => f.filename === '2026-08-18-convert-doc-sharing-policies.sql')
    expect(migration).toBeTruthy()
    const sql = migration!.sql
    expect(sql).toMatch(/discoverability_scope[\s\S]*DEFAULT 0[\s\S]*0=hidden, 1=space/)
    expect(sql).toMatch(/marker_key='sharing_discovery_backfill_v1' AND marker_value='backfill'/)
    expect(sql).toMatch(/UPDATE doc_meta[\s\S]*discoverability_scope = CASE WHEN share_scope = 1 THEN 1 ELSE 0 END/)
    expect(sql).toMatch(/UPDATE schema_migration_markers[\s\S]*marker_value='preserve'/)
    expect(sql).not.toMatch(/column_name='space_searchable'[\s\S]*UPDATE doc_meta/)
    expect(sql).toMatch(/DROP COLUMN space_searchable/)
    expect(sql).toMatch(/DROP COLUMN allow_external_applications/)
    expect(sql).toMatch(/DROP COLUMN external_application_policy/)
    expect(sql).toMatch(/IF EXISTS[\s\S]*DROP CHECK chk_doc_meta_share_scope/)
    expect(sql).toMatch(/ADD CONSTRAINT chk_doc_meta_share_role CHECK \(share_role IN \(1,2,4\)\)/)
    expect(() => splitSqlStatements(sql)).not.toThrow()
  })
})

// Contract test for rerunning the shipped migration after any DDL phase failed.
describe('legacy HTML grants migration contract', () => {
  const migrationPath = fileURLToPath(
    new URL('../migrations/upgrades/2026-08-21-migrate-legacy-html-grants.sql', import.meta.url),
  )

  it('copies only safe missing grants into the document Home Space without overwriting authority', async () => {
    const sql = await readFile(migrationPath, 'utf8')
    expect(sql).toMatch(/JSON_TYPE\(JSON_EXTRACT\(hm\.json, '\$\.grants'\)\)='OBJECT'/)
    expect(sql).toMatch(/dm\.principal_space_id=dm\.space_id|principal_space_id,role,granted_by/)
    expect(sql).toMatch(/legacy\.role_name IN \('reader','writer','commenter'\)|IN \('reader','writer','commenter'\)/)
    expect(sql).not.toMatch(/WHEN 'admin' THEN/)
    expect(sql).toMatch(/grant_keys\.uid[\s\S]*<>dm\.owner_id/)
    expect(sql).toMatch(/grant_keys\.uid[\s\S]*<>COALESCE\(JSON_UNQUOTE\(JSON_EXTRACT\(hm\.json, '\$\.creator_uid'\)\), ''\)/)
    expect(sql).toMatch(/NOT EXISTS \([\s\S]*existing\.doc_id[\s\S]*=dm\.doc_id[\s\S]*existing\.uid[\s\S]*=grant_keys\.uid[\s\S]*existing\.principal_space_id[\s\S]*=dm\.space_id/)
    expect(sql).toMatch(/INSERT IGNORE INTO doc_member/)
    expect(sql).not.toMatch(/ON DUPLICATE KEY UPDATE role|UPDATE doc_member/)
    expect(sql).not.toMatch(/JSON_REMOVE|JSON_SET\([^\n]*grants/)
    expect(() => splitSqlStatements(sql)).not.toThrow()
  })

  it('is optional-table safe and bumps each changed document epoch once', async () => {
    const sql = await readFile(migrationPath, 'utf8')
    expect(sql).toMatch(/information_schema\.columns[\s\S]*table_name='meta'[\s\S]*column_name='json'/)
    expect(sql).toMatch(/CREATE TEMPORARY TABLE tmp_legacy_html_grants/)
    expect(sql).toMatch(/marker_key='legacy_html_grants_to_space_members_v1'[\s\S]*marker_value='complete'/)
    expect(sql).toMatch(/START TRANSACTION[\s\S]*INSERT IGNORE INTO doc_member[\s\S]*SET dm\.permission_epoch=dm\.permission_epoch\+1[\s\S]*INSERT INTO schema_migration_markers[\s\S]*COMMIT/)
    expect(sql).toMatch(/SELECT DISTINCT doc_id FROM tmp_legacy_html_grants/)
    expect(sql).toMatch(/DROP TEMPORARY TABLE IF EXISTS tmp_legacy_html_grants/)
  })
})

describe('space-qualified permissions migration resumability', () => {
  const migrationPath = fileURLToPath(
    new URL('../migrations/upgrades/2026-08-13-space-qualified-permissions.sql', import.meta.url),
  )

  it('keeps add, backfill, NOT NULL, and primary-key phases independently guarded', async () => {
    const sql = await readFile(migrationPath, 'utf8')
    const tables = [
      {
        table: 'doc_meta',
        column: 'owner_space_id',
        update: /UPDATE doc_meta SET owner_space_id=space_id/,
        primaryKey: undefined,
      },
      {
        table: 'doc_member',
        column: 'principal_space_id',
        update: /UPDATE doc_member dm[\s\S]*?SET dm\.principal_space_id=m\.space_id/,
        primaryKey: 'doc_id,uid,principal_space_id',
      },
      {
        table: 'doc_access_request',
        column: 'principal_space_id',
        update: /UPDATE doc_access_request r[\s\S]*?SET r\.principal_space_id=m\.space_id/,
        primaryKey: 'doc_id,uid,principal_space_id',
      },
      {
        table: 'doc_invite_redemption',
        column: 'principal_space_id',
        update: /UPDATE doc_invite_redemption r[\s\S]*?SET r\.principal_space_id=m\.space_id/,
        primaryKey: 'invite_token,uid,principal_space_id',
      },
    ] as const

    for (const [index, spec] of tables.entries()) {
      const start = sql.indexOf(`-- ${spec.table}.`)
      const end = index + 1 < tables.length ? sql.indexOf(`-- ${tables[index + 1]!.table}.`) : sql.indexOf('END //')
      const section = sql.slice(start, end)

      expect(start, `${spec.table}: section missing`).toBeGreaterThanOrEqual(0)
      expect(section).toMatch(
        new RegExp(
          `IF NOT EXISTS \\([\\s\\S]*?information_schema\\.columns[\\s\\S]*?table_name='${spec.table}'[\\s\\S]*?column_name='${spec.column}'[\\s\\S]*?THEN[\\s\\S]*?ADD COLUMN ${spec.column}[\\s\\S]*?END IF;`,
        ),
      )

      // These assertions are the interrupted-rerun contract: UPDATE and MODIFY
      // occur after the add-column END IF, so an already-present nullable column
      // cannot cause the remaining phases to be skipped.
      const addEnd = section.indexOf('END IF;')
      const updateAt = section.search(spec.update)
      const notNullAt = section.indexOf(`MODIFY ${spec.column} VARCHAR(64) NOT NULL`)
      expect(updateAt, `${spec.table}: backfill missing`).toBeGreaterThan(addEnd)
      expect(notNullAt, `${spec.table}: NOT NULL phase missing`).toBeGreaterThan(updateAt)

      const beforeUpdate = section.slice(addEnd, updateAt)
      expect(beforeUpdate).toContain('information_schema.columns')
      expect(beforeUpdate).toContain(`table_name='${spec.table}'`)
      expect(beforeUpdate).toContain(`column_name='${spec.column}'`)
      expect(beforeUpdate).toContain(`SELECT 1 FROM ${spec.table}`)

      const beforeNotNull = section.slice(updateAt, notNullAt)
      expect(beforeNotNull).toContain('information_schema.columns')
      expect(beforeNotNull).toContain("is_nullable='YES'")

      if (spec.primaryKey) {
        const primaryKeyAt = section.indexOf(`<> '${spec.primaryKey}'`)
        expect(primaryKeyAt, `${spec.table}: primary-key state check missing`).toBeGreaterThan(notNullAt)
        expect(section.slice(notNullAt, primaryKeyAt)).toContain('information_schema.statistics')
        expect(section).toContain(`ADD PRIMARY KEY(${spec.primaryKey})`)
      }
    }
  })

  it('models reruns from every partial state as advancing only the unfinished phases', () => {
    const rerun = (state: { column: boolean; backfilled: boolean; notNull: boolean; primaryKey: boolean }) => {
      const executed: string[] = []
      if (!state.column) {
        executed.push('add-column')
        state.column = true
      }
      if (state.column && !state.backfilled) {
        executed.push('backfill')
        state.backfilled = true
      }
      if (state.column && state.backfilled && !state.notNull) {
        executed.push('not-null')
        state.notNull = true
      }
      if (state.notNull && !state.primaryKey) executed.push('primary-key')
      return executed
    }

    expect(rerun({ column: true, backfilled: false, notNull: false, primaryKey: false })).toEqual([
      'backfill',
      'not-null',
      'primary-key',
    ])
    expect(rerun({ column: true, backfilled: true, notNull: false, primaryKey: false })).toEqual([
      'not-null',
      'primary-key',
    ])
    expect(rerun({ column: true, backfilled: true, notNull: true, primaryKey: false })).toEqual([
      'primary-key',
    ])
    expect(rerun({ column: true, backfilled: true, notNull: true, primaryKey: true })).toEqual([])
  })
})

// Regression for the advisory-lock connection-affinity blocker: GET_LOCK,
// every migration statement, and RELEASE_LOCK must run on ONE connection.
describe('advisory lock connection affinity', () => {
  class RecordingConn implements MigrationConnection {
    readonly log: string[] = []
    private readonly ledger = new Map<string, string>()
    async query(sql: string, params: unknown[] = []): Promise<[unknown, unknown]> {
      this.log.push(sql.trim().replace(/\s+/g, ' ').slice(0, 24))
      const n = sql.trim().replace(/\s+/g, ' ')
      if (/^SELECT GET_LOCK/i.test(n)) return [[{ acquired: 1 }], []]
      if (/^SELECT RELEASE_LOCK/i.test(n)) return [[{ released: 1 }], []]
      if (/^SELECT checksum FROM schema_migrations/i.test(n)) {
        const c = this.ledger.get(String(params[0]))
        return [c ? [{ checksum: c }] : [], []]
      }
      if (/^INSERT INTO schema_migrations/i.test(n)) {
        this.ledger.set(String(params[0]), String(params[1]))
        return [[], []]
      }
      return [[], []]
    }
  }

  it('routes the lock and all statements through the single bound connection', async () => {
    // A pool that would hand out a DISTINCT connection on every call — proving
    // the runner takes exactly one and never rotates.
    const handedOut: RecordingConn[] = []
    const pool = {
      async getConnection() {
        const c = new RecordingConn()
        handedOut.push(c)
        return c
      },
    }
    const conn = await pool.getConnection()
    const db = connectionMigrationDb(conn)
    await runMigrations(db, [
      { filename: '2026-07-01-a.sql', path: '/tmp/a.sql', sql: 'SELECT 1;', checksum: sha256('SELECT 1;') },
    ])

    expect(handedOut).toHaveLength(1) // only one connection ever taken
    expect(conn.log[0]).toMatch(/GET_LOCK/i) // lock first...
    expect(conn.log.at(-1)).toMatch(/RELEASE_LOCK/i) // ...release last, same conn
  })
})
