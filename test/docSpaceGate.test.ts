import { describe, it, expect, vi, beforeEach } from 'vitest'

// Unit tests for the single-doc space-scoping gate (remove-sp §6). requireDocRole
// now reads the explicit per-mount policy from `req.docSpaceScope`, NOT a spaceId
// argument:
//   - Bot ({ mode: 'bot', spaceId }): a cross-space hit 404s BEFORE the role
//     check, so a doc in another space is indistinguishable from a missing one.
//   - Human ({ mode: 'human' }): locate by docId ALONE — no cross-space gate, so
//     a cross-Space direct member / owner resolves exactly as if `sp` were right.
//   - Unset scope: fail CLOSED (bot with empty space) so a wiring bug 404s rather
//     than silently opening the human locate.
// We mock the repo and resolveRole so the gate logic is exercised in isolation;
// roleAtLeast + resolveEffectiveRole run for real (restricted docs short-circuit
// to the direct role with zero IO).
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: {
    getByDocId: vi.fn(),
  },
}))
vi.mock('../src/permission/resolveRole.js', () => ({
  resolveRole: vi.fn(),
}))

import { requireDocRole } from '../src/api/guard.js'
import type { DocSpaceScope } from '../src/api/middleware/docSpaceScope.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { resolveRole } from '../src/permission/resolveRole.js'
import { setOctoIdentity } from '../src/auth/octoIdentity.js'

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

/** Minimal Express-like req carrying the per-mount doc space-scoping policy. */
function mockReq(opts: {
  uid?: string
  scope?: DocSpaceScope
  octoToken?: string
  viewerSpaceId?: string
  verifiedViewerSpaceId?: string
} = {}) {
  return {
    uid: opts.uid ?? 'u_1',
    octoToken: opts.octoToken ?? 'session-token',
    principalSpaceId: opts.scope?.mode === 'bot' ? opts.scope.spaceId : 's1',
    docSpaceScope: opts.scope,
    ...(opts.scope?.mode === 'human'
      ? {
          viewerSpaceId: opts.viewerSpaceId ?? 's1',
          verifiedViewerSpaceId: opts.verifiedViewerSpaceId ?? 's1',
        }
      : {}),
  }
}

/** A live (status===1) doc_meta row in space 's1'. */
function metaRow(over: Record<string, unknown> = {}) {
  return {
    doc_id: 'd_1',
    document_name: 'octo:s1:f_default:d_1',
    title: 'My Doc',
    owner_id: 'u_owner',
    space_id: 's1',
    folder_id: 'f_default',
    doc_type: 'doc',
    status: 1,
    permission_epoch: 7,
    share_scope: 0,
    share_role: 0,
    created_at: new Date(0),
    updated_at: new Date(1000),
    created_by: 'u_owner',
    updated_by: 'u_owner',
    ...over,
  }
}

beforeEach(() => {
  vi.mocked(docMetaRepo.getByDocId).mockReset()
  vi.mocked(resolveRole).mockReset()
  setOctoIdentity({
    verifyToken: async () => null,
    getUser: async () => null,
    getUsers: async () => [],
    isSpaceMember: async () => true,
  })
})

describe('requireDocRole — Bot mount cross-space gate (§6)', () => {
  const botScope: DocSpaceScope = { mode: 'bot', spaceId: 's2' }

  it('404s a cross-space doc with no exact principal grant', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(metaRow({ space_id: 's1' }) as never)
    const res = mockRes()

    const guard = await requireDocRole(mockReq({ uid: 'u_1', scope: botScope }) as never, res as never, 'd_1', 'reader')

    expect(guard).toBeNull()
    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
    expect(vi.mocked(resolveRole)).toHaveBeenCalledWith('u_1', 'd_1', 's2')
  })

  it('allows a cross-space Bot only through its exact principal-qualified direct grant', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(metaRow({ space_id: 's1' }) as never)
    vi.mocked(resolveRole).mockResolvedValue('writer' as never)
    const res = mockRes()

    const guard = await requireDocRole(mockReq({ uid: 'bot_b', scope: botScope }) as never, res as never, 'd_1', 'reader')

    expect(guard?.role).toBe('writer')
    expect(res.statusCode).toBe(0)
    expect(vi.mocked(resolveRole)).toHaveBeenCalledWith('bot_b', 'd_1', 's2')
  })

  it('keeps non-leaking 404 when a cross-space direct grant is below the required role', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(metaRow({ space_id: 's1' }) as never)
    vi.mocked(resolveRole).mockResolvedValue('reader' as never)
    const res = mockRes()
    const guard = await requireDocRole(mockReq({ uid: 'bot_b', scope: botScope }) as never, res as never, 'd_1', 'writer')
    expect(guard).toBeNull()
    expect(res.statusCode).toBe(404)
  })

  it('404s a cross-space archived doc without a grant', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(metaRow({ space_id: 's1', status: 2 }) as never)
    vi.mocked(resolveRole).mockResolvedValue('none' as never)
    const res = mockRes()

    const guard = await requireDocRole(mockReq({ uid: 'u_1', scope: botScope }) as never, res as never, 'd_1', 'reader')

    expect(guard).toBeNull()
    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
  })

  it('lets a same-space bot request through and resolves the role as before', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(metaRow({ space_id: 's1' }) as never)
    vi.mocked(resolveRole).mockResolvedValue('writer' as never)
    const res = mockRes()

    const guard = await requireDocRole(
      mockReq({ uid: 'u_1', scope: { mode: 'bot', spaceId: 's1' } }) as never,
      res as never,
      'd_1',
      'reader',
    )

    expect(res.statusCode).toBe(0)
    expect(guard).not.toBeNull()
    expect(guard!.role).toBe('writer')
    expect(vi.mocked(resolveRole)).toHaveBeenCalledWith('u_1', 'd_1', 's1')
  })
})

describe('requireDocRole — Human mount locates by docId (§6)', () => {
  const humanScope: DocSpaceScope = { mode: 'human' }

  it('revalidates when the request-local verified Space does not match the candidate', async () => {
    const isSpaceMember = vi.fn(async () => true)
    setOctoIdentity({
      verifyToken: async () => null,
      getUser: async () => null,
      getUsers: async () => [],
      isSpaceMember,
    })
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(metaRow() as never)
    vi.mocked(resolveRole).mockResolvedValue('writer' as never)
    const res = mockRes()

    const guard = await requireDocRole(
      mockReq({ uid: 'u_1', scope: humanScope, viewerSpaceId: 's1', verifiedViewerSpaceId: 'stale-space' }) as never,
      res as never,
      'd_1',
      'reader',
    )

    expect(guard?.role).toBe('writer')
    expect(isSpaceMember).toHaveBeenCalledWith('u_1', 's1', 'session-token')
  })

  it('allows a direct collaborator from a different verified current Space', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(metaRow({ space_id: 's_other' }) as never)
    vi.mocked(resolveRole).mockResolvedValue('writer' as never)
    const res = mockRes()
    const guard = await requireDocRole(mockReq({ uid: 'u_1', scope: humanScope }) as never, res as never, 'd_1', 'reader')
    expect(guard?.role).toBe('writer')
    expect(res.statusCode).toBe(0)
    expect(vi.mocked(resolveRole)).toHaveBeenCalled()
  })

  it('preserves the existing 404 for a missing/deleted doc', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(null as never)
    const res = mockRes()

    const guard = await requireDocRole(mockReq({ uid: 'u_1', scope: humanScope }) as never, res as never, 'd_1', 'reader')

    expect(guard).toBeNull()
    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
    expect(vi.mocked(resolveRole)).not.toHaveBeenCalled()
  })

  it('returns 409 for an archived doc only after the role gate passes', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(metaRow({ status: 2 }) as never)
    vi.mocked(resolveRole).mockResolvedValue('reader' as never)
    const res = mockRes()

    const guard = await requireDocRole(mockReq({ uid: 'u_1', scope: humanScope }) as never, res as never, 'd_1', 'reader')

    expect(guard).toBeNull()
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ error: 'conflict' })
  })

  it('does not leak archived state to a caller with no role', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(metaRow({ status: 2 }) as never)
    vi.mocked(resolveRole).mockResolvedValue('none' as never)
    const res = mockRes()

    const guard = await requireDocRole(mockReq({ uid: 'u_none', scope: humanScope }) as never, res as never, 'd_1', 'reader')

    expect(guard).toBeNull()
    expect(res.statusCode).toBe(403)
    expect(res.body).toEqual({ error: 'forbidden' })
  })

  it('preserves the existing 403 when the role is insufficient', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(metaRow() as never)
    vi.mocked(resolveRole).mockResolvedValue('reader' as never)
    const res = mockRes()

    const guard = await requireDocRole(mockReq({ uid: 'u_1', scope: humanScope }) as never, res as never, 'd_1', 'admin')

    expect(guard).toBeNull()
    expect(res.statusCode).toBe(403)
    expect(res.body).toEqual({ error: 'forbidden' })
  })
})

describe('requireDocRole — fail-closed when the mount set no policy', () => {
  it('treats an unset scope as bot-with-empty-space, so any real doc 404s (wiring bug is safe)', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(metaRow({ space_id: 's1' }) as never)
    const res = mockRes()

    const guard = await requireDocRole(mockReq({ uid: 'u_1', scope: undefined }) as never, res as never, 'd_1', 'reader')

    expect(guard).toBeNull()
    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
    expect(vi.mocked(resolveRole)).not.toHaveBeenCalled()
  })
})
