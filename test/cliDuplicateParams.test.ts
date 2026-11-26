import { describe, it, expect, vi } from 'vitest'

/**
 * The CLI route path uses `:doc_id` while the shared duplicate handler reads
 * `req.params.docId`. Review reproduced `getByDocId(undefined)` → 404 through the
 * real CLI HTTP entry; this pins the mapping that fixes it.
 */
vi.mock('../src/api/cliv2/operations.js', () => ({ docsOperations: [] }))
vi.mock('../src/api/cliv2/adapter.js', () => ({
  docsBusinessHandlers: () => () => [],
  errorForStatus: () => new Error('unused'),
}))
vi.mock('../src/api/cliv2/auth.js', () => ({
  CliError: class CliError extends Error { status = 500; envelope = { error: 'x' } },
  createAuthResolver: () => null,
  hasAction: () => true,
}))
vi.mock('../src/api/routes/docs.js', () => ({ duplicateDocHandler: vi.fn() }))

import { applyCliDocIdParam } from '../src/api/cliv2/router.js'

describe('CLI duplicate path params', () => {
  it('maps doc_id onto the handler spelling', () => {
    const params: Record<string, string | undefined> = { doc_id: 'd_cli' }
    applyCliDocIdParam(params)
    expect(params.docId).toBe('d_cli')
  })

  it('keeps an existing docId untouched', () => {
    const params: Record<string, string | undefined> = { docId: 'd_human', doc_id: 'd_cli' }
    applyCliDocIdParam(params)
    expect(params.docId).toBe('d_human')
  })
})
