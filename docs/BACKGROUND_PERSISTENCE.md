# Background Yjs persistence

`YJS_BACKGROUND_STORE=true` (default) keeps the authoritative `yjs_document`
row and the existing Redis/WebSocket protocol. No schema migration or additional
delta table is required. SQL still receives a complete, compressed snapshot;
only extraction on the collaboration thread is incremental.

For an already loaded/saved document:

1. Capture a Yjs update against the last successfully committed state vector,
   and capture the update's matching vector in the same synchronous turn.
   Delete sets remain included even if no client clock advanced.
2. Lock the latest physical row with `SELECT ... FOR UPDATE`.
3. A reusable worker decompresses the row, verifies that it contains the delta's
   causal base, applies the delta, encodes the complete merged state, checks
   decoded and stored budgets, and compresses once.
4. UPSERT the prepared bytes and editor metadata in the same SQL transaction.
   Advance the checkpoint and retire applicable oversize markers only after
   commit, using the captured vector rather than the later mutable live doc.

Two nodes can submit different deltas: the row lock serializes their merge with
the latest committed snapshot. No Redis publication or peer delivery waits for
this SQL commit. Redis Pub/Sub remains a real-time transport, not durable storage.

The worker also verifies that the result includes the captured target vector.
If compaction, replacement, or a missing row invalidates the cached base, the
store captures a full update and matching vector, then repeats preparation under
the same row lock. An unknown encoding, corrupt compressed row, budget failure,
worker failure, timeout, or failed SQL commit never advances the checkpoint.
The existing row is retained on rejection; a later save still includes the
uncommitted changes. Hocuspocus logs a failed store and retains the live document;
this change does not claim a durable acknowledgement before SQL commit.

Resources are bounded per backend process: one reused worker, at most 16 accepted
jobs and 64 MiB of queued/in-flight input bytes, a 30-second running-job timeout,
and a 512 MiB worker old-generation heap limit. Queue saturation rejects the
store instead of silently dropping an update or accumulating unlimited buffers.
A failed worker is replaced on subsequent work. Graceful shutdown flushes
Hocuspocus, drains accepted worker jobs, terminates the worker, then closes SQL.
Idle workers are unreferenced so tooling/tests can exit normally.

`YJS_BACKGROUND_STORE=false` selects the synchronous full-state path. Switching
this flag needs no data conversion, and gzip-capable prior nodes can read the
same rows during a rolling deployment. The separate `YJS_WRITE_V2` and
`YJS_STORAGE_GZIP` reader-compatibility rollout requirements still apply.

This optimization does not remove initial document loading, the first full
capture when no checkpoint exists, full-state fallback after replacement, or
front-end rendering costs. Yjs incremental encoding still traverses deletion
history on the collaboration thread. It reduces hot-path work rather than
promising a constant-time save or unlimited document size.

Regression coverage includes V1/V2 deltas over all four storage encodings,
delete-only updates, concurrent writers, stale/missing bases, edits across
awaits, failed commits, both size budgets, worker crashes/timeouts, backpressure,
draining shutdown, and a warmed-worker event-loop responsiveness check.
