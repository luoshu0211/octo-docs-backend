-- Space-qualify every document principal. Each phase is independently resumable.
DELIMITER //
DROP PROCEDURE IF EXISTS octo_space_qualify_permissions //
CREATE PROCEDURE octo_space_qualify_permissions()
BEGIN
  -- doc_meta.owner_space_id: add, backfill, and constrain are separate states.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name='doc_meta' AND column_name='owner_space_id'
  ) THEN
    ALTER TABLE doc_meta ADD COLUMN owner_space_id VARCHAR(64) NULL AFTER owner_id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name='doc_meta' AND column_name='owner_space_id'
  ) AND EXISTS (
    SELECT 1 FROM doc_meta WHERE owner_space_id IS NULL OR owner_space_id=''
  ) THEN
    UPDATE doc_meta SET owner_space_id=space_id WHERE owner_space_id IS NULL OR owner_space_id='';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name='doc_meta' AND column_name='owner_space_id' AND is_nullable='YES'
  ) THEN
    ALTER TABLE doc_meta MODIFY owner_space_id VARCHAR(64) NOT NULL;
  END IF;

  -- doc_member.principal_space_id.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name='doc_member' AND column_name='principal_space_id'
  ) THEN
    ALTER TABLE doc_member ADD COLUMN principal_space_id VARCHAR(64) NULL AFTER uid;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name='doc_member' AND column_name='principal_space_id'
  ) AND EXISTS (
    SELECT 1 FROM doc_member WHERE principal_space_id IS NULL OR principal_space_id=''
  ) THEN
    UPDATE doc_member dm
    JOIN doc_meta m ON m.doc_id=dm.doc_id
    SET dm.principal_space_id=m.space_id
    WHERE dm.principal_space_id IS NULL OR dm.principal_space_id='';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name='doc_member' AND column_name='principal_space_id' AND is_nullable='YES'
  ) THEN
    ALTER TABLE doc_member MODIFY principal_space_id VARCHAR(64) NOT NULL;
  END IF;

  IF COALESCE((
    SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',')
    FROM information_schema.statistics
    WHERE table_schema=DATABASE() AND table_name='doc_member' AND index_name='PRIMARY'
  ), '') <> 'doc_id,uid,principal_space_id' THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.statistics
      WHERE table_schema=DATABASE() AND table_name='doc_member' AND index_name='PRIMARY'
    ) THEN
      ALTER TABLE doc_member DROP PRIMARY KEY, ADD PRIMARY KEY(doc_id,uid,principal_space_id);
    ELSE
      ALTER TABLE doc_member ADD PRIMARY KEY(doc_id,uid,principal_space_id);
    END IF;
  END IF;

  -- doc_access_request.principal_space_id.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name='doc_access_request' AND column_name='principal_space_id'
  ) THEN
    ALTER TABLE doc_access_request ADD COLUMN principal_space_id VARCHAR(64) NULL AFTER uid;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name='doc_access_request' AND column_name='principal_space_id'
  ) AND EXISTS (
    SELECT 1 FROM doc_access_request WHERE principal_space_id IS NULL OR principal_space_id=''
  ) THEN
    UPDATE doc_access_request r
    JOIN doc_meta m ON m.doc_id=r.doc_id
    SET r.principal_space_id=m.space_id
    WHERE r.principal_space_id IS NULL OR r.principal_space_id='';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name='doc_access_request' AND column_name='principal_space_id' AND is_nullable='YES'
  ) THEN
    ALTER TABLE doc_access_request MODIFY principal_space_id VARCHAR(64) NOT NULL;
  END IF;

  IF COALESCE((
    SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',')
    FROM information_schema.statistics
    WHERE table_schema=DATABASE() AND table_name='doc_access_request' AND index_name='PRIMARY'
  ), '') <> 'doc_id,uid,principal_space_id' THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.statistics
      WHERE table_schema=DATABASE() AND table_name='doc_access_request' AND index_name='PRIMARY'
    ) THEN
      ALTER TABLE doc_access_request DROP PRIMARY KEY, ADD PRIMARY KEY(doc_id,uid,principal_space_id);
    ELSE
      ALTER TABLE doc_access_request ADD PRIMARY KEY(doc_id,uid,principal_space_id);
    END IF;
  END IF;

  -- doc_invite_redemption.principal_space_id.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name='doc_invite_redemption' AND column_name='principal_space_id'
  ) THEN
    ALTER TABLE doc_invite_redemption ADD COLUMN principal_space_id VARCHAR(64) NULL AFTER uid;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name='doc_invite_redemption' AND column_name='principal_space_id'
  ) AND EXISTS (
    SELECT 1 FROM doc_invite_redemption WHERE principal_space_id IS NULL OR principal_space_id=''
  ) THEN
    UPDATE doc_invite_redemption r
    JOIN doc_invite i ON i.invite_token=r.invite_token
    JOIN doc_meta m ON m.doc_id=i.doc_id
    SET r.principal_space_id=m.space_id
    WHERE r.principal_space_id IS NULL OR r.principal_space_id='';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name='doc_invite_redemption' AND column_name='principal_space_id' AND is_nullable='YES'
  ) THEN
    ALTER TABLE doc_invite_redemption MODIFY principal_space_id VARCHAR(64) NOT NULL;
  END IF;

  IF COALESCE((
    SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',')
    FROM information_schema.statistics
    WHERE table_schema=DATABASE() AND table_name='doc_invite_redemption' AND index_name='PRIMARY'
  ), '') <> 'invite_token,uid,principal_space_id' THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.statistics
      WHERE table_schema=DATABASE() AND table_name='doc_invite_redemption' AND index_name='PRIMARY'
    ) THEN
      ALTER TABLE doc_invite_redemption DROP PRIMARY KEY, ADD PRIMARY KEY(invite_token,uid,principal_space_id);
    ELSE
      ALTER TABLE doc_invite_redemption ADD PRIMARY KEY(invite_token,uid,principal_space_id);
    END IF;
  END IF;
END //
CALL octo_space_qualify_permissions() //
DROP PROCEDURE IF EXISTS octo_space_qualify_permissions //
DELIMITER ;
