-- Finalize sharing-v3 discovery semantics and remove abandoned draft controls.
-- Existing anyone-in-Space documents were discoverable before this setting existed, so legacy
-- databases receive one historical backfill. The durable marker captured by 08-16 distinguishes
-- that legacy state from a final-schema database adopting an empty migration ledger. Temporary
-- draft columns are deliberately NOT used as migration state because 08-17 can recreate them.
DELIMITER //
DROP PROCEDURE IF EXISTS octo_finalize_doc_sharing //
CREATE PROCEDURE octo_finalize_doc_sharing()
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='doc_meta' AND column_name='discoverability_scope') THEN
    ALTER TABLE doc_meta ADD COLUMN discoverability_scope TINYINT NOT NULL DEFAULT 0 COMMENT 'Discovery scope: 0=hidden, 1=space';
  END IF;

  IF EXISTS (
    SELECT 1 FROM schema_migration_markers
    WHERE marker_key='sharing_discovery_backfill_v1' AND marker_value='backfill'
  ) THEN
    START TRANSACTION;
    UPDATE doc_meta
       SET discoverability_scope = CASE WHEN share_scope = 1 THEN 1 ELSE 0 END;
    UPDATE schema_migration_markers
       SET marker_value='preserve'
     WHERE marker_key='sharing_discovery_backfill_v1' AND marker_value='backfill';
    COMMIT;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='doc_meta' AND column_name='space_searchable') THEN
    ALTER TABLE doc_meta DROP COLUMN space_searchable;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='doc_meta' AND column_name='allow_external_applications') THEN
    ALTER TABLE doc_meta DROP COLUMN allow_external_applications;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='doc_meta' AND column_name='external_application_policy') THEN
    ALTER TABLE doc_meta DROP COLUMN external_application_policy;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE table_schema=DATABASE() AND table_name='doc_meta' AND constraint_name='chk_doc_meta_share_scope') THEN
    ALTER TABLE doc_meta DROP CHECK chk_doc_meta_share_scope;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE table_schema=DATABASE() AND table_name='doc_meta' AND constraint_name='chk_doc_meta_share_scope') THEN
    ALTER TABLE doc_meta ADD CONSTRAINT chk_doc_meta_share_scope CHECK (share_scope IN (0,1,2));
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE table_schema=DATABASE() AND table_name='doc_meta' AND constraint_name='chk_doc_meta_share_role') THEN
    ALTER TABLE doc_meta DROP CHECK chk_doc_meta_share_role;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE table_schema=DATABASE() AND table_name='doc_meta' AND constraint_name='chk_doc_meta_share_role') THEN
    ALTER TABLE doc_meta ADD CONSTRAINT chk_doc_meta_share_role CHECK (share_role IN (1,2,4));
  END IF;
END //
DELIMITER ;
CALL octo_finalize_doc_sharing();
DROP PROCEDURE IF EXISTS octo_finalize_doc_sharing;
