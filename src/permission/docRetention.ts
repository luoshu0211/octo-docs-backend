/**
 * 在线文档原件回收的保留期（OCTO-456 P1, §3.3）。
 *
 * 软删除（`doc_meta.status=0`）只把文档移入回收站；原件在保留期满后由
 * `src/trash/cleanupJob.ts` 的定时任务物理清理。保留期是**服务端常量**：
 * 前端只读接口返回的 `expireAt` / `retentionDays`，绝不自己写死 30 天。
 *
 * 关键约定（与 !208 的内部灰行契约一致）：
 *   - `deleted_at` 为 NULL 表示「历史删除、删除时刻未知」（该列在
 *     2026-11-24-add-doc-deleted-at.sql 之前不存在）。此时保留期**无法判定**：
 *     `expireAt` 返回 null，且**永不自动清理**（宁可保留，不可误删）。
 *   - `expireAt = deleted_at + 30d`（按毫秒精确相加；DATETIME(3) 精度）。
 *   - 比较统一用应用时钟；`deleted_at` 由 DB 的 NOW(3) 写入，mysql2 以同一
 *     会话/进程时区读回 Date，两边是同一绝对时刻。
 *
 * 保留期只有**一个**来源：`TRASH_RETENTION_DAYS`（env，默认 30）。清理任务的
 * cutoff、列表/状态投影的 `expireAt`/`retentionDays`、恢复的到期判定全部用它，
 * 否则把 env 调成 7 天时用户界面仍显示 30 天、文档却已被物理删除。
 *
 * 为什么读取时要容错：内部 `/internal/docs/status` 的灰行投影在单测里会用精简的
 * config mock，缺少该字段时必须回退到契约默认值，而不是在模块加载时抛错。
 */
import { config } from '../config/env.js'

function configuredRetentionDays(): number {
  const raw = (config as { trashCleanup?: { retentionDays?: unknown } }).trashCleanup?.retentionDays
  const value = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 30
}

/**
 * 回收站保留天数（对外契约值，写入 `retentionDays` / `retention_days`）。
 * 同时是清理任务的 cutoff 依据 —— 展示、判定、清理共用同一个数。
 */
export const TRASH_RETENTION_DAYS = configuredRetentionDays()

/** 保留期毫秒数（`deleted_at + 30d`）。 */
export const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * 回收站条目的到期时刻：`deleted_at + retentionDays`。
 * 删除时刻为 NULL / 不可解析时返回 null（期限未知，不自动清理）。
 */
export function trashExpireAt(
  deletedAt: unknown,
  retentionDays: number = TRASH_RETENTION_DAYS,
): Date | null {
  const date = toDate(deletedAt)
  if (date === null) return null
  return new Date(date.getTime() + retentionDays * 24 * 60 * 60 * 1000)
}

/** 同上，ISO8601 UTC 字符串（wire 用）；期限未知 => null。 */
export function trashExpireAtIso(
  deletedAt: unknown,
  retentionDays: number = TRASH_RETENTION_DAYS,
): string | null {
  return trashExpireAt(deletedAt, retentionDays)?.toISOString() ?? null
}

/**
 * 是否已超过保留期（严格大于：正好 30 天当天仍可恢复，与内部灰行的
 * `isDeletionExpired` 保持同一比较方向）。删除时刻未知 => false。
 */
export function isTrashExpired(
  deletedAt: unknown,
  nowMs: number = Date.now(),
  retentionDays: number = TRASH_RETENTION_DAYS,
): boolean {
  const date = toDate(deletedAt)
  if (date === null) return false
  return date.getTime() < nowMs - retentionDays * 24 * 60 * 60 * 1000
}
