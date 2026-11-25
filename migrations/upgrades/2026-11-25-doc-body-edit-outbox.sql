CREATE TABLE IF NOT EXISTS doc_body_edit_outbox (
  event_id           CHAR(36) NOT NULL PRIMARY KEY,
  document_name      VARCHAR(256) NOT NULL,
  document_id        VARCHAR(64) NOT NULL,
  document_space_id  VARCHAR(64) NOT NULL,
  principal_space_id VARCHAR(64) NOT NULL,
  actor_uid          VARCHAR(64) NOT NULL,
  occurred_at_ms     BIGINT UNSIGNED NOT NULL,
  update_proof       JSON NULL,
  ready              TINYINT UNSIGNED NOT NULL DEFAULT 0,
  delivered_at       DATETIME(3) NULL,
  next_attempt_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_doc_body_edit_due (ready, delivered_at, next_attempt_at, event_id),
  KEY idx_doc_body_edit_pending (document_name, ready),
  KEY idx_doc_body_edit_expiry (occurred_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
