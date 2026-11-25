-- OCTO-456 资料库二期 — legacy ("旧列表") visibility backfill.
--
-- 与我共享 is sourced from doc_member (direct/invite) plus this table, which
-- records documents a user could see through the PRE-library lists but for
-- which docs-backend holds no doc_member row (e.g. historical org-scope lists,
-- IM-shared docs). It is a pure CANDIDATE table: it never grants an access
-- decision — every returned doc is still re-checked through the permission
-- layer by /internal/docs/status and /internal/docs/capabilities.
--
-- (doc_id, uid, principal_space) is the primary key, so one principal can be
-- backfilled exactly once per document; a repeat backfill must upsert
-- last_seen_at rather than insert. `source` keeps the provenance of the
-- backfill (the internal shared route reports every row here as 'legacy';
-- 'im_card' / 'im_link' rows are deliberately EXCLUDED this期 by
-- docMetaRepo.listSharedWithUser).
--
-- No producer writes this table yet: it is created empty. The shared route's
-- union logic is live and simply contributes no rows until a backfill job
-- exists. Re-runnable (CREATE TABLE IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS doc_legacy_visible (
  doc_id          VARCHAR(64) NOT NULL,            -- 关联 doc_meta.doc_id
  uid             VARCHAR(64) NOT NULL,            -- 旧列表可见的可信 Octo user id
  principal_space VARCHAR(64) NOT NULL,            -- 该 uid 的服务端验证 Space
  source          VARCHAR(16) NOT NULL DEFAULT 'legacy', -- 补录来源（legacy / im_card / im_link …）
  last_seen_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (doc_id, uid, principal_space),
  KEY idx_legacy_principal (uid, principal_space, last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
