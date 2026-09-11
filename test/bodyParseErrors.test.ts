import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// Integration test for defect ③: express.json body-parser failures must map to
// their contract error codes at the central error handler instead of bubbling to
// a generic 500. The parse runs before auth/routing, so a bad or oversized body
// is rejected without any identity — we hit a real ephemeral server over HTTP.
import { createApp } from '../src/api/app.js'

let server: Server
let base: string

beforeAll(async () => {
  const app = createApp()
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  base = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
})

describe('body-parser error mapping (§③)', () => {
  it('malformed JSON body → 400 invalid_body (not 500)', async () => {
    const res = await fetch(`${base}/v1/bot/docs/d_1/content`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
      body: '{bad-json',
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_body' })
  })

  it('body over the global 1mb limit → 413 doc_too_large (not 500)', async () => {
    // ~6 MiB JSON body, well over express.json's 1mb cap.
    const huge = JSON.stringify({ ops: 'x'.repeat(6 * 1024 * 1024) })
    const res = await fetch(`${base}/v1/bot/docs/d_1/content`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
      body: huge,
    })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'doc_too_large' })
  })

  it('allows a 2 MiB Sheet PATCH without widening the global JSON cap', async () => {
    const medium = JSON.stringify({ cells: { 'default!0:0': { v: 'x'.repeat(2 * 1024 * 1024) } } })

    const sheetRes = await fetch(`${base}/v1/bot/docs/d_1/sheet`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
      body: medium,
    })
    // The Sheet-specific 3 MiB parser admitted the body, so bogus auth is now
    // the first failing gate. A global 1 MiB parser would have returned 413.
    expect(sheetRes.status).toBe(401)

    const contentRes = await fetch(`${base}/v1/bot/docs/d_1/content`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
      body: medium,
    })
    expect(contentRes.status).toBe(413)
    expect(await contentRes.json()).toEqual({ error: 'doc_too_large' })
  })

  it('oversized body on the sheet endpoint → 413 sheet_too_large (not doc_too_large)', async () => {
    // The parse-time 413 fires before the route handler, so the sheet write path
    // never reaches its own bounds. The central handler must still report the
    // sheet-specific code so the /:docId/sheet request-cap rejection matches the
    // read guard's sheet_too_large contract, not doc_too_large.
    const huge = JSON.stringify({ cells: { 'default!0:0': { v: 'x'.repeat(6 * 1024 * 1024) } } })
    const res = await fetch(`${base}/v1/bot/docs/d_1/sheet`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
      body: huge,
    })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'sheet_too_large' })
  })

  it('a well-formed JSON body is not caught by the parse-error mapping', async () => {
    // Valid JSON parses fine; it flows past the body parser to auth (401 here,
    // no valid bot token) — proving the mapping only fires on parse failures.
    const res = await fetch(`${base}/v1/bot/docs/d_1/content`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
      body: JSON.stringify({ ops: [] }),
    })
    expect(res.status).not.toBe(400)
    expect(res.status).not.toBe(413)
  })
})
