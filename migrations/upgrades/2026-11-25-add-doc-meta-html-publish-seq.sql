-- OCTO-456 — publish ORDER for the post-publish HTML title callback.
--
-- The published version cannot order every title write: an explicit republish
-- can change the title while keeping the same content version (republish v2
-- under title B, then v2 under title C). Both callbacks carry version 2, so a
-- version-only watermark would ignore the second, valid update.
--
-- octo-docs-html therefore also sends a monotonic publish sequence that it bumps
-- inside its document lock on every committed publish. This column keeps the
-- highest sequence applied to doc_meta; a callback at/below it is stale and is
-- ignored. `html_publish_version` stays as the version-only fallback for HTML
-- instances that predate the sequence (rolling deploy).
--
-- SAFETY: idempotent / re-runnable.
DELIMITER //

DROP PROCEDURE IF EXISTS octo_add_doc_meta_html_publish_seq //

CREATE PROCEDURE octo_add_doc_meta_html_publish_seq()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = 'doc_meta'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'doc_meta'
        AND column_name = 'html_publish_seq'
    ) THEN
      ALTER TABLE doc_meta
        ADD COLUMN html_publish_seq BIGINT NOT NULL DEFAULT 0;
    END IF;
  END IF;
END //

DELIMITER ;

CALL octo_add_doc_meta_html_publish_seq();
DROP PROCEDURE IF EXISTS octo_add_doc_meta_html_publish_seq;
