import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * P2-2 — helper-level html republish failure classification. The rename journal
 * tests cover the end-to-end "no doc_meta write" behaviour; these tests pin the
 * reasons the helper returns so the caller can keep an op retryable
 * (network_error) or fail it closed (stale_revision/invalid_response).
 */
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    htmlInternal: {
      url: 'http://octo-docs-html.test:8080',
      token: 'html-token',
      timeoutMs: 5000,
    },
  },
}))
vi.mock('../src/config/env.js', () => ({ config: mockConfig }))

import { closeHtmlRepublishReceipt, republishHtmlTitle } from '../src/api/services/htmlTitleRepublish.js'

const input = {
  slug: 'html_slug_1',
  docId: 'd_1',
  spaceId: 's1',
  title: 'New Title',
  idempotencyKey: 'op-1',
  revision: 1,
}

let fetchMock: ReturnType<typeof vi.fn>
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  mockConfig.htmlInternal.url = 'http://octo-docs-html.test:8080'
  mockConfig.htmlInternal.token = 'html-token'
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  warnSpy.mockRestore()
})

function body(
  version: unknown,
  title = 'New Title',
  slug = 'html_slug_1',
  publishSeq?: unknown,
): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      slug,
      title,
      version,
      ...(publishSeq !== undefined ? { publish_seq: publishSeq } : {}),
    }),
    text: async () => '',
  } as unknown as Response
}

describe('republishHtmlTitle — configuration and transport failures', () => {
  it.each([
    ['URL', '', 'OCTO_DOCS_HTML_INTERNAL_URL'],
    ['token', '', 'OCTO_DOCS_HTML_INTERNAL_TOKEN'],
  ])('missing %s performs no request and stays fail-closed', async (which, value, missingName) => {
    if (which === 'URL') mockConfig.htmlInternal.url = value
    else mockConfig.htmlInternal.token = value

    const result = await republishHtmlTitle(input)

    expect(result).toMatchObject({ ok: false, reason: 'config_missing', missing: [missingName] })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a timeout/abort maps to network_error (retryable, never a success)', async () => {
    fetchMock.mockImplementationOnce(async () => {
      const error = new Error('This operation was aborted')
      error.name = 'AbortError'
      throw error
    })

    const result = await republishHtmlTitle(input)

    expect(result).toEqual({ ok: false, reason: 'network_error' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('uses the html timeout budget for the signal', async () => {
    fetchMock.mockResolvedValueOnce(body(2))
    await republishHtmlTitle(input)
    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('republishHtmlTitle — response classification', () => {
  it('recognizes the nested stale_revision envelope', async () => {
    const payload = { error: { code: 'stale_revision', details: { code: 'stale_revision' } } }
    fetchMock.mockResolvedValueOnce({
      ok: false, status: 409, json: async () => payload, text: async () => JSON.stringify(payload),
    } as unknown as Response)

    await expect(republishHtmlTitle(input)).resolves.toEqual({ ok: false, reason: 'stale_revision', status: 409 })
  })

  it('treats a non-stale 409 as a generic upstream failure', async () => {
    const payload = { error: { code: 'conflict' } }
    fetchMock.mockResolvedValueOnce({
      ok: false, status: 409, json: async () => payload, text: async () => JSON.stringify(payload),
    } as unknown as Response)

    await expect(republishHtmlTitle(input)).resolves.toEqual({ ok: false, reason: 'upstream_error', status: 409 })
  })

  it.each([
    ['zero version', body(0)],
    ['string version', body('2')],
    ['title mismatch', body(2, 'Other Title')],
    ['slug mismatch', body(2, 'New Title', 'other_slug')],
  ])('rejects a malformed 200 (%s) as invalid_response', async (_label, response) => {
    fetchMock.mockResolvedValueOnce(response)
    await expect(republishHtmlTitle(input)).resolves.toEqual({ ok: false, reason: 'invalid_response' })
  })

  it.each(['identity_mismatch', 'identity_unverified'] as const)(
    'maps the html 409 %s envelope to a definitive 409 (never a 503)',
    async (code) => {
      const payload = { error: { code, message: 'binding refused', details: { code } } }
      fetchMock.mockResolvedValueOnce({
        ok: false, status: 409, json: async () => payload, text: async () => JSON.stringify(payload),
      } as unknown as Response)
      await expect(republishHtmlTitle(input)).resolves.toEqual({ ok: false, reason: code, status: 409 })
    },
  )

  it('accepts the identity code from older top-level 409 envelopes too', async () => {
    const payload = { code: 'identity_mismatch' }
    fetchMock.mockResolvedValueOnce({
      ok: false, status: 409, json: async () => payload, text: async () => JSON.stringify(payload),
    } as unknown as Response)
    await expect(republishHtmlTitle(input)).resolves.toEqual({
      ok: false, reason: 'identity_mismatch', status: 409,
    })
  })

  it('sends the monotonic revision on every request', async () => {
    fetchMock.mockResolvedValueOnce(body(2))
    await republishHtmlTitle(input)
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({
      slug: 'html_slug_1',
      doc_id: 'd_1',
      space_id: 's1',
      title: 'New Title',
      idempotency_key: 'op-1',
      revision: 1,
    })
  })
})

describe('closeHtmlRepublishReceipt — identity binding', () => {
  it('sends doc_id/space_id with the receipt key', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response)
    await closeHtmlRepublishReceipt({
      slug: 'html_slug_1', docId: 'd_1', spaceId: 's1', idempotencyKey: 'op-1',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://octo-docs-html.test:8080/internal/html/republish-title/close',
      expect.objectContaining({
        body: JSON.stringify({
          slug: 'html_slug_1', doc_id: 'd_1', space_id: 's1', idempotency_key: 'op-1',
        }),
      }),
    )
  })
})

describe('republishHtmlTitle — publish sequence compatibility', () => {
  /**
   * A receipt persisted before the sequence existed replays as publish_seq 0 (or
   * omits it). That must NOT be invalid_response: the HTML side already published,
   * so failing here would strand a rename that has nothing left to do.
   */
  it('treats publish_seq 0 as unknown and falls back to the version watermark', async () => {
    fetchMock.mockResolvedValueOnce(body(2, 'New Title', 'html_slug_1', 0))
    await expect(republishHtmlTitle(input)).resolves.toMatchObject({
      ok: true, version: 2, publishSeq: null,
    })
  })

  it('omitted publish_seq is equally unknown (older HTML instances)', async () => {
    fetchMock.mockResolvedValueOnce(body(2))
    await expect(republishHtmlTitle(input)).resolves.toMatchObject({
      ok: true, version: 2, publishSeq: null,
    })
  })

  it('carries a positive publish sequence through', async () => {
    fetchMock.mockResolvedValueOnce(body(2, 'New Title', 'html_slug_1', 7))
    await expect(republishHtmlTitle(input)).resolves.toMatchObject({
      ok: true, version: 2, publishSeq: 7,
    })
  })

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['string', '3'],
  ])('rejects a malformed publish_seq (%s)', async (_label, seq) => {
    fetchMock.mockResolvedValueOnce(body(2, 'New Title', 'html_slug_1', seq as never))
    await expect(republishHtmlTitle(input)).resolves.toEqual({ ok: false, reason: 'invalid_response' })
  })
})
