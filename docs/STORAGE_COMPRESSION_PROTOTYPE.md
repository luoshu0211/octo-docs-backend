# Automatic Yjs storage compression

Backend persistence automatically compresses Yjs state on save and decompresses it on read. No user action or opt-in configuration is required. This backend-only change does not alter Yjs network messages, cell schema, grid dimensions, or the whole-sheet REST JSON limit. It does not make a large worksheet safe to open in a browser.

## Configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| `YJS_STORAGE_GZIP` | `true` | Automatically write gzip when smaller; explicit `false` is an operator compatibility override for rolling upgrades. |
| `MAX_DOC_BYTES` | 10 MiB | Maximum decoded Yjs state on writes and gzip output on reads. |
| `MAX_DOC_STORAGE_BYTES` | `0` | Maximum stored blob on writes; zero inherits `MAX_DOC_BYTES`. |
| `YJS_WRITE_V2` | `false` | Existing choice of logical Yjs V1/V2 update format. |

The isolated million-cell benchmark uses V2, gzip, a 128 MiB decoded budget, and a 10 MiB stored budget. These capacity settings are experimental, not recommended production limits. Capacity defaults remain unchanged; compression is enabled automatically even when `YJS_STORAGE_GZIP` is unset or empty.

## Database format and rollout

The existing unsigned `encoding` column stores `1` for raw V1, `2` for raw V2, `3` for gzip V1, and `4` for gzip V2. No new column is required; the existing encoding-column migration is a prerequisite. `size_bytes` is the physical blob length. Repository reads normalize rows back to V1/V2 before collaboration, export, restore, and compaction code sees them. Gzip validates its checksum and stream termination; decompression has an output bound.

New installations consisting only of compatible consumers use the default automatic compression immediately. Existing fleets must upgrade readers before any writer emits 3/4. Older backends reject these tags as unknown rather than treating them as empty documents; this avoids overwrite but still causes unavailability. External indexers, maintenance tools, and older deployments must be audited separately.

**Deployment gate: complete step 1 before merging into an automatically deployed environment branch or rolling out this default-on build.**

1. Explicitly configure `YJS_STORAGE_GZIP=false` for every backend writer during the compatibility rollout, and verify the effective configuration is propagated to new instances. Leaving it unset is no longer safe while old readers remain.
2. Deploy this build and upgrade every other reader of `yjs_document`, keeping the explicit override until no incompatible consumer remains.
3. Remove the temporary override or set `YJS_STORAGE_GZIP=true` and roll out the configuration. Saves now compress automatically; existing raw rows convert on their next successful save. This is the normal operating state, not a user-selectable feature.

Turning writes off is not sufficient to roll back to an old binary: existing 3/4 rows must first be rewritten by a compatible reader/writer and verified. Keep the new read capability during rollout and recovery. This code change does not itself modify deployment configuration or bypass the compatibility gate.

Write budgets must not make existing rows unreadable. Legacy raw V1/V2 reads retain their previous behavior even if the row exceeds current write limits, so recovery and compression migration remain possible. Reads do not enforce the stored write budget on existing compressed rows either. New gzip rows always have a bounded decompression output using `MAX_DOC_BYTES`; audit their decoded sizes before lowering that limit. Disabling gzip writes does not disable gzip reading or its output bound. An oversized legacy row can only be written again once the final state satisfies both write budgets.

## Safety and limitations

The storage budget is preflighted wherever `persistedByteLength` is used, with HTTP overflow mapped to 413. Decoded and physical budgets are enforced again at the authoritative store and repository write boundary. The final merged state is checked inside the SQL transaction, before UPSERT. Invalid or unknown rows fail closed.

Compression does not remove CRDT identities, causality, or historical operations. It is not history compaction. Version snapshots already have their own gzip representation and are unchanged. Auto-compaction's trigger uses the physical storage budget, while its existing rebuild and cache-safety rules remain in place.

Whole-sheet JSON gates remain separate. Raising the decoded budget does not by itself allow a bot to PATCH or GET a million-cell workbook under a smaller REST budget. High-entropy content can still exceed the stored budget. All full-document encoding, gzip, decoding, and validation still consume CPU and memory; this prototype does not implement sharding or lazy loading.

Gzip is synchronous. The prototype may compress the incoming state, final merged state, and repository write separately for defense in depth. Measure event-loop delay, concurrent-document throughput, and process memory before production enablement; the benchmark's single-document timings are not throughput or latency guarantees.

## Reproduction

Run `npm test -- --maxWorkers=1 --minWorkers=1` and `npm run typecheck` for offline checks. `scripts/benchmarkStorageCodec.ts` additionally exercises real MySQL transactions and the Redis-backed guard. It refuses databases other than loopback `octo_storage_proto` or Redis prefixes outside `codec-prototype-*`; nevertheless, use fresh task-owned infrastructure, never a shared database with a matching name.

Initialize the schema and the existing encoding-column migration. Set `MYSQL_HOST=127.0.0.1`, the task-owned `MYSQL_PORT`, `MYSQL_DATABASE=octo_storage_proto`, database credentials, and task-owned Redis host/port/prefix. Set `BENCHMARK_OUTPUT_DIR` and the four experimental compression/budget settings above, and put this repository's `node_modules/.bin` on `PATH`. From this repository run `tsx scripts/benchmarkStorageCodec.ts write sequence`, substituting `constant`, `styled`, or `random` for other cases. Use a fresh database for repeated write measurements; reusing rows merges old CRDT identities into the fixture.

Restart MySQL, rediscover its published port with `docker port`, then run `tsx scripts/benchmarkStorageCodec.ts read sequence` in a new process for each successful scenario. Keep the corresponding write-result JSON in the same output directory: reads verify its SQL hash, every cell, and state vector. Run `tsx scripts/benchmarkStorageCodec.ts concurrency concurrency` for concurrent SQL stores, and `tsx scripts/benchmarkStorageCodec.ts legacy-fixtures legacy-fixtures` for lazy conversion. The `legacy-read sequence` mode requires `LEGACY_BACKEND_PATH` pointing to an untouched old backend checkout with dependencies; it expects that reader to reject the new format without changing the row. These are persistence integration tests, not authenticated WebSocket or browser acceptance.
