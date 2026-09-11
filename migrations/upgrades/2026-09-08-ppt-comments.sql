-- PPT anchors are not Yjs relative positions. Soft deletion retains thread roots.
CREATE TABLE IF NOT EXISTS ppt_comment (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  doc_id VARCHAR(64) NOT NULL,
  parent_id BIGINT UNSIGNED NULL,
  author_uid VARCHAR(64) NOT NULL,
  author_space_id VARCHAR(128) NOT NULL,
  body TEXT NOT NULL,
  anchor_json TEXT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  resolved TINYINT NOT NULL DEFAULT 0,
  deleted TINYINT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_ppt_comment_thread (doc_id, parent_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
