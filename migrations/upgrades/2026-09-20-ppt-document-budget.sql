-- Widen PPT storage before enabling 32 MiB documents. No data conversion or
-- truncation; old binaries can still read these columns. Do not narrow columns
-- on rollback: existing rows may already exceed the old MEDIUMTEXT ceiling.
-- Guard every ALTER so retry after DDL auto-commit is safe and a no-op.
DELIMITER //
DROP PROCEDURE IF EXISTS octo_widen_ppt_document_columns //
CREATE PROCEDURE octo_widen_ppt_document_columns()
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE()
    AND table_name = 'ppt_doc_state' AND column_name = 'draft_doc' AND data_type <> 'longtext') THEN
    ALTER TABLE ppt_doc_state MODIFY COLUMN draft_doc LONGTEXT NOT NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE()
    AND table_name = 'ppt_live_snapshot' AND column_name = 'doc_json' AND data_type <> 'longtext') THEN
    ALTER TABLE ppt_live_snapshot MODIFY COLUMN doc_json LONGTEXT NOT NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE()
    AND table_name = 'ppt_live_snapshot' AND column_name = 'state_json' AND data_type <> 'longtext') THEN
    ALTER TABLE ppt_live_snapshot MODIFY COLUMN state_json LONGTEXT NULL DEFAULT NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE()
    AND table_name = 'ppt_version' AND column_name = 'deck_json' AND data_type <> 'longtext') THEN
    ALTER TABLE ppt_version MODIFY COLUMN deck_json LONGTEXT NOT NULL;
  END IF;
END //
DELIMITER ;
CALL octo_widen_ppt_document_columns();
DROP PROCEDURE IF EXISTS octo_widen_ppt_document_columns;
