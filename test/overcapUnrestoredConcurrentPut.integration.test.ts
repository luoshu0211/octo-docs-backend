import '../src/config/loadEnv.ts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closePool, query } from '../src/db/pool.js'
import { overcapUnrestoredRepo } from '../src/db/repos/overcapUnrestoredRepo.js'

/**
 * MR98-009 regression (real MySQL, InnoDB gap locks): two — and more — concurrent
 * FIRST-EVER `put()` calls for the SAME absent document must both land, and the
 * final row must carry EVERY client's maximum (per-client-max merge).
 *
 * Before the fix `put()` opened with `SELECT ... FOR UPDATE` on an absent row:
 * under the pool's default REPEATABLE READ each concurrent first write took a gap
 * lock, then each `INSERT` deadlocked on the other's gap (InnoDB 1213). One
 * transaction was rolled back, that replica's rejected state vector was thrown
 * away by `persistDurableUnrestored` (which only logs), and a floor was lost — the
 * exact durability hole this MR's threat model closes. Reverting the source to the
 * pre-fix `SELECT ... FOR UPDATE`-first ordering makes this suite fail: the run
 * throws deadlocks and the final row is missing a client's maximum.
 *
 * Gated behind RUN_OVERCAP_UNRESTORED_MYSQL_TESTS=1 and skipped by default, the
 * same convention the other *.integration.test.ts suites use (they need live
 * MySQL, which unit runs do not provide). The race is probabilistic, so each shape
 * is exercised for many iterations rather than a single shot, and the assertion is
 * on the MERGED ROW, never merely on the absence of errors.
 */
const mysqlDescribe =
  process.env.RUN_OVERCAP_UNRESTORED_MYSQL_TESTS === '1' ? describe.sequential : describe.skip

const DOC_PREFIX = 'octo:overcap_unrestored_concurrent:f_default:d_'

async function ensureTable(): Promise<void> {
  await query(
    `CREATE TABLE IF NOT EXISTS overcap_unrestored (
       document_name VARCHAR(256) NOT NULL,
       state_vector  TEXT         NOT NULL,
       recorded_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
       updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
       PRIMARY KEY (document_name)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
}

async function readVector(documentName: string): Promise<Record<string, number>> {
  const rows = await query<{ state_vector: string }>(
    'SELECT state_vector FROM overcap_unrestored WHERE document_name = ?',
    [documentName],
  )
  return rows[0] ? (JSON.parse(rows[0].state_vector) as Record<string, number>) : {}
}

async function cleanupPrefix(): Promise<void> {
  await query('DELETE FROM overcap_unrestored WHERE document_name LIKE ?', [`${DOC_PREFIX}%`])
}

mysqlDescribe('overcap_unrestored concurrent first-ever put (MR98-009)', () => {
  beforeAll(async () => {
    await ensureTable()
    await cleanupPrefix()
  })

  afterAll(async () => {
    await cleanupPrefix()
    await closePool()
  })

  it('two concurrent first-ever puts both land with both clients maxima, over many iterations', async () => {
    const ITERATIONS = 80
    for (let i = 0; i < ITERATIONS; i += 1) {
      const doc = `${DOC_PREFIX}two_${i}`
      await query('DELETE FROM overcap_unrestored WHERE document_name = ?', [doc])

      // Both writers race into an ABSENT row. Neither may throw and neither floor
      // may be eaten by the other's concurrent insert.
      await Promise.all([
        overcapUnrestoredRepo.put(doc, { '1': 100 }),
        overcapUnrestoredRepo.put(doc, { '2': 200 }),
      ])

      const sv = await readVector(doc)
      expect(sv, `iteration ${i}: both maxima must survive`).toEqual({ '1': 100, '2': 200 })
    }
  })

  it('three concurrent first-ever puts merge every client maximum (higher-order deadlock path)', async () => {
    const ITERATIONS = 80
    for (let i = 0; i < ITERATIONS; i += 1) {
      const doc = `${DOC_PREFIX}three_${i}`
      await query('DELETE FROM overcap_unrestored WHERE document_name = ?', [doc])

      // A shared client (1) appears in two writers at DIFFERENT clocks: the merge
      // must keep the higher (100), never the lower (90), regardless of interleave.
      await Promise.all([
        overcapUnrestoredRepo.put(doc, { '1': 100 }),
        overcapUnrestoredRepo.put(doc, { '2': 200 }),
        overcapUnrestoredRepo.put(doc, { '1': 90, '3': 300 }),
      ])

      const sv = await readVector(doc)
      expect(sv, `iteration ${i}: per-client max across three writers`).toEqual({
        '1': 100,
        '2': 200,
        '3': 300,
      })
    }
  })
})
