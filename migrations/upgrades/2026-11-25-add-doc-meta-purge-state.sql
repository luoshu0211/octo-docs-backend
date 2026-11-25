-- OCTO-456 P1 — durable "purge in progress" state.
--
-- Purging an HTML document deletes its content in octo-docs-html BEFORE the
-- doc_meta row is physically removed. Without a persisted state, a restore that
-- commits during that remote call can reactivate the row and then watch the
-- purge delete the content: the user ends up with an ACTIVE document whose body
-- is gone. Restore and retry therefore have to see the same state under the row
-- lock, which needs a column:
--
--   0 = normal
--   1 = purge claimed (content deletion may be in flight / retryable)
--
-- SAFETY: idempotent / re-runnable.
DELIMITER //

DROP PROCEDURE IF EXISTS octo_add_doc_meta_purge_state //

CREATE PROCEDURE octo_add_doc_meta_purge_state()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = 'doc_meta'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'doc_meta'
        AND column_name = 'purge_state'
    ) THEN
      ALTER TABLE doc_meta
        ADD COLUMN purge_state TINYINT NOT NULL DEFAULT 0;
    END IF;
  END IF;
END //

DELIMITER ;

CALL octo_add_doc_meta_purge_state();
DROP PROCEDURE IF EXISTS octo_add_doc_meta_purge_state;
