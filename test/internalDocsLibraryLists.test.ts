import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * OCTO-456 internal library listings: GET /internal/docs/shared and
 * /internal/docs/readable. The repo queries are mocked; these tests pin the
 * handler behaviour that drive depends on — the sources union (direct / invite /
 * legacy merged into ONE item), the owner exclusion (enforced in SQL, asserted
 * on the call), cursor passthrough, limit clamping, and the read-role replay
 * (owner / direct / org-wide authenticated / anyone_in_space).
 */
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    driveDerived: {
      inboundToken: 'drive-tok',
      outboundToken: '',
      enabled: false,
      internalBaseUrl: '',
      timeoutMs: 500,
      ttlMs: 1000,
    },
  },
}))
vi.mock('../src/config/env.js', () => ({ config: mockConfig }))
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  MAX_LIBRARY_PAGE_SIZE: 500,
  docMetaRepo: { listSharedWithUser: vi.fn(), listReadableForUser: vi.fn() },
}))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  docMemberRepo: {},
  SOURCE_DIRECT: 1,
  SOURCE_INVITE: 2,
}))

import {
  internalDocsReadableHandler,
  internalDocsSharedHandler,
} from '../src/api/routes/internalDocsLibrary.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'

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
function request(query: Record<string, string> = {}, token = 'drive-tok') {
  return {
    query,
    header: (name: string) => (name.toLowerCase() === 'x-internal-token' ? token : undefined),
  }
}

const row = {
  doc_id: 'd1',
  title: 'Shared Doc',
  doc_type: 'doc',
  owner_id: 'owner',
  created_by: 'creator',
  space_id: 's1',
  updated_at: new Date('2026-11-21T00:00:00.000Z'),
  role: 1,
  member_source: 1,
  has_legacy: 0,
  has_view: 0,
  share_scope: null as number | null,
  share_role: null as number | null,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockConfig.driveDerived.inboundToken = 'drive-tok'
  vi.mocked(docMetaRepo.listSharedWithUser).mockResolvedValue({ items: [], nextCursor: null })
  vi.mocked(docMetaRepo.listReadableForUser).mockResolvedValue({ items: [], nextCursor: null })
})

describe('GET /internal/docs/shared', () => {
  it('401s without the internal token', async () => {
    const res = response()
    await internalDocsSharedHandler(
      request({ uid: 'u1', principal_space_id: 's1' }, '') as never,
      res as never,
    )
    expect(res.statusCode).toBe(401)
    expect(docMetaRepo.listSharedWithUser).not.toHaveBeenCalled()
  })

  it('400s on a missing uid / principal_space_id', async () => {
    for (const query of [
      { principal_space_id: 's1' },
      { uid: 'u1' },
      { uid: '', principal_space_id: 's1' },
    ]) {
      const res = response()
      await internalDocsSharedHandler(request(query) as never, res as never)
      expect(res.statusCode).toBe(400)
      expect(res.body).toEqual({ error: 'invalid_request' })
    }
  })

  it('defaults limit to 200 and clamps the upper bound to 500', async () => {
    await internalDocsSharedHandler(
      request({ uid: 'u1', principal_space_id: 's1' }) as never,
      response() as never,
    )
    expect(vi.mocked(docMetaRepo.listSharedWithUser).mock.calls[0]![0]).toMatchObject({
      uid: 'u1', principalSpaceId: 's1', pageSize: 200, cursor: undefined,
    })

    await internalDocsSharedHandler(
      request({ uid: 'u1', principal_space_id: 's1', limit: '9999' }) as never,
      response() as never,
    )
    expect(vi.mocked(docMetaRepo.listSharedWithUser).mock.calls[1]![0].pageSize).toBe(500)
  })

  it('direct + legacy on the SAME doc => one item with sources ["direct","legacy"]', async () => {
    vi.mocked(docMetaRepo.listSharedWithUser).mockResolvedValue({
      items: [{ ...row, has_legacy: 1 }],
      nextCursor: 'CURSOR',
    } as never)
    const res = response()
    await internalDocsSharedHandler(
      request({ uid: 'u1', principal_space_id: 's1', cursor: 'CURSOR0' }) as never,
      res as never,
    )
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      items: [{
        doc_id: 'd1',
        title: 'Shared Doc',
        doc_type: 'doc',
        owner_uid: 'owner',
        created_by: 'creator',
        doc_space_id: 's1',
        role: 'reader',
        sources: ['direct', 'legacy'],
        updated_at: '2026-11-21T00:00:00.000Z',
      }],
      next_cursor: 'CURSOR',
      has_more: true,
    })
    expect(vi.mocked(docMetaRepo.listSharedWithUser).mock.calls[0]![0].cursor).toBe('CURSOR0')
  })

  it('invite provenance maps to sources ["invite"]', async () => {
    vi.mocked(docMetaRepo.listSharedWithUser).mockResolvedValue({
      items: [{ ...row, member_source: 2 }],
      nextCursor: null,
    } as never)
    const res = response()
    await internalDocsSharedHandler(
      request({ uid: 'u1', principal_space_id: 's1' }) as never,
      res as never,
    )
    const body = res.body as { items: Array<{ sources: string[] }>; has_more: boolean }
    expect(body.items[0]!.sources).toEqual(['invite'])
    expect(body.has_more).toBe(false)
    expect((res.body as { next_cursor: unknown }).next_cursor).toBeNull()
  })

  it('a legacy-only row (no doc_member grant) projects role reader + sources ["legacy"]', async () => {
    vi.mocked(docMetaRepo.listSharedWithUser).mockResolvedValue({
      items: [{ ...row, role: null, member_source: null, has_legacy: 1 }],
      nextCursor: null,
    } as never)
    const res = response()
    await internalDocsSharedHandler(
      request({ uid: 'u1', principal_space_id: 's1' }) as never,
      res as never,
    )
    expect((res.body as { items: Array<{ role: string; sources: string[] }> }).items[0])
      .toMatchObject({ role: 'reader', sources: ['legacy'] })
  })

  // 2026-11-27 product rule: the second 与我共享 source is "查看记录 + 当前分享
  // 范围". A view-only row carries the share role as its display role and shows
  // NO invite provenance (so no unread badge).
  it('a view-only row projects sources ["view"] and the current share role', async () => {
    vi.mocked(docMetaRepo.listSharedWithUser).mockResolvedValue({
      items: [{
        ...row,
        role: null,
        member_source: null,
        has_legacy: 0,
        has_view: 1,
        share_scope: 2,
        share_role: 2,
      }],
      nextCursor: null,
    } as never)
    const res = response()
    await internalDocsSharedHandler(
      request({ uid: 'u1', principal_space_id: 's1' }) as never,
      res as never,
    )
    expect((res.body as { items: Array<{ role: string; sources: string[] }> }).items[0])
      .toMatchObject({ role: 'writer', sources: ['view'] })
  })

  it('view + legacy on the SAME doc => one item with sources ["legacy","view"]', async () => {
    vi.mocked(docMetaRepo.listSharedWithUser).mockResolvedValue({
      items: [{
        ...row,
        role: null,
        member_source: null,
        has_legacy: 1,
        has_view: 1,
        share_scope: 2,
        share_role: null,
      }],
      nextCursor: null,
    } as never)
    const res = response()
    await internalDocsSharedHandler(
      request({ uid: 'u1', principal_space_id: 's1' }) as never,
      res as never,
    )
    expect((res.body as { items: Array<{ role: string; sources: string[] }> }).items[0])
      .toMatchObject({ role: 'reader', sources: ['legacy', 'view'] })
  })

  it('a member record wins over the view leg (role + sources keep the member grant)', async () => {
    vi.mocked(docMetaRepo.listSharedWithUser).mockResolvedValue({
      items: [{
        ...row,
        role: 1,
        member_source: 2,
        has_legacy: 0,
        has_view: 1,
        share_scope: 2,
        share_role: 2,
      }],
      nextCursor: null,
    } as never)
    const res = response()
    await internalDocsSharedHandler(
      request({ uid: 'u1', principal_space_id: 's1' }) as never,
      res as never,
    )
    expect((res.body as { items: Array<{ role: string; sources: string[] }> }).items[0])
      .toMatchObject({ role: 'reader', sources: ['invite', 'view'] })
  })

  it('projects created_by independently from owner (blank stays blank, never owner)', async () => {
    vi.mocked(docMetaRepo.listSharedWithUser).mockResolvedValue({
      items: [{ ...row, created_by: '' }],
      nextCursor: null,
    } as never)
    const res = response()
    await internalDocsSharedHandler(
      request({ uid: 'u1', principal_space_id: 's1' }) as never,
      res as never,
    )
    const item = (res.body as { items: Array<{ owner_uid: string; created_by: string }> }).items[0]!
    expect(item.owner_uid).toBe('owner')
    expect(item.created_by).toBe('')
  })

  it('turns a malformed cursor into 400 invalid_cursor', async () => {
    vi.mocked(docMetaRepo.listSharedWithUser).mockRejectedValue(new Error('invalid_cursor'))
    const res = response()
    await internalDocsSharedHandler(
      request({ uid: 'u1', principal_space_id: 's1', cursor: 'garbage' }) as never,
      res as never,
    )
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_cursor' })
  })
})

describe('GET /internal/docs/readable', () => {
  const readableRow = {
    doc_id: 'd1',
    title: 'Readable',
    doc_type: 'doc',
    owner_id: 'owner',
    owner_space_id: 's1',
    space_id: 's1',
    updated_at: new Date('2026-11-22T00:00:00.000Z'),
    role: null,
    share_scope: 0,
    share_role: 1,
  }

  it('owner => admin, sources []', async () => {
    vi.mocked(docMetaRepo.listReadableForUser).mockResolvedValue({
      items: [{ ...readableRow }],
      nextCursor: null,
    } as never)
    const res = response()
    await internalDocsReadableHandler(
      request({ uid: 'owner', principal_space_id: 's1' }) as never,
      res as never,
    )
    expect(res.body).toEqual({
      items: [{
        doc_id: 'd1',
        title: 'Readable',
        doc_type: 'doc',
        owner_uid: 'owner',
        doc_space_id: 's1',
        role: 'admin',
        sources: [],
        updated_at: '2026-11-22T00:00:00.000Z',
      }],
      next_cursor: null,
      has_more: false,
    })
  })

  it('doc_member role maps to its wire name', async () => {
    vi.mocked(docMetaRepo.listReadableForUser).mockResolvedValue({
      items: [{ ...readableRow, role: 2 }],
      nextCursor: null,
    } as never)
    const res = response()
    await internalDocsReadableHandler(
      request({ uid: 'u1', principal_space_id: 's1' }) as never,
      res as never,
    )
    expect((res.body as { items: Array<{ role: string }> }).items[0]!.role).toBe('writer')
  })

  it('anyone_in_space in the caller Space => share role; other Space with no grant => dropped', async () => {
    vi.mocked(docMetaRepo.listReadableForUser).mockResolvedValue({
      items: [
        { ...readableRow, doc_id: 'd_home', share_scope: 1, share_role: 1 },
        { ...readableRow, doc_id: 'd_foreign', space_id: 's_other', share_scope: 1, share_role: 1 },
      ],
      nextCursor: null,
    } as never)
    const res = response()
    await internalDocsReadableHandler(
      request({ uid: 'stranger', principal_space_id: 's1' }) as never,
      res as never,
    )
    const items = (res.body as { items: Array<{ doc_id: string; role: string }> }).items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ doc_id: 'd_home', role: 'reader' })
  })

  it('authenticated share scope (org-wide) grants the share role', async () => {
    vi.mocked(docMetaRepo.listReadableForUser).mockResolvedValue({
      items: [{ ...readableRow, doc_id: 'd_org', space_id: 's_other', share_scope: 2, share_role: 2 }],
      nextCursor: null,
    } as never)
    const res = response()
    await internalDocsReadableHandler(
      request({ uid: 'stranger', principal_space_id: 's1' }) as never,
      res as never,
    )
    expect((res.body as { items: Array<{ role: string }> }).items[0]!.role).toBe('writer')
  })

  it('passes the cursor through and reports has_more', async () => {
    vi.mocked(docMetaRepo.listReadableForUser).mockResolvedValue({
      items: [{ ...readableRow }],
      nextCursor: 'NEXT',
    } as never)
    const res = response()
    await internalDocsReadableHandler(
      request({ uid: 'owner', principal_space_id: 's1', cursor: 'C0', limit: '50' }) as never,
      res as never,
    )
    expect(vi.mocked(docMetaRepo.listReadableForUser).mock.calls[0]![0]).toMatchObject({
      cursor: 'C0', pageSize: 50,
    })
    expect(res.body).toMatchObject({ next_cursor: 'NEXT', has_more: true })
  })

  it('401s without the internal token', async () => {
    const res = response()
    await internalDocsReadableHandler(
      request({ uid: 'u1', principal_space_id: 's1' }, '') as never,
      res as never,
    )
    expect(res.statusCode).toBe(401)
  })
})
