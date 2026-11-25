-- OCTO-456 — doc_member_notification doc_id index (soft-delete fan-out).
--
-- softDelete() removes every unread reminder for a document in the same
-- transaction:
--
--   DELETE FROM doc_member_notification WHERE doc_id = ?
--
-- The only non-doc_id-leading indexes are PRIMARY (recipient_uid,
-- recipient_space_id, doc_id) and idx_member_notification_unread (recipient_uid,
-- recipient_space_id, read_at, event_at), so MySQL cannot use either as a
-- doc_id lookup: the delete scans the whole table. The column is also the
-- natural FK-shaped lookup for any future per-document read of these reminders.
--
-- ONLINE DDL: the index is added with ALGORITHM=INPLACE, LOCK=NONE so concurrent
-- reads/writes keep working while MySQL builds it. If the running server cannot
-- satisfy those clauses (older 5.7 variants or an engine/edge case), the
-- procedure falls back to a plain CREATE INDEX; that fallback may take a
-- stronger metadata lock, so schedule the migration in a maintenance window if
-- this table is large. Inspect `SHOW PROCESSLIST` / `performance_schema` when in
-- doubt. The migration is additive and safe to retry; rollback is:
--
--   ALTER TABLE doc_member_notification DROP INDEX idx_doc_member_notification_doc;
--
-- SAFETY: idempotent / re-runnable (the migration runner is at-least-once).
-- MySQL 8 has no `ADD INDEX IF NOT EXISTS`, so the CREATE is guarded behind an
-- information_schema.statistics existence check in a throwaway stored procedure
-- — the same convention as 2026-11-24-add-doc-deleted-at.sql.
--
-- Usage:
--   mysql -u <user> -p <database> < migrations/upgrades/2026-11-24-add-doc-member-notification-doc-index.sql

DELIMITER //

DROP PROCEDURE IF EXISTS octo_add_doc_member_notification_doc_index //

CREATE PROCEDURE octo_add_doc_member_notification_doc_index()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name   = 'doc_member_notification'
      AND index_name   = 'idx_doc_member_notification_doc'
  ) THEN
    BEGIN
      DECLARE EXIT HANDLER FOR SQLEXCEPTION
      BEGIN
        -- Online DDL unavailable: fall back to a plain index build. This can
        -- block writes while it runs — see the maintenance-window note above.
        CREATE INDEX idx_doc_member_notification_doc
          ON doc_member_notification (doc_id);
      END;
      ALTER TABLE doc_member_notification
        ADD INDEX idx_doc_member_notification_doc (doc_id),
        ALGORITHM=INPLACE, LOCK=NONE;
    END;
  END IF;
END //

DELIMITER ;

CALL octo_add_doc_member_notification_doc_index();
DROP PROCEDURE IF EXISTS octo_add_doc_member_notification_doc_index;
