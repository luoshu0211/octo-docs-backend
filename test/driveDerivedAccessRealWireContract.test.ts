import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'

/**
 * TES-144 — real wire-contract test for the drive derived-access client.
 *
 * Round 2 missed the docs<->drive contract mismatch because every unit test
 * stubbed the response with docs-side-authored fixtures, which were always
 * self-consistent. Here we stand up a REAL http server that emits the exact
 * bytes the drive service sends (`octo-drive .../derivedaccess/api.go` returns
 * `{"role":"reader"}` / `{"role":"none"}`) and drive the client through actual
 * fetch/JSON parsing, so contract drift can no longer hide behind a stub.
 */
import { HttpDriveDerivedAccess } from '../src/drive/derivedAccessClient.js'

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
  it('parses real drive wire {"role":"reader"} as reader', async () => {
    const baseUrl = await serveRawBody('{"role":"reader"}')
    expect(await makeClient(baseUrl).derivedRole('d_xxx', 'u_bob', 'sp-xyz')).toBe('reader')
  })

  it('parses real drive wire {"role":"none"} as none', async () => {
    const baseUrl = await serveRawBody('{"role":"none"}')
    expect(await makeClient(baseUrl).derivedRole('d_xxx', 'u_bob', 'sp-xyz')).toBe('none')
  })

  it('fails closed on legacy {"access":true} shape (contract-drift regression guard)', async () => {
    // Pin the docs side: if drive ever regressed to the old {access} shape, docs
    // must NOT silently accept it — it fails closed to none.
    const baseUrl = await serveRawBody('{"access":true}')
    expect(await makeClient(baseUrl).derivedRole('d_xxx', 'u_bob', 'sp-xyz')).toBe('none')
  })
})
