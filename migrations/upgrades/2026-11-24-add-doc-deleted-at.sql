-- OCTO-456 资料库二期 — deletion grey state (P0 read contract).
--
-- doc_meta.status=0 has always meant "soft-deleted", but it carried no deletion
-- timestamp, so docs-backend could neither render `deleted_at` nor evaluate the
-- 30-day retention window. This migration adds that ONE nullable column:
--
--   deleted_at DATETIME(3) NULL   -- NULL = deletion happened before this column
--                                 -- existed, so the retention deadline is
--                                 -- UNKNOWN (reported as not-expired).
--
-- NO BACKFILL: for historical status=0 rows the real deletion time cannot be
-- reconstructed, so they deliberately stay NULL. Treating them as "expired"
-- would grey-out documents that are still inside their retention window;
-- treating them as "not expired" is the only fail-open choice and is the
-- product's temporary rule. The writer (`docMetaRepo.softDelete`) stamps the
-- timestamp from now on; a revival path clears it.
--
-- The column is additive with a NULL default, so MySQL 8 applies it as an
-- instant metadata-only change (no table rewrite) and every existing / future
-- INSERT that omits it keeps the historical NULL semantics.
--
-- SAFETY: idempotent / re-runnable (the migration runner is at-least-once).
-- MySQL 8 has no `ADD COLUMN IF NOT EXISTS`, so the ALTER is guarded behind an
-- information_schema existence check in a throwaway stored procedure — the same
-- convention as 2026-07-14-add-doc-share-scope.sql /
-- 2026-11-23-add-doc-legacy-visible.sql. A retry or partial re-apply is a no-op,
-- not `ERROR 1060 Duplicate column`.
--
-- Usage:
--   mysql -u <user> -p <database> < migrations/upgrades/2026-11-24-add-doc-deleted-at.sql

DELIMITER //

DROP PROCEDURE IF EXISTS octo_add_doc_meta_deleted_at //

CREATE PROCEDURE octo_add_doc_meta_deleted_at()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name   = 'doc_meta'
      AND column_name  = 'deleted_at'
  ) THEN
    ALTER TABLE doc_meta
      ADD COLUMN deleted_at DATETIME(3) NULL DEFAULT NULL
        COMMENT '软删时间(status=0)，NULL=历史删除无法判定；保留期=30天'
        AFTER status;
  END IF;
END //

DELIMITER ;

CALL octo_add_doc_meta_deleted_at();
DROP PROCEDURE IF EXISTS octo_add_doc_meta_deleted_at;
