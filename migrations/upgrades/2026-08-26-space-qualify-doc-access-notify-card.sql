-- Space-qualify approver-card delivery coordinates. Historical notifications
-- were routed through the document Home Space, so legacy rows are backfilled
-- from doc_access_request.doc_id -> doc_meta.space_id. Orphaned legacy rows are
-- preserved with the empty sentinel rather than deleted or falsely attributed.
-- The procedure guards every phase so the migration is safe to resume/re-run.

DELIMITER //

DROP PROCEDURE IF EXISTS octo_space_qualify_doc_access_notify_card //

CREATE PROCEDURE octo_space_qualify_doc_access_notify_card()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name='doc_access_notify_card'
      AND column_name='delivery_space_id'
  ) THEN
    ALTER TABLE doc_access_notify_card
      ADD COLUMN delivery_space_id VARCHAR(64) NOT NULL DEFAULT '' AFTER recipient_uid;
  END IF;

  UPDATE doc_access_notify_card c
  LEFT JOIN doc_access_request r ON r.request_id=c.request_id
  LEFT JOIN doc_meta m ON m.doc_id=r.doc_id
  SET c.delivery_space_id=COALESCE(NULLIF(c.delivery_space_id,''), m.space_id, '')
  WHERE c.delivery_space_id='';

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema=DATABASE() AND table_name='doc_access_notify_card'
      AND index_name='PRIMARY' AND seq_in_index=3 AND column_name='delivery_space_id'
  ) THEN
    ALTER TABLE doc_access_notify_card
      DROP PRIMARY KEY,
      ADD PRIMARY KEY(request_id,recipient_uid,delivery_space_id);
  END IF;
END //

CALL octo_space_qualify_doc_access_notify_card() //
DROP PROCEDURE IF EXISTS octo_space_qualify_doc_access_notify_card //

DELIMITER ;
