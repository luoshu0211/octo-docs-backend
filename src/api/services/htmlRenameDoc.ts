/**
 * HTML 文档改名的两段式流程（OCTO-456 §4.8 / 评审 HIGH：操作身份与并发顺序）。
 *
 *   ┌ 短事务① ───────────────────────────────────────────────────────────┐
 *   │ lock doc_meta FOR UPDATE → 校验 status/space/(cli epoch+role)      │
 *   │ current == 目标标题?            → already（200，不再发版）          │
 *   │ 有 pending 且 from/to 相同      → 复用它的 id（响应丢失后的重试）   │
 *   │ 有 pending 但目标/起点不同      → 409 rename_in_progress            │
 *   │ pending 超过 10 分钟            → 标 failed 后按“没有 pending”继续 │
 *   │ 否则插入新 op(uuid, pending) → 提交                                 │
 *   └────────────────────────────────────────────────────────────────────┘
 *   ↓ 用 op.id 作为 idempotency_key 调 html republish（HTTP，不在事务里）
 *   ┌ 短事务② ───────────────────────────────────────────────────────────┐
 *   │ lock op FOR UPDATE → op completed? 幂等成功（不写 doc_meta）        │
 *   │ op 已 failed / 有更晚完成的 op → op failed，409 rename_superseded   │
 *   │ lock doc_meta → current != op.from_title → op failed，409 title_changed │
 *   │ 否则写 title + op 标 completed(version) → 提交                      │
 *   └────────────────────────────────────────────────────────────────────┘
 *
 * ── 为什么不能再用标题哈希做 key ─────────────────────────────────────────────
 * `sha256(docId\nbeforeTitle\ntitle)` 把“同一次改名的重试”和“若干步之后又出现
 * 相同标题的另一次改名”混为一谈:A→B→A→B 的第三次会命中第一步的 key,html 返回旧
 * 版本、不 +1,而 doc_meta 已经写成 B —— 两边永久不一致。操作 journal 给每一次
 * **逻辑改名**一个独立 id,重试才复用。
 *
 * ── 并发顺序 ────────────────────────────────────────────────────────────────
 * 两个并发请求 A→B / A→C:① 都在 doc_meta 行锁上串行化,第二个看到 pending 的 to
 * 不是自己,直接 409,不会出现“html 先 B 后 C、doc_meta 却先 C 后 B”的反向提交。
 * 同一 (from,to) 的并发重试共用一个 id,html 幂等,② 里的“current==目标”分支把
 * 后到的那次安全地当作已完成。
 *
 * 任何一步的 DB 失败都回 503 rename_failed 且保留 pending(事务回滚),客户端用同一
 * 请求重试即可命中同一个 op id。
 */
import { randomUUID } from 'node:crypto'
import { transaction, type Tx } from '../../db/pool.js'
import { docMetaRepo, type DocMeta } from '../../db/repos/docMetaRepo.js'
import { docMemberRepo } from '../../db/repos/docMemberRepo.js'
import {
  docRenameOperationRepo,
  RENAME_OP_COMPLETED,
  RENAME_OP_PENDING,
} from '../../db/repos/docRenameOperationRepo.js'
import { canRenameOriginal } from '../../permission/docCapabilities.js'
import type { ResolvedRole } from '../../permission/role.js'
import { republishHtmlTitle, closeHtmlRepublishReceipt } from './htmlTitleRepublish.js'

/**
 * A pending operation older than this is considered abandoned (the process that
 * created it crashed before completing the html call or the local commit). It is
 * marked failed and the next attempt starts a fresh operation. 10 minutes is far
 * beyond the html call's 5s timeout plus the local commit.
 */
export const RENAME_OPERATION_PENDING_TTL_MS = 10 * 60 * 1000

export interface HtmlRenameInput {
  docId: string
  /** doc_meta.space_id read by the route guard (the document's own Space). */
  docSpaceId: string
  uid: string
  /** Caller's verified principal Space; CLI lock rechecks need it. */
  principalSpaceId: string | null
  /** Request scope: 'human' | 'bot' | 'cli'. Only 'cli' rechecks epoch + role. */
  mode: string
  /** guard.meta.permission_epoch, enforced under the lock in cli mode. */
  expectedEpoch: number
  slug: string
  title: string
  /**
   * OCTO-456 §4.8 optimistic lock. When non-empty the current doc_meta.title
   * must still equal it under the prepare row lock; otherwise the rename is
   * answered 409 title_changed without publishing. Omitted/empty preserves the
   * historical behavior byte-for-byte.
   */
  expectedTitle?: string | null
}

export type HtmlRenameResult =
  /** `title` is what the route should report: the requested title normally, or
   * the CURRENT doc_meta title when a delayed duplicate found the operation
   * already completed (possibly after a later rename moved the doc elsewhere). */
  | { ok: true; alreadyApplied: boolean; title: string; beforeTitle: string; version: number | null }
  | {
    ok: false
    status: 403 | 409 | 503
    error: string
    /** 409 rename_recovery_required only: the remote title this doc needs. */
    pendingTitle?: string
    /** 409 title_changed only: the authoritative title observed under the lock. */
    currentTitle?: string
    version?: number | null
  }

type Prepared =
  | { kind: 'already'; beforeTitle: string }
  | { kind: 'proceed'; opId: string; fromTitle: string; revision: number }
  | {
    kind: 'failure'
    status: 403 | 409
    error: string
    pendingTitle?: string
    currentTitle?: string
    version?: number | null
  }

type CommitOutcome =
  | { ok: true; mode: 'applied' | 'already'; title: string; beforeTitle: string; version: number | null }
  | { ok: false; status: 403 | 409; error: string; currentTitle?: string; closeReceipt?: boolean }

function failure(status: 403 | 409 | 503, error: string): HtmlRenameResult {
  return { ok: false, status, error }
}

/**
 * Lock the document row and validate everything that must hold before publishing
 * a new html version. Also selects or creates the rename operation.
 */
async function prepare(tx: Tx, input: HtmlRenameInput): Promise<Prepared> {
  const [meta] = await tx.query<DocMeta>('SELECT * FROM doc_meta WHERE doc_id = ? FOR UPDATE', [input.docId])
  if (!meta) return { kind: 'failure', status: 409, error: 'conflict' }
  if (meta.status !== 1) return { kind: 'failure', status: 409, error: 'doc_archived' }
  if (meta.space_id !== input.docSpaceId) return { kind: 'failure', status: 409, error: 'conflict' }
  // P1-3: authorize BEFORE the irreversible html publish, for EVERY mode. The
  // route guard's read happened outside this lock; an epoch bump or a revoked
  // grant between then and now must stop the rename before a remote version is
  // created. The commit phase repeats these checks to cover the publish window.
  if (Number(meta.permission_epoch) !== input.expectedEpoch) {
    return { kind: 'failure', status: 409, error: 'conflict' }
  }
  if (!input.principalSpaceId) return { kind: 'failure', status: 403, error: 'forbidden' }
  // §4.8: the author identity is the COMPOUND (uid, owner Space), matching grey
  // visibility and every other mutation. A cross-Space owner has only its direct
  // member role (typically reader) and cannot impersonate the author.
  const principalSpaceId = input.principalSpaceId ?? ''
  const currentRole: ResolvedRole = meta.owner_id === input.uid && meta.owner_space_id === principalSpaceId
    ? 'admin'
    : (await docMemberRepo.getRoleTx(tx, meta.doc_id, input.uid, principalSpaceId, true)) ?? 'none'
  if (!canRenameOriginal(
    currentRole, meta.doc_type, meta.owner_id, meta.owner_space_id, input.uid, principalSpaceId,
  )) {
    return { kind: 'failure', status: 403, error: 'forbidden' }
  }

  const currentTitle = meta.title ?? ''

  // §4.8 optimistic lock: the caller's expected_title must still match the row
  // under the SAME lock that will create/resume the operation. Checked BEFORE
  // the pending/already shortcuts: two requests that both expect A and target
  // different titles must let exactly one through, not both.
  const expectedTitle = input.expectedTitle ?? ''
  if (expectedTitle !== '' && currentTitle !== expectedTitle) {
    return { kind: 'failure', status: 409, error: 'title_changed', currentTitle }
  }

  // Pending MUST be inspected before the "already at target" shortcut. If an
  // earlier A→B already published remotely but failed locally, doc_meta is still
  // A while a pending A→B exists. A request to "rename to A" would otherwise be
  // answered 200 as a no-op and strand that pending operation (and its remote
  // version) forever. Order:
  //   1. same from/to pending  → resume it (retry of the unfinished rename);
  //   2. current == target yet a DIFFERENT op is pending → 409 (the document's
  //      title is moving; finish/retry the pending rename first);
  //   3. no pending            → a genuine no-op, 200.
  const pending = await docRenameOperationRepo.getLatestPendingForDocTx(tx, input.docId)
  if (pending && pending.from_title === currentTitle && pending.to_title === input.title) {
    // Same logical rename retry — reuse the id REGARDLESS of age. The html side
    // may already have published under this key (local write failed / response
    // lost), so allocating a new id after the TTL would publish a duplicate
    // version and split the two stores. Touch updated_at for observability.
    await docRenameOperationRepo.touchPendingTx(tx, pending.id)
    return { kind: 'proceed', opId: pending.id, fromTitle: pending.from_title, revision: pending.revision }
  }
  if (pending && currentTitle === input.title) {
    // Target already matches the local title, but an unfinished operation is
    // still holding this document. Do NOT report success: the caller should
    // retry the pending rename instead of silently abandoning it.
    return { kind: 'failure', status: 409, error: 'rename_in_progress' }
  }
  if (pending) {
    // A DIFFERENT rename is pending. TTL may reclaim an abandoned one (the
    // process died before publishing), but that is an explicit fence: the old op
    // is marked failed here so its late commit can never write doc_meta.
    if (Date.now() - new Date(pending.updated_at).getTime() >= RENAME_OPERATION_PENDING_TTL_MS) {
      await docRenameOperationRepo.markFailedTx(tx, pending.id)
    } else {
      return { kind: 'failure', status: 409, error: 'rename_in_progress' }
    }
  }

  // Half-success recovery / mismatch detection. A previous attempt published an
  // html version but the local write was refused (grant/epoch changed between
  // publish and commit); the op was marked failed WITH that version. This must be
  // resolved BEFORE the "already at target" shortcut: a failed A→B leaves the
  // remote on B while doc_meta is still A, so a later A→A request must NOT be
  // answered 200 — the two stores disagree.
  const failed = await docRenameOperationRepo.getLatestFailedForDocTx(tx, input.docId)
  if (failed && failed.version !== null) {
    const superseded = await docRenameOperationRepo.getLatestCompletedAfterTx(tx, input.docId, failed.revision)
    if (!superseded) {
      if (failed.from_title === currentTitle && failed.to_title === input.title) {
        // Same rename: resume the SAME id so html replays that version.
        await docRenameOperationRepo.resumeFailedTx(tx, failed.id)
        return { kind: 'proceed', opId: failed.id, fromTitle: failed.from_title, revision: failed.revision }
      }
      if (failed.to_title !== currentTitle) {
        return {
          kind: 'failure',
          status: 409,
          error: 'rename_recovery_required',
          pendingTitle: failed.to_title,
          version: failed.version,
        }
      }
      // failed.to_title === currentTitle: remote and local titles agree (the local
      // write actually landed or someone converged it), so "already" is safe.
    }
  }

  if (currentTitle === input.title) return { kind: 'already', beforeTitle: currentTitle }

  const opId = randomUUID()
  await docRenameOperationRepo.insertPendingTx(tx, {
    id: opId,
    docId: input.docId,
    fromTitle: currentTitle,
    toTitle: input.title,
  })
  // The revision is DB-generated (AUTO_INCREMENT); read it back so the html call
  // carries the monotonic fence value for THIS operation.
  const created = await docRenameOperationRepo.getByIdTx(tx, opId)
  if (!created) return { kind: 'failure', status: 409, error: 'conflict' }
  return { kind: 'proceed', opId, fromTitle: currentTitle, revision: created.revision }
}

/**
 * Second phase: fence the operation, then write atomically.
 *
 * Fencing is by OPERATION STATE + revision order, never by title equality alone:
 * the same title can reappear legitimately (A→B→A), so a delayed duplicate of an
 * old A→B must not be allowed to write B again after B→A has completed. The op
 * row lock makes every commit of one operation mutually exclusive, and the
 * "newer completed op" probe rejects an operation that has been superseded.
 */
async function commit(
  input: HtmlRenameInput,
  opId: string,
  version: number | null,
  publishSeq: number | null,
): Promise<CommitOutcome> {
  return transaction(async (tx): Promise<CommitOutcome> => {
    // P2-1: SAME lock order as prepare — doc_meta row first, then the operation
    // row. The reverse order (op → doc_meta) let a prepare (doc_meta → op insert)
    // and a commit deadlock on the same document.
    const [meta] = await tx.query<DocMeta>('SELECT * FROM doc_meta WHERE doc_id = ? FOR UPDATE', [input.docId])
    if (!meta) {
      await docRenameOperationRepo.markFailedWithVersionTx(tx, opId, version)
      return { ok: false, status: 409, error: 'conflict' }
    }
    if (meta.status !== 1) {
      await docRenameOperationRepo.markFailedWithVersionTx(tx, opId, version)
      return { ok: false, status: 409, error: 'doc_archived' }
    }
    if (meta.space_id !== input.docSpaceId) {
      await docRenameOperationRepo.markFailedWithVersionTx(tx, opId, version)
      return { ok: false, status: 409, error: 'conflict' }
    }
    // P1-2: re-verify the epoch and the rename authority for EVERY mode, not
    // just CLI. The html publish happened outside these locks, so a revocation
    // or an ACL change during that window must not be followed by a local write.
    if (Number(meta.permission_epoch) !== input.expectedEpoch) {
      await docRenameOperationRepo.markFailedWithVersionTx(tx, opId, version)
      // Remote version is already published; local state refuses. Same refusal
      // code the route uses when the title moved under it.
      return { ok: false, status: 409, error: 'title_changed', currentTitle: meta.title ?? '' }
    }
    if (!input.principalSpaceId) {
      await docRenameOperationRepo.markFailedWithVersionTx(tx, opId, version)
      return { ok: false, status: 403, error: 'forbidden' }
    }
    // Same compound author contract as prepare: a cross-Space owner has only its
    // direct member role and is refused if that role cannot rename.
    const principalSpaceId = input.principalSpaceId ?? ''
    const owner = meta.owner_id === input.uid && meta.owner_space_id === principalSpaceId
    const role: ResolvedRole = owner
      ? 'admin'
      : (await docMemberRepo.getRoleTx(tx, meta.doc_id, input.uid, principalSpaceId, true)) ?? 'none'
    if (!canRenameOriginal(role, meta.doc_type, meta.owner_id, meta.owner_space_id, input.uid, principalSpaceId)) {
      await docRenameOperationRepo.markFailedWithVersionTx(tx, opId, version)
      return { ok: false, status: 403, error: 'forbidden' }
    }

    const op = await docRenameOperationRepo.getByIdForUpdateTx(tx, opId)
    if (!op) return { ok: false, status: 409, error: 'rename_superseded' }

    // (1) Another duplicate of THIS operation already committed. Report success
    // against the CURRENT document title (which a later rename may have moved
    // elsewhere) without writing anything.
    if (op.status === RENAME_OP_COMPLETED) {
      return {
        ok: true,
        mode: 'already',
        title: meta.title ?? op.to_title,
        beforeTitle: op.from_title,
        version: op.version,
      }
    }
    // (2) The operation was explicitly fenced (stale TTL reclaim or a failed
    // commit). It must never write doc_meta again.
    if (op.status !== RENAME_OP_PENDING) {
      return { ok: false, status: 409, error: 'rename_superseded' }
    }
    // (3) A LATER logical rename already completed while we were publishing.
    // Our html version is now stale; never overwrite the newer local title.
    const newer = await docRenameOperationRepo.getLatestCompletedAfterTx(tx, input.docId, op.revision)
    if (newer) {
      // Terminal but NOT a half-success: a newer rename owns the title, so
      // recovery must never resurrect this one (see markSupersededTx).
      await docRenameOperationRepo.markSupersededTx(tx, opId, version)
      // Superseded by a newer completed rename: this operation can never be
      // resumed, so its html replay receipt may be dropped.
      return { ok: false, status: 409, error: 'rename_superseded', closeReceipt: true }
    }

    /**
     * Record the publish order this rename committed, in the SAME transaction as
     * the title. A late post-publish callback from an older HTML write would
     * otherwise still be newer than the last callback watermark and roll the
     * library title back; the callback path fences on this sequence.
     *
     * Runs in the "title already correct" branch too: the html side has committed
     * a new publish sequence even when doc_meta.title did not change.
     */
    const recordAppliedPublish = async (): Promise<void> => {
      if (publishSeq === null && version === null) return
      await tx.query(
        `UPDATE doc_meta
            SET html_publish_seq = GREATEST(html_publish_seq, ?),
                html_publish_version = GREATEST(html_publish_version, ?)
          WHERE doc_id = ?`,
        [publishSeq ?? 0, version ?? 0, meta.doc_id],
      )
    }

    /**
     * Is THIS rename's published write already superseded by a newer applied
     * title write?
     *
     * The ordering fence has to run BEFORE the title is written, not only on the
     * watermark. `GREATEST` keeps the largest sequence, but a rename that started
     * earlier can still reach this branch after a newer HTML callback already
     * committed a different title: its `from_title` still matches the current row,
     * so the ordinary optimistic check passes and the OLD title would be written
     * back while the watermark stays at the newer sequence — Docs then reports a
     * title that no HTML version contains.
     *
     * A rename whose sequence is at/below the applied one is superseded: the
     * journal is closed without writing, and the caller gets 409 rename_superseded
     * (the same terminal answer as "a later logical rename already completed").
     * Renames with no sequence (older HTML instances) keep the previous behaviour.
     */
    const appliedSeq = Number((meta as { html_publish_seq?: number | string }).html_publish_seq ?? 0)
    if (publishSeq !== null && publishSeq > 0 && publishSeq <= appliedSeq) {
      // A newer applied publish already owns the title. Recorded as superseded
      // rather than failed-with-version: the next independent rename must not be
      // told to "recover" a title that a newer write legitimately replaced.
      await docRenameOperationRepo.markSupersededTx(tx, opId, version)
      // The html receipt for this operation is spent: a retry must allocate a new
      // operation (with a higher revision) instead of replaying a superseded one.
      return { ok: false, status: 409, error: 'rename_superseded', closeReceipt: true }
    }

    const currentTitle = meta.title ?? ''
    if (currentTitle === input.title) {
      await recordAppliedPublish()
      await docRenameOperationRepo.markCompletedTx(tx, opId, version)
      return {
        ok: true,
        mode: 'applied',
        title: currentTitle,
        beforeTitle: op.from_title,
        version,
      }
    }
    if (currentTitle !== op.from_title) {
      // Someone else changed the title while html was publishing. Never
      // overwrite: the published version no longer corresponds to a writable
      // local state.
      await docRenameOperationRepo.markFailedWithVersionTx(tx, opId, version)
      return { ok: false, status: 409, error: 'title_changed', currentTitle }
    }
    await docMetaRepo.rename(input.docId, input.title, input.uid, tx)
    await recordAppliedPublish()
    await docRenameOperationRepo.markCompletedTx(tx, opId, version)
    return {
      ok: true,
      mode: 'applied',
      title: input.title,
      beforeTitle: op.from_title,
      version,
    }
  })
}

type StaleOutcome =
  /** The journal operation already committed: replay its success. */
  | { kind: 'replayed'; outcome: CommitOutcome }
  /** The operation is pending but a later logical rename already completed. */
  | { kind: 'superseded' }
  /** Still pending and not superseded: the html fence may clear on a retry. */
  | { kind: 'retry' }

/**
 * Late `stale_revision` handling (P2).
 *
 * The html monotonic fence rejects a revision that is not higher than the
 * document's max published revision. That happens in two very different
 * situations, and treating both as a terminal failure was wrong:
 *
 *   1. Two in-flight requests of the SAME operation: the first commits and
 *      closes its receipt; the later one reaches html after the close and gets
 *      stale_revision. Its journal row is COMPLETED — this is a successful
 *      duplicate, so replay it as 200 (never markFailed / 409).
 *   2. A genuinely newer rename completed while this op was publishing. Its row
 *      is still PENDING and a higher completed revision exists — only then is it
 *      superseded (409), and it can never be resumed.
 *
 * A pending op that is not superseded leaves no local proof of a later commit;
 * keep it pending and answer 503 so the caller retries (a later retry either
 * replays the completed row or observes the superseding commit).
 *
 * Locks are taken in the SAME order as prepare/commit: doc_meta row first, then
 * the operation row.
 */
async function classifyStaleRevision(input: HtmlRenameInput, opId: string): Promise<StaleOutcome> {
  return transaction(async (tx): Promise<StaleOutcome> => {
    const [meta] = await tx.query<DocMeta>('SELECT * FROM doc_meta WHERE doc_id = ? FOR UPDATE', [input.docId])
    const op = await docRenameOperationRepo.getByIdForUpdateTx(tx, opId)
    if (!op) return { kind: 'superseded' }
    if (op.status === RENAME_OP_COMPLETED) {
      return {
        kind: 'replayed',
        outcome: {
          ok: true,
          mode: 'already',
          title: meta?.title ?? op.to_title,
          beforeTitle: op.from_title,
          version: op.version,
        },
      }
    }
    if (op.status === RENAME_OP_PENDING) {
      const newer = await docRenameOperationRepo.getLatestCompletedAfterTx(tx, op.doc_id, op.revision)
      if (newer) {
        // Terminal: this op can never publish again, so its html receipt (if any)
        // may be closed by the caller.
        await docRenameOperationRepo.markFailedWithVersionTx(tx, opId, null)
        return { kind: 'superseded' }
      }
      // The fence proves html is ahead, but no later LOCAL rename completed. Do
      // not claim supersession (there is nothing newer to replay). Fail this op
      // without a version so a retry allocates a FRESH operation with a higher
      // revision instead of reusing an id html will keep rejecting.
      await docRenameOperationRepo.markFailedWithVersionTx(tx, opId, null)
      return { kind: 'retry' }
    }
    // Already failed/fenced (TTL reclaim or a refused commit): terminal.
    return { kind: 'superseded' }
  })
}

/**
 * Execute the two-step html rename. Never throws: every failure is a closed
 * result so the route can answer without writing doc_meta on a partial failure.
 */
export async function renameHtmlDoc(input: HtmlRenameInput): Promise<HtmlRenameResult> {
  let prepared: Prepared
  try {
    prepared = await transaction((tx) => prepare(tx, input))
  } catch {
    return failure(503, 'rename_failed')
  }
  if (prepared.kind === 'failure') {
    return {
      ok: false,
      status: prepared.status,
      error: prepared.error,
      ...(prepared.pendingTitle !== undefined ? { pendingTitle: prepared.pendingTitle } : {}),
      ...(prepared.currentTitle !== undefined ? { currentTitle: prepared.currentTitle } : {}),
      ...(prepared.version !== undefined ? { version: prepared.version } : {}),
    }
  }
  if (prepared.kind === 'already') {
    return {
      ok: true,
      alreadyApplied: true,
      title: prepared.beforeTitle,
      beforeTitle: prepared.beforeTitle,
      version: null,
    }
  }

  // The html call happens outside any transaction: it must never hold a row lock
  // across a network round-trip.
  const republished = await republishHtmlTitle({
    slug: input.slug,
    docId: input.docId,
    spaceId: input.docSpaceId,
    title: input.title,
    idempotencyKey: prepared.opId,
    revision: prepared.revision,
  })
  if (!republished.ok) {
    if (republished.reason === 'stale_revision') {
      let stale: StaleOutcome
      try {
        stale = await classifyStaleRevision(input, prepared.opId)
      } catch {
        return failure(503, 'rename_failed')
      }
      if (stale.kind === 'replayed' && stale.outcome.ok) {
        // The first request already committed and closed the receipt; this late
        // duplicate is a success, not a conflict. Do not close again.
        return {
          ok: true,
          alreadyApplied: stale.outcome.mode === 'already',
          title: stale.outcome.title,
          beforeTitle: stale.outcome.beforeTitle,
          version: stale.outcome.version,
        }
      }
      if (stale.kind === 'superseded') {
        // A later completed rename owns the document now. The stale attempt's
        // receipt is useless and may be reclaimed; never write doc_meta.
        await closeHtmlRepublishReceipt({
          slug: input.slug, docId: input.docId, spaceId: input.docSpaceId, idempotencyKey: prepared.opId,
        })
        return failure(409, 'rename_superseded')
      }
      // Pending but no later local commit: the op was fenced failed above so a
      // retry allocates a fresh higher revision. Answer 503 (retryable) — only a
      // PROVEN supersession answers 409 rename_superseded.
      return failure(503, 'rename_failed')
    }
    if (republished.reason === 'identity_mismatch' || republished.reason === 'identity_unverified') {
      // The asserted doc_meta identity is not (or cannot be proven to be) the
      // document bound to this slug in octo-docs-html. Publishing would mutate
      // the wrong document, so fail this operation closed (no doc_meta write)
      // and surface the upstream 409 verbatim — never as a retryable 503.
      try {
        await transaction((tx) => docRenameOperationRepo.markFailedTx(tx, prepared.opId))
      } catch {
        return failure(503, 'rename_failed')
      }
      return failure(409, republished.reason)
    }
    // Pending stays in place: a retry reuses this op id and html replays the
    // already-published version instead of creating another one.
    return failure(503, 'rename_failed')
  }

  let committed: CommitOutcome
  try {
    committed = await commit(input, prepared.opId, republished.version, republished.publishSeq)
  } catch {
    return failure(503, 'rename_failed')
  }
  if (!committed.ok) {
    if (committed.closeReceipt) {
      await closeHtmlRepublishReceipt({
        slug: input.slug, docId: input.docId, spaceId: input.docSpaceId, idempotencyKey: prepared.opId,
      })
    }
    return {
      ok: false,
      status: committed.status,
      error: committed.error,
      ...(committed.currentTitle !== undefined ? { currentTitle: committed.currentTitle } : {}),
    }
  }

  // Terminal success: the receipt is no longer needed for replay. Best-effort;
  // a close failure only warns.
  await closeHtmlRepublishReceipt({
    slug: input.slug, docId: input.docId, spaceId: input.docSpaceId, idempotencyKey: prepared.opId,
  })

  return {
    ok: true,
    // 'already' means an earlier duplicate committed the same operation; the
    // document may since have moved on (A→B→A), so report its CURRENT title.
    alreadyApplied: committed.mode === 'already',
    title: committed.title,
    beforeTitle: committed.beforeTitle,
    version: committed.version,
  }
}

export interface HtmlPublishTitleCallbackInput {
  docId: string
  slug: string
  spaceId: string
  /** Verified Bot uid that delivered the callback (req.uid). */
  uid: string
  /** Verified human owner of that Bot (req.botOwnerUid), if any. */
  botOwnerUid?: string | null
  title: string
  expectedTitle?: string | null
  /** Published version of the callback; >0 enables stale-callback fencing. */
  version?: number | null
  /**
   * Monotonic publish sequence of the callback's write. Preferred over `version`
   * for ordering: an explicit republish can give two different titles the same
   * content version, so only the sequence tells which one is newer. Older HTML
   * instances omit it and fall back to the version watermark.
   */
  publishSeq?: number | null
}

export type HtmlPublishTitleCallbackResult =
  | { ok: true; changed: boolean; title: string; beforeTitle: string }
  | { ok: false; status: 403 | 404 | 409 | 503; error: string; currentTitle?: string }

/**
 * OCTO-456 §4.8 HTML publish callback — metadata only.
 *
 * After octo-docs-html commits a new version it PATCHes `/octo-doc/:slug` with
 * the title that version rendered. That callback must NOT go through the rename
 * journal: the HTML side already published, so republishing would mint yet
 * another version for every publish. It only converges doc_meta.title.
 *
 * Identity is verified fail-closed:
 *   · exact slug binding — the route resolved this docId from the slug inside
 *     the Bot's server-resolved Space, and we re-check doc_type/space/slug under
 *     the row lock so a concurrent re-registration cannot redirect the write;
 *   · trusted publisher — only the document's owner (the publishing Bot) or that
 *     Bot's verified human owner may assert the rendered title. Any other shared
 *     admin Bot can still rename through the normal journaled docId route, but
 *     cannot silently desync HTML by using the callback surface.
 *
 * The compare (expected_title) and the write share one `FOR UPDATE` row lock, so
 * two concurrent callbacks cannot both "win".
 */
export async function applyHtmlPublishTitle(
  input: HtmlPublishTitleCallbackInput,
): Promise<HtmlPublishTitleCallbackResult> {
  try {
    return await transaction(async (tx): Promise<HtmlPublishTitleCallbackResult> => {
      const [meta] = await tx.query<DocMeta>('SELECT * FROM doc_meta WHERE doc_id = ? FOR UPDATE', [input.docId])
      if (
        !meta
        || meta.space_id !== input.spaceId
        || meta.doc_type !== 'html'
        || meta.octo_doc_slug !== input.slug
        || meta.status === 0
      ) {
        return { ok: false, status: 404, error: 'not_found' }
      }
      if (meta.status !== 1) return { ok: false, status: 409, error: 'doc_archived' }

      const ownerMatches = (ownerId: string | undefined | null): boolean =>
        typeof ownerId === 'string' && ownerId !== ''
        && meta.owner_id === ownerId && meta.owner_space_id === input.spaceId
      const trustedPublisher = ownerMatches(input.uid) || ownerMatches(input.botOwnerUid)
      if (!trustedPublisher) return { ok: false, status: 403, error: 'forbidden' }

      const currentTitle = meta.title ?? ''
      const expectedTitle = input.expectedTitle ?? ''
      if (expectedTitle !== '' && currentTitle !== expectedTitle) {
        return { ok: false, status: 409, error: 'title_changed', currentTitle }
      }
      // HTML releases its lock before notifying us, so v3 may arrive before v2.
      // A callback at or below the applied watermark must never roll the title
      // back; only a strictly newer write may commit.
      //
      // The sequence is the primary fence: a library rename may have committed a
      // later publish (recorded in the same transaction as its title), and an
      // explicit republish can give two titles the same content version — only
      // the sequence orders those. Version remains the fallback for HTML
      // instances that do not send one yet.
      const incomingSeq = Number(input.publishSeq ?? 0)
      const incomingVersion = Number(input.version ?? 0)
      const appliedSeq = Number((meta as { html_publish_seq?: number | string }).html_publish_seq ?? 0)
      if (incomingSeq > 0) {
        if (incomingSeq <= appliedSeq) {
          return { ok: true, changed: false, title: currentTitle, beforeTitle: currentTitle }
        }
        await tx.query(
          `UPDATE doc_meta
              SET title = ?, updated_by = ?,
                  html_publish_seq = ?,
                  html_publish_version = GREATEST(html_publish_version, ?)
            WHERE doc_id = ?`,
          [input.title, input.uid, incomingSeq, incomingVersion > 0 ? incomingVersion : 0, meta.doc_id],
        )
        return { ok: true, changed: currentTitle !== input.title, title: input.title, beforeTitle: currentTitle }
      }
      if (incomingVersion > 0) {
        const applied = Number((meta as { html_publish_version?: number | string }).html_publish_version ?? 0)
        if (incomingVersion <= applied) {
          return { ok: true, changed: false, title: currentTitle, beforeTitle: currentTitle }
        }
        await tx.query(
          'UPDATE doc_meta SET title = ?, updated_by = ?, html_publish_version = ? WHERE doc_id = ?',
          [input.title, input.uid, incomingVersion, meta.doc_id],
        )
        return { ok: true, changed: currentTitle !== input.title, title: input.title, beforeTitle: currentTitle }
      }
      if (currentTitle === input.title) {
        return { ok: true, changed: false, title: currentTitle, beforeTitle: currentTitle }
      }
      await docMetaRepo.rename(meta.doc_id, input.title, input.uid, tx)
      return { ok: true, changed: true, title: input.title, beforeTitle: currentTitle }
    })
  } catch {
    return { ok: false, status: 503, error: 'rename_failed' }
  }
}
