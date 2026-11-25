import { config } from '../config/env.js'
import { query, transaction, type Tx } from '../db/pool.js'
import { driveInternalUrl } from './internalUrl.js'

export interface DocumentEditProof {
  generation: string | null
  clocks: Array<[client: number, end: number]>
  deletes: Array<[client: number, start: number, end: number]>
}

export interface PendingDocumentEdit {
  eventId: string
  actorUid: string
  principalSpaceId: string
  occurredAtMs: number
  proof: DocumentEditProof
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
  return Boolean(config.driveDerived.internalBaseUrl && config.driveDerived.outboundToken)
}

async function stageDocumentEdits(db: Pick<Tx, 'query'>, documentName: string, edits: readonly PendingDocumentEdit[]): Promise<void> {
  if (edits.length === 0) return
  const pending = edits.map(() => 'SELECT ? AS event_id, ? AS principal_space_id, ? AS actor_uid, ? AS occurred_at_ms, ? AS update_proof').join(' UNION ALL ')
  await db.query(
    `INSERT INTO doc_body_edit_outbox
       (event_id, document_name, document_id, document_space_id, principal_space_id, actor_uid, occurred_at_ms, update_proof)
     SELECT e.event_id, m.document_name, m.doc_id, m.space_id, e.principal_space_id, e.actor_uid, e.occurred_at_ms, e.update_proof
       FROM doc_meta m CROSS JOIN (${pending}) AS e
      WHERE m.document_name = ? AND m.doc_type = 'doc' AND m.status = 1
     ON DUPLICATE KEY UPDATE event_id = doc_body_edit_outbox.event_id`,
    [...edits.flatMap(edit => [edit.eventId, edit.principalSpaceId, edit.actorUid, edit.occurredAtMs, JSON.stringify(edit.proof)]), documentName],
  )
}

export function stageDocumentEdit(documentName: string, edit: PendingDocumentEdit): Promise<void> {
  return stageDocumentEdits({ query }, documentName, [edit])
}

// Any replica that saves the matching Yjs state may publish the event.
// Keep the proof staged until the state and the ready flag commit together.
export async function confirmPersistedDocumentEdits(
  tx: Tx, documentName: string, local: readonly PendingDocumentEdit[], includesEdit: (proof: DocumentEditProof) => boolean,
): Promise<void> {
  await stageDocumentEdits(tx, documentName, local)
  const candidates = await tx.query<{ event_id: string; update_proof: DocumentEditProof }>(
    `SELECT e.event_id, e.update_proof FROM doc_body_edit_outbox e
      JOIN doc_meta m ON m.doc_id = e.document_id AND m.document_name = e.document_name
     WHERE e.document_name = ? AND e.ready = 0 AND m.doc_type = 'doc' AND m.status = 1
     FOR UPDATE`,
    [documentName],
  )
  const confirmed = candidates.filter(row => includesEdit(row.update_proof)).map(row => row.event_id)
  if (confirmed.length) {
    await tx.execute(
      `UPDATE doc_body_edit_outbox SET ready = 1, update_proof = NULL
        WHERE event_id IN (${confirmed.map(() => '?').join(', ')})`, confirmed,
    )
  }
}

async function flushDocumentEdits(url: string, token: string): Promise<boolean> {
  const cutoff = Date.now() - activityWindowMs
  await query('DELETE FROM doc_body_edit_outbox WHERE occurred_at_ms < ? ORDER BY occurred_at_ms LIMIT 100', [cutoff])
  const batch = await transaction(async tx => {
    const due = await tx.query<OutboxRow>(
      `SELECT event_id, document_id, document_space_id, principal_space_id, actor_uid, occurred_at_ms
         FROM doc_body_edit_outbox
        WHERE ready = 1 AND delivered_at IS NULL AND next_attempt_at <= NOW(3) AND occurred_at_ms >= ?
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
      `UPDATE doc_body_edit_outbox SET delivered_at = NOW(3) WHERE event_id IN (${acknowledged.map(() => '?').join(', ')})`,
      acknowledged,
    )
  }
  if (acknowledged.length !== batch.length) {
    // eslint-disable-next-line no-console -- asynchronous delivery is retried
    console.warn('[document-activity] will retry undelivered events:', batch.length - acknowledged.length)
  }
  return acknowledged.length === batchSize
}

export function startDocumentActivityDelivery(): () => Promise<void> {
  if (!documentActivityEnabled()) return async () => {}
  const url = driveInternalUrl(config.driveDerived.internalBaseUrl, '/internal/v1/docs/document-edits')
  const token = config.driveDerived.outboundToken
  let stopping = false
  let inFlight: Promise<void> | undefined
  const drain = async () => {
    while (!stopping && await flushDocumentEdits(url, token)) {
      // Continue after a successful full batch. Each request has the same
      // timeout and the next iteration waits for the entire batch to finish.
    }
  }
  const timer = setInterval(() => {
    if (inFlight) return
    inFlight = drain().catch(() => {
      // eslint-disable-next-line no-console -- keep the worker running during database outages
      console.warn('[document-activity] outbox delivery failed')
    }).finally(() => { inFlight = undefined })
  }, intervalMs)
  timer.unref()
  return async () => {
    stopping = true
    clearInterval(timer)
    await inFlight
  }
}
