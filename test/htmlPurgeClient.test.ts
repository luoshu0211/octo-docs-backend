import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * OCTO-456 P1 —— octo-docs-html 内部 purge 客户端。
 * 只验证 wire 形状/状态映射，不发真实请求（stub 全局 fetch）。
 */
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: { htmlInternal: { url: 'http://octo-docs-html:8080', token: 'html-secret', timeoutMs: 5000 } },
}))
vi.mock('../src/config/env.js', () => ({ config: mockConfig }))

import { htmlPurgeConfigured, purgeHtmlDocument } from '../src/api/services/htmlPurge.js'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  mockConfig.htmlInternal = { url: 'http://octo-docs-html:8080', token: 'html-secret', timeoutMs: 5000 }
  vi.stubGlobal('fetch', fetchMock)
})

describe('purgeHtmlDocument', () => {
  it('treats an unconfigured deployment as skipped (not an error)', async () => {
    mockConfig.htmlInternal = { url: '', token: '', timeoutMs: 5000 }
    expect(htmlPurgeConfigured()).toBe(false)
    expect(await purgeHtmlDocument('slug-1', 'd1', 'org1')).toEqual({ ok: true, skipped: true, reason: 'config_missing' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects an unsafe slug before building the URL', async () => {
    expect(await purgeHtmlDocument('../etc/passwd')).toEqual({ ok: false, reason: 'invalid_slug' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('POSTs {slug} to /internal/html/purge with the internal token and no redirects', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    expect(await purgeHtmlDocument('slug-1', 'd1', 'org1')).toEqual({ ok: true })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('http://octo-docs-html:8080/internal/html/purge')
    expect(init.method).toBe('POST')
    expect(init.headers['X-Internal-Token']).toBe('html-secret')
    expect(JSON.parse(init.body)).toEqual({ slug: 'slug-1', doc_id: 'd1', space_id: 'org1' })
    expect(init.redirect).toBe('manual')
  })

  it('maps a business 404 (content_gone) to success so retries are idempotent', async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ error: { code: 'content_gone', message: 'document content not found' } }),
      { status: 404 },
    ))
    expect(await purgeHtmlDocument('slug-1', 'd1', 'org1')).toEqual({ ok: true })
  })

  it('accepts the flat content_gone variants too (mixed-version rollout)', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: 'content_gone' }), { status: 404 }))
    expect(await purgeHtmlDocument('slug-1', 'd1', 'org1')).toEqual({ ok: true })
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'content_gone' }), { status: 404 }))
    expect(await purgeHtmlDocument('slug-1', 'd1', 'org1')).toEqual({ ok: true })
  })

  it('does NOT treat a plain router 404 as success (old html without the endpoint)', async () => {
    // Gin/httpx answers an unmatched route with a plain-text 404: the versions and
    // assets of this document still exist, so docs must keep doc_meta.
    fetchMock.mockResolvedValueOnce(new Response('404 page not found', { status: 404 }))
    expect(await purgeHtmlDocument('slug-1', 'd1', 'org1')).toEqual({
      ok: false, reason: 'upstream_error', status: 404,
    })
    // A JSON body with an unrelated code is equally not proof.
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 }))
    expect(await purgeHtmlDocument('slug-1', 'd1', 'org1')).toEqual({
      ok: false, reason: 'upstream_error', status: 404,
    })
  })

  it('maps a non-2xx to upstream_error with the status', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }))
    expect(await purgeHtmlDocument('slug-1', 'd1', 'org1')).toEqual({ ok: false, reason: 'upstream_error', status: 503 })
  })

  it('maps a transport failure to network_error (never throws)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
    expect(await purgeHtmlDocument('slug-1', 'd1', 'org1')).toEqual({ ok: false, reason: 'network_error' })
  })
})
