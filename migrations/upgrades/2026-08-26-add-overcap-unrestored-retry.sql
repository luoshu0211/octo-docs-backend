-- Upgrade migration: add overcap_unrestored table (MR98-006 durable over-cap retry carrier)
--
-- WHAT: a durable, replica-independent holding area for the REJECTED state vector
--   of a document that failed its persistence size cap, keyed by the Hocuspocus
--   persistence key (document_name, NOT doc_id). One row per document; the state
--   vector is stored as JSON `{clientId: clock}`, merged per-client-max exactly as
--   the Redis marker (compactionNotice `recordUnrestoredOverCap`) merges it.
--
-- WHY: the over-cap interlock's durable signal is the Redis marker, which survives
--   replica death with no heartbeat. But the marker is written on the rejection
--   path, and if Redis is unreachable at THAT moment no marker is created — and the
--   over-cap frame typically locks the client session, so the first rejection is
--   often the last store and there is no natural retry. The in-memory retry queue
--   (oversizeGuard) fixes the "alive replica" half, but it lives in process memory:
--   a pod SIGKILLed/OOMed during the outage window (23 SIGKILL-137s in the
--   2026-08-21 incident) takes the queue with it, and after the per-replica field
--   lapses on its 1h TTL `isOverCapAnywhere` finds nothing while the compaction
--   stamp still stands — the browser is told to delete its only copy (MR98-003
--   reopened on the write-failure path). This table is where the rejected state
--   vector lands at rejection time so it OUTLIVES the replica: a fresh replica (or
--   the 10-minute over-cap heartbeat) reconciles it into the Redis marker through
--   the same atomic RECORD script, and the row is removed only once that record
--   lands or a dominating store clears it. The database is the natural bottom: the
--   rejection path is already on the persistence layer, so if the DB is unreachable
--   the whole write path is degraded anyway.
--
-- SAFETY: idempotent / re-runnable (CREATE TABLE IF NOT EXISTS). Adds a new table
--   only; rewrites no data and is safe to apply while the service is running.
--
-- Usage:
--   mysql -u <user> -p <database> < migrations/upgrades/2026-08-26-add-overcap-unrestored-retry.sql

CREATE TABLE IF NOT EXISTS overcap_unrestored (
  document_name VARCHAR(256) NOT NULL,            -- Hocuspocus persistence key (not doc_id)
  state_vector  TEXT         NOT NULL,            -- rejected Yjs state vector as JSON {clientId: clock}, per-client-max merged
  recorded_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (document_name)                     -- one row per document; put() UPSERTs a per-client-max merge
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
