import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * OCTO-456 §4.8 `expected_title` compare-and-set in docMetaRepo.
 *
 * Generic doc/sheet/board (and html without a slug) have no upstream journal, so
 * the row lock + compare + write in this repository is their ONLY atomicity
 * boundary. These tests drive the real implementation against an in-memory
 * `doc_meta` row and pin the SQL shape: the compare must be a locking read and a
 * mismatch must issue no UPDATE.
 */
const h = vi.hoisted(() => {
  const state = { title: 'A' as string | null, updates: [] as Array<{ title: string; updatedBy: string }> }
  function execute(sql: string, args: unknown[] = []): unknown[] {
    const q = sql.replace(/\s+/g, ' ').trim()
    if (q.startsWith('SELECT title FROM doc_meta WHERE doc_id = ? FOR UPDATE')) {
      return state.title === null ? [] : [{ title: state.title }]
    }
    if (q.startsWith('UPDATE doc_meta SET title = ?, updated_by = ? WHERE doc_id = ?')) {
      state.updates.push({ title: String(args[0]), updatedBy: String(args[1]) })
      state.title = String(args[0])
      return []
    }
    throw new Error(`unexpected SQL: ${q}`)
  }
  return { state, execute }
})

vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(async (sql: string, args?: unknown[]) => h.execute(sql, args)),
  transaction: vi.fn(async (fn: (tx: { query: (sql: string, args?: unknown[]) => Promise<unknown[]> }) => Promise<unknown>) =>
    fn({ query: async (sql: string, args?: unknown[]) => h.execute(sql, args) })),
}))

import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'

beforeEach(() => {
  h.state.title = 'A'
  h.state.updates = []
})

describe('docMetaRepo.renameWithExpectedTitle — row-locked compare-and-set', () => {
  it('refuses a stale expected title without issuing an UPDATE', async () => {
    const result = await docMetaRepo.renameWithExpectedTitle({
      docId: 'd1', title: 'B', updatedBy: 'u1', expectedTitle: 'Stale',
    })
    expect(result).toEqual({ ok: false, reason: 'title_changed', currentTitle: 'A' })
    expect(h.state.title).toBe('A')
    expect(h.state.updates).toEqual([])
  })

  it('writes when the expected title still matches', async () => {
    const result = await docMetaRepo.renameWithExpectedTitle({
      docId: 'd1', title: 'B', updatedBy: 'u1', expectedTitle: 'A',
    })
    expect(result).toEqual({ ok: true })
    expect(h.state.title).toBe('B')
    expect(h.state.updates).toEqual([{ title: 'B', updatedBy: 'u1' }])
  })

  it('two requests that both expect A: exactly one succeeds, the second sees the committed title', async () => {
    const first = await docMetaRepo.renameWithExpectedTitle({
      docId: 'd1', title: 'B', updatedBy: 'u1', expectedTitle: 'A',
    })
    const second = await docMetaRepo.renameWithExpectedTitle({
      docId: 'd1', title: 'C', updatedBy: 'u2', expectedTitle: 'A',
    })

    expect(first).toEqual({ ok: true })
    expect(second).toEqual({ ok: false, reason: 'title_changed', currentTitle: 'B' })
    expect(h.state.title).toBe('B')
    expect(h.state.updates).toHaveLength(1)
  })

  it('reports not_found when the row disappeared between guard and write', async () => {
    h.state.title = null
    const result = await docMetaRepo.renameWithExpectedTitle({
      docId: 'missing', title: 'B', updatedBy: 'u1', expectedTitle: 'A',
    })
    expect(result).toEqual({ ok: false, reason: 'not_found' })
    expect(h.state.updates).toEqual([])
  })
})
