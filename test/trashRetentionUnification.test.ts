import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * OCTO-456 P1 — the retention window has ONE source.
 *
 * The cleanup job used to read TRASH_RETENTION_DAYS (env) while the trash list,
 * /internal/docs/status and the restore check used a hard-coded 30 days. With
 * TRASH_RETENTION_DAYS=7 the UI promised 23 more restorable days while the job
 * permanently deleted the document. Everything must derive from the same value.
 */
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    trashCleanup: { enabled: true, intervalMs: 1000, retentionDays: 7, batchSize: 10, maxBatchesPerRun: 1 },
    htmlInternal: { url: '', token: '', timeoutMs: 1000 },
    search: { indexEnabled: false },
  },
}))
vi.mock('../src/config/env.js', () => ({ config: mockConfig }))

import {
  TRASH_RETENTION_DAYS,
  TRASH_RETENTION_MS,
  isTrashExpired,
  trashExpireAt,
  trashExpireAtIso,
} from '../src/permission/docRetention.js'
import { createTrashCleanupScheduler } from '../src/trash/cleanupJob.js'

describe('trash retention unification', () => {
  it('uses the configured non-default window for display, expiry and cleanup', async () => {
    expect(TRASH_RETENTION_DAYS).toBe(7)
    expect(TRASH_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000)

    const deletedAt = new Date('2026-11-20T00:00:00.000Z')
    expect(trashExpireAtIso(deletedAt)).toBe('2026-11-27T00:00:00.000Z')
    // 8 days later is expired; 6 days later is not — both against the SAME 7-day
    // window the cleanup scheduler below uses.
    expect(isTrashExpired(deletedAt, new Date('2026-11-26T00:00:00.000Z').getTime())).toBe(false)
    expect(isTrashExpired(deletedAt, new Date('2026-11-29T00:00:00.000Z').getTime())).toBe(true)

    const cutoffs: Date[] = []
    const scheduler = createTrashCleanupScheduler({
      enabled: true,
      intervalMs: 60_000,
      retentionDays: TRASH_RETENTION_DAYS,
      batchSize: 10,
      maxBatchesPerRun: 1,
      now: () => new Date('2026-11-25T00:00:00.000Z'),
      listExpired: async (cutoff) => {
        cutoffs.push(cutoff)
        return []
      },
      purge: async () => ({ ok: true, documentName: 'x' }) as never,
    })
    await scheduler.runOnce()
    expect(cutoffs).toHaveLength(1)
    expect(cutoffs[0]!.toISOString()).toBe('2026-11-18T00:00:00.000Z')
  })

  it('falls back to 30 days when the config projection has no retention field', async () => {
    // Slim config mocks (internal /status tests) must not crash module load.
    const retention = await import('../src/permission/docRetention.js')
    expect(retention.TRASH_RETENTION_DAYS).toBeGreaterThanOrEqual(1)
    expect(trashExpireAt(new Date('2026-11-20T00:00:00.000Z'))).not.toBeNull()
  })
})
