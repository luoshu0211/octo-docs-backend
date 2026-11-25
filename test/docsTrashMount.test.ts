import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

/**
 * 挂载冒烟测试（真实 Express）：两条新路由确实挂在了对的 surface / 前缀上，
 * 且 internal 路由保持「limiter → token → body」顺序（未认证的坏 body 必须
 * 先得到 401，而不是 body-parser 的 400）。
 */
import { createApp } from '../src/api/app.js'

let server: Server | null = null

async function listen(surface: 'public' | 'internal'): Promise<string> {
  const app = createApp({ surface })
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server!.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => server!.close((e) => (e ? reject(e) : resolve())))
    server = null
  }
})

describe('OCTO-456 P0/P1 mount smoke', () => {
  it('POST /internal/docs/member-added/unread is internal-only and rejects before body parsing', async () => {
    const base = await listen('internal')
    const res = await fetch(`${base}/internal/docs/member-added/unread`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })

  it('human trash routes are reachable on the public mount (auth gate first)', async () => {
    const base = await listen('public')
    for (const [method, path] of [
      ['GET', '/api/v1/docs/trash'],
      ['POST', '/api/v1/docs/trash/restore'],
      ['POST', '/api/v1/docs/trash/purge'],
      ['POST', '/api/v1/docs/d_1/restore'],
      ['POST', '/api/v1/docs/d_1/purge'],
    ] as const) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', authorization: 'Bearer bogus' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      })
      // Without a valid octo identity every one of them stops at auth (401 with no
      // token, 503 when the offline identity service cannot be reached). A 404 here
      // would mean the route itself is missing/mis-mounted.
      expect([401, 503]).toContain(res.status)
    }
  })
})
