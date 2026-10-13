# Worksheet discovery and scoped reads

## API contract

Both routes use the existing document-reader authorization gate on the Bot
`/v1/bot/docs` and human `/api/v1/docs` mounts. Worksheet selectors do not grant
access or change protected-range/write authorization.

### Directory

`GET /v1/bot/docs/:docId/sheets`

```json
{
  "docId": "d_example",
  "items": [
    { "sheetId": "default", "name": "汇总", "order": 0, "rowCount": 200, "columnCount": 20 },
    { "sheetId": "sales", "name": "新剧榜单", "order": 1, "rowCount": 200, "columnCount": 20 }
  ]
}
```

The directory returns only tab metadata, sorted by order and then logical ID.
`sheetId` is the persisted `sheetList` key. Counts describe declared grid size,
not non-empty cells. The legacy empty registry exposes one implicit
`default` / `Sheet1` tab with the existing 1000-row/100-column fallback, without
writing that entry into the document. No cell validation, cell data or complete
version vector is needed in the directory response. An oversized directory is
rejected using the configured response cap.

### Scoped data

`GET /v1/bot/docs/:docId/sheet?sheetId=sales&limit=1000`

Alternatively supply `sheetName` for exact display-name matching. Do not supply
both selectors. The response adds `sheetId`, keeps the existing `baseVersion`
write token, and restricts these maps before validation/pagination/byte budgeting:

- `sheetCells`, `sheetHyperLinks`, `sheetConditionalFormats`: exact `sheetId!` prefix.
- `sheetMerges`: exact `sheetId:` prefix.
- `sheetDims`: exact `sheetId:` prefix; bare `cN`/`rN` entries belong only to `default`.
- `sheetList`, `sheetFreeze`, `sheetFilters`, `sheetDataValidations`: selected sheet only.

Cell keys are preserved rather than stripped or renumbered. Without selectors
and without a scoped cursor, the existing whole-workbook behavior remains.
Selectors alone do not opt into pagination: callers use `limit` or `cursor`.
An empty selected tab returns empty cells and no continuation cursor.

Errors:

| HTTP | Error | Caller action |
| --- | --- | --- |
| 400 | `invalid_sheet_selector` | Supply exactly one valid, nonempty selector. Repeated/nested selector values are rejected. |
| 404 | `sheet_not_found` | Refresh the directory; never silently fall back to the full workbook. |
| 409 | `ambiguous_sheet_name` | Inspect `candidates: [{sheetId,name}]` and select an explicit ID. |
| 400 | `invalid_cursor` | Restart; the cursor is malformed or belongs to a different document/selection. |
| 409 | `sheet_changed` | Restart from the first page because the existing workbook version check failed. |

## Compact cursors

New cursors are base64url-encoded JSON with an explicit version marker (`t: 2`),
SHA-256/base64url fingerprint of the original baseVersion (`v`), document ID (`d`),
worksheet ID or `null` for the workbook (`s`), and the last emitted cell key (`k`).
Clients must treat this representation as opaque. It is a continuation marker,
not an authorization token, and never replaces the document reader gate.

The fingerprint is 43 ASCII characters regardless of how many historical Yjs
clients contributed to the state vector. The response still carries the original
baseVersion for existing write clients. This preserves the existing state-vector
consistency semantics; it does not introduce a new per-worksheet version model.
Edits to other worksheets can therefore invalidate a selected-sheet walk too.

Cursor-only continuation inherits the selected worksheet. Repeating an equivalent
ID/name is allowed; changing the document or selected worksheet is rejected.
First-page metadata appears only once, as before. Byte accounting uses the actual
compact encoder, including document, scope and last key, rather than assuming
the former full-vector cursor size.

The old `{v: baseVersion, k: lastKey}` cursor remains accepted for whole-workbook
continuations and is upgraded on the next response. It cannot be combined with a
new worksheet selector because it has no selection scope. Deploy the backend
before the CLI: an old backend may silently ignore unknown query parameters.
The paired CLI refuses to present such an unconfirmed response as a scoped read.
Do not disable HTTP/2 or increase ingress limits as a substitute for this fix.

## Bot workflow

```sh
octo-cli docs sheet list <docId>
octo-cli docs sheet get <docId> --sheet-id sales --limit 1000
octo-cli docs sheet get <docId> --cursor '<nextCursor>' --limit 1000
```

Match the user's requested name against the directory. Prefer its persistent ID
for further requests. Ask for clarification on ambiguous names. Follow only the
returned cursors until `hasMore` is false. Never fetch the whole workbook merely
to filter a requested worksheet locally.

## Performance and verification boundaries

Read handlers use one ephemeral decoded Y.Doc and reuse the existing validators.
Selected maps are filtered before validation, so unrelated oversized/invalid
cell resources do not prevent a valid selected-sheet read. The live-state read
still snapshots the whole workbook; this is not a storage-level range-read API.

Regression suites cover directory access/type gates, implicit legacy tabs, exact
Unicode names, ambiguous/missing/invalid selectors, every returned resource family,
scoped byte budgets, legacy tokens, changed versions, foreign document/worksheet
continuations, and 1200-client state vectors. Real document acceptance still
requires an authorized identity and a deployed backend/CLI pair.

For cross-repository contract verification, build the CLI and run:

```sh
OCTO_SHEET_READ_CLI_BINARY=/absolute/path/to/built/octo-cli npm test -- test/sheetReadHttp.test.ts
```

This runs the actual CLI against the real Express router and genuine Yjs state,
with explicitly mocked authorization/storage boundaries. It verifies routing,
directory discovery, name selection and complete pagination through a 2 KiB HTTP
header budget; the equivalent legacy long cursor is rejected with HTTP 431.
It is not production authentication, persistence or the incident document's
acceptance. The subprocess uses an isolated `OCTO_CONFIG_DIR` so local profiles
cannot redirect or prevent fixture requests.
