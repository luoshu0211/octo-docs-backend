/**
 * Docs -> Drive view-event forwarder (OCTO-456 §4.5).
 *
 * Opening an online document in docs-backend records a recent view in the docs
 * read model (doc_view_history). Drive's 最近访问 view is a separate read model
 * keyed by (uid, principal_space, kind='doc', ref_id); it only learns about an
 * open from this best-effort forward. Drive's endpoint:
 *
 *   POST {DRIVE_INTERNAL_URL}/v1/internal/drive/library/view
 *   X-Internal-Token: {DRIVE_INTERNAL_TOKEN}
 *   {uid, principal_space_id, doc_id, space_id, entry_id: 0, viewed_at}
 *
 * Contract notes (mirrors internal/modules/library/p0.go internalRecordView on
 * the drive side):
 *   - `space_id` is the document's HOME Space (doc_meta.space_id), NOT the
 *     viewer's Space; `entry_id` is 0 because an online doc is unmounted in
 *     drive's file tree.
 *   - `viewed_at` is the exact timestamp docs persisted, so both recent lists
 *     agree instead of drifting by the HTTP latency.
 *   - Fire-and-forget: the caller's open/POST response never waits on Drive and
 *     never fails because of it. A failure is logged as a warning after bounded
 *     retries and then dropped (Drive's recent list is a convenience read model;
 *     the docs-side history remains authoritative).
 *
 * Configuration is connection info, not a feature switch: when
 * `DRIVE_INTERNAL_URL` or `DRIVE_INTERNAL_TOKEN` is empty the forward is
 * SILENTLY skipped (nothing is logged on every view, no error surfaces).
 */
import { config } from '../config/env.js'

/** One view event as docs observed it. */
export interface DocViewEvent {
  uid: string
  /**
   * The Space the docs recent-view row was ACTUALLY written under — the verified
   * viewer Space for a human (which may differ from their identity principal
   * Space), the server-resolved Space for a bot. Drive keys its 最近访问 record
   * by this value, so it must never be re-derived from the identity token.
   */
  principalSpaceId: string
  docId: string
  /** doc_meta.space_id — the document's home Space. */
  spaceId: string
  viewedAt: Date
}

/** Wire body of POST /v1/internal/drive/library/view (drive parses snake_case). */
export interface DriveViewEventBody {
  uid: string
  principal_space_id: string
  doc_id: string
  space_id: string
  entry_id: number
  viewed_at: string
}

export const DRIVE_VIEW_PATH = '/v1/internal/drive/library/view'
/** Total attempts (1 initial + retries) before the event is dropped. */
export const DRIVE_VIEW_MAX_ATTEMPTS = 3
const RETRY_BASE_DELAY_MS = 100
const REQUEST_TIMEOUT_MS = 3000

/**
 * Process-wide bounded queue. A Drive outage used to fan out one independent
 * retry chain per opened document (each with its own 3 attempts), which amplified
 * traffic exactly when Drive was already struggling. Now:
 *   - at most DRIVE_VIEW_CONCURRENCY forwards run at once;
 *   - at most DRIVE_VIEW_QUEUE_MAX wait; beyond that the event is dropped and
 *     counted (with a rate-limited warning);
 *   - identical (uid, principalSpaceId, docId) events within a 5s window are
 *     merged, keeping the LATEST viewedAt (a single forward moves the recent
 *     entry to the newest view anyway).
 */
export const DRIVE_VIEW_QUEUE_MAX = 1000
export const DRIVE_VIEW_CONCURRENCY = 4
export const DRIVE_VIEW_DEDUPE_WINDOW_MS = 5000

/** True when both connection values are configured. */
export function driveViewForwardEnabled(): boolean {
  return config.driveInternalUrl.trim() !== '' && config.driveInternalToken.trim() !== ''
}

/** Pure wire-shape builder, exported so the payload contract is directly testable. */
export function buildDriveViewEventBody(event: DocViewEvent): DriveViewEventBody {
  return {
    uid: event.uid,
    principal_space_id: event.principalSpaceId,
    doc_id: event.docId,
    space_id: event.spaceId,
    entry_id: 0,
    viewed_at: event.viewedAt.toISOString(),
  }
}

function endpoint(): string {
  return `${config.driveInternalUrl.trim().replace(/\/+$/, '')}${DRIVE_VIEW_PATH}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * POST one view event to Drive, retrying transient failures.
 *
 * Returns true on a 2xx, false when the forward is unconfigured or every attempt
 * failed. Never throws: this function is only ever called fire-and-forget.
 */
export async function forwardViewEvent(event: DocViewEvent): Promise<boolean> {
  if (!driveViewForwardEnabled()) return false
  const body = JSON.stringify(buildDriveViewEventBody(event))
  let lastReason = 'unknown'
  for (let attempt = 1; attempt <= DRIVE_VIEW_MAX_ATTEMPTS; attempt += 1) {
    // A per-attempt abort bounds a hung Drive service so the retry budget cannot
    // pin an idle timer forever.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const res = await fetch(endpoint(), {
        method: 'POST',
        headers: {
          'X-Internal-Token': config.driveInternalToken.trim(),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body,
        signal: controller.signal,
        // Never follow redirects: the request carries the shared X-Internal-Token
        // and fetch's cross-origin redirect protection does NOT strip custom
        // headers. A compromised/SSRF-ing Drive endpoint (or any open redirect)
        // could otherwise collect the service token. The path is fixed and
        // in-network, so a 3xx has no legitimate meaning.
        redirect: 'manual',
      })
      // Drain/ignore the body: only the status matters here.
      await res.arrayBuffer().catch(() => undefined)
      if (res.status >= 300 && res.status < 400) {
        lastReason = `redirect ${res.status}`
        break
      }
      if (res.ok) return true
      // 4xx is deterministic (a caller/config bug); retrying cannot fix it.
      // 401 means the shared token rotated — warn once, do not hammer Drive.
      if (res.status >= 400 && res.status < 500) {
        lastReason = `status ${res.status}`
        break
      }
      lastReason = `status ${res.status}`
    } catch (err) {
      lastReason = err instanceof Error ? err.name : 'error'
    } finally {
      clearTimeout(timer)
    }
    if (attempt < DRIVE_VIEW_MAX_ATTEMPTS) await sleep(RETRY_BASE_DELAY_MS * attempt)
  }
  // INTENTIONAL operator-visible warning, not a silently swallowed error. This
  // is the FINAL outcome after the bounded retry budget is exhausted (or a
  // deterministic 4xx): the forward is dropped and the docs-side history stays
  // authoritative. Do not downgrade/remove it — losing the Drive mirror silently
  // is exactly the failure an operator needs to see. The event is not rethrown
  // because this is fire-and-forget and must never fail the caller's open.
  //
  // Fixed format string; identifiers stay in the argument list so an
  // externally controlled docId can never be interpreted as a util.format
  // directive (js/tainted-format-string).
  // eslint-disable-next-line no-console
  console.warn('[octo-docs] drive view forward failed: %s', lastReason, {
    docId: event.docId,
    attempts: DRIVE_VIEW_MAX_ATTEMPTS,
  })
  return false
}

/**
 * Schedule the forward without awaiting it. Unconfigured => silent no-op.
 *
 * `.catch` is belt-and-braces: forwardViewEvent already contains its own
 * failures, but a fire-and-forget promise must never become an unhandled
 * rejection that could terminate the process.
 */
interface QueuedView {
  key: string
  event: DocViewEvent
}

const viewQueue: QueuedView[] = []
/** Only QUEUED (not in-flight) items; a queued duplicate updates this object. */
const queuedByKey = new Map<string, QueuedView>()
/** Last enqueue time per key, for the 5s coalescing window (covers in-flight). */
const recentByKey = new Map<string, number>()
let activeForwards = 0
let droppedViews = 0
let mergedViews = 0
let lastQueueFullWarnAt = 0

function viewKey(event: DocViewEvent): string {
  return `${event.uid}\u0000${event.principalSpaceId}\u0000${event.docId}`
}

function pruneRecent(now: number): void {
  if (recentByKey.size <= 10_000) return
  for (const [key, at] of recentByKey) {
    if (now - at >= DRIVE_VIEW_DEDUPE_WINDOW_MS) recentByKey.delete(key)
  }
}

function pumpViewQueue(): void {
  while (activeForwards < DRIVE_VIEW_CONCURRENCY && viewQueue.length > 0) {
    const item = viewQueue.shift()!
    // The item is no longer queued: remove it from the coalescing map BEFORE the
    // forward starts. Otherwise a duplicate arriving while it is in-flight would
    // mutate `item.event`, and the in-flight request (already built) would still
    // send the OLD viewedAt — the exact "changed the object but sent stale bytes"
    // bug. A duplicate inside the 5s window is now counted as merged and dropped;
    // docs-side history remains authoritative, so the recent entry simply keeps
    // the first forward.
    if (queuedByKey.get(item.key) === item) queuedByKey.delete(item.key)
    activeForwards += 1
    void forwardViewEvent(item.event)
      .catch(() => false)
      .finally(() => {
        activeForwards -= 1
        if (queuedByKey.get(item.key) === item) queuedByKey.delete(item.key)
        pumpViewQueue()
      })
  }
}

/** Observable queue counters (tests/ops). */
export function getDriveViewQueueStats(): {
  queued: number
  active: number
  dropped: number
  merged: number
} {
  return { queued: viewQueue.length, active: activeForwards, dropped: droppedViews, merged: mergedViews }
}

/** Reset the process-wide queue between tests. */
export function __resetViewForwardQueueForTests(): void {
  viewQueue.length = 0
  queuedByKey.clear()
  recentByKey.clear()
  activeForwards = 0
  droppedViews = 0
  mergedViews = 0
  lastQueueFullWarnAt = 0
}

export function scheduleDriveViewForward(event: DocViewEvent): void {
  if (!driveViewForwardEnabled()) return
  const key = viewKey(event)
  const now = Date.now()

  const queued = queuedByKey.get(key)
  if (queued) {
    // Still waiting: keep the newest view metadata in the same slot.
    queued.event = event
    mergedViews += 1
    return
  }
  const recentAt = recentByKey.get(key)
  if (recentAt !== undefined && now - recentAt < DRIVE_VIEW_DEDUPE_WINDOW_MS) {
    // An identical forward is in flight (or just completed) within the window.
    mergedViews += 1
    return
  }
  if (viewQueue.length >= DRIVE_VIEW_QUEUE_MAX) {
    droppedViews += 1
    if (now - lastQueueFullWarnAt >= 60_000) {
      lastQueueFullWarnAt = now
      // eslint-disable-next-line no-console
      console.warn('[octo-docs] drive view forward queue full; dropping event', {
        queued: viewQueue.length,
        dropped: droppedViews,
      })
    }
    return
  }

  const item: QueuedView = { key, event }
  viewQueue.push(item)
  queuedByKey.set(key, item)
  recentByKey.set(key, now)
  pruneRecent(now)
  pumpViewQueue()
}
