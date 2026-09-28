# Spreadsheet productivity API

Structural row/column edits on a worksheet containing conditional-format rules
return `409 sheet_conditional_format_unsupported` before mutation or a safety
snapshot. Clients must preserve the rules, not delete them to bypass the guard.

This change extends the conditional-format historical restore support from MR
!147. Deploy both before advertising CLI authoring. Frontend MR !106 consumes
the same `sheetConditionalFormats` Y.Map and explicit text cell format.

## Conditional-format rules

`GET /v1/bot/docs/:docId/sheet` returns `sheetConditionalFormats`, including `{}`
when no rules exist. Paged reads include rules on the first page only.
`PATCH /v1/bot/docs/:docId/sheet` accepts `conditionalFormats`, a sparse map keyed
by `logicalId!cfId`: complete `{priority,rule}` values create/update individual
rules, `null` deletes them. The embedded CLI sheet reference contains an example.

Rules retain Univer's nested configuration and bounded extension properties
verbatim for forward-compatible round-tripping; unknown properties are not
interpreted by the backend. Priority is a finite signed number, not a
nonnegative index: frontend !106 inserts new rules with decreasing negative
priorities and sorts numerically. Data bars use threshold objects such as
`min: {type: "num", value: 0}` and `max: {type: "max"}`, not bare numbers.
Color-scale and icon-set entries also carry these threshold objects in `value`.

Writes use the existing `If-Match`, writer reauthorization, protected-sheet and
automatic safety-snapshot path. Rules contribute to both binary storage and
read-payload limits; additional bounds are 1000 rules/1 MiB per workbook and
64 KiB/512 ranges per rule. A deleted worksheet loses its rules. Row/column
structural edits on a worksheet with rules fail closed until relocation is
implemented. Do not remove rules implicitly to bypass this restriction.

Historical restore uses the existing versions endpoint, including clearing rules
when restoring a version without them. Rules referencing a worksheet absent from
the restored sheet list are rejected before any live state changes, with the
same legacy-default-sheet handling as ordinary writes. Conditional-format Excel import/export is
not added here.

## Cleaning

`POST /v1/bot/docs/:docId/sheet/split` and `/sheet/deduplicate` require writer
access, `If-Match`, `logicalId` and an inclusive zero-based `range`. Both default
to `preview: true`; use explicit `preview: false` to apply the same request and
base version. Split also requires a 1-16 character literal `delimiter`; it accepts
one source column. `overwrite: true` is required to replace occupied destinations
to the right. Dedupe accepts `header` and `caseSensitive`, both default false.

Preview returns planned `cells`, output `range`, `rows`, `columns`, `removedRows`,
`overwrittenCells` and `baseVersion`. It performs no write or snapshot. Apply
returns counts and the new version, not the entire cell batch. A stale version
returns 412; re-read and preview instead of automatically retrying old consent.
Missing overwrite consent returns 409 `cleaning_overwrite_required`.

Input/output is limited to 20,000 cells or the lower configured write limit.
Literal splitting preserves empty fields, identifiers and formula-looking text;
it writes strings with number format `@` while retaining destination styles.
Unused split padding remains absent rather than becoming empty text cells;
occupied padding is cleared only with overwrite consent. Genuine empty delimiter
fields remain explicit empty strings.
Deduplication keeps first occurrences and blank rows, compacts only selected
values and clears the tail without deleting worksheet rows. Case-insensitive
comparison uses locale-independent Unicode lowercase. Source cells carrying a
rich-text payload (`p`) are refused with `422 cleaning_complex_sheet` during both
preview and apply; their inline formatting is never silently flattened. Source formulas,
active filters, overlapping merges, drawings, links, validations and comments
are refused. Protected cells and authoritative permissions are still checked by
the common live-write path. CLI changes use version safety snapshots, not a
browser client's native undo stack.

Temporary personal filtering remains browser-local. CLI users can privately
filter read results; the shared `filters` mutation is not a personal view.
