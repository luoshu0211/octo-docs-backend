import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * OCTO-456 P1 — 保留期到期自动清理任务。
 * 用固定时钟 + 假仓储验证：
 *   - 开关关闭：runOnce 不触达仓储、start 只打 DISABLED 日志；
 *   - 筛选 cutoff = now - retentionDays；
 *   - 分批直到空批；同一批一个都没删掉就停手；
 *   - 删除失败只计数，不抛出。
 */
import { createTrashCleanupScheduler } from '../src/trash/cleanupJob.js'

const NOW = new Date('2026-12-01T00:00:00.000Z').getTime()
const DAY = 24 * 60 * 60 * 1000

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createTrashCleanupScheduler', () => {
  it('is a hard no-op while disabled (no repo access, DISABLED log)', async () => {
    const listExpired = vi.fn(async () => [])
    const purge = vi.fn(async () => ({ ok: true }))
    const log = vi.fn()
    const scheduler = createTrashCleanupScheduler({
      enabled: false, intervalMs: 1000, retentionDays: 30, now: () => NOW, listExpired, purge, log,
    })

    expect(await scheduler.runOnce()).toEqual({
      skipped: true, cutoff: null, scanned: 0, purged: 0, failed: 0,
    })
    scheduler.start()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(listExpired).not.toHaveBeenCalled()
    expect(purge).not.toHaveBeenCalled()
    expect(log.mock.calls.some(([message]) => String(message).includes('DISABLED'))).toBe(true)
    scheduler.stop()
  })

  it('passes now - retentionDays as the cutoff and purges each expired doc', async () => {
    const listExpired = vi.fn()
      .mockResolvedValueOnce([{ doc_id: 'd1' }, { doc_id: 'd2' }])
      .mockResolvedValueOnce([])
    const purge = vi.fn(async () => ({ ok: true }))
    const scheduler = createTrashCleanupScheduler({
      enabled: true, intervalMs: 1000, retentionDays: 30, now: () => NOW, listExpired, purge,
      log: vi.fn(),
    })

    const summary = await scheduler.runOnce()
    expect(summary).toEqual({
      skipped: false,
      cutoff: new Date(NOW - 30 * DAY).toISOString(),
      scanned: 2,
      purged: 2,
      failed: 0,
    })
    expect(listExpired).toHaveBeenNthCalledWith(1, new Date(NOW - 30 * DAY), 100)
    expect(purge).toHaveBeenCalledWith('d1')
    expect(purge).toHaveBeenCalledWith('d2')
  })

  it('keeps paging until a short/empty batch and respects page bounds', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ doc_id: `d${i}` }))
    const listExpired = vi.fn()
      .mockResolvedValueOnce(full)
      .mockResolvedValueOnce([{ doc_id: 'd100' }])
    const purge = vi.fn(async () => ({ ok: true }))
    const scheduler = createTrashCleanupScheduler({
      enabled: true, intervalMs: 1000, retentionDays: 30, now: () => NOW,
      listExpired, purge, batchSize: 100, log: vi.fn(),
    })

    const summary = await scheduler.runOnce()
    expect(summary.scanned).toBe(101)
    expect(summary.purged).toBe(101)
    // 第二批只有 1 条（< batchSize）=> 停止，不再发第三次查询。
    expect(listExpired).toHaveBeenCalledTimes(2)
  })

  it('counts per-doc failures and stops immediately when a whole batch made no progress', async () => {
    const listExpired = vi.fn(async () => [{ doc_id: 'd1' }, { doc_id: 'd2' }])
    const purge = vi.fn(async () => ({ ok: false }))
    const scheduler = createTrashCleanupScheduler({
      enabled: true, intervalMs: 1000, retentionDays: 30, now: () => NOW,
      listExpired, purge, log: vi.fn(),
    })

    const summary = await scheduler.runOnce()
    expect(summary).toMatchObject({ scanned: 2, purged: 0, failed: 2 })
    // 同批仍然失败 => 不能无限重试同一批。
    expect(listExpired).toHaveBeenCalledTimes(1)
  })

  it('swallows a thrown purge and keeps going', async () => {
    const listExpired = vi.fn()
      .mockResolvedValueOnce([{ doc_id: 'd1' }, { doc_id: 'd2' }])
      .mockResolvedValueOnce([])
    const purge = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ ok: true })
    const scheduler = createTrashCleanupScheduler({
      enabled: true, intervalMs: 1000, retentionDays: 30, now: () => NOW,
      listExpired, purge, log: vi.fn(),
    })

    const summary = await scheduler.runOnce()
    expect(summary).toMatchObject({ scanned: 2, purged: 1, failed: 1 })
  })

  it('logs ENABLED with interval/retention and runs one pass immediately on start', async () => {
    const listExpired = vi.fn(async () => [])
    const log = vi.fn()
    const scheduler = createTrashCleanupScheduler({
      enabled: true, intervalMs: 6 * 60 * 60 * 1000, retentionDays: 30, now: () => NOW,
      listExpired, purge: vi.fn(async () => ({ ok: true })), log,
    })

    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    scheduler.start()
    await vi.waitFor(() => expect(listExpired).toHaveBeenCalled())
    expect(log.mock.calls.some(([message]) =>
      String(message).includes('trash cleanup enabled') && String(message).includes('retention 30d'))).toBe(true)
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 6 * 60 * 60 * 1000)
    scheduler.stop()
  })
})
