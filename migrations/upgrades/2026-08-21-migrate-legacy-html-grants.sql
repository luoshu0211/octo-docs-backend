-- Migrate legacy octo-doc HTML meta.json.grants into the authoritative,
-- Space-qualified doc_member table after the 2026-08-13 compound-key migration.
--
-- This is a separate migration because the predecessor can already be ledgered
-- in local/staging environments even when the target production rollout has not
-- begun. Existing doc_member rows always win, and meta.grants remains intact as
-- inert audit/rollback data.

CREATE TABLE IF NOT EXISTS schema_migration_markers (
  marker_key VARCHAR(128) NOT NULL,
  marker_value VARCHAR(32) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(marker_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DELIMITER //
DROP PROCEDURE IF EXISTS octo_migrate_legacy_html_grants //
CREATE PROCEDURE octo_migrate_legacy_html_grants()
BEGIN
  DECLARE migration_complete INT DEFAULT 0;

  SELECT COUNT(*) INTO migration_complete
  FROM schema_migration_markers
  WHERE marker_key='legacy_html_grants_to_space_members_v1'
    AND marker_value='complete';

  IF migration_complete=0 AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name='meta' AND column_name='json'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name='doc_meta' AND column_name='octo_doc_slug'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name='doc_member' AND column_name='principal_space_id'
  ) THEN
    DROP TEMPORARY TABLE IF EXISTS tmp_legacy_html_grants;
    CREATE TEMPORARY TABLE tmp_legacy_html_grants (
      doc_id VARCHAR(64) NOT NULL,
      uid VARCHAR(64) NOT NULL,
      principal_space_id VARCHAR(64) NOT NULL,
      role TINYINT NOT NULL,
      granted_by VARCHAR(64) NOT NULL,
      created_at DATETIME(3) NOT NULL,
      PRIMARY KEY(doc_id,uid,principal_space_id)
    ) ENGINE=InnoDB;

    -- Deployment runs this snapshot while legacy HTML grant writes are
    -- paused, then immediately deploys the doc_member-only HTML runtime.
    START TRANSACTION;

    INSERT IGNORE INTO tmp_legacy_html_grants
      (doc_id,uid,principal_space_id,role,granted_by,created_at)
    SELECT
      dm.doc_id,
      grant_keys.uid,
      dm.space_id,
      CASE LOWER(TRIM(JSON_UNQUOTE(JSON_EXTRACT(
        hm.json,
        CONCAT('$.grants.', JSON_QUOTE(grant_keys.uid), '.role')
      ))))
        WHEN 'reader' THEN 1
        WHEN 'writer' THEN 2
        WHEN 'commenter' THEN 4
      END,
      CASE
        WHEN CHAR_LENGTH(TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(
          hm.json,
          CONCAT('$.grants.', JSON_QUOTE(grant_keys.uid), '.granted_by')
        )), ''))) BETWEEN 1 AND 64
        THEN TRIM(JSON_UNQUOTE(JSON_EXTRACT(
          hm.json,
          CONCAT('$.grants.', JSON_QUOTE(grant_keys.uid), '.granted_by')
        )))
        ELSE dm.owner_id
      END,
      CASE
        WHEN TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(
          hm.json,
          CONCAT('$.grants.', JSON_QUOTE(grant_keys.uid), '.created_at')
        )), '')) REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?Z$'
        THEN STR_TO_DATE(
          TRIM(JSON_UNQUOTE(JSON_EXTRACT(
            hm.json,
            CONCAT('$.grants.', JSON_QUOTE(grant_keys.uid), '.created_at')
          ))),
          IF(
            TRIM(JSON_UNQUOTE(JSON_EXTRACT(
              hm.json,
              CONCAT('$.grants.', JSON_QUOTE(grant_keys.uid), '.created_at')
            ))) LIKE '%.%',
            '%Y-%m-%dT%H:%i:%s.%fZ',
            '%Y-%m-%dT%H:%i:%sZ'
          )
        )
        WHEN hm.updated_at>0 THEN FROM_UNIXTIME(hm.updated_at/1000)
        ELSE CURRENT_TIMESTAMP(3)
      END
    FROM (
      SELECT
        slug,
        json,
        updated_at,
        COALESCE(
          NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(json, '$.canonical_doc_id'))), ''),
          NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(json, '$.docs_backend_doc_id'))), '')
        ) AS registered_doc_id
      FROM meta
    ) hm
    JOIN doc_meta dm
      ON dm.doc_type='html'
     AND dm.status<>0
     AND dm.space_id<>''
     AND (
       (hm.registered_doc_id IS NOT NULL AND dm.doc_id COLLATE utf8mb4_bin=hm.registered_doc_id COLLATE utf8mb4_bin)
       OR (
         hm.registered_doc_id IS NULL
         AND dm.octo_doc_slug COLLATE utf8mb4_bin=hm.slug COLLATE utf8mb4_bin
         AND (
           dm.space_id COLLATE utf8mb4_bin=NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(hm.json, '$.space_id'))), '') COLLATE utf8mb4_bin
           OR (
             NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(hm.json, '$.space_id'))), '') IS NULL
             AND (
               SELECT COUNT(*) FROM doc_meta unique_slug
               WHERE unique_slug.doc_type='html'
                 AND unique_slug.status<>0
                 AND unique_slug.octo_doc_slug COLLATE utf8mb4_bin=hm.slug COLLATE utf8mb4_bin
             )=1
           )
         )
       )
     )
    CROSS JOIN JSON_TABLE(
      IF(
        JSON_TYPE(JSON_EXTRACT(hm.json, '$.grants'))='OBJECT',
        JSON_KEYS(JSON_EXTRACT(hm.json, '$.grants')),
        JSON_ARRAY()
      ),
      '$[*]' COLUMNS(uid VARCHAR(512) PATH '$')
    ) AS grant_keys
    WHERE CHAR_LENGTH(grant_keys.uid) BETWEEN 1 AND 64
      AND grant_keys.uid COLLATE utf8mb4_bin=TRIM(grant_keys.uid) COLLATE utf8mb4_bin
      AND grant_keys.uid COLLATE utf8mb4_bin<>dm.owner_id COLLATE utf8mb4_bin
      AND grant_keys.uid COLLATE utf8mb4_bin<>COALESCE(JSON_UNQUOTE(JSON_EXTRACT(hm.json, '$.creator_uid')), '') COLLATE utf8mb4_bin
      AND LOWER(TRIM(JSON_UNQUOTE(JSON_EXTRACT(
        hm.json,
        CONCAT('$.grants.', JSON_QUOTE(grant_keys.uid), '.role')
      )))) IN ('reader','writer','commenter')
      AND NOT EXISTS (
        SELECT 1 FROM doc_member existing
        WHERE existing.doc_id COLLATE utf8mb4_bin=dm.doc_id COLLATE utf8mb4_bin
          AND existing.uid COLLATE utf8mb4_bin=grant_keys.uid COLLATE utf8mb4_bin
          AND existing.principal_space_id COLLATE utf8mb4_bin=dm.space_id COLLATE utf8mb4_bin
      );

    INSERT IGNORE INTO doc_member
      (doc_id,uid,principal_space_id,role,granted_by,source,invite_token,created_at)
    SELECT doc_id,uid,principal_space_id,role,granted_by,1,'',created_at
    FROM tmp_legacy_html_grants;

    -- The maintenance-window contract prevents concurrent member mutation, so
    -- every candidate above is an actual insert. Bump once per changed document.
    UPDATE doc_meta dm
    JOIN (SELECT DISTINCT doc_id FROM tmp_legacy_html_grants) changed
      ON changed.doc_id COLLATE utf8mb4_bin=dm.doc_id COLLATE utf8mb4_bin
    SET dm.permission_epoch=dm.permission_epoch+1;

    INSERT INTO schema_migration_markers(marker_key,marker_value)
    VALUES ('legacy_html_grants_to_space_members_v1','complete');

    COMMIT;

    DROP TEMPORARY TABLE IF EXISTS tmp_legacy_html_grants;
  END IF;
END //
CALL octo_migrate_legacy_html_grants() //
DROP PROCEDURE IF EXISTS octo_migrate_legacy_html_grants //
DELIMITER ;
