-- Yjs update-format column for yjs_document (incident 2026-08-21 follow-up).
--
-- Rows have always held `Y.encodeStateAsUpdate` output (the v1 lib0 encoding).
-- We are moving new writes to `Y.encodeStateAsUpdateV2`, which is materially
-- smaller for a document with a long edit history — measured on the sheet that
-- caused the incident: 9,503,044 -> 5,088,640 bytes persisted (-46%), and
-- 18,320,896 -> 6,073,851 bytes for its in-memory state (-67%), with byte-exact
-- content equality across all 103,680 cells.
--
-- The column records which encoder produced `state` so reads pick the matching
-- decoder. Existing rows are v1 by definition, hence DEFAULT 1: this migration
-- rewrites no data and is safe to apply while the service is running. Rows
-- convert lazily, one per successful store, so a rollback only has to stop
-- writing 2 — every row remains readable by both the old and new code as long
-- as the old code is not asked to read a row it never wrote.
--
--   1 = Y.encodeStateAsUpdate / Y.applyUpdate           (lib0 v1)
--   2 = Y.encodeStateAsUpdateV2 / Y.applyUpdateV2       (lib0 v2)
ALTER TABLE yjs_document
  ADD COLUMN encoding TINYINT UNSIGNED NOT NULL DEFAULT 1
  COMMENT 'Yjs update format of `state`: 1=v1 (legacy), 2=v2';
