/**
 * 回收站保留期到期的自动清理任务（OCTO-456 P1，§B6）。
 *
 * 每 `TRASH_CLEANUP_INTERVAL_MS`（默认 6h）扫描一次
 *   `doc_meta.status = 0 AND deleted_at IS NOT NULL AND deleted_at < NOW() - 30d`
 * 的文档，用与 `POST /api/v1/docs/{docId}/purge` **同一个** `purgeDocument` 服务
 * 物理删除（html 内容 best_effort：删不掉也继续删 doc_meta，避免任务被一篇坏
 * 文档永久卡住）。
 *
 * 关键取舍：
 *   - `deleted_at IS NULL` 的历史行**永不自动清理**（删除时刻未知 = 保留期无法
 *     判定；与内部灰行 `expireAt:null` 的契约一致）。
 *   - 默认 **关闭**（`TRASH_CLEANUP_ENABLED=false`）。开启后启动日志会明确打印
 *     interval / 保留天数 / batch，运维可据此确认任务真的在跑。
 *   - 用 `setInterval().unref()`：定时器不阻止进程退出；SIGTERM 的 graceful
 *     shutdown 会 `stop()`。每轮有重入保护，上一轮没跑完不会叠加。
 *   - 单轮扫描量有上界（`maxBatchesPerRun × batchSize`），且「一批里一个都没删掉」
 *     立即停止 —— 数据库半故障时不允许把同一批失败文档无限重试。
 *
 * 单测通过 `createTrashCleanupScheduler({ listExpired, purge, now })` 注入假时间
 * 与假仓储，验证「筛选 cutoff」与「开关」。
 */
import { config } from '../config/env.js'
import { docTrashRepo } from '../db/repos/docTrashRepo.js'
import { TRASH_RETENTION_DAYS } from '../permission/docRetention.js'
import { purgeDocument } from './purgeDocument.js'

const DAY_MS = 24 * 60 * 60 * 1000

export interface TrashCleanupRow {
  doc_id: string
  /** Cursor component: keyset paging so a failing page cannot block the rest. */
  deleted_at?: Date | null
}

export type TrashCleanupLogger = (message: string, ...args: unknown[]) => void

export interface TrashCleanupOptions {
  /** 总开关；false 时 start() 只打日志，runOnce() 直接跳过。 */
  enabled: boolean
  /** 两轮之间的间隔（ms），默认 6h。 */
  intervalMs: number
  /** 保留天数，默认 30；cutoff = now - retentionDays。 */
  retentionDays: number
  /** 每批扫描/删除条数，默认 100（上限 1000）。 */
  batchSize?: number
  /** 单轮最多处理多少批，默认 100（防止一次跑太久）。 */
  maxBatchesPerRun?: number
  /** 可注入时钟（单测用固定时间）。 */
  now?: () => number
  /** 可注入候选查询（单测用假仓储）。 */
  listExpired?: (
    cutoff: Date,
    limit: number,
    after?: { deletedAt: Date; docId: string },
  ) => Promise<TrashCleanupRow[]>
  /** 可注入删除（默认走 purgeDocument best_effort）。 */
  purge?: (docId: string) => Promise<{ ok: boolean }>
  log?: TrashCleanupLogger
}

export interface TrashCleanupSummary {
  /** 开关关闭时 true，且不会触达仓储。 */
  skipped: boolean
  /** 本次 cutoff（ISO8601 UTC），便于日志核对。 */
  cutoff: string | null
  scanned: number
  purged: number
  failed: number
}

export interface TrashCleanupScheduler {
  runOnce(): Promise<TrashCleanupSummary>
  start(): void
  stop(): void
}

const defaultLogger: TrashCleanupLogger = (message, ...args) => {
  // eslint-disable-next-line no-console
  console.log(message, ...args)
}

export function createTrashCleanupScheduler(options: TrashCleanupOptions): TrashCleanupScheduler {
  const log = options.log ?? defaultLogger
  const now = options.now ?? Date.now
  const batchSize = Math.min(1000, Math.max(1, Math.floor(options.batchSize ?? 100)))
  const maxBatchesPerRun = Math.min(1000, Math.max(1, Math.floor(options.maxBatchesPerRun ?? 100)))
  const listExpired = options.listExpired
    ?? ((cutoff: Date, limit: number, after?: { deletedAt: Date; docId: string }) =>
      docTrashRepo.listExpiredForCleanup(cutoff, limit, after))
  const purge = options.purge
    ?? ((docId: string) => purgeDocumentBestEffort(docId))

  let timer: ReturnType<typeof setInterval> | null = null
  let running = false
  /**
   * Where the NEXT run starts. Kept across runs on purpose: with a per-run
   * cursor, a page of permanently failing tombstones consumed the whole scan
   * budget every time and the documents behind them were never attempted. When a
   * run walks off the end of the queue the cursor resets, so the queue is retried
   * from the head on the following run.
   */
  let resumeFrom: { deletedAt: Date; docId: string } | undefined

  async function runOnce(): Promise<TrashCleanupSummary> {
    if (!options.enabled) {
      return { skipped: true, cutoff: null, scanned: 0, purged: 0, failed: 0 }
    }
    const cutoff = new Date(now() - options.retentionDays * DAY_MS)
    let scanned = 0
    let purged = 0
    let failed = 0

    let cursor: { deletedAt: Date; docId: string } | undefined = resumeFrom
    // Only a run that stops because it ran out of BUDGET carries its cursor
    // forward. Walking off the end of the queue must reset it, otherwise a row
    // that failed once transiently is skipped by every later run.
    let exhaustedBudget = false
    for (let batch = 0; batch < maxBatchesPerRun; batch += 1) {
      const rows = await listExpired(cutoff, batchSize, cursor)
      if (rows.length === 0) {
        cursor = undefined
        break
      }
      scanned += rows.length
      for (const row of rows) {
        try {
          const result = await purge(row.doc_id)
          if (result.ok) {
            purged += 1
          } else {
            failed += 1
          }
        } catch (err) {
          failed += 1
          log('[octo-docs] trash cleanup: purge failed for doc', row.doc_id, err)
        }
      }
      // Advance by (deleted_at, doc_id) instead of stopping at the first failing
      // page: a permanently failing row must not block every document behind it.
      const last = rows[rows.length - 1]!
      if (!last.deleted_at) {
        cursor = undefined
        break
      }
      cursor = { deletedAt: last.deleted_at, docId: last.doc_id }
      if (rows.length < batchSize) {
        // Short page = the queue is exhausted, not a budget stop.
        cursor = undefined
        break
      }
      // Reaching here on the last allowed batch means the budget is what stopped
      // us, so the cursor is the resume point for the next run.
      if (batch === maxBatchesPerRun - 1) exhaustedBudget = true
    }
    resumeFrom = exhaustedBudget ? cursor : undefined

    return {
      skipped: false,
      cutoff: cutoff.toISOString(),
      scanned,
      purged,
      failed,
    }
  }

  async function tick(): Promise<void> {
    if (running) return
    running = true
    try {
      const summary = await runOnce()
      if (summary.purged > 0 || summary.failed > 0) {
        log('[octo-docs] trash cleanup run finished', summary)
      }
    } catch (err) {
      log('[octo-docs] trash cleanup run failed (will retry next tick)', err)
    } finally {
      running = false
    }
  }

  function start(): void {
    if (!options.enabled) {
      log(
        '[octo-docs] trash cleanup DISABLED (TRASH_CLEANUP_ENABLED=false); ' +
          'expired trashed documents are NOT auto-purged',
      )
      return
    }
    if (timer !== null) return
    log(
      `[octo-docs] trash cleanup enabled: every ${options.intervalMs}ms, ` +
        `retention ${options.retentionDays}d, batch ${batchSize}`,
    )
    // 启动即跑一轮（捕获进程停机期间到期的文档），随后按 interval 周期执行。
    void tick()
    timer = setInterval(() => void tick(), options.intervalMs)
    timer.unref()
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  return { runOnce, start, stop }
}

/** 自动清理使用 best_effort：html 内容删失败也继续删 doc_meta。 */
async function purgeDocumentBestEffort(docId: string): Promise<{ ok: boolean }> {
  const result = await purgeDocument(docId, { mode: 'best_effort' })
  return { ok: result.ok }
}

/**
 * 进程启动入口：按 config 构造调度器并 start，返回停止函数（shutdown 调用）。
 * 关闭时也只打印一行明确的 DISABLED 日志。
 */
export function startTrashCleanup(overrides: Partial<TrashCleanupOptions> = {}): () => void {
  const scheduler = createTrashCleanupScheduler({
    enabled: config.trashCleanup.enabled,
    intervalMs: config.trashCleanup.intervalMs,
    // Same constant the listing/status projections and the restore check use.
    // Reading the env var here independently is what made a 7-day deployment
    // delete documents whose UI still promised 23 more days.
    retentionDays: TRASH_RETENTION_DAYS,
    ...overrides,
  })
  scheduler.start()
  return () => scheduler.stop()
}
