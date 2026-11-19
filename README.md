# Octo Docs — Collaborative Document Backend

Real-time collaborative document subsystem for **Octo Docs**, built on
**Hocuspocus + Yjs**, implementing the FROZEN backend design contract
(`docs/contract/backend-design.md`, v3 candidate).

This backend is a focused, stateful **CRDT real-time sync service**: it handles
WebSocket sync (Yjs), authoritative binary persistence to MySQL, document-
autonomous authorization (`doc_member` + owner), short-lived collab-token
issuance, link invites, and a no-DOM Agent conversion path. It does **not** do
anything whiteboard/Excalidraw related (deferred by the contract).

> ⚠️ **Status: runnable scaffold + core paths.** Some integration glue is
> stubbed and clearly marked with `TODO(§...)`. See [Known gaps](#known-gaps).

---

## Architecture overview

```
 Tiptap front-end ──ws──▶  Hocuspocus WS server (:1234)
                            ├─ onAuthenticate  (verify collab JWT, epoch, role)
                            ├─ extension-database  → MySQL (Y.Doc binary, §3.2)
                            ├─ extension-redis     → Redis pub/sub bus (§5.1)
                            └─ beforeHandleMessage (per-principal write recheck)

 Front-end / octo-web ──REST──▶  Meta API (:3000)  /api/v1/docs/*
                                  ├─ collab-token issuance (§4.4)
                                  ├─ docs CRUD / members / invites (§8.4)
                                  └─ invite accept flow (§4.6)

 PPT front-end ──ws──▶  PPT relay on the same HTTP listener (:3000)
                         └─ /api/v1/ppt/collab (PPT CRDT protocol)

 Authoritative store: MySQL   |   Broadcast bus + epoch cache + registry: Redis
 Identity: octo (token→uid, uid→profile, §4.7)   |   Attachments: object storage (§3.5, stub)
```

The shared public gateway routes `/docs-collab` WebSocket upgrades to Hocuspocus
`1234` and `/api/v1/ppt/collab` upgrades to HTTP `3000`. Both use the same public
domain and TLS listener. For direct-port deployments, configure the separate
PPT endpoint as described in [deployment configuration](docs/DEPLOYMENT.md).

Key design invariants (from the contract):

- **For Yjs document types, authoritative state is the Y.Doc binary** (§3.1). Single-row
  merged-state model with **merge-on-write + diffUpdate bypass** (§3.2/§3.3).
- **PPT retains its native CRDT operations and snapshots** in MySQL; it does not
  send those frames to Hocuspocus or use Y.Doc binary persistence.
- **Document-autonomous permissions**: `resolveRole = doc_member + owner`, no
  group inheritance (§4.2).
- **Two-layer token chain**: octo session token → `POST /collab-token` →
  short-lived collab JWT → WS handshake (§4.4). The long-lived octo token is
  never put on the WS.
- **`permission_epoch`** is authoritative in DB, cached in Redis, with
  singleflight DB fallback; revocation/downgrade is real-time (§4.5).
- **documentName** = `octo:{space}:{folder}:{doc}` (4 segments); whiteboard keys
  are 5 segments with `parts[3]==='wb'` and are rejected here (§4.1/§8.1).
- **Limited invite accounting** is per Space-qualified principal
  `(uid, principalSpaceId)`: repeated acceptance by the same principal consumes
  one use, while the same uid accepting in distinct verified Spaces consumes
  one use in each Space.

---

## Document deletion policy

Bots cannot delete documents, including documents they own or administer.
Authenticated bot requests to `DELETE /v1/bot/docs/:docId` and
`DELETE /v1/bot/docs/octo-doc/:octoDocSlug` return HTTP 403 with
`{"error":"bot_delete_forbidden"}` before document lookup or mutation. This also
applies to retries for already deleted documents; invalid tokens still return 401.
Human deletion through `DELETE /api/v1/docs/:docId` retains its existing verified
Space and document-admin checks, soft deletion, and collaboration invalidation.
This policy does not change bot creation, editing, or other resource operations.

## CLI v2 whiteboard attachment lifetime

A CLI v2 Excalidraw `replace` import removes old live file references and tombstones
old elements. It retains their attachment records and stored bytes because
named versions and safety snapshots still reference them. A later restore can
therefore resolve the original images, and its safety snapshot can recover the
replacement images when undoing the restore.

Staged images are cleaned up when the scene edit explicitly rejects the import.
A thrown scene write or response-delivery failure can follow a committed edit,
so its images are retained for readback. Unreferenced staged images and historical
media may require later reclamation; deleting them safely requires checking both
live and retained-version references. This path does not implement that collector
or reconstruct image objects deleted by an older deployment.

## Document metadata actors

`GET /api/v1/docs/:docId` and readable rows in the Docs list expose `createdBy`
and `updatedBy` as persisted user IDs; `updatedBy` is an empty string when no
editor is recorded. `POST /api/v1/docs/metadata` accepts up to 500 `docIds` and
returns `{ items: [{ docId, createdBy, updatedBy, updatedAt }] }` only for active
documents the caller can read. Missing, deleted, archived, and unreadable IDs
are omitted. The Bot endpoint
`POST /v1/bot/docs/metadata` applies the same rule using the Bot's server-verified
Space and exact cross-Space grants. These fields do not change document ownership
or access permissions.

## Prerequisites

- **Node.js ≥ 20** (developed on v22), npm.
- **MySQL 8** (authoritative store).
- **Redis 5+** (pub/sub broadcast bus, epoch cache, connection registry).
- **`typst` binary** (only for PDF export) — a single static Rust binary; see
  [PDF export (Typst)](#pdf-export-typst).

MySQL and Redis are only needed to **run the server** and for integration
flows. The **unit test suite runs fully offline** (mocks / in-memory).

---

## Environment variables

Copy `.env.example` to `.env` and adjust. Summary:

| Var | Purpose | Contract |
| --- | --- | --- |
| `HOCUSPOCUS_PORT` / `HTTP_PORT` | Hocuspocus Yjs WS / HTTP API and PPT WS ports | §2.1 / §8.4 |
| `MYSQL_*` | authoritative store connection | §3.4 |
| `REDIS_URL` / `REDIS_*` (incl. `REDIS_PREFIX`) | authenticated broadcast bus / cache / registry; URL overrides all connection fields | §5 / [Redis configuration](docs/redis-configuration.md) |
| `COLLAB_TOKEN_SECRET` / `COLLAB_TOKEN_TTL_SECONDS` | collab JWT signing + TTL (5 min) | §4.4 |
| `COLLAB_ALLOW_LEGACY_TOKENS_WITHOUT_HOME_SPACE_PROOF` | temporary Home-Space/PPT compatibility only; it never bypasses Docs current-Space proof | §4.4 / deployment guide |
| `OCTO_IDENTITY_MODE` (`http`/`middleware`) / `OCTO_SERVER_BASE_URL` | octo identity integration | §4.7 |
| `OCTO_SERVER_TOKEN` | optional service token for octo-server human/service directory lookups. Human member writes prefer this token when configured and otherwise use `req.octoToken`. Bot PUT defaults an omitted `principalSpaceId` to the Bot bearer-authenticated Space (not the document Home Space), validates that exact target with the Bot bearer, and may upsert `(docId, uid, BotSpace)` regardless of the document Home Space. When a Bot explicitly selects another Space, PUT deliberately performs no current directory-membership/eligibility revalidation and may only change the role on an already-existing exact row; it cannot create that grant. Bot PUT and exact, directory-free Bot DELETE remain enabled without `OCTO_SERVER_TOKEN`. Human DELETE queries the target Space's Bot directory, cascades a Human removal to that Human's authorized same-Space Bots, and removes an explicitly targeted Bot exactly; directory failure is fail-closed. Deploy octo-server PR #819 before enabling Bot own-Space upserts. | §4.7 / v4.3 bot API |
| `MAX_DOC_BYTES` | single-doc size hard cap (~10MB) | §9.5 |
| `SEARCH_ENABLED` / `SEARCH_PAGE_SIZE_MAX` / `SEARCH_MAX_VISIBLE_TERMS` | full-text doc search: feature switch, per-page hit cap, and the OpenSearch `doc_id IN` down-push bound (over bound ⇒ 503 `terms_limit_exceeded`) | search |
| `OPENSEARCH_NODE` / `OPENSEARCH_USERNAME` / `OPENSEARCH_PASSWORD` | read-only OpenSearch client for the `octo-doc` index | search |
| `OPENSEARCH_TLS_REJECT_UNAUTHORIZED` | verify the OpenSearch TLS cert (`true`/`false`/`1`/`0`, default `true`); set `false` only for a trusted internal self-signed https node — emits a one-time warning when disabled | search |
| `KAFKA_BROKERS` / `KAFKA_ACKS` / `DOCINDEX_KAFKA_TOPIC` | doc-index signal producer: broker list, producer acks, and the topic the external indexer consumes (must match its `DOCINDEX_KAFKA_TOPIC`) | search / indexer |
| `ATTACHMENT_BUCKET` | object-storage bucket (presign stub) | §3.5 |
| `TYPST_EXPORT_BINARY` | path to the `typst` binary (empty ⇒ resolved from `PATH`) | PDF export |
| `TYPST_EXPORT_MAX_CONCURRENT` / `TYPST_EXPORT_MAX_QUEUE` | compile concurrency + queue bound (over queue ⇒ 503) | PDF export |
| `TYPST_EXPORT_COMPILE_TIMEOUT_MS` | hard per-compile timeout (child killed on expiry) | PDF export |
| `TYPST_EXPORT_MAX_IMAGE_BYTES` | per-attachment image download cap for embedding | PDF export |
| `TYPST_EXPORT_MAX_IMAGE_COUNT` | max images embedded per export (count bound) | PDF export |
| `TYPST_EXPORT_MAX_IMAGE_TOTAL_BYTES` | aggregate byte budget across embedded images per export | PDF export |

---

## Setup & run

```bash
# 1. install
npm install

# 2. create the schema (fresh install only)
#    FRESH INSTALL ONLY — schema.sql holds the full CREATE TABLE DDLs and is
#    applied once. Re-running it on an existing DB does nothing for tables that
#    already exist, so it does NOT add columns introduced after the initial
#    install — use the upgrade migrations below for that.
mysql -u <user> -p <database> < migrations/schema.sql

# 2b. EXISTING DEPLOYMENTS — build, then run the migration ledger runner.
#     It applies migrations/upgrades/*.sql in filename order, records filename
#     + checksum in schema_migrations, and safely skips already-applied files.
npm run build
npm run migrate

# 3. dev server (tsx watch) — Hocuspocus WS (:1234), HTTP API + PPT WS (:3000)
npm run dev

# build + run compiled output
npm run build
npm start
```

For local development before building, `npm run migrate:dev` runs the same
runner directly from TypeScript. Plain `mysql < migrations/upgrades/...` remains
valid as a low-level fallback, but production deploys should use `npm run
migrate` as an explicit step before starting the new server version.

### Approval-card rolling-upgrade compatibility

The approval callback normally carries the operator's trusted
`operator_space_id`. During a compatible octo-server rollout, an older queued or
replayed callback may omit that newly-added field. Only for that missing-field
legacy shape, Docs uses the signed card delivery `space_id` and revalidates the
exact `(operator_uid, space_id)` principal as a current document admin before
the pending→terminal CAS; it never substitutes the document owner/Home Space.
An explicitly present but empty/invalid `operator_space_id` remains forbidden.

Callback receipts are immutable idempotency records. An event whose receipt was
already finalized as `forbidden` before the compatible deployment replays that
same result and is not re-authorized; a still-unfinalized/queued legacy event can
be revalidated and succeed after rollout. This preserves replay-exact behavior
without weakening authorization.
When adopting the runner on a database previously migrated by hand, its first
run will re-run the idempotent upgrade files once to populate the
`schema_migrations` ledger.

At runtime the service verifies, before opening the WebSocket or REST listeners,
that `docs_metadata.role_encoding` is exactly `append-v1`. A missing table/row,
an older encoding, or an unknown value aborts startup. Run the migrations to add
the marker; the service never changes the marker or re-encodes role rows, and an
existing conflicting marker is deliberately not overwritten by the migration.

## PDF export (Typst)

Documents are exported to PDF server-side by rendering the persisted document to
[Typst](https://typst.app) source and compiling it with the standalone `typst`
binary:

```
POST /api/v1/docs/:docId/export/pdf   (reader role)  →  application/pdf
```

The request pipeline is: authorise (reader) → load the authoritative persisted
Y.Doc → convert to ProseMirror JSON → render to Typst source (`src/export/
renderTypst.ts`) → compile with a short-lived `typst` child process
(`src/export/typstService.ts`). Typst has **no resident process** and **no
network access** at compile time, so image bytes are pre-downloaded
(size-bounded) into a per-compile sandbox root that `typst --root` cannot escape.

### Installing the `typst` binary

Typst is a single static Rust binary (~30MB) with no browser or LaTeX
dependency. Install it on the machine that runs this backend:

```bash
# macOS
brew install typst

# Linux (musl static release; pick your arch)
curl -fsSL https://github.com/typst/typst/releases/download/v0.13.1/typst-x86_64-unknown-linux-musl.tar.xz \
  | tar -xJ -C /tmp \
  && sudo install -m 0755 /tmp/typst-x86_64-unknown-linux-musl/typst /usr/local/bin/typst

typst --version   # verify
```

The bundled `Dockerfile` already installs the pinned `typst` binary plus the
Noto CJK and emoji fonts. If you run the backend **outside** the image (e.g.
directly on a host), install `typst` as above and make sure the host has CJK and
emoji fonts (`Noto Sans CJK` / `Noto Color Emoji`, or the platform equivalents
like PingFang / Apple Color Emoji on macOS) — Typst resolves fonts from the
system font book, so glyph coverage follows the host's installed fonts.

Set `TYPST_EXPORT_BINARY` if the binary is not on `PATH`; tune
`TYPST_EXPORT_MAX_CONCURRENT` / `TYPST_EXPORT_MAX_QUEUE` /
`TYPST_EXPORT_COMPILE_TIMEOUT_MS` / `TYPST_EXPORT_MAX_IMAGE_BYTES` /
`TYPST_EXPORT_MAX_IMAGE_COUNT` / `TYPST_EXPORT_MAX_IMAGE_TOTAL_BYTES` as needed.

## Sheet size dimensions (read payload vs storage)

See [Worksheet discovery and scoped reads](docs/SHEET_READ.md) for the directory
endpoint, worksheet selectors, compact cursors, compatibility and validation.

A spreadsheet (`doc_type = 'sheet'`) is bounded by **two independent byte
dimensions**. They measure different serializations of the same sheet, use
different caps, and are NOT comparable — mixing them up is the source of the
apparent "dead zone" myth, so they are documented together here.

| Dimension | What it measures | How | Cap (env) | Where enforced |
| --- | --- | --- | --- | --- |
| **Write request** | One `PATCH /:docId/sheet` JSON body | Raw HTTP request bytes | `SHEET_WRITE_MAX_REQUEST_BYTES` (default **3 MiB**) | Route-selected `express.json` parser → **413 `sheet_too_large`** |
| **Write entries** | Operations in each Sheet PATCH resource map | Number of object entries; cell sets and deletes both count | `SHEET_WRITE_MAX_CELLS` (default **20,000**) | Route gate `docSheet.ts` → **413 `too_many_cells`** or the resource-specific equivalent |
| **Read payload** | The JSON body a `GET /:docId/sheet` returns | UTF-8 bytes of the decoded cells and whole-grid maps, including checkbox validations | `SHEET_READ_MAX_CELL_BYTES` (default **1 MB**) → `config.sheetRead.maxCellBytes` | Read gate `docSheet.ts` → **413 `sheet_too_large`**; write gate `editDocSheet.ts` measures it the SAME way and pre-rejects a write that would exceed it |
| **Storage** | The persisted Y.Doc binary update | `Y.encodeStateAsUpdate(doc).length` | `MAX_DOC_BYTES` (default **10 MB**) → `config.maxDocBytes` | `persistence.store`; write gate `editDocSheet.ts` → **413 `doc_too_large`** |

Key points:

- **The write cap is aligned to the read cap.** `editDocSheet` rejects a write
  whose post-edit *read payload* would exceed `maxCellBytes` (`sheet_too_large`)
  *before* it touches the live Y.Doc. This guarantees **every sheet written
  through the REST/PATCH path is whole-read-readable** — there is no
  write-but-not-readable state reachable via normal writes.

- **The two dimensions are different sizes for the same sheet.** The storage
  binary carries CRDT metadata (client IDs, clocks, deletion tombstones from
  edited/deleted cells) that the decoded `{sheetCells, sheetDims}` read payload
  does not. So a sheet whose *storage* is, say, 1.05 MB can still have a *read
  payload* well under 1 MB and therefore **whole-reads 200, not 413**. That is
  correct behaviour, not a gap: the read 413 is governed only by the read-payload
  dimension, never by storage bytes.

- **Whole-read 413 is not a dead end.** A sheet whose read payload exceeds
  `maxCellBytes` (only reachable by seeding the live Y.Doc *outside* the write
  gate — e.g. a version-restore of a historic oversized snapshot, or an import)
  returns 413 `sheet_too_large` on a whole read, but the **paginated read
  (`?limit=`/`?cursor=`) retrieves it page by page**, each page bounded by
  `maxCellBytes`. No cell is unreachable.

- **Checkbox inspection-budget 413 is repairable too.** Collaboration peers can write enough
  individually valid checkbox ranges to exceed the server's bounded overlap-inspection work.
  In that case GET returns no partial validation set; it returns the snapshot `baseVersion` and one
  `repairDataValidationKey`. Delete that key with a validation-only PATCH and retry. Each accepted
  repair must strictly shrink the raw checkbox metadata, and repeated repairs remain available even
  when one deletion is not yet enough to bring the sheet back under the inspection budget.

- **Stored checkbox candidates are bounded at every write boundary.** REST batches and live
  collaboration updates share `SHEET_WRITE_MAX_DATA_VALIDATIONS` (default **5000**) as the complete
  persisted checkbox-candidate cap, plus `SHEET_WRITE_MAX_DATA_VALIDATION_BYTES` (default **1 MB**)
  for raw checkbox metadata; malformed historical keys count toward both limits. Invalid new or
  orphaned WebSocket validation writes are synchronously compensated before the debounced store,
  while non-growing edits and deletions remain available to repair legacy state. If a validation
  write is rejected, direct writes to other root maps from the same Yjs transaction are compensated
  too, while validation deletions are retained as repair progress.

- **Protection authorization differs by transport.** REST/agent Sheet writes enforce protected
  ranges server-side. Raw collaboration WebSocket frames have writer-role admission and validation
  shape/resource guards, but no per-frame principal-aware protected-range authorization; the web UI
  keeps its existing client-side protection checks. This MR does not claim to close that pre-existing
  WebSocket authorization gap for cells or checkbox validations.

- **413 observability.** Both size-413 bodies name the dimension they measured so
  a caller sees at a glance which cap tripped and how far past it the payload sits:
  - `sheet_too_large` (read gate and write gate) → `{ error, payloadBytes, limit }`
    (read-payload dimension; the read gate also adds a `hint` to paginate).
  - `doc_too_large` (write gate) → `{ error, docBytes, limit }` (storage dimension).

  A caller that sees `sheet_too_large` therefore knows to switch to a paginated
  read; one that sees `doc_too_large` knows the sheet has hit the hard storage
  cap and must be trimmed.

## Tests

### PPT size budgets

Run `2026-09-20-ppt-document-budget.sql` before starting this version. It widens
draft, live document/state, and version JSON columns from MEDIUMTEXT to LONGTEXT,
preserving existing rows and allowing repeat runs. Rolling back the application
does not require narrowing these columns; narrowing can destroy larger documents.
Live snapshots retain a separate 64 MiB per-value safety budget, including CRDT
history. The visible document cap remains 32 MiB, not 64 MiB.

Whole-document writes allow up to 32 MiB of compact UTF-8 deck JSON
(`PPT_MAX_DOCUMENT_BYTES`). Their HTTP parser allows 40 MiB
(`PPT_WRITE_MAX_REQUEST_BYTES`) including the revision/envelope and JSON
whitespace. This applies only to human `PATCH /api/v1/ppt/docs/:id/live`,
`PUT /api/v1/ppt/docs/:id/draft`, and Bot `PATCH /v1/bot/docs/:id/ppt`.
The former 8 MiB relay blob setting no longer limits a whole deck. Per-frame,
per-blob, operation-count, and room-log budgets remain independent and unchanged.

The human full-deck routes currently parse this bounded body after the per-IP
rate limiter but before endpoint authentication; an unauthenticated request can
therefore allocate up to the 40 MiB parser limit before being denied. Gateways
must enforce request/concurrency limits as well as the application rate limit.
Bot routes authenticate their token before invoking the large parser.

Live collaboration checks the resulting deck before acknowledging persistence;
an oversized edit rolls back rather than becoming a saved-but-unreadable deck.
Draft-to-live initialization also checks the final deck after canonical-title
refresh and legacy text/HTML normalization. An oversized conversion writes no
snapshot and leaves the saved draft available for reduction and retry.
The small-frame path uses a conservative snapshot/state/tail upper bound; near
the document limit it materializes the actual result under the room lock.
REST rejects oversized documents with `PAYLOAD_TOO_LARGE` and the measured
document bytes/limit; parser errors identify the separate request dimension.

Rendered version HTML has a separate 64 MiB budget; exported HTML retains its
160 MiB budget. Escaping and embedded attachments can enlarge these artifacts.
Deployments must allow the 40 MiB request through their gateway and provision
MySQL `max_allowed_packet` for the combined deck/CRDT state or deck/version HTML
(at least 128 MiB for ordinary near-limit decks). The version writer retains its
database-packet preflight; increasing the JSON limit does not disable it.
Large individual assets/operations still need the attachment path rather than
bypassing the smaller collaboration frame limit.

```bash
npm test          # vitest run (offline unit tests)
npm run test:watch
```

The default unit suite covers the critical contract paths with mocked services.
Live database suites are opt-in. The `ppt_cluster_integration` CI job starts
disposable MySQL 8 and Redis 7 services, sets `PPT_CANONICAL_MYSQL_TEST=1` and
`PPT_CLUSTER_MYSQL_TEST=1`, and runs `test/pptCanonicalId.mysql.test.ts` to verify
canonical IDs, shared routes and collaboration across independent processes.
Use the isolated service configuration in `.gitlab-ci.yml` when running this
suite locally; never point these database tests at an existing deployment.
The separate `ppt_budget_integration` job runs `test/pptBudget.mysql.test.ts`
with `PPT_BUDGET_MYSQL_TEST=1`, an empty dedicated database and a 256 MiB MySQL
packet limit. It covers migration idempotency, exact 32 MiB persistence,
genesis rejection/recovery, overflow rollback, compaction, versioning and reopen.

---

## Project structure

```
backend/
├─ migrations/
│  ├─ schema.sql                # §3.4 — the 8 DDLs, copied verbatim (fresh install)
│  └─ upgrades/                 # idempotent incremental migrations for existing DBs
├─ src/
│  ├─ config/env.ts             # typed env config
│  ├─ db/
│  │  ├─ pool.ts                # mysql2 pool + query/transaction helpers
│  │  ├─ redis.ts               # ioredis client + key namespacing
│  │  └─ repos/                 # doc_meta, doc_member, doc_invite,
│  │                            #   doc_invite_redemption, yjs_document
│  ├─ schema/index.ts           # buildSchema() + COLLAB_FIELD (local stand-in)
│  ├─ permission/
│  │  ├─ documentName.ts        # parse/build + validation matrix
│  │  ├─ role.ts                # Role <-> number, ranking
│  │  ├─ resolveRole.ts         # resolveRole / recheckCurrentRole
│  │  ├─ recheck.ts             # recheck + singleflight + short-TTL cache
│  │  ├─ epoch.ts               # permission_epoch read/bump (DB+Redis+SF)
│  │  └─ connectionRegistry.ts  # cross-node connection registry
│  ├─ auth/
│  │  ├─ collabToken.ts         # sign/verify collab JWT
│  │  ├─ issueCollabToken.ts    # §4.4 issuance service
│  │  └─ octoIdentity.ts        # OctoIdentity interface + HTTP/middleware impls
│  ├─ collab/
│  │  ├─ persistence.ts         # fetch/store merge-on-write (§3.2)
│  │  ├─ authenticate.ts        # onAuthenticate logic (§4.1)
│  │  └─ server.ts              # Hocuspocus Server wiring
│  ├─ agent/conversion.ts       # no-DOM ProseMirror <-> Y.Doc (§7.1)
│  ├─ api/
│  │  ├─ app.ts                 # Express app, mounts /api/v1/docs/*
│  │  ├─ middleware/auth.ts     # AuthMiddleware (octo token -> uid)
│  │  ├─ guard.ts               # requireDocRole
│  │  ├─ routes/                # docs, collabToken, members, invites, attachments
│  │  └─ services/              # acceptInvite + acceptDecision (pure §4.6)
│  └─ index.ts                  # process entry (WS + REST + epoch sub + shutdown)
└─ test/                        # vitest unit tests
```

---

## CONTRACT-MAPPING

Which module implements which contract section:

| Contract section | Implementation |
| --- | --- |
| §2.1 Server config, §2.2 lifecycle hooks | `src/collab/server.ts` |
| §3.1–3.3 Y.Doc binary authoritative, merge-on-write + diffUpdate bypass | `src/collab/persistence.ts` (`computeFinalState`) |
| §3.4 the 8 table DDLs | `migrations/schema.sql` |
| §3.4 repos | `src/db/repos/*` |
| §3.5 attachment presign | `src/api/routes/attachments.ts` (stub) |
| §4.1 onAuthenticate (verify, epoch, recheck, readOnly, parse) | `src/collab/authenticate.ts` |
| §4.1/§8.1/appendix B documentName validation matrix | `src/permission/documentName.ts` |
| §4.2 resolveRole (doc_member + owner) | `src/permission/resolveRole.ts` |
| §4.4 collab-token issuance + two-layer chain | `src/auth/issueCollabToken.ts`, `src/auth/collabToken.ts` |
| §4.5 permission_epoch (DB authoritative, Redis cache, singleflight) | `src/permission/epoch.ts` |
| §4.5 connection registry | `src/permission/connectionRegistry.ts` |
| §4.5 step 4 per-principal write recheck | `src/collab/server.ts` (`beforeHandleMessage`) |
| §4.6 link invite accept flow (branches a–d) | `src/api/services/acceptDecision.ts` (pure) + `acceptInvite.ts` (IO) |
| §4.7 octo identity (token→uid, uid→profile) | `src/auth/octoIdentity.ts` |
| §5.1 extension-redis multi-instance | `src/collab/server.ts` (Redis extension) |
| §7.1 no-DOM ProseMirror <-> Y.Doc | `src/agent/conversion.ts`, `src/schema/index.ts` |
| §8.1 handshake / documentName | `src/permission/documentName.ts`, collab-token route |
| §8.2 close codes (4401/4403) | `src/collab/authenticate.ts` (`AuthError`) |
| §8.3.1 awareness identity/field validation | `src/collab/server.ts` (`onAwarenessUpdate`) |
| §8.4 REST metadata API | `src/api/routes/*`, `src/api/app.ts` |
| §9.4 graceful shutdown flush | `src/index.ts` (SIGTERM) |
| §9.5 single-doc size cap | `src/collab/persistence.ts` (`store`) |
| §10.1 exact dependency versions | `package.json` |

---

## Known gaps

Honest accounting of what is **stubbed / deferred** for the next round:

- **Object-storage presign (§3.5)** — `attachments.ts` returns a non-signed
  stub URL; no COS/S3 SDK, no `doc_attachment` registration / read re-signing.
- **`@octo/docs-schema` shared package (§7.1)** — `src/schema/index.ts` is a
  local minimal ProseMirror schema stand-in. It MUST be replaced by the frozen
  shared package so the server schema is byte-identical to the Tiptap front-end.
- **octo same-process mount (§4.7(a))** — `MiddlewareOctoIdentity` delegates to
  the HTTP introspection endpoint; the real in-process `AuthMiddleware` /
  `c.GetLoginUID()` bridge requires running inside octo-server.
- **octo batch profile (§4.7(b))** — `getUsers` fans out per-uid calls; the thin
  `POST /v1/users/batch` is the one octo-side addition the contract calls out.
- **Epoch invalidation → live connection action (§4.5 step 3)** — the Redis
  subscriber refreshes the per-node epoch watermark + caches; locating and
  closing/flipping individual live connections is TODO. The `beforeHandleMessage`
  per-principal recheck is the backstop in the meantime.
- **Document lock / single-writer election (§5.3)** — `extension-redis` provides
  the lock primitive; explicit lock TTL/renew/release-on-destroy
  (`releaseAllDocumentLocks`) and documentName affinity routing are deployment/
  gateway concerns not wired here.
- **Agent `/internal/agent/docs/*` write endpoints (§7.2/§7.3)** — the no-DOM
  conversion util exists; the owner-node-routed `openDirectConnection` write
  endpoints are not yet built.
- **Incremental-log persistence model (§3.3 alternative)** — DDLs for
  `yjs_snapshot` / `yjs_update_log` are in `schema.sql` but the model is the
  default-off alternative; not implemented.
