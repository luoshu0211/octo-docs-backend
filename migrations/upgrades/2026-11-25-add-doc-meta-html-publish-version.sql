-- OCTO-456 — publish ordering for the post-publish HTML title callback.
--
-- HTML releases the document lock before notifying Docs; callbacks can arrive
-- out of order. The callback now carries the published version, and Docs ignores
-- any version older than the last one applied to doc_meta. This column keeps
-- that watermark durable.
--
-- SAFETY: idempotent / re-runnable.
DELIMITER //

DROP PROCEDURE IF EXISTS octo_add_doc_meta_html_publish_version //

CREATE PROCEDURE octo_add_doc_meta_html_publish_version()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = 'doc_meta'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'doc_meta'
        AND column_name = 'html_publish_version'
    ) THEN
      ALTER TABLE doc_meta
        ADD COLUMN html_publish_version BIGINT NOT NULL DEFAULT 0;
    END IF;
  END IF;
END //

DELIMITER ;

CALL octo_add_doc_meta_html_publish_version();
DROP PROCEDURE IF EXISTS octo_add_doc_meta_html_publish_version;
