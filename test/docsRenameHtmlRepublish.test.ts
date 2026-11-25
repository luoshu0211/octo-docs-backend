import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

/**
 * PATCH /api/v1/docs/:docId — route wiring for the OCTO-456 §4.8 HTML rename.
 *
 * The two-step / journal behaviour itself is covered by docsRenameHtmlJournal
 * (real `renameHtmlDoc` against an in-memory transaction harness + stubbed
 * fetch). Here we pin the ROUTE contract:
 *   - html + slug delegates to renameHtmlDoc and maps its closed result to the
 *     response (200 / 409 / 503), never falling through to a second doc_meta write;
 *   - html with no slug keeps the historical path; html_ppt / doc / sheet / board
 *     never touch the html upstream;
 *   - title validation still happens before any publish.
 */
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: { search: { indexEnabled: false } },
}))
vi.mock('../src/config/env.js', () => ({ config: mockConfig }))
vi.mock('../src/api/guard.js', () => ({ requireDocRole: vi.fn() }))
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: {
    rename: vi.fn(async () => undefined),
    renameWithExpectedTitle: vi.fn(async () => ({ ok: true })),
    getByOctoDocSlug: vi.fn(async () => null),
    resolveDocumentName: vi.fn(async () => null),
  },
  DocOwnershipError: class extends Error {},
}))
vi.mock('../src/ppt/liveEdit.js', () => ({ editPptLive: vi.fn(async () => undefined) }))
vi.mock('../src/permission/principalSpace.js', () => ({
  resolveRequestPrincipalSpace: vi.fn(async () => 's1'),
}))
const { renameHtmlDocMock, applyHtmlPublishTitleMock } = vi.hoisted(() => ({
  renameHtmlDocMock: vi.fn(async () => ({ ok: true, alreadyApplied: false, beforeTitle: 'Before Title', version: 7 })),
  applyHtmlPublishTitleMock: vi.fn(async () => ({ ok: true, changed: true, title: 'New Title', beforeTitle: 'Before Title' })),
}))
vi.mock('../src/api/services/htmlRenameDoc.js', () => ({
  renameHtmlDoc: renameHtmlDocMock,
  applyHtmlPublishTitle: applyHtmlPublishTitleMock,
}))

import { octoDocRenameHandler, renameDocHandler } from '../src/api/routes/docs.js'
import { requireDocRole } from '../src/api/guard.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { editPptLive } from '../src/ppt/liveEdit.js'
import { PptApiError } from '../src/api/ppt/envelope.js'
import { resolveRequestPrincipalSpace } from '../src/permission/principalSpace.js'

interface MockRes {
  statusCode: number
  body: unknown
  status(code: number): MockRes
  json(body: unknown): MockRes
}
function response(): MockRes {
  return {
    statusCode: 0,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}
function request(title: unknown = 'New Title', extra: Record<string, unknown> = {}) {
  return {
    uid: 'u_caller',
    params: { docId: 'd_1' },
    body: { title, ...extra },
    query: {},
    docSpaceScope: { mode: 'human' as const },
  }
}
function guard(docType: string, octoDocSlug: string | null, role = 'admin') {
  return {
    role,
    meta: {
      doc_id: 'd_1',
      title: 'Before Title',
      doc_type: docType,
      owner_id: 'u_owner',
      owner_space_id: 's1',
      space_id: 's1',
      status: 1,
      permission_epoch: 3,
      octo_doc_slug: octoDocSlug,
    },
  }
}

beforeEach(() => {
  vi.mocked(requireDocRole).mockReset()
  vi.mocked(docMetaRepo.rename).mockClear()
  vi.mocked(docMetaRepo.rename).mockResolvedValue(undefined)
  vi.mocked(docMetaRepo.renameWithExpectedTitle).mockReset()
  vi.mocked(docMetaRepo.renameWithExpectedTitle).mockResolvedValue({ ok: true })
  vi.mocked(editPptLive).mockClear()
  vi.mocked(editPptLive).mockResolvedValue(undefined)
  vi.mocked(resolveRequestPrincipalSpace).mockClear()
  vi.mocked(resolveRequestPrincipalSpace).mockResolvedValue('s1')
  renameHtmlDocMock.mockReset()
  renameHtmlDocMock.mockResolvedValue({ ok: true, alreadyApplied: false, title: 'New Title', beforeTitle: 'Before Title', version: 7 })
  applyHtmlPublishTitleMock.mockReset()
  applyHtmlPublishTitleMock.mockResolvedValue({ ok: true, changed: true, title: 'New Title', beforeTitle: 'Before Title' })
  vi.mocked(docMetaRepo.getByOctoDocSlug).mockReset()
  vi.mocked(docMetaRepo.getByOctoDocSlug).mockResolvedValue(null)
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  logSpy.mockRestore()
})

let logSpy: MockInstance

describe('PATCH /api/v1/docs/:docId — html rename delegates to the journal flow', () => {
  it('passes the document identity/title to renameHtmlDoc and returns its outcome', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guard('html', 'html_slug_1') as never)

    const res = response()
    await renameDocHandler(request() as never, res as never)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ docId: 'd_1', title: 'New Title', beforeTitle: 'Before Title' })
    expect(renameHtmlDocMock).toHaveBeenCalledWith({
      docId: 'd_1',
      docSpaceId: 's1',
      uid: 'u_caller',
      principalSpaceId: null,
      mode: 'human',
      expectedEpoch: 3,
      slug: 'html_slug_1',
      title: 'New Title',
    })
    // The journal already wrote doc_meta; the route must not write it again.
    expect(docMetaRepo.rename).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledWith(
      '[octo-docs] html republished before rename',
      expect.objectContaining({ docId: 'd_1', slug: 'html_slug_1', version: 7 }),
    )
  })

  it('already-applied rename returns 200 without publishing', async () => {
    renameHtmlDocMock.mockResolvedValueOnce({
      ok: true, alreadyApplied: true, title: 'New Title', beforeTitle: 'New Title', version: null,
    })
    vi.mocked(requireDocRole).mockResolvedValue(guard('html', 'html_slug_1') as never)

    const res = response()
    await renameDocHandler(request() as never, res as never)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ docId: 'd_1', title: 'New Title', beforeTitle: 'New Title' })
    expect(docMetaRepo.rename).not.toHaveBeenCalled()
  })

  it('exposes rename_recovery_required details (pendingTitle/version)', async () => {
    renameHtmlDocMock.mockResolvedValueOnce({
      ok: false, status: 409, error: 'rename_recovery_required', pendingTitle: 'B', version: 2,
    })
    vi.mocked(requireDocRole).mockResolvedValue(guard('html', 'html_slug_1') as never)

    const res = response()
    await renameDocHandler(request('A') as never, res as never)

    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ error: 'rename_recovery_required', pendingTitle: 'B', version: 2 })
    expect(docMetaRepo.rename).not.toHaveBeenCalled()
  })

  it.each([
    ['U+0085 NEL', '\u0085'],
    ['NBSP', '\u00A0'],
    ['ideographic space', '\u3000'],
    ['mixed Go-space set', '\u0085\u00A0\u3000\u202F\u2028'],
  ])('trims %s with Go TrimSpace semantics before journal/doc_meta', async (_label, edge) => {
    vi.mocked(requireDocRole).mockResolvedValue(guard('html', 'html_slug_1') as never)
    renameHtmlDocMock.mockResolvedValue({
      ok: true, alreadyApplied: false, title: 'New Title', beforeTitle: 'Before Title', version: 2,
    })

    const res = response()
    await renameDocHandler(request(`${edge} New Title ${edge}`) as never, res as never)

    expect(res.statusCode).toBe(200)
    expect(renameHtmlDocMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'New Title' }))
    expect(res.body).toEqual({ docId: 'd_1', title: 'New Title', beforeTitle: 'Before Title' })

    vi.mocked(requireDocRole).mockResolvedValue(guard('doc', null) as never)
    const docRes = response()
    await renameDocHandler(request(`${edge} New Title ${edge}`) as never, docRes as never)
    expect(docMetaRepo.rename).toHaveBeenCalledWith('d_1', 'New Title', 'u_caller')
  })

  it('a delayed duplicate reports the CURRENT doc title, not the requested one', async () => {
    // The op completed earlier, then a later rename moved the doc back to A.
    renameHtmlDocMock.mockResolvedValueOnce({
      ok: true, alreadyApplied: true, title: 'A', beforeTitle: 'A', version: 2,
    })
    vi.mocked(requireDocRole).mockResolvedValue(guard('html', 'html_slug_1') as never)

    const res = response()
    await renameDocHandler(request('B') as never, res as never)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ docId: 'd_1', title: 'A', beforeTitle: 'A' })
    expect(docMetaRepo.rename).not.toHaveBeenCalled()
  })

  it.each([
    [503, 'rename_failed'],
    [409, 'rename_in_progress'],
    [409, 'title_changed'],
    [403, 'forbidden'],
  ])('maps a journal failure %i %s without writing doc_meta', async (status, error) => {
    renameHtmlDocMock.mockResolvedValueOnce({ ok: false, status, error })
    vi.mocked(requireDocRole).mockResolvedValue(guard('html', 'html_slug_1') as never)

    const res = response()
    await renameDocHandler(request() as never, res as never)

    expect(res.statusCode).toBe(status)
    expect(res.body).toEqual({ error })
    expect(docMetaRepo.rename).not.toHaveBeenCalled()
  })

  it('html with an empty slug keeps the historical direct-rename path (no journal)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guard('html', null) as never)

    const res = response()
    await renameDocHandler(request() as never, res as never)

    expect(res.statusCode).toBe(200)
    expect(renameHtmlDocMock).not.toHaveBeenCalled()
    expect(docMetaRepo.rename).toHaveBeenCalledOnce()
  })

  it.each(['doc', 'sheet', 'board'])('%s never enters the html journal', async (docType) => {
    vi.mocked(requireDocRole).mockResolvedValue(guard(docType, null) as never)

    const res = response()
    await renameDocHandler(request() as never, res as never)

    expect(res.statusCode).toBe(200)
    expect(renameHtmlDocMock).not.toHaveBeenCalled()
    expect(docMetaRepo.rename).toHaveBeenCalledOnce()
  })

  it('html_ppt keeps its existing PPT path', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guard('html_ppt', 'ppt_slug') as never)

    const res = response()
    await renameDocHandler(request() as never, res as never)

    expect(res.statusCode).toBe(200)
    expect(renameHtmlDocMock).not.toHaveBeenCalled()
    expect(docMetaRepo.rename).not.toHaveBeenCalled()
    expect(editPptLive).toHaveBeenCalledWith(
      expect.objectContaining({ docId: 'd_1', uid: 'u_caller', spaceId: 's1', isBot: false }),
      { title: 'New Title' },
    )
  })

  it('trims surrounding whitespace before journal/html/doc_meta (P2)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guard('html', 'html_slug_1') as never)

    const res = response()
    await renameDocHandler(request('  New Title  ') as never, res as never)

    expect(res.statusCode).toBe(200)
    expect(renameHtmlDocMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'New Title' }))
    expect(res.body).toEqual({ docId: 'd_1', title: 'New Title', beforeTitle: 'Before Title' })

    // The non-html path gets the same normalized value.
    vi.mocked(requireDocRole).mockResolvedValue(guard('doc', null) as never)
    const docRes = response()
    await renameDocHandler(request('  New Title  ') as never, docRes as never)
    expect(docMetaRepo.rename).toHaveBeenCalledWith('d_1', 'New Title', 'u_caller')
    expect(docRes.body).toEqual({ docId: 'd_1', title: 'New Title', beforeTitle: 'Before Title' })
  })

  it('rejects a whitespace-only title after trimming', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guard('html', 'html_slug_1') as never)
    const res = response()
    await renameDocHandler(request('   ') as never, res as never)
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'title required' })
    expect(renameHtmlDocMock).not.toHaveBeenCalled()
  })

  it('forwards expected_title to the html journal', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guard('html', 'html_slug_1') as never)
    const res = response()
    await renameDocHandler(request('New Title', { expected_title: ' Before Title ' }) as never, res as never)
    expect(res.statusCode).toBe(200)
    expect(renameHtmlDocMock).toHaveBeenCalledWith(expect.objectContaining({ expectedTitle: 'Before Title' }))
  })

  it('maps a journal title_changed refusal with currentTitle', async () => {
    renameHtmlDocMock.mockResolvedValueOnce({
      ok: false, status: 409, error: 'title_changed', currentTitle: 'Someone Else',
    })
    vi.mocked(requireDocRole).mockResolvedValue(guard('html', 'html_slug_1') as never)
    const res = response()
    await renameDocHandler(request('New Title', { expected_title: 'Before Title' }) as never, res as never)
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ error: 'title_changed', currentTitle: 'Someone Else' })
  })

  it('non-html expected_title uses the transactional compare-and-set, not a blind rename', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guard('doc', null) as never)
    vi.mocked(docMetaRepo.renameWithExpectedTitle).mockResolvedValueOnce({
      ok: false, reason: 'title_changed', currentTitle: 'Someone Else',
    })
    const res = response()
    await renameDocHandler(request('New Title', { expected_title: 'Before Title' }) as never, res as never)
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ error: 'title_changed', currentTitle: 'Someone Else' })
    expect(docMetaRepo.renameWithExpectedTitle).toHaveBeenCalledWith({
      docId: 'd_1', title: 'New Title', updatedBy: 'u_caller', expectedTitle: 'Before Title',
    })
    expect(docMetaRepo.rename).not.toHaveBeenCalled()
  })

  it('two non-html requests that both expect A: exactly one succeeds', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guard('doc', null) as never)
    // Faithful stand-in for the row-locked compare-and-set: the second caller
    // observes the first caller's committed title and is refused.
    let currentTitle = 'Before Title'
    vi.mocked(docMetaRepo.renameWithExpectedTitle).mockImplementation(async (input) => {
      if (input.expectedTitle !== currentTitle) {
        return { ok: false, reason: 'title_changed', currentTitle }
      }
      currentTitle = input.title
      return { ok: true }
    })

    const first = response()
    await renameDocHandler(request('B', { expected_title: 'Before Title' }) as never, first as never)
    const second = response()
    await renameDocHandler(request('C', { expected_title: 'Before Title' }) as never, second as never)

    expect(first.statusCode).toBe(200)
    expect(first.body).toEqual({ docId: 'd_1', title: 'B', beforeTitle: 'Before Title' })
    expect(second.statusCode).toBe(409)
    expect(second.body).toEqual({ error: 'title_changed', currentTitle: 'B' })
  })

  it('html_ppt forwards expected_title into the PPT write transaction', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guard('html_ppt', 'ppt_slug') as never)
    const res = response()
    await renameDocHandler(request('New Title', { expected_title: 'Before Title' }) as never, res as never)
    expect(res.statusCode).toBe(200)
    expect(editPptLive).toHaveBeenCalledWith(
      expect.objectContaining({ docId: 'd_1' }),
      { title: 'New Title', expectedTitle: 'Before Title' },
    )
  })

  it('maps the PPT title_changed conflict to the docs rename wire shape', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guard('html_ppt', 'ppt_slug') as never)
    vi.mocked(editPptLive).mockRejectedValueOnce(new PptApiError('CONFLICT', 'title changed', {
      details: { reason: 'title_changed', currentTitle: 'Someone Else' },
    }))
    const res = response()
    await renameDocHandler(request('New Title', { expected_title: 'Before Title' }) as never, res as never)
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ error: 'title_changed', currentTitle: 'Someone Else' })
  })

  it('rejects a non-string expected_title before any write', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guard('doc', null) as never)
    const res = response()
    await renameDocHandler(request('New Title', { expected_title: 42 }) as never, res as never)
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_expected_title' })
    expect(docMetaRepo.rename).not.toHaveBeenCalled()
    expect(docMetaRepo.renameWithExpectedTitle).not.toHaveBeenCalled()
  })

  it('validates the title before entering the journal', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guard('html', 'html_slug_1') as never)

    for (const [title, error] of [['', 'title required'], ['x'.repeat(513), 'title too long']] as const) {
      const res = response()
      await renameDocHandler(request(title) as never, res as never)
      expect(res.statusCode).toBe(400)
      expect(res.body).toEqual({ error })
    }
    expect(renameHtmlDocMock).not.toHaveBeenCalled()
  })
})

describe('PATCH /octo-doc/:slug — html publish callback is metadata-only', () => {
  function slugRequest(extra: Record<string, unknown> = {}) {
    return {
      uid: 'bot1',
      params: { octoDocSlug: 'html_slug_1' },
      body: { title: 'New Title' },
      query: {},
      principalSpaceId: 's1',
      botOwnerUid: 'human1',
      docSpaceScope: { mode: 'bot' as const, spaceId: 's1' },
      ...extra,
    }
  }

  it('updates metadata through applyHtmlPublishTitle and never enters the rename journal', async () => {
    vi.mocked(docMetaRepo.getByOctoDocSlug).mockResolvedValue({
      doc_id: 'd_1',
      title: 'Before Title',
      doc_type: 'html',
      owner_id: 'bot1',
      owner_space_id: 's1',
      space_id: 's1',
      status: 1,
      octo_doc_slug: 'html_slug_1',
    } as never)
    vi.mocked(requireDocRole).mockResolvedValue(guard('html', 'html_slug_1') as never)

    const res = response()
    await octoDocRenameHandler(slugRequest() as never, res as never)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ docId: 'd_1', title: 'New Title', beforeTitle: 'Before Title' })
    expect(applyHtmlPublishTitleMock).toHaveBeenCalledWith(expect.objectContaining({
      docId: 'd_1', slug: 'html_slug_1', spaceId: 's1', uid: 'bot1', botOwnerUid: 'human1', title: 'New Title',
    }))
    // THE regression: no republish/journal on the publish callback path.
    expect(renameHtmlDocMock).not.toHaveBeenCalled()
    expect(docMetaRepo.rename).not.toHaveBeenCalled()
  })

  it('maps a metadata-only title_changed refusal with currentTitle', async () => {
    vi.mocked(docMetaRepo.getByOctoDocSlug).mockResolvedValue({
      doc_id: 'd_1', title: 'Before Title', doc_type: 'html', owner_id: 'bot1', owner_space_id: 's1',
      space_id: 's1', status: 1, octo_doc_slug: 'html_slug_1',
    } as never)
    vi.mocked(requireDocRole).mockResolvedValue(guard('html', 'html_slug_1') as never)
    applyHtmlPublishTitleMock.mockResolvedValueOnce({
      ok: false, status: 409, error: 'title_changed', currentTitle: 'Someone Else',
    })

    const res = response()
    await octoDocRenameHandler(slugRequest({ body: { title: 'New Title', expected_title: 'Before Title' } }) as never, res as never)

    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ error: 'title_changed', currentTitle: 'Someone Else' })
    expect(renameHtmlDocMock).not.toHaveBeenCalled()
  })
})
