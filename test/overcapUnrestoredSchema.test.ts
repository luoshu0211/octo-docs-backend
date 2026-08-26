import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * MR98-006: the durable over-cap retry carrier lives in a real table. Pin its
 * shape in both the fresh-install schema and the incremental upgrade, and pin
 * that the upgrade is re-runnable (the migration runner is at-least-once).
 */
const root = fileURLToPath(new URL('..', import.meta.url))
const schema = readFileSync(`${root}/migrations/schema.sql`, 'utf8')
const upgrade = readFileSync(
  `${root}/migrations/upgrades/2026-08-26-add-overcap-unrestored-retry.sql`,
  'utf8',
)

describe('overcap_unrestored durable retry schema', () => {
  it('schema.sql defines the table keyed one row per document_name', () => {
    expect(schema).toContain('CREATE TABLE overcap_unrestored (')
    expect(schema).toMatch(/overcap_unrestored[\s\S]*document_name VARCHAR\(256\) NOT NULL/)
    expect(schema).toMatch(/overcap_unrestored[\s\S]*state_vector\s+TEXT\s+NOT NULL/)
    expect(schema).toMatch(/overcap_unrestored[\s\S]*PRIMARY KEY \(document_name\)/)
  })

  it('the upgrade is idempotent (re-runnable) and matches the table shape', () => {
    expect(upgrade).toContain('CREATE TABLE IF NOT EXISTS overcap_unrestored (')
    expect(upgrade).toMatch(/document_name VARCHAR\(256\) NOT NULL/)
    expect(upgrade).toMatch(/state_vector\s+TEXT\s+NOT NULL/)
    expect(upgrade).toMatch(/recorded_at\s+DATETIME\(3\)/)
    expect(upgrade).toContain('PRIMARY KEY (document_name)')
    expect(upgrade).toContain('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4')
  })
})
