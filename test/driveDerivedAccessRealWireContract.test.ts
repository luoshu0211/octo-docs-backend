import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'

/**
 * TES-144 — real wire-contract test for the drive derived-access client.
 *
 * Round 2 missed the docs<->drive contract mismatch because every unit test
 * stubbed the response with docs-side-authored fixtures, which were always
 * self-consistent. Here we stand up a REAL http server that emits the exact
 * bytes the drive service sends from the complete derived-access contract and
 * drives the client through actual fetch/JSON parsing, so contract drift can no
 * longer hide behind a docs-side-authored stub.
 */
import { HttpDriveDerivedAccess } from '../src/drive/derivedAccessClient.js'
const readerRevision = `sha256:${'a'.repeat(64)}`
const emptyRevision = `sha256:${'b'.repeat(64)}`

let server: Server | null = null

/** Start a server that replies with the given raw body bytes, return its base URL. */
async function serveRawBody(rawBody: string): Promise<string> {
  server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(rawBody)
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const port = (server!.address() as AddressInfo).port
  return `http://127.0.0.1:${port}`
}

function makeClient(baseUrl: string) {
  return new HttpDriveDerivedAccess({ enabled: true, baseUrl, token: 'test-token', timeoutMs: 1000, ttlMs: 15_000 })
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
  }
})

describe('HttpDriveDerivedAccess real drive wire contract (TES-144)', () => {
  it('parses the complete Drive reader proof from real wire JSON', async () => {
    const raw = JSON.stringify({ role: 'reader', source_revision: readerRevision, valid_for_ms: 15_000 })
    const baseUrl = await serveRawBody(raw)
    expect(await makeClient(baseUrl).derivedAccess('d_xxx', 'u_bob', 'sp-xyz'))
      .toMatchObject({ role: 'reader', sourceRevision: readerRevision, validForMs: 15_000 })
  })

  it('parses a confirmed Drive none result with its source proof', async () => {
    const baseUrl = await serveRawBody(JSON.stringify({ role: 'none', source_revision: emptyRevision, valid_for_ms: 15_000 }))
    expect(await makeClient(baseUrl).derivedAccess('d_xxx', 'u_bob', 'sp-xyz'))
      .toMatchObject({ role: 'none', sourceRevision: emptyRevision })
  })

  it('does not treat legacy {"access":true} as a complete source proof', async () => {
    const baseUrl = await serveRawBody('{"access":true}')
    expect(await makeClient(baseUrl).derivedAccess('d_xxx', 'u_bob', 'sp-xyz')).toBeNull()
  })
})
