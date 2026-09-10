-- PPT versions are independent of Yjs doc_version and are never deleted.
CREATE TABLE IF NOT EXISTS ppt_version (
  doc_id VARCHAR(64) NOT NULL,
  version_seq BIGINT UNSIGNED NOT NULL,
  kind VARCHAR(16) NOT NULL,
  label VARCHAR(200) NOT NULL DEFAULT '',
  base_revision BIGINT UNSIGNED NOT NULL,
  deck_json MEDIUMTEXT NOT NULL,
  html LONGTEXT NOT NULL,
  content_hash CHAR(64) NOT NULL,
  created_by VARCHAR(64) NOT NULL,
  principal_space_id VARCHAR(128) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (doc_id, version_seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
