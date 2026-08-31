-- Add the authoritative decider identity to doc_access_request: the winning
-- decider's trusted Space (decided_by_space_id) and the authoritative decision
-- time (decided_at_unix, unix SECONDS — the same unit as the octo-server card
-- callback `acted_at`). Both are written in the SAME CAS-guarded UPDATE as the
-- pending→terminal status flip, so the sole CAS winner persists WHO (decided_by),
-- FROM WHICH Space (decided_by_space_id) and WHEN (decided_at_unix) atomically —
-- a duplicate / concurrent late click that loses the CAS reads these back and
-- reports the real winner rather than itself.
--
-- Both columns are additive and nullable / defaulted so they are backward
-- compatible: rows decided BEFORE this migration keep decided_by but have an
-- empty decided_by_space_id and a NULL decided_at_unix. The callback response
-- treats those as an optional-Space / optional-time DEGRADATION (the id/time are
-- simply omitted from the wire) — it never guesses a Space from the document,
-- card or a default, so a legacy row can never be misattributed to the wrong
-- Space.
--
-- SAFETY: idempotent / re-runnable. MySQL 8 lacks ADD COLUMN IF NOT EXISTS, so
-- each ALTER is guarded by an information_schema check in a throwaway procedure
-- (same convention as 2026-08-04-add-doc-access-request-bot-uids.sql) —
-- re-running is a no-op, not ERROR 1060.
--
-- Usage:
--   mysql -u <user> -p <database> < migrations/upgrades/2026-08-25-add-doc-access-request-decider-space.sql

DELIMITER //

DROP PROCEDURE IF EXISTS octo_add_doc_access_request_decider_space //

CREATE PROCEDURE octo_add_doc_access_request_decider_space()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name   = 'doc_access_request'
      AND column_name  = 'decided_by_space_id'
  ) THEN
    ALTER TABLE doc_access_request
      ADD COLUMN decided_by_space_id VARCHAR(64) NOT NULL DEFAULT '' AFTER decided_by;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name   = 'doc_access_request'
      AND column_name  = 'decided_at_unix'
  ) THEN
    ALTER TABLE doc_access_request
      ADD COLUMN decided_at_unix BIGINT UNSIGNED NULL DEFAULT NULL AFTER decision_note;
  END IF;
END //

CALL octo_add_doc_access_request_decider_space() //

DROP PROCEDURE IF EXISTS octo_add_doc_access_request_decider_space //

DELIMITER ;
