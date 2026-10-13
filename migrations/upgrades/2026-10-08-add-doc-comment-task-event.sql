CREATE TABLE IF NOT EXISTS doc_comment_task_event (
  task_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  attempt_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  seq INT UNSIGNED NOT NULL,
  event JSON NOT NULL,
  PRIMARY KEY (task_key, attempt_id, seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
