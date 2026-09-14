import type { AgedOpDrop } from './snapshotter.js'

/**
 * Production escalation for an aged-out op (XIN-1807 P1-2). The snapshotter drops a
 * permanently-buffered op ONLY to unfreeze GC, and the drop can diverge the server from
 * live peers if a FUTURE durable op would have filled it — a data-integrity event with
 * no other in-band signal. The default handler is a bare `console.warn`; production must
 * do better, so this emits a STRUCTURED, machine-parseable `console.error` (a stable
 * `event` tag + the dropped `(actor, s)` identities) at ERROR severity, so a
 * log-based alert can fire on `ppt_relay_aged_op_drop` and the dropped pairs are on the
 * record for reconciliation. It stays storage-agnostic (no audit-table dependency wired
 * here); a deployment that wants durable reconciliation persists the `dropped` array
 * from this same hook. The snapshotter swallows a throw from here, so an emit failure
 * can never abort GC — but this path only formats + logs and does not throw.
 *
 * OPERATOR OBLIGATION: alert on this event and reconcile the dropped ops; see
 * `docs/DEPLOYMENT.md`.
 */
export function productionAgedOpDropHandler(event: {
  docId: string
  targetSeq: number
  bufferedLag: number
  lagCap: number
  trigger: 'seq-lag' | 'byte-budget'
  dropped: AgedOpDrop[]
}): void {
  // eslint-disable-next-line no-console
  console.error(
    '[ppt-relay] aged-op drop (data-integrity divergence risk; alert + reconcile) ' +
      JSON.stringify({
        event: 'ppt_relay_aged_op_drop',
        docId: event.docId,
        targetSeq: event.targetSeq,
        bufferedLag: event.bufferedLag,
        lagCap: event.lagCap,
        trigger: event.trigger,
        droppedCount: event.dropped.length,
        dropped: event.dropped,
      }),
  )
}
