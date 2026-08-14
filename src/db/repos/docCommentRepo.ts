/**
 * doc_comment repository (feature #3 — inline comments).
 *
 * Stores inline-comment threads out-of-band from the Y.Doc: a thread root
 * (parent_id IS NULL) carries the opaque Yjs RelativePosition anchor bytes; its
 * replies (parent_id -> root id, single-level nesting) carry no anchors. The
 * server never parses the anchor bytes — they are read/written as opaque BLOBs.
 *
 * The id is allocated by the DB (AUTO_INCREMENT), never app-side. Columns map
 * snake_case -> camelCase in the typed return (see DocComment).
 */
import { query, transaction } from '../pool.js'

export interface DocComment {
  id: number
  docId: string
  documentName: string
  parentId: number | null
  authorUid: string
  body: string
  anchorStart: Buffer | null
  anchorEnd: Buffer | null
  anchorText: string
  resolved: boolean
  resolvedBy: string | null
  resolvedAt: Date | null
  deleted: boolean
  createdAt: Date
  updatedAt: Date
}

interface DocCommentRow {
  id: number | string
  doc_id: string
  document_name: string
  parent_id: number | string | null
  author_uid: string
  body: string
  anchor_start: Buffer | null
  anchor_end: Buffer | null
  anchor_text: string
  resolved: number
  resolved_by: string | null
  resolved_at: Date | null
  deleted: number
  created_at: Date
  updated_at: Date
}

function mapRow(row: DocCommentRow): DocComment {
  return {
    id: Number(row.id),
    docId: row.doc_id,
    documentName: row.document_name,
    parentId: row.parent_id == null ? null : Number(row.parent_id),
    authorUid: row.author_uid,
    body: row.body,
    anchorStart: row.anchor_start ?? null,
    anchorEnd: row.anchor_end ?? null,
    anchorText: row.anchor_text,
    resolved: row.resolved === 1,
    resolvedBy: row.resolved_by ?? null,
    resolvedAt: row.resolved_at ?? null,
    deleted: row.deleted === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export interface DocCommentMarker {
  id: number
  anchorStart: Buffer
  anchorEnd: Buffer
  anchorText: string
  resolved: boolean
  updatedAt: Date
}

interface DocCommentMarkerRow {
  id: number | string
  anchor_start: Buffer
  anchor_end: Buffer
  anchor_text: string
  resolved: number
  updated_at: Date
}

export interface CreateCommentInput {
  docId: string
  documentName: string
  parentId: number | null
  authorUid: string
  body: string
  /** Opaque RelativePosition bytes; root only (NULL for replies). */
  anchorStart: Buffer | null
  anchorEnd: Buffer | null
  anchorText: string
}

export interface ListRootsOptions {
  includeResolved: boolean
  /** Return roots with id strictly greater than this cursor (ascending paging). */
  cursor: number | null
  limit: number
}

export const docCommentRepo = {
  /**
   * Insert a root or reply and return the DB-assigned id. Runs in a transaction
   * so LAST_INSERT_ID() is read on the same connection that did the INSERT.
   */
  async create(input: CreateCommentInput): Promise<number> {
    return transaction(async (tx) => {
      await tx.query(
        `INSERT INTO doc_comment
           (doc_id, document_name, parent_id, author_uid, body, anchor_start, anchor_end, anchor_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.docId,
          input.documentName,
          input.parentId,
          input.authorUid,
          input.body,
          input.anchorStart,
          input.anchorEnd,
          input.anchorText,
        ],
      )
      const rows = await tx.query<{ id: number | string }>('SELECT LAST_INSERT_ID() AS id')
      return Number(rows[0]?.id ?? 0)
    })
  },

  async createReplyIfRoot(input: Omit<CreateCommentInput, 'anchorStart' | 'anchorEnd' | 'anchorText'>): Promise<number | null> {
    return transaction(async (tx) => {
      const roots = await tx.query<{ id: number | string }>(
        `SELECT id FROM doc_comment
          WHERE id = ? AND doc_id = ? AND parent_id IS NULL AND deleted = 0
          FOR UPDATE`,
        [input.parentId, input.docId],
      )
      if (!roots[0]) return null
      await tx.query(
        `INSERT INTO doc_comment
           (doc_id, document_name, parent_id, author_uid, body, anchor_start, anchor_end, anchor_text)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, '')`,
        [input.docId, input.documentName, input.parentId, input.authorUid, input.body],
      )
      const rows = await tx.query<{ id: number | string }>('SELECT LAST_INSERT_ID() AS id')
      return Number(rows[0]?.id ?? 0)
    })
  },

  async getById(id: number): Promise<DocComment | null> {
    const rows = await query<DocCommentRow>('SELECT * FROM doc_comment WHERE id = ? LIMIT 1', [id])
    return rows[0] ? mapRow(rows[0]) : null
  },

  /** All non-deleted comments for a doc (roots + replies), oldest first. */
  async listByDoc(docId: string): Promise<DocComment[]> {
    const rows = await query<DocCommentRow>(
      'SELECT * FROM doc_comment WHERE doc_id = ? AND deleted = 0 ORDER BY id ASC',
      [docId],
    )
    return rows.map(mapRow)
  },

  /** Thread roots for a doc, ascending by id, cursor-paginated. */
  async listRoots(docId: string, opts: ListRootsOptions): Promise<DocComment[]> {
    const where = ['doc_id = ?', 'parent_id IS NULL', 'deleted = 0']
    const args: unknown[] = [docId]
    if (!opts.includeResolved) {
      where.push('resolved = 0')
    }
    if (opts.cursor != null) {
      where.push('id > ?')
      args.push(opts.cursor)
    }
    // `query()` runs on mysql2 `.execute()` (a prepared statement), which rejects
    // a numeric LIMIT bound via `?` with ER_WRONG_ARGUMENTS (errno 1210) — a
    // guaranteed 500. `opts.limit` is not clamped at the call site, so coerce and
    // clamp it to a positive integer in 1..100 here; the result is provably an
    // integer and is therefore safe to inline directly (no injection surface).
    const lim = Math.min(100, Math.max(1, Number.isInteger(opts.limit) ? opts.limit : 20))
    const rows = await query<DocCommentRow>(
      `SELECT * FROM doc_comment WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT ${lim}`,
      [...args],
    )
    return rows.map(mapRow)
  },

  /** Lightweight unresolved roots for board marker hydration. */
  async listUnresolvedMarkers(docId: string, cursor: number | null, limit: number): Promise<DocCommentMarker[]> {
    const lim = Math.min(100, Math.max(1, Number.isInteger(limit) ? limit : 50))
    const cursorClause = cursor == null ? '' : ' AND id > ?'
    const args: unknown[] = cursor == null ? [docId] : [docId, cursor]
    const rows = await query<DocCommentMarkerRow>(
      `SELECT id, anchor_start, anchor_end, anchor_text, resolved, updated_at
         FROM doc_comment
        WHERE doc_id = ? AND parent_id IS NULL AND deleted = 0 AND resolved = 0${cursorClause}
        ORDER BY id ASC LIMIT ${lim}`,
      args,
    )
    return rows.map((row) => ({
      id: Number(row.id),
      anchorStart: row.anchor_start,
      anchorEnd: row.anchor_end,
      anchorText: row.anchor_text,
      resolved: row.resolved === 1,
      updatedAt: row.updated_at,
    }))
  },

  /** Non-deleted replies of a thread root, oldest first. */
  async listReplies(parentId: number): Promise<DocComment[]> {
    const rows = await query<DocCommentRow>(
      'SELECT * FROM doc_comment WHERE parent_id = ? AND deleted = 0 ORDER BY id ASC',
      [parentId],
    )
    return rows.map(mapRow)
  },

  /**
   * Non-deleted replies for many thread roots in a single query, oldest first.
   * Lets the list path avoid an N+1 (one listReplies per root); callers group
   * the flat result by parentId. Returns [] without querying when given no ids.
   *
   * The pool's `query()` helper runs on `.execute()` (a prepared statement), and
   * mysql2 does NOT expand an array bound to a single `IN (?)` placeholder under
   * `.execute()` — that array-expansion only happens on `.query()`. So we build
   * one `?` placeholder per id and pass a FLAT param list (one value per
   * placeholder); binding the nested array against `IN (?)` would match zero
   * rows and silently drop every reply.
   */
  async listRepliesForRoots(rootIds: number[]): Promise<DocComment[]> {
    if (rootIds.length === 0) return []
    const placeholders = rootIds.map(() => '?').join(', ')
    const rows = await query<DocCommentRow>(
      `SELECT * FROM doc_comment WHERE parent_id IN (${placeholders}) AND deleted = 0 ORDER BY id ASC`,
      rootIds,
    )
    return rows.map(mapRow)
  },

  /**
   * Rewrite the anchors of many thread roots in ONE transaction.
   *
   * Batched, not looped: a single row insert can shift dozens of anchors, and applying them one at a
   * time leaves the set half migrated on any partial failure — some comments moved, some not, with
   * nothing recording which. All-or-nothing is the only state a client can reason about.
   *
   * `anchor_text` is deliberately NOT touched. That snapshot is the evidence trail: if an anchor is
   * ever rewritten to the wrong place, the preserved original text stops agreeing with whatever now
   * sits at the new coordinate, which makes the mistake visible instead of silent. Refreshing it here
   * would erase exactly that signal. (schema.sql also documents it as display/audit only.)
   *
   * Scoped by `doc_id` in the WHERE clause as defence in depth: the route already verified every id
   * belongs to this document, but a cross-document write must not be reachable by a single bad param.
   * Replies are excluded via `parent_id IS NULL` — the schema CHECK requires their anchors to stay
   * NULL, so an UPDATE that set them would be rejected by the database anyway; failing to match is the
   * safer of the two.
   *
   * No row count is returned: `Tx` exposes only `query`, and more importantly the route has already
   * confirmed every id exists, belongs to this doc, and is a live thread root — so a zero-match here
   * would mean a concurrent delete, not a caller mistake. Re-deriving that in the repo would duplicate
   * a check the route cannot skip anyway.
   */
  async updateAnchors(
    docId: string,
    anchors: ReadonlyArray<{ id: number; anchorStart: Buffer; anchorEnd: Buffer }>,
  ): Promise<void> {
    if (anchors.length === 0) return
    // Lock in a DETERMINISTIC order, not the caller's array order. Each UPDATE takes a row lock held
    // until the transaction commits, so two concurrent batches that share rows and arrive in opposite
    // order deadlock: A holds 7 and waits for 8 while B holds 8 and waits for 7. The caller's order is
    // the client's payload order, which for this endpoint is whatever order the sheet's structural edit
    // happened to enumerate comments in — two users editing the same sheet routinely produce different
    // ones. Sorting by id here (rather than asking callers to) makes every batch in the process acquire
    // locks along the same path, which is what removes the cycle; a caller cannot opt out of it.
    const ordered = [...anchors].sort((a, b) => a.id - b.id)
    await transaction(async (tx) => {
      for (const a of ordered) {
        await tx.query(
          'UPDATE doc_comment SET anchor_start = ?, anchor_end = ? WHERE id = ? AND doc_id = ? AND parent_id IS NULL AND deleted = 0',
          [a.anchorStart, a.anchorEnd, a.id, docId],
        )
      }
    })
  },

  async updateBody(id: number, body: string): Promise<void> {
    await query('UPDATE doc_comment SET body = ? WHERE id = ?', [body, id])
  },

  /** Resolve / reopen a thread root; stamps resolved_by/resolved_at when set. */
  async setResolved(id: number, resolved: boolean, byUid: string): Promise<void> {
    if (resolved) {
      await query(
        'UPDATE doc_comment SET resolved = 1, resolved_by = ?, resolved_at = CURRENT_TIMESTAMP(3) WHERE id = ?',
        [byUid, id],
      )
    } else {
      await query(
        'UPDATE doc_comment SET resolved = 0, resolved_by = NULL, resolved_at = NULL WHERE id = ?',
        [id],
      )
    }
  },

  async softDelete(id: number): Promise<void> {
    await query('UPDATE doc_comment SET deleted = 1 WHERE id = ?', [id])
  },

  /**
   * Hard delete (admin moderation). Cascades to child replies so a removed
   * thread root never leaves orphaned reply rows detached from any thread.
   * Runs both the root row and its replies in one transaction. When the target
   * is a reply (its id is never another row's parent_id under single-level
   * nesting), the `parent_id = ?` arm matches nothing and only that one row goes.
   *
   * Scoped to `doc_id` as defense-in-depth: a destructive cascade must not rely
   * solely on the caller having pre-bounded the doc. The `(id = ? OR parent_id
   * = ?) AND doc_id = ?` form removes the root + its replies within the doc and
   * can never touch another doc's rows.
   */
  async hardDelete(id: number, docId: string): Promise<void> {
    await transaction(async (tx) => {
      // Serialize with createReplyIfRoot's root lock. If reply creation wins,
      // this delete waits and then removes the committed reply; if deletion
      // wins, the reply path waits and subsequently finds no valid root.
      await tx.query(
        'SELECT id FROM doc_comment WHERE id = ? AND doc_id = ? FOR UPDATE',
        [id, docId],
      )
      await tx.query(
        'DELETE FROM doc_comment WHERE (id = ? OR parent_id = ?) AND doc_id = ?',
        [id, id, docId],
      )
    })
  },
}
