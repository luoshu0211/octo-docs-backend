-- OCTO-456 — monotonic revision for the HTML rename journal.
--
-- The commit-phase fence must reject a pending operation when a LATER logical
-- rename already completed. created_at is DATETIME(3), so two operations created
-- in the same millisecond cannot be ordered by it; `revision` is an
-- auto-increment sequence used instead. (It is DB-generated, never written by
-- application code.)
--
-- This is a SEPARATE migration on purpose: the base
-- 2026-11-24-add-doc-rename-operation.sql was already part of this MR's history
-- and may have been applied in an environment, so changing it would break that
-- environment's checksum. New installs get the column from migrations/schema.sql;
-- existing installs get it here.
--
-- FILENAME ORDER MATTERS: the runner sorts filenames lexicographically. The
-- earlier name (2026-11-24-...-operation-revision.sql) sorted BEFORE the base
-- file ('.' < '-'), so on an existing ledger the revision migration could be
-- recorded as a no-op while the table did not exist yet. 2026-11-25 sorts after
-- the base, and environments whose ledger recorded the old empty run simply do
-- not have this new filename, so it executes and backfills the column.
--
-- SAFETY: idempotent / re-runnable. Skips when the journal table does not exist
-- yet (the base migration creates it), adds the column+index only when missing,
-- and adds a missing index even if the column already exists. MySQL requires an
-- AUTO_INCREMENT column to be indexed, so the column and key are added in ONE
-- ALTER — a column-only ALTER would fail.
--
-- Usage:
--   mysql -u <user> -p <database> < migrations/upgrades/2026-11-25-add-doc-rename-operation-revision.sql

DELIMITER //

DROP PROCEDURE IF EXISTS octo_add_doc_rename_operation_revision //

CREATE PROCEDURE octo_add_doc_rename_operation_revision()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = DATABASE()
      AND table_name   = 'doc_rename_operation'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name   = 'doc_rename_operation'
        AND column_name  = 'revision'
    ) THEN
      ALTER TABLE doc_rename_operation
        ADD COLUMN revision BIGINT NOT NULL AUTO_INCREMENT,
        ADD KEY idx_doc_rename_operation_revision (revision);
    ELSEIF NOT EXISTS (
      SELECT 1 FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name   = 'doc_rename_operation'
        AND index_name   = 'idx_doc_rename_operation_revision'
    ) THEN
      ALTER TABLE doc_rename_operation
        ADD KEY idx_doc_rename_operation_revision (revision);
    END IF;
  END IF;
END //

DELIMITER ;

CALL octo_add_doc_rename_operation_revision();
DROP PROCEDURE IF EXISTS octo_add_doc_rename_operation_revision;
