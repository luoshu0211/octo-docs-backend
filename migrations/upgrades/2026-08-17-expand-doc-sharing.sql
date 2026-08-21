-- Sharing v3: authenticated link access plus independent application/discovery settings.
-- Idempotent for clean, repeated and partially-applied upgrades.
DELIMITER //
DROP PROCEDURE IF EXISTS octo_expand_doc_sharing //
CREATE PROCEDURE octo_expand_doc_sharing()
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='doc_meta' AND column_name='allow_external_applications') THEN
    ALTER TABLE doc_meta ADD COLUMN allow_external_applications TINYINT(1) NOT NULL DEFAULT 1;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='doc_meta' AND column_name='space_searchable') THEN
    ALTER TABLE doc_meta ADD COLUMN space_searchable TINYINT(1) NOT NULL DEFAULT 0;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE table_schema=DATABASE() AND table_name='doc_meta' AND constraint_name='chk_doc_meta_share_scope') THEN
    ALTER TABLE doc_meta DROP CHECK chk_doc_meta_share_scope;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE table_schema=DATABASE() AND table_name='doc_meta' AND constraint_name='chk_doc_meta_share_scope') THEN
    ALTER TABLE doc_meta ADD CONSTRAINT chk_doc_meta_share_scope CHECK (share_scope IN (0,1,2));
  END IF;
END //
DELIMITER ;
CALL octo_expand_doc_sharing();
DROP PROCEDURE IF EXISTS octo_expand_doc_sharing;
