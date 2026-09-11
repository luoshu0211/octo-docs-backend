-- Per-actor continuity survives frame pruning and process restarts.
CREATE TABLE IF NOT EXISTS ppt_collab_actor_seq (
  doc_id VARCHAR(64) NOT NULL,
  actor VARCHAR(255) NOT NULL,
  last_s BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (doc_id, actor)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
