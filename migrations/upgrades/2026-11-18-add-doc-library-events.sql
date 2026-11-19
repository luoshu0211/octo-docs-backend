CREATE TABLE IF NOT EXISTS doc_library_event (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  recipient_uid       VARCHAR(64) NOT NULL,
  recipient_space_id  VARCHAR(64) NOT NULL,
  doc_id              VARCHAR(64) NOT NULL,
  title               VARCHAR(512) NOT NULL,
  actor_uid           VARCHAR(64) NOT NULL,
  kind                ENUM('access_requested','access_approved','access_denied','member_role_changed','member_removed') NOT NULL,
  request_id          VARCHAR(64) NULL,
  previous_role       TINYINT NULL,
  new_role            TINYINT NULL,
  created_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  read_at             DATETIME(3) NULL,
  KEY idx_library_inbox (recipient_uid, recipient_space_id, id),
  KEY idx_library_request (recipient_uid, recipient_space_id, doc_id, request_id, kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
