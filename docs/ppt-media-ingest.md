# PPT media URL ingestion

`POST /api/v1/docs/:docId/attachments/ingest` (Human) and
`POST /v1/bot/docs/:docId/attachments/ingest` (Bot gateway) retain the shared
attachment contract. The target document's stored type selects the behavior:

- Non-PPT: existing image-only ingestion and signed image URL response.
- `html_ppt`: content-identified image/audio/video ingestion into native PPT media.

Request: `{"urls":["https://public-cdn.example/video.mp4"]}`.

PPT success response (the CLI wraps it in `data`):

```json
{
  "mappings": [{
    "sourceUrl": "https://public-cdn.example/video.mp4",
    "attachId": "att_example",
    "ref": "ppt-media:att_example",
    "mime": "video/mp4",
    "sizeBytes": 12345
  }],
  "notIngested": []
}
```

Use `ref` in an image/media component's `src` (or image `poster`), then save the
deck with a freshly read `baseRevision`. Ingestion itself does not edit the deck.
No external URL or base64 content needs to be persisted in the deck. Existing
PPT media reads and HTML export resolve the registered same-document attachment.
An ordinary attachment ID is not interchangeable with a PPT media ID.

## Limits and safety

- Shared writer guard: verified identity/Space and target document role.
- Recheck role and permission epoch before/after storage work and before reply.
  Revocation aborts the batch and compensates its created objects/rows.
- Maximum 10 unique URLs for PPT, also subject to the configured shared raw URL
  count limit. Duplicate URL strings within a request are fetched only once.
- Per-file limit: the lower of 50 MiB and the configured attachment file limit.
  At most 100 MiB of successfully downloaded source bytes per batch.
- SVG sanitation and its separate 1 MiB bound are mandatory. The direct PPT
  upload path also sanitizes SVG; adding SVG to the read allowlist never opens
  an unsanitized upload path.
- MIME is identified from bytes, not an extension or upstream Content-Type.
  Recognized containers are not a guarantee of full decoding or browser codec support.
- Public HTTP(S) only, configured safe ports, every DNS answer and redirect
  validated, connection pinned to a validated address. No source credentials.
  DNS and response streaming share the existing fetch deadline.

HTTP 200 can contain partial failures. `notIngested` names each failed source
with a bounded reason such as `ssrf_blocked`, `response_too_large`,
`unsupported_media_type`, `size_too_large`, `batch_size_too_large` or
`store_failed`. Do not insert an element for those entries. Storage/DB failure
compensates that attempt; a cleanup failure is surfaced as a server error, not
silently reported as a successful import.

The endpoint is not idempotent across requests. Retain successful receipts and
retry only failed entries. Reconcile an uncertain timeout before retrying;
the operation can have created attachments without editing the deck.

## CLI

Keep the existing `octo-cli file upload --file ./video.mp4` command, then call
this endpoint with `octo-cli api POST /v1/bot/docs/<docId>/attachments/ingest`.
No new generated CLI upload command, server schema migration, frontend flag,
release credential or real-environment release gate is required.

Older servers return `not_an_image` for video/audio and ordinary attachments
for PPT images. A successful upload/HTTP 200 is not proof of this rollout:
verify that PPT mappings contain the native `ref` before editing the deck.
