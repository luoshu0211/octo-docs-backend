import { config } from '../config/env.js'
import { query, transaction, type Tx } from '../db/pool.js'

export interface PendingDocumentEdit {
  eventId: string
  actorUid: string
  principalSpaceId: string
  occurredAtMs: number
}

interface OutboxRow {
  event_id: string
  document_id: string
  document_space_id: string
  principal_space_id: string
  actor_uid: string
  occurred_at_ms: number | string
}

const batchSize = 16
const intervalMs = 5_000
const activityWindowMs = 7 * 24 * 60 * 60 * 1_000

export function documentActivityEnabled(): boolean {
  return Boolean(config.driveDerived.internalBaseUrl && config.driveDerived.activityToken)
}

// Keep the event and the exact Yjs snapshot in the same transaction. Only
// metadata crosses into the outbox. Sheets use the same collaboration store
// but are outside this activity contract.
export async function enqueueDocumentEdits(tx: Tx, documentName: string, edits: readonly PendingDocumentEdit[]): Promise<void> {
  if (edits.length === 0) return
  const pending = edits.map(() => 'SELECT ? AS event_id, ? AS principal_space_id, ? AS actor_uid, ? AS occurred_at_ms').join(' UNION ALL ')
  await tx.execute(
    `INSERT INTO doc_body_edit_outbox
       (event_id, document_id, document_space_id, principal_space_id, actor_uid, occurred_at_ms)
     SELECT e.event_id, m.doc_id, m.space_id, e.principal_space_id, e.actor_uid, e.occurred_at_ms
       FROM doc_meta m CROSS JOIN (${pending}) AS e
      WHERE m.document_name = ? AND m.doc_type = 'doc' AND m.status = 1
     ON DUPLICATE KEY UPDATE event_id = doc_body_edit_outbox.event_id`,
    [...edits.flatMap(edit => [edit.eventId, edit.principalSpaceId, edit.actorUid, edit.occurredAtMs]), documentName],
  )
}

async function flushDocumentEdits(url: string, token: string): Promise<void> {
  const cutoff = Date.now() - activityWindowMs
  await query('DELETE FROM doc_body_edit_outbox WHERE occurred_at_ms < ? ORDER BY occurred_at_ms LIMIT 100', [cutoff])
  const batch = await transaction(async tx => {
    const due = await tx.query<OutboxRow>(
      `SELECT event_id, document_id, document_space_id, principal_space_id, actor_uid, occurred_at_ms
         FROM doc_body_edit_outbox
        WHERE next_attempt_at <= NOW(3) AND occurred_at_ms >= ?
        ORDER BY next_attempt_at, event_id LIMIT ${batchSize} FOR UPDATE SKIP LOCKED`,
      [cutoff],
    )
    if (due.length) {
      await tx.execute(
        `UPDATE doc_body_edit_outbox SET next_attempt_at = DATE_ADD(NOW(3), INTERVAL 30 SECOND)
          WHERE event_id IN (${due.map(() => '?').join(', ')})`,
        due.map(row => row.event_id),
      )
    }
    return due
  })
  const delivered = await Promise.all(batch.map(async ({ occurred_at_ms, ...row }) => {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'X-Internal-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...row, occurred_at: new Date(Number(occurred_at_ms)).toISOString() }),
        redirect: 'error',
        signal: AbortSignal.timeout(3_000),
      })
      await response.body?.cancel()
      return response.ok ? row.event_id : null
    } catch {
      return null
    }
  }))
  const acknowledged = delivered.filter(id => id !== null)
  if (acknowledged.length) {
    await query(
      `DELETE FROM doc_body_edit_outbox WHERE event_id IN (${acknowledged.map(() => '?').join(', ')})`,
      acknowledged,
    )
  }
  if (acknowledged.length !== batch.length) {
    // eslint-disable-next-line no-console -- asynchronous delivery is retried
    console.warn('[document-activity] will retry undelivered events:', batch.length - acknowledged.length)
  }
}

export function startDocumentActivityDelivery(): () => Promise<void> {
  if (!documentActivityEnabled()) return async () => {}
  const url = new URL('/internal/v1/docs/document-edits', config.driveDerived.internalBaseUrl).href
  const token = config.driveDerived.activityToken
  let inFlight: Promise<void> | undefined
  const timer = setInterval(() => {
    if (inFlight) return
    inFlight = flushDocumentEdits(url, token).catch(() => {
      // eslint-disable-next-line no-console -- keep the worker running during database outages
      console.warn('[document-activity] outbox delivery failed')
    }).finally(() => { inFlight = undefined })
  }, intervalMs)
  timer.unref()
  return async () => {
    clearInterval(timer)
    await inFlight
  }
}
