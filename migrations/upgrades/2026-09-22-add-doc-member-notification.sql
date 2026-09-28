-- Durable, cross-device unread reminders for direct document membership grants.
-- Existing grants are not backfilled: only a new add after deployment emits a reminder.
-- Idempotent for the migration runner's at-least-once execution contract.
CREATE TABLE IF NOT EXISTS doc_member_notification (
  recipient_uid      VARCHAR(64) NOT NULL,
  recipient_space_id VARCHAR(64) NOT NULL,
  doc_id             VARCHAR(64) NOT NULL,
  granted_by         VARCHAR(64) NOT NULL,
  role               TINYINT NOT NULL,
  event_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  read_at            DATETIME(3) NULL,
  PRIMARY KEY (recipient_uid, recipient_space_id, doc_id),
  KEY idx_member_notification_unread (recipient_uid, recipient_space_id, read_at, event_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
