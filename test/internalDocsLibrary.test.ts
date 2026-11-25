import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * OCTO-456 internal library contract (POST /internal/docs/status and
 * /internal/docs/capabilities). Offline: mock config, the two read repos, the
 * permission layer's drive-derived gate and call the exported handlers directly
 * (mirrors internalDocRole.test.ts).
 *
 * The permission resolution itself is REAL here (resolveEffectiveRole +
 * effectiveRole), so these tests pin the share-scope / direct-role merge — not a
 * hand-rolled copy of it.
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
    driveInternalUrl: '',
    driveInternalToken: '',
  },
}))
vi.mock('../src/config/env.js', () => ({ config: mockConfig }))
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: { getByDocIds: vi.fn(), getLegacyVisibleDocIds: vi.fn() },
}))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  docMemberRepo: { getRoles: vi.fn() },
  SOURCE_DIRECT: 1,
  SOURCE_INVITE: 2,
}))

import {
  internalDocCapabilitiesHandler,
  internalDocStatusHandler,
} from '../src/api/routes/internalDocsLibrary.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'

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
function request(body: unknown, token = 'drive-tok') {
  return {
    body,
    header: (name: string) => (name.toLowerCase() === 'x-internal-token' ? token : undefined),
  }
}

const baseMeta = {
  doc_id: 'd1',
  title: 'Doc One',
  doc_type: 'doc',
  owner_id: 'owner',
  owner_space_id: 's1',
  space_id: 's1',
  status: 1,
  share_scope: 0,
  share_role: 1,
  updated_at: new Date('2026-11-20T01:02:03.000Z'),
}

beforeEach(() => {
  vi.clearAllMocks()
  mockConfig.driveDerived.inboundToken = 'drive-tok'
  vi.mocked(docMetaRepo.getByDocIds).mockResolvedValue([] as never)
  vi.mocked(docMetaRepo.getLegacyVisibleDocIds).mockResolvedValue(new Set() as never)
  vi.mocked(docMemberRepo.getRoles).mockResolvedValue(new Map() as never)
})

describe('POST /internal/docs/status', () => {
  it('401s without the internal token and never reads the DB', async () => {
    const res = response()
    await internalDocStatusHandler(
      request({ uid: 'u1', principal_space_id: 's1', doc_ids: ['d1'] }, '') as never,
      res as never,
    )
    expect(res.statusCode).toBe(401)
    expect(docMetaRepo.getByDocIds).not.toHaveBeenCalled()
  })

  it('400s on a malformed body', async () => {
    for (const body of [undefined, {}, { uid: 'u1', principal_space_id: 's1' },
      { uid: 'u1', principal_space_id: 's1', doc_ids: [1] }]) {
      const res = response()
      await internalDocStatusHandler(request(body) as never, res as never)
      expect(res.statusCode).toBe(400)
      expect(res.body).toEqual({ error: 'invalid_request' })
    }
  })

  it('400s when more than 500 unique ids are requested', async () => {
    const res = response()
    await internalDocStatusHandler(
      request({
        uid: 'u1',
        principal_space_id: 's1',
        doc_ids: Array.from({ length: 501 }, (_, i) => `d${i}`),
      }) as never,
      res as never,
    )
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'too_many_doc_ids' })
  })

  it('returns an empty items array for an empty id list', async () => {
    const res = response()
    await internalDocStatusHandler(
      request({ uid: 'u1', principal_space_id: 's1', doc_ids: [] }) as never,
      res as never,
    )
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ items: [] })
    expect(docMetaRepo.getByDocIds).not.toHaveBeenCalled()
  })

  it('owner (uid + owner Space) => admin, can_read, not deleted, ISO updated_at', async () => {
    vi.mocked(docMetaRepo.getByDocIds).mockResolvedValue([{ ...baseMeta }] as never)
    const res = response()
    await internalDocStatusHandler(
      request({ uid: 'owner', principal_space_id: 's1', doc_ids: ['d1'] }) as never,
      res as never,
    )
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      items: [{
        doc_id: 'd1',
        title: 'Doc One',
        doc_type: 'doc',
        owner_uid: 'owner',
        doc_space_id: 's1',
        role: 'admin',
        updated_at: '2026-11-20T01:02:03.000Z',
        deleted: false,
        deleted_at: null,
        expired: false,
        can_read: true,
      }],
    })
    expect(docMemberRepo.getRoles).toHaveBeenCalledWith(['d1'], 'owner', 's1')
  })

  it('non-owner direct writer => writer', async () => {
    vi.mocked(docMetaRepo.getByDocIds).mockResolvedValue([{ ...baseMeta }] as never)
    vi.mocked(docMemberRepo.getRoles).mockResolvedValue(new Map([['d1', 'writer']]) as never)
    const res = response()
    await internalDocStatusHandler(
      request({ uid: 'u1', principal_space_id: 's1', doc_ids: ['d1'] }) as never,
      res as never,
    )
    expect((res.body as { items: Array<{ role: string }> }).items[0]!.role).toBe('writer')
  })

  it('anyone_in_space share: readable when the principal Space IS the doc Space', async () => {
    vi.mocked(docMetaRepo.getByDocIds).mockResolvedValue([
      { ...baseMeta, share_scope: 1, share_role: 1 },
    ] as never)
    const res = response()
    await internalDocStatusHandler(
      request({ uid: 'stranger', principal_space_id: 's1', doc_ids: ['d1'] }) as never,
      res as never,
    )
    const items = (res.body as { items: Array<{ role: string; can_read: boolean }> }).items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ role: 'reader', can_read: true })
  })

  it('anyone_in_space share: NOT readable from another principal Space (no member row)', async () => {
    vi.mocked(docMetaRepo.getByDocIds).mockResolvedValue([
      { ...baseMeta, share_scope: 1, share_role: 1 },
    ] as never)
    const res = response()
    await internalDocStatusHandler(
      request({ uid: 'stranger', principal_space_id: 's_other', doc_ids: ['d1'] }) as never,
      res as never,
    )
    expect(res.body).toEqual({ items: [] })
  })

  it('authenticated share scope (org-wide read) grants reader', async () => {
    vi.mocked(docMetaRepo.getByDocIds).mockResolvedValue([
      { ...baseMeta, space_id: 's_other', share_scope: 2, share_role: 1 },
    ] as never)
    const res = response()
    await internalDocStatusHandler(
      request({ uid: 'stranger', principal_space_id: 's1', doc_ids: ['d1'] }) as never,
      res as never,
    )
    expect((res.body as { items: Array<{ role: string; can_read: boolean }> }).items[0])
      .toMatchObject({ role: 'reader', can_read: true })
  })

  it('omits a doc with no role and a doc id that does not exist (never 404s the batch)', async () => {
    vi.mocked(docMetaRepo.getByDocIds).mockResolvedValue([{ ...baseMeta }] as never)
    const res = response()
    await internalDocStatusHandler(
      request({ uid: 'stranger', principal_space_id: 's1', doc_ids: ['d1', 'missing'] }) as never,
      res as never,
    )
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ items: [] })
  })

  it('deleted doc: owner observes the grey row (deleted_at NULL => expired:false, role none)', async () => {
    vi.mocked(docMetaRepo.getByDocIds).mockResolvedValue([
      { ...baseMeta, status: 0, deleted_at: null },
    ] as never)
    const res = response()
    await internalDocStatusHandler(
      request({ uid: 'owner', principal_space_id: 's1', doc_ids: ['d1'] }) as never,
      res as never,
    )
    expect(res.body).toEqual({
      items: [{
        doc_id: 'd1',
        title: 'Doc One',
        doc_type: 'doc',
        owner_uid: 'owner',
        doc_space_id: 's1',
        role: 'none',
        updated_at: '2026-11-20T01:02:03.000Z',
        deleted: true,
        deleted_at: null,
        expire_at: null,
        retention_days: 30,
        expired: false,
        can_read: false,
      }],
    })
    // Only a deleted row triggers the legacy provenance lookup.
    expect(docMetaRepo.getLegacyVisibleDocIds).toHaveBeenCalledWith(['d1'], 'owner', 's1')
  })

  it('deleted doc: owner uid from a DIFFERENT principal Space does not see the grey row (P1-2)', async () => {
    vi.mocked(docMetaRepo.getByDocIds).mockResolvedValue([
      { ...baseMeta, status: 0, deleted_at: null },
    ] as never)
    const res = response()
    await internalDocStatusHandler(
      request({ uid: 'owner', principal_space_id: 's_other', doc_ids: ['d1'] }) as never,
      res as never,
    )
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ items: [] })
  })

  it('shared candidate with NULL deleted_at maps to a deleted grey row (candidate -> status linkage)', async () => {
    // Exactly what listSharedWithUser now returns for a HISTORICAL soft-deleted
    // row: status=0, deleted_at NULL, observed through a doc_member grant. If the
    // candidate layer dropped that row (the pre-fix `deleted_at IS NOT NULL`
    // predicate), Drive would never get the chance to ask status for it. Feeding
    // the candidate's meta here pins the second half: it must map to a grey row,
    // not disappear and not be reported as expired.
    vi.mocked(docMetaRepo.getByDocIds).mockResolvedValue([
      { ...baseMeta, status: 0, deleted_at: null },
    ] as never)
    vi.mocked(docMemberRepo.getRoles).mockResolvedValue(new Map([['d1', 'reader']]) as never)
    const res = response()
    await internalDocStatusHandler(
      request({ uid: 'u1', principal_space_id: 's1', doc_ids: ['d1'] }) as never,
      res as never,
    )
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      items: [{
        doc_id: 'd1',
        title: 'Doc One',
        doc_type: 'doc',
        owner_uid: 'owner',
        doc_space_id: 's1',
        role: 'none',
        updated_at: '2026-11-20T01:02:03.000Z',
        deleted: true,
        deleted_at: null,
        expire_at: null,
        retention_days: 30,
        expired: false,
        can_read: false,
      }],
    })
  })

  it('deleted doc: ANY doc_member role still observes the grey row', async () => {    for (const role of ['reader', 'commenter', 'writer', 'admin'] as const) {
      vi.mocked(docMetaRepo.getByDocIds).mockResolvedValue([{ ...baseMeta, status: 0 }] as never)
      vi.mocked(docMemberRepo.getRoles).mockResolvedValue(new Map([['d1', role]]) as never)
      const res = response()
      await internalDocStatusHandler(
        request({ uid: 'u1', principal_space_id: 's1', doc_ids: ['d1'] }) as never,
        res as never,
      )
      expect((res.body as { items: Array<{ role: string; can_read: boolean }> }).items[0])
        .toMatchObject({ role: 'none', can_read: false, deleted: true })
    }
  })

  it('deleted doc: a legacy 补录 row alone keeps the grey row observable', async () => {
    vi.mocked(docMetaRepo.getByDocIds).mockResolvedValue([{ ...baseMeta, status: 0 }] as never)
    vi.mocked(docMetaRepo.getLegacyVisibleDocIds).mockResolvedValue(new Set(['d1']) as never)
    const res = response()
    await internalDocStatusHandler(
      request({ uid: 'legacy_uid', principal_space_id: 's1', doc_ids: ['d1'] }) as never,
      res as never,
    )
    expect((res.body as { items: unknown[] }).items).toHaveLength(1)
  })

  it('deleted doc: share_scope alone is NOT enough (fail closed)', async () => {
    vi.mocked(docMetaRepo.getByDocIds).mockResolvedValue([
      { ...baseMeta, status: 0, share_scope: 1, share_role: 1 },
      { ...baseMeta, doc_id: 'd2', status: 0, share_scope: 2, share_role: 1 },
    ] as never)
    const res = response()
    await internalDocStatusHandler(
      request({ uid: 'stranger', principal_space_id: 's1', doc_ids: ['d1', 'd2'] }) as never,
      res as never,
    )
    expect(res.body).toEqual({ items: [] })
  })

  it('deleted doc: outputs deleted_at as ISO8601 UTC (...Z)', async () => {
    vi.mocked(docMetaRepo.getByDocIds).mockResolvedValue([
      { ...baseMeta, status: 0, deleted_at: new Date('2026-11-22T03:04:05.678Z') },
    ] as never)
    const res = response()
    await internalDocStatusHandler(
      request({ uid: 'owner', principal_space_id: 's1', doc_ids: ['d1'] }) as never,
      res as never,
    )
    expect((res.body as { items: Array<{ deleted_at: string }> }).items[0]!.deleted_at)
      .toBe('2026-11-22T03:04:05.678Z')
  })

  it('expired: exactly 30 days is NOT expired, 1ms older IS expired, NULL is never expired', async () => {
    const now = Date.parse('2026-11-24T12:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(now)
    try {
      const at = (offsetMs: number) => new Date(now + offsetMs)
      const cases: Array<[Date | null, boolean]> = [
        [null, false],
        [at(-1), false],
        [at(-(30 * 24 * 60 * 60 * 1000) + 1), false],
        [at(-(30 * 24 * 60 * 60 * 1000)), false],
        [at(-(30 * 24 * 60 * 60 * 1000) - 1), true],
        [at(-31 * 24 * 60 * 60 * 1000), true],
      ]
      for (const [deletedAt, expired] of cases) {
        vi.mocked(docMetaRepo.getByDocIds).mockResolvedValue([
          { ...baseMeta, status: 0, deleted_at: deletedAt },
        ] as never)
        const res = response()
        await internalDocStatusHandler(
          request({ uid: 'owner', principal_space_id: 's1', doc_ids: ['d1'] }) as never,
          res as never,
        )
        expect((res.body as { items: Array<{ expired: boolean }> }).items[0]!.expired).toBe(expired)
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('soft-deleted doc WITHOUT any surviving grant is omitted; archived docs are omitted', async () => {
    vi.mocked(docMetaRepo.getByDocIds).mockResolvedValue([
      { ...baseMeta, status: 0 },
      { ...baseMeta, doc_id: 'd2', status: 2 },
    ] as never)
    const res = response()
    await internalDocStatusHandler(
      request({ uid: 'stranger', principal_space_id: 's1', doc_ids: ['d1', 'd2'] }) as never,
      res as never,
    )
    expect(res.body).toEqual({ items: [] })
  })

  it('skips the legacy lookup entirely when the batch has no deleted rows', async () => {
    vi.mocked(docMetaRepo.getByDocIds).mockResolvedValue([{ ...baseMeta, status: 1 }] as never)
    vi.mocked(docMemberRepo.getRoles).mockResolvedValue(new Map([['d1', 'reader']]) as never)
    const res = response()
    await internalDocStatusHandler(
      request({ uid: 'u1', principal_space_id: 's1', doc_ids: ['d1'] }) as never,
      res as never,
    )
    expect(res.statusCode).toBe(200)
    expect(docMetaRepo.getLegacyVisibleDocIds).not.toHaveBeenCalled()
  })

  it('preserves request order and de-duplicates repeated ids', async () => {
    vi.mocked(docMetaRepo.getByDocIds).mockResolvedValue([
      { ...baseMeta, doc_id: 'd2', title: 'Two' },
      { ...baseMeta, doc_id: 'd1', title: 'One' },
    ] as never)
    vi.mocked(docMemberRepo.getRoles).mockResolvedValue(
      new Map([['d1', 'reader'], ['d2', 'reader']]) as never,
    )
    const res = response()
    await internalDocStatusHandler(
      request({ uid: 'u1', principal_space_id: 's1', doc_ids: ['d2', 'd1', 'd2'] }) as never,
      res as never,
    )
    expect((res.body as { items: Array<{ doc_id: string }> }).items.map((i) => i.doc_id))
      .toEqual(['d2', 'd1'])
    expect(docMetaRepo.getByDocIds).toHaveBeenCalledWith(['d2', 'd1'])
  })
})

describe('POST /internal/docs/capabilities', () => {
  async function capsFor(
    role: 'reader' | 'commenter' | 'writer' | 'admin',
    meta: Record<string, unknown> = {},
    uid = 'u1',
  ) {
    vi.mocked(docMetaRepo.getByDocIds).mockResolvedValue([{ ...baseMeta, ...meta }] as never)
    vi.mocked(docMemberRepo.getRoles).mockResolvedValue(new Map([['d1', role]]) as never)
    const res = response()
    await internalDocCapabilitiesHandler(
      request({ uid, principal_space_id: 's1', doc_ids: ['d1'] }) as never,
      res as never,
    )
    expect(res.statusCode).toBe(200)
    return (res.body as {
      items: Array<{ doc_id: string; role: string; doc: Record<string, boolean> }>
    }).items[0]!
  }

  it('401s without the internal token', async () => {
    const res = response()
    await internalDocCapabilitiesHandler(
      request({ uid: 'u1', principal_space_id: 's1', doc_ids: ['d1'] }, '') as never,
      res as never,
    )
    expect(res.statusCode).toBe(401)
  })

  it('maps reader -> read/export/copy/download only', async () => {
    const item = await capsFor('reader')
    expect(item.role).toBe('reader')
    expect(item.doc).toEqual({
      can_read: true,
      can_comment: false,
      can_edit: false,
      can_share: false,
      can_export: true,
      can_copy: true,
      can_rename_original: false,
      can_delete_original: false,
      can_download_original: true,
    })
  })

  it('maps commenter -> + comment (but no edit)', async () => {
    const item = await capsFor('commenter')
    expect(item.doc).toMatchObject({ can_read: true, can_comment: true, can_edit: false })
  })

  it('maps writer -> + edit, still no share/rename/delete', async () => {
    const item = await capsFor('writer')
    expect(item.doc).toMatchObject({
      can_edit: true, can_share: false, can_rename_original: false, can_delete_original: false,
    })
  })

  it('maps admin -> everything true for a doc', async () => {
    const item = await capsFor('admin')
    expect(Object.values(item.doc).every(Boolean)).toBe(true)
  })

  it('html: the ORIGINAL AUTHOR in the same Space may rename without an admin role (§4.8)', async () => {
    // Same entry Space as the owner: the §4.8 author branch authorizes the rename
    // while the caller's only role is a reader member row.
    const item = await capsFor(
      'reader',
      { doc_type: 'html', owner_id: 'author', owner_space_id: 's1' },
      'author',
    )
    // Owner + same Space is the repo's owner-is-admin shortcut; the rename bit is
    // true either way, and the pure author branch (reader role) is unit-tested in
    // docCapabilitiesRename.test.ts.
    expect(item.role).toBe('admin')
    expect(item.doc.can_rename_original).toBe(true)
  })

  it('html: author UID from ANOTHER principal Space keeps only reader permissions', async () => {
    // Readable via authenticated share (no doc_member row). The compound author
    // identity is (uid, owner Space): s2 != s1, so canRenameOriginal stays false.
    vi.mocked(docMetaRepo.getByDocIds).mockResolvedValue([{
      ...baseMeta, doc_type: 'html', owner_id: 'author', owner_space_id: 's1', share_scope: 2, share_role: 1,
    }] as never)
    vi.mocked(docMemberRepo.getRoles).mockResolvedValue(new Map() as never)
    const res = response()
    await internalDocCapabilitiesHandler(
      request({ uid: 'author', principal_space_id: 's2', doc_ids: ['d1'] }) as never,
      res as never,
    )
    expect(res.statusCode).toBe(200)
    const item = (res.body as { items: Array<{ role: string; doc: Record<string, boolean> }> }).items[0]!
    expect(item.role).toBe('reader')
    expect(item.doc.can_rename_original).toBe(false)
  })

  it('html: a NON-author reader may not rename', async () => {
    const item = await capsFor('reader', { doc_type: 'html', owner_id: 'author' }, 'u1')
    expect(item.doc.can_rename_original).toBe(false)
  })

  it('html: an admin who is not the author may rename (§4.8 role>=admin branch)', async () => {
    const item = await capsFor('admin', { doc_type: 'html', owner_id: 'author' }, 'u1')
    expect(item.doc.can_rename_original).toBe(true)
  })

  it('sheet/board/html_ppt rename + delete require admin', async () => {
    for (const docType of ['doc', 'sheet', 'board', 'html_ppt']) {
      const writer = await capsFor('writer', { doc_type: docType })
      expect(writer.doc.can_rename_original).toBe(false)
      expect(writer.doc.can_delete_original).toBe(false)
      const admin = await capsFor('admin', { doc_type: docType })
      expect(admin.doc.can_rename_original).toBe(true)
      expect(admin.doc.can_delete_original).toBe(true)
    }
  })

  it('omits deleted / archived / missing docs', async () => {
    vi.mocked(docMetaRepo.getByDocIds).mockResolvedValue([
      { ...baseMeta, status: 0 },
      { ...baseMeta, doc_id: 'd2', status: 2 },
    ] as never)
    vi.mocked(docMemberRepo.getRoles).mockResolvedValue(
      new Map([['d1', 'admin'], ['d2', 'admin']]) as never,
    )
    const res = response()
    await internalDocCapabilitiesHandler(
      request({ uid: 'u1', principal_space_id: 's1', doc_ids: ['d1', 'd2', 'gone'] }) as never,
      res as never,
    )
    expect(res.body).toEqual({ items: [] })
  })
})
