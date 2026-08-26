import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('doc access notification ledger migration', () => {
  const sql = readFileSync('migrations/upgrades/2026-08-26-space-qualify-doc-access-notify-card.sql', 'utf8')

  it('guards the column and PK upgrade for repeat/resume execution', () => {
    expect(sql).toMatch(/information_schema\.columns[\s\S]*column_name='delivery_space_id'/)
    expect(sql).toMatch(/information_schema\.statistics[\s\S]*seq_in_index=3[\s\S]*column_name='delivery_space_id'/)
    expect(sql).toContain('PRIMARY KEY(request_id,recipient_uid,delivery_space_id)')
  })

  it('backfills legacy rows from request document Home Space and preserves orphans', () => {
    expect(sql).toMatch(/doc_access_request r ON r\.request_id=c\.request_id/)
    expect(sql).toMatch(/doc_meta m ON m\.doc_id=r\.doc_id/)
    expect(sql).toContain("COALESCE(NULLIF(c.delivery_space_id,''), m.space_id, '')")
  })
})
