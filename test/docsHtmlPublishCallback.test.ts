import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * OCTO-456 §4.8 HTML publish callback (PATCH /octo-doc/:slug) — metadata only.
 *
 * octo-docs-html already committed the new version; the callback must converge
 * doc_meta.title and MUST NOT call the html republish/journal. The regression is
 * exactly "HTML published v2 with a new title → doc_meta updates, html gains no
 * version". This drives the real service against an in-memory `doc_meta` row
 * lock and fails any SQL that is not the expected doc_meta read/update (so a
 * journal/republish regression cannot hide).
 */
const h = vi.hoisted(() => {
  type Doc = {
    doc_id: string
    title: string
    doc_type: string
    owner_id: string
    owner_space_id: string
    space_id: string
    octo_doc_slug: string | null
    status: number
  }
  const state = { docs: new Map<string, Doc>() }
  function execute(sql: string, args: unknown[] = []): unknown[] {
    const q = sql.replace(/\s+/g, ' ').trim()
    if (q.startsWith('SELECT * FROM doc_meta WHERE doc_id = ? FOR UPDATE')) {
      const doc = state.docs.get(String(args[0]))
      return doc ? [{ ...doc }] : []
    }
    if (q.startsWith('UPDATE doc_meta SET title = ?, updated_by = ? WHERE doc_id = ?')) {
      const doc = state.docs.get(String(args[2]))
      if (doc) doc.title = String(args[0])
      return []
    }
    throw new Error(`unexpected SQL (callback must not touch the journal): ${q}`)
  }
  return { state, execute }
})

vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(async (sql: string, args?: unknown[]) => h.execute(sql, args)),
  transaction: vi.fn(async (fn: (tx: { query: (sql: string, args?: unknown[]) => Promise<unknown[]> }) => Promise<unknown>) =>
    fn({ query: async (sql: string, args?: unknown[]) => h.execute(sql, args) })),
}))
vi.mock('../src/config/env.js', () => ({
  config: {
    htmlInternal: { url: 'http://octo-docs-html.test:8080', token: 'html-token', timeoutMs: 5000 },
    search: { indexEnabled: false },
  },
}))

import { applyHtmlPublishTitle } from '../src/api/services/htmlRenameDoc.js'

function seed(overrides: Record<string, unknown> = {}) {
  h.state.docs.set('d1', {
    doc_id: 'd1',
    title: 'Old Title',
    doc_type: 'html',
    owner_id: 'bot1',
    owner_space_id: 's1',
    space_id: 's1',
    octo_doc_slug: 'html_slug_1',
    status: 1,
    ...overrides,
  } as never)
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    docId: 'd1',
    slug: 'html_slug_1',
    spaceId: 's1',
    uid: 'bot1',
    title: 'Published v2 Title',
    ...overrides,
  } as never
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  h.state.docs = new Map()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('applyHtmlPublishTitle — publish callback converges metadata only', () => {
  it('updates doc_meta.title for the published v2 title and makes NO html call', async () => {
    seed()
    const result = await applyHtmlPublishTitle(input())

    expect(result).toEqual({ ok: true, changed: true, title: 'Published v2 Title', beforeTitle: 'Old Title' })
    expect(h.state.docs.get('d1')!.title).toBe('Published v2 Title')
    // No republish/close request: HTML stays at the v2 it already published.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is idempotent when the callback repeats the same title', async () => {
    seed({ title: 'Published v2 Title' })
    const result = await applyHtmlPublishTitle(input())
    expect(result).toEqual({
      ok: true, changed: false, title: 'Published v2 Title', beforeTitle: 'Published v2 Title',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['wrong slug binding', { octo_doc_slug: 'other_slug' }, 404, 'not_found'],
    ['wrong space', { space_id: 's2' }, 404, 'not_found'],
    ['leftover deleted row', { status: 0 }, 404, 'not_found'],
    ['archived row', { status: 2 }, 409, 'doc_archived'],
  ])('rejects %s with %i %s and writes nothing', async (_label, overrides, status, error) => {
    seed(overrides)
    const result = await applyHtmlPublishTitle(input())
    expect(result).toMatchObject({ ok: false, status, error })
    expect(h.state.docs.get('d1')!.title).toBe('Old Title')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('accepts the publishing Bot\'s verified human owner as the trusted publisher', async () => {
    seed({ owner_id: 'human1' })
    const result = await applyHtmlPublishTitle(input({ botOwnerUid: 'human1' }))
    expect(result).toMatchObject({ ok: true, changed: true })
    expect(h.state.docs.get('d1')!.title).toBe('Published v2 Title')
  })

  it("refuses a shared admin Bot that is neither the owner nor the Bot's human owner", async () => {
    seed({ owner_id: 'human1' })
    const result = await applyHtmlPublishTitle(input({ uid: 'other_bot' }))
    expect(result).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
    expect(h.state.docs.get('d1')!.title).toBe('Old Title')
  })

  it('honors expected_title under the row lock', async () => {
    seed()
    const mismatch = await applyHtmlPublishTitle(input({ expectedTitle: 'Stale' }))
    expect(mismatch).toMatchObject({
      ok: false, status: 409, error: 'title_changed', currentTitle: 'Old Title',
    })
    expect(h.state.docs.get('d1')!.title).toBe('Old Title')

    const match = await applyHtmlPublishTitle(input({ expectedTitle: 'Old Title' }))
    expect(match).toMatchObject({ ok: true, changed: true })
    expect(h.state.docs.get('d1')!.title).toBe('Published v2 Title')
  })
})
