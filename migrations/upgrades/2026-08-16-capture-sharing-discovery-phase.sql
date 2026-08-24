-- Capture whether discovery semantics still need their one-time historical backfill.
-- This marker is intentionally durable: temporary draft-column existence is not a safe phase
-- signal when a final-schema database adopts an empty migration ledger and 08-17 runs again.
CREATE TABLE IF NOT EXISTS schema_migration_markers (
  marker_key VARCHAR(128) NOT NULL,
  marker_value VARCHAR(32) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (marker_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DELIMITER //
DROP PROCEDURE IF EXISTS octo_capture_sharing_discovery_phase //
CREATE PROCEDURE octo_capture_sharing_discovery_phase()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migration_markers
    WHERE marker_key='sharing_discovery_backfill_v1'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema=DATABASE()
        AND table_name='doc_meta'
        AND column_name='discoverability_scope'
    ) THEN
      INSERT INTO schema_migration_markers(marker_key, marker_value)
      VALUES ('sharing_discovery_backfill_v1', 'preserve');
    ELSE
      INSERT INTO schema_migration_markers(marker_key, marker_value)
      VALUES ('sharing_discovery_backfill_v1', 'backfill');
    END IF;
  END IF;
END //
DELIMITER ;
CALL octo_capture_sharing_discovery_phase();
DROP PROCEDURE IF EXISTS octo_capture_sharing_discovery_phase;
