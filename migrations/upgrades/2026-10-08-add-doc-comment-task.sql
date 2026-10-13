CREATE TABLE IF NOT EXISTS doc_comment_task (
  task_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  doc_id VARCHAR(64) NOT NULL,
  doc_kind VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  comment_id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
  bot_uid VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
  delivery VARCHAR(16) NOT NULL DEFAULT 'pending',
  progress JSON NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (task_key),
  UNIQUE KEY uk_comment_bot (doc_id, doc_kind, comment_id, bot_uid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
