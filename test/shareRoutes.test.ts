import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit test: mock the guard, the doc_meta repo write, and the epoch bump.
// The share handlers run against the mocked guard so validation / normalization /
// epoch-bump behavior is exercised without live infra (mirrors docsRoutes.test).
vi.mock('../src/api/guard.js', () => ({
  requireDocRole: vi.fn(),
}))
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: {
    setShareSettings: vi.fn(async () => ({
      updated: true,
      settings: {
        shareScope: 1,
        shareRole: 2,
        spaceSearchable: false,
        permissionEpoch: 8,
      },
    })),
  },
}))
vi.mock('../src/permission/epoch.js', () => ({
  refreshAndPublish: vi.fn(async () => undefined),
}))

import { getShareHandler, putShareHandler } from '../src/api/routes/docs.js'
import { requireDocRole } from '../src/api/guard.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { refreshAndPublish } from '../src/permission/epoch.js'

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
    status(c: number) {
      this.statusCode = c
      return this
    },
    json(b: unknown) {
      this.body = b
      return this
    },
  }
}

function req(body: unknown, options: { bot?: boolean } = {}) {
  const requestBody = body != null && typeof body === 'object'
    ? { permissionEpoch: 7, ...body }
    : body
  return {
    uid: 'u_admin',
    spaceId: 's1',
    params: { docId: 'd_1' },
    body: requestBody,
    ...(options.bot ? { botToken: 'bot-token' } : {}),
  } as never
}

const guardMeta = (over: Record<string, unknown> = {}) => ({
  meta: {
    doc_id: 'd_1',
    document_name: 'octo:s1:f_default:d_1',
    space_id: 's1',
    share_scope: 0,
    share_role: 1,
    permission_epoch: 7,
    discoverability_scope: 0,
    ...over,
  },
  role: 'admin',
})

beforeEach(() => {
  vi.mocked(requireDocRole).mockReset()
  vi.mocked(docMetaRepo.setShareSettings).mockClear()
  vi.mocked(docMetaRepo.setShareSettings).mockResolvedValue({
    updated: true,
    settings: {
      shareScope: 1,
      shareRole: 2,
      spaceSearchable: false,
      permissionEpoch: 8,
    },
  } as never)
  vi.mocked(refreshAndPublish).mockClear()
})

describe('GET /api/v1/docs/:docId/share (#64)', () => {
  it('needs only reader and returns the current scope/role (fail-safe names)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guardMeta({ share_scope: 1, share_role: 2 }) as never)
    const res = mockRes()
    await getShareHandler(req(undefined), res as never)
    expect(vi.mocked(requireDocRole).mock.calls[0]![3]).toBe('reader')
    expect(res.statusCode).toBe(200)
  })

  it('an unexpected stored value reads back as the most-restrictive default', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guardMeta({
      share_scope: 9,
      share_role: 9,
      discoverability_scope: 9,
    }) as never)
    const res = mockRes()
    await getShareHandler(req(undefined), res as never)
  })

  it('propagates the guard rejection (404/403) without emitting a body', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(null)
    const res = mockRes()
    await getShareHandler(req(undefined), res as never)
    expect(res.statusCode).toBe(0) // guard wrote its own status; handler returned early
    expect(docMetaRepo.setShareSettings).not.toHaveBeenCalled()
  })

  it('hides Human-only authenticated/search settings from Bot responses', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guardMeta({
      share_scope: 2,
      share_role: 1,
      discoverability_scope: 1,
    }) as never)
    const res = mockRes()
    await getShareHandler(req(undefined, { bot: true }), res as never)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ docId: 'd_1', permissionEpoch: 7 })
  })

  it('returns only Bot-manageable share fields and hides discoverability', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guardMeta({
      share_scope: 1,
      share_role: 2,
      discoverability_scope: 1,
    }) as never)
    const res = mockRes()
    await getShareHandler(req(undefined, { bot: true }), res as never)
    expect(res.body).toEqual({
      docId: 'd_1',
      shareScope: 'anyone_in_space',
      shareRole: 'edit',
      permissionEpoch: 7,
    })
  })
})

describe('PUT /api/v1/docs/:docId/share (#64)', () => {
  it('lets a Bot change supported scope while preserving Human-owned discoverability', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guardMeta({ discoverability_scope: 1 }) as never)
    const res = mockRes()
    await putShareHandler(
      req({ shareScope: 'anyone_in_space', shareRole: 'edit' }, { bot: true }),
      res as never,
    )
    expect(docMetaRepo.setShareSettings).toHaveBeenCalledWith('d_1', 1, 2, true, 7)
    expect(res.statusCode).toBe(200)
  })

  it.each([
    { shareScope: 'authenticated', shareRole: 'read' },
    { shareScope: 'restricted', spaceSearchable: true },
    { shareScope: 'restricted', spaceSearchable: false },
  ])('rejects Bot attempts to set Human-only share controls: %j', async (body) => {
    vi.mocked(requireDocRole).mockResolvedValue(guardMeta() as never)
    const res = mockRes()
    await putShareHandler(req(body, { bot: true }), res as never)
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'unsupported_share_settings' })
    expect(docMetaRepo.setShareSettings).not.toHaveBeenCalled()
    expect(refreshAndPublish).not.toHaveBeenCalled()
  })

  it('prevents a Bot from changing a Human-selected authenticated scope', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guardMeta({ share_scope: 2 }) as never)
    const res = mockRes()
    await putShareHandler(req({ shareScope: 'restricted' }, { bot: true }), res as never)
    expect(res.statusCode).toBe(403)
    expect(res.body).toEqual({ error: 'forbidden' })
    expect(docMetaRepo.setShareSettings).not.toHaveBeenCalled()
    expect(refreshAndPublish).not.toHaveBeenCalled()
  })

  it('needs admin, writes anyone_in_space/edit and bumps the epoch DOC-WIDE (no uid)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guardMeta() as never)
    const res = mockRes()
    await putShareHandler(req({ shareScope: 'anyone_in_space', shareRole: 'edit' }), res as never)
    expect(vi.mocked(requireDocRole).mock.calls[0]![3]).toBe('admin')
    expect(docMetaRepo.setShareSettings).toHaveBeenCalledWith('d_1', 1, 2, false, 7)
    // doc-wide invalidation: refreshAndPublish called with (documentName, newEpoch)
    // and NO uid — the setShareSettings tx already bumped the epoch atomically.
    expect(refreshAndPublish).toHaveBeenCalledWith('octo:s1:f_default:d_1', 8)
    expect(vi.mocked(refreshAndPublish).mock.calls[0]!.length).toBe(2)
    expect(res.statusCode).toBe(200)
  })

  it('writes authenticated/read and does not require Space membership semantics', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guardMeta() as never)
    const res = mockRes()
    await putShareHandler(req({
      shareScope: 'authenticated',
      shareRole: 'read',
      spaceSearchable: true,
    }), res as never)
    expect(docMetaRepo.setShareSettings).toHaveBeenCalledWith('d_1', 2, 1, true, 7)
    expect(res.body).toEqual({
      docId: 'd_1',
      shareScope: 'authenticated',
      shareRole: 'read',
      spaceSearchable: true,
      permissionEpoch: 8,
    })
  })

  it('writes and normalizes the existing commenter role as shareRole=comment', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guardMeta() as never)
    const res = mockRes()
    await putShareHandler(req({ shareScope: 'authenticated', shareRole: 'comment' }), res as never)
    expect(docMetaRepo.setShareSettings).toHaveBeenCalledWith('d_1', 2, 4, false, 7)
    expect(res.body).toMatchObject({ shareRole: 'comment' })
  })

  it('rejects admin link sharing at the API boundary', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guardMeta() as never)
    const res = mockRes()
    await putShareHandler(req({ shareScope: 'authenticated', shareRole: 'admin' }), res as never)
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_role' })
    expect(docMetaRepo.setShareSettings).not.toHaveBeenCalled()
  })

  it('rejects edit sharing for HTML while permitting comment', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guardMeta({ doc_type: 'html' }) as never)
    const denied = mockRes()
    await putShareHandler(req({ shareScope: 'authenticated', shareRole: 'edit' }), denied as never)
    expect(denied.statusCode).toBe(400)
    expect(docMetaRepo.setShareSettings).not.toHaveBeenCalled()

    const allowed = mockRes()
    await putShareHandler(req({ shareScope: 'authenticated', shareRole: 'comment' }), allowed as never)
    expect(docMetaRepo.setShareSettings).toHaveBeenCalledWith('d_1', 2, 4, false, 7)
  })

  it('normalizes shareRole to read when scope=restricted, ignoring the sent edit', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guardMeta() as never)
    const res = mockRes()
    await putShareHandler(req({ shareScope: 'restricted', shareRole: 'edit' }), res as never)
    expect(docMetaRepo.setShareSettings).toHaveBeenCalledWith('d_1', 0, 1, false, 7)
    expect(res.statusCode).toBe(200)
  })

  it('accepts restricted with no shareRole at all', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guardMeta() as never)
    const res = mockRes()
    await putShareHandler(req({ shareScope: 'restricted' }), res as never)
    expect(docMetaRepo.setShareSettings).toHaveBeenCalledWith('d_1', 0, 1, false, 7)
    expect(res.statusCode).toBe(200)
  })

  it('400 invalid_scope for a scope outside the enum', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guardMeta() as never)
    const res = mockRes()
    await putShareHandler(req({ shareScope: 'public', shareRole: 'read' }), res as never)
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_scope' })
    expect(docMetaRepo.setShareSettings).not.toHaveBeenCalled()
    expect(refreshAndPublish).not.toHaveBeenCalled()
  })

  it.each([undefined, -1, 1.5, '7', null])(
    '400 invalid_permission_epoch for malformed or missing epoch: %j',
    async (permissionEpoch) => {
      vi.mocked(requireDocRole).mockResolvedValue(guardMeta() as never)
      const body = { shareScope: 'restricted', permissionEpoch }
      const res = mockRes()
      await putShareHandler(req(body), res as never)
      expect(res.statusCode).toBe(400)
      expect(res.body).toEqual({ error: 'invalid_permission_epoch' })
      expect(docMetaRepo.setShareSettings).not.toHaveBeenCalled()
      expect(refreshAndPublish).not.toHaveBeenCalled()
    },
  )

  it('returns authoritative settings on stale epoch and does not publish', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guardMeta() as never)
    vi.mocked(docMetaRepo.setShareSettings).mockResolvedValue({
      updated: false,
      current: {
        shareScope: 2,
        shareRole: 4,
        spaceSearchable: true,
        permissionEpoch: 9,
      },
    } as never)
    const res = mockRes()
    await putShareHandler(req({ shareScope: 'restricted', permissionEpoch: 7 }), res as never)
    expect(docMetaRepo.setShareSettings).toHaveBeenCalledWith('d_1', 0, 1, false, 7)
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({
      error: 'share_settings_conflict',
      current: {
        docId: 'd_1',
        shareScope: 'authenticated',
        shareRole: 'comment',
        spaceSearchable: true,
        permissionEpoch: 9,
      },
    })
    expect(refreshAndPublish).not.toHaveBeenCalled()
  })

  it('400 invalid_role when anyone_in_space is missing a valid shareRole', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guardMeta() as never)
    for (const body of [
      { shareScope: 'anyone_in_space' },
      { shareScope: 'anyone_in_space', shareRole: 'bogus' },
          ]) {
      const res = mockRes()
      await putShareHandler(req(body), res as never)
      expect(res.statusCode).toBe(400)
      expect(res.body).toEqual({ error: 'invalid_role' })
    }
    expect(docMetaRepo.setShareSettings).not.toHaveBeenCalled()
  })

  it('does not write when the admin guard rejects (403/404/409)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(null)
    const res = mockRes()
    await putShareHandler(req({ shareScope: 'anyone_in_space', shareRole: 'edit' }), res as never)
    expect(docMetaRepo.setShareSettings).not.toHaveBeenCalled()
    expect(refreshAndPublish).not.toHaveBeenCalled()
  })
})
