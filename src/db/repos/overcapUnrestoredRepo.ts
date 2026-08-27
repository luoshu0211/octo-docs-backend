/**
 * overcap_unrestored repository (MR98-006).
 *
 * The DURABLE, replica-independent carrier for the REJECTED state vector of a
 * document that failed its persistence size cap. It is the bottom layer of the
 * over-cap retry chain:
 *
 *   in-memory queue (fast path, this process)
 *     -> Redis marker (compactionNotice, survives replica death, 30-day TTL)
 *       -> THIS TABLE (survives replica death even when Redis was unreachable at
 *          rejection time — the exact hole the in-memory queue could not close,
 *          because a SIGKILL/OOM takes the queue with the process).
 *
 * WHY THE DATABASE IS THE NATURAL BOTTOM. The rejection path is already on the
 * persistence layer (`persistence.store` rejected the write here). If the DB is
 * unreachable the whole write path is degraded anyway, so anchoring the retry
 * record here means the regression truly bottoms out: there is no lower layer to
 * fall through to.
 *
 * One row per `document_name`. The state vector is stored as JSON
 * `{clientId: clock}` and merged PER-CLIENT-MAX on every `put`, identically to
 * the Redis marker's own merge (the sanitiser is shared with compactionNotice so
 * the two notions cannot drift). Each mutation runs inside a transaction that
 * locks the row with `SELECT ... FOR UPDATE` before merging, so two concurrent
 * rejections cannot lose each other's floor and a reconcile cannot race a fresh
 * rejection into dropping a delta. `put` seeds the row with an idempotent
 * `INSERT IGNORE` BEFORE that lock so a first-ever concurrent write locks a
 * present row rather than a gap — see the deadlock note on `put`.
 */
import { query, transaction, type Tx } from '../pool.js'
import { sanitizeStateVector, type StateVectorMap } from '../../collab/compactionNotice.js'

/** One pending durable record: a document and its merged rejected state vector. */
export interface UnrestoredRecord {
  documentName: string
  stateVector: StateVectorMap
}

/** Parse a stored JSON state vector, tolerating corruption (reads as empty). */
function parseStored(raw: unknown): StateVectorMap {
  if (typeof raw !== 'string') return {}
  try {
    return sanitizeStateVector(JSON.parse(raw) as StateVectorMap)
  } catch {
    return {}
  }
}

/**
 * A transient InnoDB lock error that is safe to retry with a fresh transaction:
 * deadlock (1213 / ER_LOCK_DEADLOCK) or lock-wait timeout (1205). Everything
 * else propagates.
 */
function isTransientLockError(err: unknown): boolean {
  const e = err as { errno?: number; code?: string } | null
  return (
    !!e &&
    (e.errno === 1213 ||
      e.errno === 1205 ||
      e.code === 'ER_LOCK_DEADLOCK' ||
      e.code === 'ER_LOCK_WAIT_TIMEOUT')
  )
}

/**
 * Belt-and-braces retry for `put` (MR98-009). The insert-then-lock ordering below
 * removes the gap-lock deadlock for the common two-replica first-ever write, but
 * three-or-more concurrent first-ever inserts can still deadlock on InnoDB's
 * shared-lock-on-duplicate upgrade — a structural property of concurrent inserts
 * that no lock ordering closes. Each retry runs a FRESH transaction that re-reads
 * the committed row before merging, so the per-client-max merge always folds onto
 * the winner's durable maxima and no floor is lost across a retry. A small
 * randomised backoff keeps two mutually-deadlocked writers from retrying in
 * lock-step. After the bounded attempts the error propagates so the caller stays
 * loud and fail-closed.
 */
async function withLockRetry<R>(fn: () => Promise<R>): Promise<R> {
  const MAX_ATTEMPTS = 6
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn()
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS || !isTransientLockError(err)) throw err
      const backoffMs = attempt * 4 + Math.floor(Math.random() * 6)
      await new Promise((resolve) => setTimeout(resolve, backoffMs))
    }
  }
}

/** Lock and read the current merged state vector for a document, or null. */
async function selectForUpdate(tx: Tx, documentName: string): Promise<StateVectorMap | null> {
  const rows = await tx.query<{ state_vector: string }>(
    'SELECT state_vector FROM overcap_unrestored WHERE document_name = ? FOR UPDATE',
    [documentName],
  )
  const row = rows[0]
  if (!row) return null
  return parseStored(row.state_vector)
}

export const overcapUnrestoredRepo = {
  /**
   * Merge a rejected state vector into the durable record (per-client-max), or
   * create it. An empty vector writes nothing — a real over-cap document always
   * carries structs, and an empty durable record would suppress notices for a
   * document with no rejected state to protect (the same no-phantom rule the
   * Redis marker enforces). Throws on a DB failure so the caller can be loud and
   * keep the in-memory retry alive (fail closed) rather than treat the missing
   * record as "resolved".
   */
  async put(documentName: string, sv: StateVectorMap): Promise<void> {
    const clean = sanitizeStateVector(sv)
    if (Object.keys(clean).length === 0) return
    await withLockRetry(() =>
      transaction(async (tx) => {
        // Insert-then-lock (MR98-009). The row MUST exist before it is locked. If
        // instead we open with `SELECT ... FOR UPDATE` on an ABSENT document, two
        // concurrent first-ever puts each take a gap lock (gap locks coexist), then
        // each `INSERT` waits on the other's gap for its insert-intention lock — a
        // guaranteed InnoDB deadlock (1213) under the pool's default REPEATABLE
        // READ, and no isolation-level change alone closes it. The victim's put()
        // throws and `persistDurableUnrestored` only logs, so one replica's rejected
        // vector is lost durably. Seeding the row with an idempotent `INSERT IGNORE`
        // first removes the gap: the two inserts target the exact same primary key,
        // so they serialise on one insert-intention lock instead of deadlocking, and
        // the following `SELECT ... FOR UPDATE` then takes a plain record lock on a
        // row that is certain to be present. The '{}' seed is never a clobber — on
        // an existing row IGNORE is a no-op, so a concurrent writer's committed
        // maxima are read back below and preserved by the per-client-max merge; and
        // the seed is only ever committed carrying the merged (non-empty) vector the
        // UPDATE writes inside this same transaction, so no empty phantom is exposed.
        // Three-or-more concurrent first-ever inserts can still deadlock on InnoDB's
        // shared-lock-on-duplicate; `withLockRetry` re-reads and merges to cover it.
        await tx.query(
          `INSERT IGNORE INTO overcap_unrestored (document_name, state_vector, recorded_at, updated_at)
           VALUES (?, '{}', NOW(3), NOW(3))`,
          [documentName],
        )
        const existing = (await selectForUpdate(tx, documentName)) ?? {}
        const merged: StateVectorMap = { ...existing }
        for (const [client, clock] of Object.entries(clean)) {
          if (clock > (merged[client] ?? 0)) merged[client] = clock
        }
        await tx.query(
          'UPDATE overcap_unrestored SET state_vector = ?, updated_at = NOW(3) WHERE document_name = ?',
          [JSON.stringify(merged), documentName],
        )
      }),
    )
  },

  /**
   * Every pending durable record, for the reconciliation drain. A fresh replica
   * has an empty in-memory queue but this table may hold records left by a pod
   * that died during the outage window; this is how it rebuilds the Redis marker.
   */
  async list(): Promise<UnrestoredRecord[]> {
    const rows = await query<{ document_name: string; state_vector: string }>(
      'SELECT document_name, state_vector FROM overcap_unrestored',
    )
    return rows
      .map((r) => ({ documentName: r.document_name, stateVector: parseStored(r.state_vector) }))
      .filter((r) => Object.keys(r.stateVector).length > 0)
  },

  /**
   * Remove ONLY the part of a record that was just recorded to Redis: a
   * concurrent rejection may have raised a client's floor since the reconcile
   * read the row, and that delta is not yet durable, so it must stay. Mirrors the
   * in-memory `drainUnrestoredRetry` discipline. When nothing above the recorded
   * floor remains the row is deleted; otherwise it is trimmed to the surviving
   * delta. Runs under the row lock so the trim is computed against the current
   * value, not a stale read.
   */
  async removeRecorded(documentName: string, recorded: StateVectorMap): Promise<void> {
    const rec = sanitizeStateVector(recorded)
    await transaction(async (tx) => {
      const existing = await selectForUpdate(tx, documentName)
      if (!existing) return
      let remaining: StateVectorMap | null = null
      for (const [client, clock] of Object.entries(existing)) {
        if (clock > (rec[client] ?? 0)) {
          remaining ??= {}
          remaining[client] = clock
        }
      }
      if (remaining) {
        await tx.query(
          'UPDATE overcap_unrestored SET state_vector = ?, updated_at = NOW(3) WHERE document_name = ?',
          [JSON.stringify(remaining), documentName],
        )
      } else {
        await tx.query('DELETE FROM overcap_unrestored WHERE document_name = ?', [documentName])
      }
    })
  },

  /**
   * Clear the record ONLY when `persisted` proves the rejected state was
   * accounted for: its state vector must DOMINATE the recorded one (carry every
   * recorded client at a clock at least as high). The same evidence
   * `resolveUnrestoredOverCap` requires of the Redis marker, so a durable record
   * that never reached Redis cannot be resurrected by a reconcile AFTER a
   * dominating store already recovered the state. An undominated store leaves the
   * row standing (fail closed). Runs under the row lock.
   */
  async removeIfDominated(documentName: string, persisted: StateVectorMap): Promise<void> {
    const have = sanitizeStateVector(persisted)
    await transaction(async (tx) => {
      const existing = await selectForUpdate(tx, documentName)
      if (!existing) return
      for (const [client, clock] of Object.entries(existing)) {
        if ((have[client] ?? 0) < clock) return // an undominated floor: keep protecting.
      }
      await tx.query('DELETE FROM overcap_unrestored WHERE document_name = ?', [documentName])
    })
  },
}
