import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * TES-131 drive picker — listManageableHandler (GET /api/v1/docs/manageable).
 * Thin handler over docMetaRepo.listManageable: forwards the caller's uid /
 * space / principal space + cursor + clamped page_size, maps rows to the picker
 * DTO, passes nextCursor through, and turns a malformed cursor into 400 rather
 * than a 500. Mirrors docsListAuthz.test.ts: mock the repo + octo identity, call
 * the exported handler directly (no live infra).
 */
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: { listManageable: vi.fn() },
}))
vi.mock('../src/auth/octoIdentity.js', () => ({
  getOctoIdentity: () => ({ isSpaceMember: vi.fn() }),
}))

import { listManageableHandler } from '../src/api/routes/docs.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'

interface MockRes {
  statusCode: number
  body: unknown
  status(c: number): MockRes
  json(b: unknown): MockRes
}
function mockRes(): MockRes {
  return {
    statusCode: 0,
    body: undefined as unknown,
    status(c: number) { this.statusCode = c; return this },
    json(b: unknown) { this.body = b; return this },
  }
}
function req(query: Record<string, unknown> = {}) {
  return { uid: 'u_1', spaceId: 's_1', principalSpaceId: 's_1', query } as never
}

beforeEach(() => {
  vi.mocked(docMetaRepo.listManageable).mockReset()
  vi.mocked(docMetaRepo.listManageable).mockResolvedValue({ items: [], nextCursor: null })
})

describe('GET /api/v1/docs/manageable — listManageableHandler', () => {
  it('forwards uid/space/principalSpace + cursor and a clamped page_size to the repo', async () => {
    const res = mockRes()
    await listManageableHandler(req({ cursor: 'c0', page_size: '9999' }), res as never)
    expect(vi.mocked(docMetaRepo.listManageable).mock.calls[0]![0]).toEqual({
      uid: 'u_1',
      spaceId: 's_1',
      principalSpaceId: 's_1',
      pageSize: 100, // clamped from 9999
      cursor: 'c0',
    })
    expect(res.statusCode).toBe(200)
  })

  it('defaults page_size to 20 when absent and forwards no cursor', async () => {
    const res = mockRes()
    await listManageableHandler(req({}), res as never)
    const arg = vi.mocked(docMetaRepo.listManageable).mock.calls[0]![0]
    expect(arg.pageSize).toBe(20)
    expect(arg.cursor).toBeUndefined()
  })

  it('OCTO-456: forwards a trimmed `q` title filter and no q for a blank one', async () => {
    await listManageableHandler(req({ q: '  Quarterly Report  ' }), mockRes() as never)
    expect(vi.mocked(docMetaRepo.listManageable).mock.calls[0]![0]).toMatchObject({
      q: 'Quarterly Report',
    })

    await listManageableHandler(req({ q: '   ' }), mockRes() as never)
    expect(vi.mocked(docMetaRepo.listManageable).mock.calls[1]![0].q).toBeUndefined()

    await listManageableHandler(req({}), mockRes() as never)
    expect(vi.mocked(docMetaRepo.listManageable).mock.calls[2]![0].q).toBeUndefined()
  })

  it('maps rows to the picker DTO (optional octoDocSlug, ISO updatedAt) and passes nextCursor through', async () => {
    vi.mocked(docMetaRepo.listManageable).mockResolvedValue({
      items: [
        { doc_id: 'd1', title: 'Home doc', doc_type: 'doc', owner_id: 'u_1', space_id: 's_1', octo_doc_slug: null, updated_at: new Date('2024-01-02T03:04:05.000Z') },
        { doc_id: 'd2', title: 'HTML page', doc_type: 'html', owner_id: 'u_1', space_id: 's_other', octo_doc_slug: 'slug-2', updated_at: new Date('2024-01-01T00:00:00.000Z') },
      ],
      nextCursor: 'next-tok',
    })
    const res = mockRes()
    await listManageableHandler(req({}), res as never)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      items: [
        { docId: 'd1', title: 'Home doc', ownerId: 'u_1', docType: 'doc', updatedAt: '2024-01-02T03:04:05.000Z' },
        { docId: 'd2', title: 'HTML page', ownerId: 'u_1', docType: 'html', octoDocSlug: 'slug-2', updatedAt: '2024-01-01T00:00:00.000Z' },
      ],
      nextCursor: 'next-tok',
    })
  })

  it('turns a malformed-cursor error into 400 (not a 500)', async () => {
    vi.mocked(docMetaRepo.listManageable).mockRejectedValue(new Error('invalid_cursor'))
    const res = mockRes()
    await listManageableHandler(req({ cursor: 'garbage' }), res as never)
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_cursor' })
  })

  it('rethrows an unexpected repo error (surfaces as 5xx via the async wrapper)', async () => {
    vi.mocked(docMetaRepo.listManageable).mockRejectedValue(new Error('db down'))
    await expect(listManageableHandler(req({}), mockRes() as never)).rejects.toThrow('db down')
  })
})
