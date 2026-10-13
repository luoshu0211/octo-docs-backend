-- Deploy all generation-aware collaboration nodes together before admitting sheet writers.
-- Re-runnable: never rotate an existing generation on migration retry.
CREATE TABLE IF NOT EXISTS doc_state_generation (
  document_name VARCHAR(256) NOT NULL,
  generation CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (document_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT IGNORE INTO doc_state_generation (document_name, generation)
SELECT document_name, UUID() FROM doc_meta WHERE doc_type = 'sheet';
