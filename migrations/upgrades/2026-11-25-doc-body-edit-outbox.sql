CREATE TABLE IF NOT EXISTS doc_body_edit_outbox (
  event_id           CHAR(36) NOT NULL PRIMARY KEY,
  document_id        VARCHAR(64) NOT NULL,
  document_space_id  VARCHAR(64) NOT NULL,
  principal_space_id VARCHAR(64) NOT NULL,
  actor_uid          VARCHAR(64) NOT NULL,
  occurred_at_ms     BIGINT UNSIGNED NOT NULL,
  next_attempt_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_doc_body_edit_due (next_attempt_at, event_id),
  KEY idx_doc_body_edit_expiry (occurred_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
