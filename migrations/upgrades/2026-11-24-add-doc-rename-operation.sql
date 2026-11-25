-- OCTO-456 — durable HTML rename journal.
--
-- HTML rename is two steps: octo-docs-html republishes the new title (version+1),
-- then docs-backend writes doc_meta. Retries must reuse the FIRST step's published
-- version, while a genuinely new rename (A->B after an earlier A->B completed)
-- must publish a new one. A hash of (docId,beforeTitle,title) cannot tell those
-- apart (A->B->A->B would replay the first key), so each logical rename gets a
-- durable row here and its uuid becomes the html `idempotency_key`.
--
-- A pending row also serializes concurrent renames of one document: a second
-- request with a different target sees pending and is rejected with
-- 409 rename_in_progress instead of racing the first one's doc_meta write.
--
-- status: 0 = pending, 1 = completed, 2 = failed.
-- (doc_id, status) backs the "latest pending operation for this doc" lookup.
--
-- SAFETY: idempotent / re-runnable (the migration runner is at-least-once).
-- MySQL 8 has no `CREATE TABLE IF NOT EXISTS` semantics for adding a table with
-- a new name safely? It does — but the existence check below keeps this file
-- consistent with the other 2026-11-24 upgrades and avoids masking a table with
-- a different definition.
--
-- Usage:
--   mysql -u <user> -p <database> < migrations/upgrades/2026-11-24-add-doc-rename-operation.sql

DELIMITER //

DROP PROCEDURE IF EXISTS octo_add_doc_rename_operation //

CREATE PROCEDURE octo_add_doc_rename_operation()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = DATABASE()
      AND table_name   = 'doc_rename_operation'
  ) THEN
    CREATE TABLE doc_rename_operation (
      id          VARCHAR(64)  NOT NULL,
      doc_id      VARCHAR(64)  NOT NULL,
      from_title  VARCHAR(512) NOT NULL,
      to_title    VARCHAR(512) NOT NULL,
      status      TINYINT      NOT NULL DEFAULT 0,
      version     INT          NULL,
      created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      KEY idx_doc_rename_operation_doc_status (doc_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  END IF;
END //

DELIMITER ;

CALL octo_add_doc_rename_operation();
DROP PROCEDURE IF EXISTS octo_add_doc_rename_operation;
