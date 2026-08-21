-- Destructive rollback: collapses same-UID grants from different Spaces. Abort before any DDL
-- when the target UID-only keys would collide; operators must resolve every reported duplicate
-- before retrying this rollback.
DELIMITER //
DROP PROCEDURE IF EXISTS octo_preflight_space_permissions_rollback //
CREATE PROCEDURE octo_preflight_space_permissions_rollback()
BEGIN
  IF EXISTS (
    SELECT 1 FROM doc_member GROUP BY doc_id, uid HAVING COUNT(*) > 1
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='rollback blocked: duplicate doc_member (doc_id,uid)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM doc_access_request GROUP BY doc_id, uid HAVING COUNT(*) > 1
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='rollback blocked: duplicate doc_access_request (doc_id,uid)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM doc_invite_redemption GROUP BY invite_token, uid HAVING COUNT(*) > 1
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='rollback blocked: duplicate doc_invite_redemption (invite_token,uid)';
  END IF;
END //
DELIMITER ;
CALL octo_preflight_space_permissions_rollback();
DROP PROCEDURE IF EXISTS octo_preflight_space_permissions_rollback;

ALTER TABLE doc_invite_redemption DROP PRIMARY KEY, ADD PRIMARY KEY(invite_token,uid), DROP COLUMN principal_space_id;
ALTER TABLE doc_access_request DROP PRIMARY KEY, ADD PRIMARY KEY(doc_id,uid), DROP COLUMN principal_space_id;
ALTER TABLE doc_member DROP PRIMARY KEY, ADD PRIMARY KEY(doc_id,uid), DROP COLUMN principal_space_id;
ALTER TABLE doc_meta DROP COLUMN owner_space_id;
