import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// Integration test for the bot-facing mount (§ v4.3): a real ephemeral Express
// server built from createApp(), exercised over HTTP. The doc-list repo is
// mocked so no MySQL is needed; everything up to and including the metadata
// handler's space scoping runs for real.
//
// It proves the wiring the design requires:
//   - /v1/bot/docs is guarded by verifyBot (bad token => 401),
//   - the bot path needs NO X-Space-Id header — the space is server-injected,
//   - a client-supplied X-Space-Id on the bot path is ignored (anti-spoof),
//   - the human /api/v1/docs chain is unchanged (still hard-400s without a space).
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: {
    listForUser: vi.fn(async () => ({ total: 0, items: [] })),
    getByDocId: vi.fn(),
    setShareSettings: vi.fn(async () => ({
      updated: true,
      settings: { shareScope: 1, shareRole: 2, spaceSearchable: false, permissionEpoch: 2 },
    })),
  },
  DocOwnershipError: class DocOwnershipError extends Error {},
}))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  docMemberRepo: {
    upsertDirect: vi.fn(async () => {}),
    upsertDirectWithNotification: vi.fn(async () => ({ created: true })),
    updateExistingDirect: vi.fn(async () => true),
    removePrincipalExact: vi.fn(async () => ({
      changed: true,
      removedUids: ['u_target'],
      newEpoch: 2,
    })),
    removePrincipalWithBots: vi.fn(),
  },
}))
vi.mock('../src/permission/epoch.js', () => ({
  bumpEpoch: vi.fn(async () => 2),
  refreshAndPublish: vi.fn(async () => {}),
}))
vi.mock('../src/permission/resolveRole.js', () => ({
  resolveRole: vi.fn(async () => 'reader'),
  resolveDocMetaByName: vi.fn(),
}))

import { createApp } from '../src/api/app.js'
import { setOctoIdentity, type OctoIdentity, type OctoUser } from '../src/auth/octoIdentity.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { resolveRole } from '../src/permission/resolveRole.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import { bumpEpoch } from '../src/permission/epoch.js'
import { config } from '../src/config/env.js'

const listForUser = vi.mocked(docMetaRepo.listForUser)
const getByDocId = vi.mocked(docMetaRepo.getByDocId)
const setShareSettings = vi.mocked(docMetaRepo.setShareSettings)
const resolveDocRole = vi.mocked(resolveRole)
const upsertDirect = vi.mocked(docMemberRepo.upsertDirect)
const upsertDirectWithNotification = vi.mocked(docMemberRepo.upsertDirectWithNotification)
const updateExistingDirect = vi.mocked(docMemberRepo.updateExistingDirect)
const bumpEpochMock = vi.mocked(bumpEpoch)
const removePrincipalExact = vi.mocked(docMemberRepo.removePrincipalExact)
const removePrincipalWithBots = vi.mocked(docMemberRepo.removePrincipalWithBots)
const originalServiceToken = config.octoIdentity.serviceToken

const docMeta = {
  doc_id: 'd_bot',
  document_name: 'octo:s_real:f_default:d_bot',
  title: 'Bot doc',
  owner_id: 'u_owner',
  owner_space_id: 's_real',
  space_id: 's_real',
  folder_id: 'f_default',
  doc_type: 'doc',
  status: 1,
  permission_epoch: 1,
  share_scope: 0,
  share_role: 0,
  created_at: new Date(0),
  updated_at: new Date(0),
}

/** Identity stub: individual tests supply verifyToken / verifyBot behavior. */
function stub(overrides: Partial<OctoIdentity>): OctoIdentity {
  return {
    verifyToken: async () => null,
    verifyBot: async () => null,
    getUser: async (): Promise<OctoUser | null> => null,
    lookupSpacePrincipalAsBot: async () => ({ status: 'not_found' }),
    getUsers: async (): Promise<OctoUser[]> => [],
    isSpaceMember: async () => false,
    ...overrides,
  }
}

let server: Server
let base: string

beforeAll(async () => {
  const app = createApp()
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  base = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  config.octoIdentity.serviceToken = originalServiceToken
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
})

beforeEach(() => {
  listForUser.mockClear()
  listForUser.mockResolvedValue({ total: 0, items: [] })
  getByDocId.mockReset().mockResolvedValue(docMeta as never)
  setShareSettings.mockReset().mockResolvedValue({
    updated: true,
    settings: { shareScope: 1, shareRole: 2, spaceSearchable: false, permissionEpoch: 2 },
  })
  resolveDocRole.mockReset().mockResolvedValue('reader')
  upsertDirect.mockClear()
  upsertDirectWithNotification.mockReset().mockResolvedValue({ created: true })
  updateExistingDirect.mockClear()
  bumpEpochMock.mockClear()
  removePrincipalExact.mockClear()
  removePrincipalExact.mockResolvedValue({
    changed: true,
    removedUids: ['u_target'],
    newEpoch: 2,
  })
  removePrincipalWithBots.mockReset()
  removePrincipalWithBots.mockResolvedValue({
    changed: true,
    removedUids: ['u_target'],
    newEpoch: 2,
  })
  config.octoIdentity.serviceToken = ''
})

describe('bot mount /v1/bot/docs (§ v4.3)', () => {
  it('rejects the bot path with 401 when the bot token is invalid', async () => {
    setOctoIdentity(stub({ verifyBot: async () => null }))
    const res = await fetch(`${base}/v1/bot/docs`, { headers: { authorization: 'Bearer bad' } })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
    expect(listForUser).not.toHaveBeenCalled()
  })

  it('needs no X-Space-Id: the space is server-injected and reaches the handler', async () => {
    setOctoIdentity(stub({ verifyBot: async () => ({ uid: 'bot_1', spaceId: 's_bot' }) }))
    const res = await fetch(`${base}/v1/bot/docs`, { headers: { authorization: 'Bearer ok' } })
    expect(res.status).toBe(200) // NOT 400 space_required
    expect(listForUser).toHaveBeenCalledTimes(1)
    expect(listForUser.mock.calls[0]![0]).toMatchObject({ uid: 'bot_1', spaceId: 's_bot' })
  })

  it('ignores a client-supplied X-Space-Id on the bot path (anti-spoof)', async () => {
    setOctoIdentity(stub({ verifyBot: async () => ({ uid: 'bot_1', spaceId: 's_real' }) }))
    const res = await fetch(`${base}/v1/bot/docs`, {
      headers: { authorization: 'Bearer ok', 'X-Space-Id': 's_spoofed' },
    })
    expect(res.status).toBe(200)
    expect(listForUser.mock.calls[0]![0]).toMatchObject({ spaceId: 's_real' })
  })

  it('uses the server-resolved Space for a single doc and ignores a spoofed header', async () => {
    setOctoIdentity(stub({ verifyBot: async () => ({ uid: 'bot_1', spaceId: 's_real' }) }))
    const res = await fetch(`${base}/v1/bot/docs/d_bot`, {
      headers: { authorization: 'Bearer ok', 'X-Space-Id': 's_spoofed' },
    })
    expect(res.status).toBe(200)
    expect(resolveDocRole).toHaveBeenCalledWith('bot_1', 'd_bot', 's_real')
  })

  it('hides Human-only share fields from the real Bot metadata response', async () => {
    setOctoIdentity(stub({ verifyBot: async () => ({ uid: 'bot_1', spaceId: 's_real' }) }))
    getByDocId.mockResolvedValue({
      ...docMeta,
      share_scope: 2,
      discoverability_scope: 1,
    } as never)

    const res = await fetch(`${base}/v1/bot/docs/d_bot`, {
      headers: { authorization: 'Bearer ok' },
    })

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body).not.toHaveProperty('shareScope')
    expect(body).not.toHaveProperty('shareRole')
    expect(body).not.toHaveProperty('spaceSearchable')
    expect(body.permissionEpoch).toBe(1)
  })

  it('allows a server-resolved foreign-Space Bot with an exact direct grant', async () => {
    setOctoIdentity(stub({ verifyBot: async () => ({ uid: 'bot_1', spaceId: 's_foreign' }) }))
    resolveDocRole.mockResolvedValue('reader')
    const res = await fetch(`${base}/v1/bot/docs/d_bot`, {
      headers: { authorization: 'Bearer ok', 'X-Space-Id': 's_real' },
    })
    expect(res.status).toBe(200)
    expect(resolveDocRole).toHaveBeenCalledWith('bot_1', 'd_bot', 's_foreign')
  })

  it('keeps a non-leaking 404 for a foreign-Space Bot without an exact grant', async () => {
    setOctoIdentity(stub({ verifyBot: async () => ({ uid: 'bot_1', spaceId: 's_foreign' }) }))
    resolveDocRole.mockResolvedValue('none')
    const res = await fetch(`${base}/v1/bot/docs/d_bot`, { headers: { authorization: 'Bearer ok' } })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
  })

  it('rejects Human-only sharing fields on the real Bot mount before any write', async () => {
    setOctoIdentity(stub({ verifyBot: async () => ({ uid: 'bot_1', spaceId: 's_real' }) }))
    resolveDocRole.mockResolvedValue('admin')

    for (const body of [
      { shareScope: 'authenticated', shareRole: 'read', permissionEpoch: 1 },
      { shareScope: 'restricted', spaceSearchable: true, permissionEpoch: 1 },
    ]) {
      const res = await fetch(`${base}/v1/bot/docs/d_bot/share`, {
        method: 'PUT',
        headers: { authorization: 'Bearer ok', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'unsupported_share_settings' })
    }
    expect(setShareSettings).not.toHaveBeenCalled()
  })

  it('keeps supported Bot sharing writes and preserves discoverability', async () => {
    setOctoIdentity(stub({ verifyBot: async () => ({ uid: 'bot_1', spaceId: 's_real' }) }))
    resolveDocRole.mockResolvedValue('admin')
    getByDocId.mockResolvedValue({ ...docMeta, discoverability_scope: 1 } as never)

    const res = await fetch(`${base}/v1/bot/docs/d_bot/share`, {
      method: 'PUT',
      headers: { authorization: 'Bearer ok', 'content-type': 'application/json' },
      body: JSON.stringify({ shareScope: 'anyone_in_space', shareRole: 'edit', permissionEpoch: 1 }),
    })

    expect(res.status).toBe(200)
    expect(setShareSettings).toHaveBeenCalledWith('d_bot', 1, 2, true, 1)
    const body = await res.json() as Record<string, unknown>
    expect(body).toMatchObject({
      docId: 'd_bot', shareScope: 'anyone_in_space', shareRole: 'edit', permissionEpoch: 2,
    })
    expect(body).not.toHaveProperty('spaceSearchable')
  })

  it('hides Human-only settings from a Bot conflict response', async () => {
    setOctoIdentity(stub({ verifyBot: async () => ({ uid: 'bot_1', spaceId: 's_real' }) }))
    resolveDocRole.mockResolvedValue('admin')
    setShareSettings.mockResolvedValue({
      updated: false,
      current: { shareScope: 1, shareRole: 2, spaceSearchable: true, permissionEpoch: 9 },
    } as never)

    const res = await fetch(`${base}/v1/bot/docs/d_bot/share`, {
      method: 'PUT',
      headers: { authorization: 'Bearer ok', 'content-type': 'application/json' },
      body: JSON.stringify({ shareScope: 'restricted', permissionEpoch: 1 }),
    })

    expect(res.status).toBe(409)
    const body = await res.json() as { current: Record<string, unknown> }
    expect(body.current).toEqual({
      docId: 'd_bot', shareScope: 'anyone_in_space', shareRole: 'edit', permissionEpoch: 9,
    })
    expect(body.current).not.toHaveProperty('spaceSearchable')
  })

  it('hides an authenticated scope from a Bot conflict response', async () => {
    setOctoIdentity(stub({ verifyBot: async () => ({ uid: 'bot_1', spaceId: 's_real' }) }))
    resolveDocRole.mockResolvedValue('admin')
    setShareSettings.mockResolvedValue({
      updated: false,
      current: { shareScope: 2, shareRole: 1, spaceSearchable: true, permissionEpoch: 9 },
    } as never)

    const res = await fetch(`${base}/v1/bot/docs/d_bot/share`, {
      method: 'PUT',
      headers: { authorization: 'Bearer ok', 'content-type': 'application/json' },
      body: JSON.stringify({ shareScope: 'restricted', permissionEpoch: 1 }),
    })

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: 'share_settings_conflict',
      current: { docId: 'd_bot', permissionEpoch: 9 },
    })
  })

  it('defaults an omitted principalSpaceId to the bearer Space, not the document Home Space', async () => {
    const lookupSpacePrincipalAsBot = vi.fn(async () => ({ status: 'eligible' as const, principalType: 'human' as const }))
    setOctoIdentity(stub({
      verifyBot: async () => ({ uid: 'bot_1', spaceId: 's_real' }),
      lookupSpacePrincipalAsBot,
    }))
    resolveDocRole.mockResolvedValue('admin')

    const res = await fetch(`${base}/v1/bot/docs/d_bot/members`, {
      method: 'PUT',
      headers: { authorization: 'Bearer bot-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ uid: 'u_target', role: 'reader' }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, created: true, notified: true })
    expect(lookupSpacePrincipalAsBot).toHaveBeenCalledWith('u_target', 's_real', 'bot-secret')
    expect(upsertDirectWithNotification).toHaveBeenCalledWith(expect.objectContaining({
      docId: 'd_bot', uid: 'u_target', principalSpaceId: 's_real', grantedBy: 'bot_1', notifyRecipient: true,
    }))
  })

  it('keeps a Bot recipient silent while preserving the direct grant', async () => {
    setOctoIdentity(stub({
      verifyBot: async () => ({ uid: 'bot_1', spaceId: 's_real' }),
      lookupSpacePrincipalAsBot: async () => ({ status: 'eligible', principalType: 'user_bot' }),
    }))
    resolveDocRole.mockResolvedValue('admin')
    const res = await fetch(`${base}/v1/bot/docs/d_bot/members`, {
      method: 'PUT', headers: { authorization: 'Bearer bot-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ uid: 'bot_target', role: 'writer' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(upsertDirectWithNotification).not.toHaveBeenCalled()
    expect(upsertDirect).toHaveBeenCalledWith(expect.objectContaining({ uid: 'bot_target' }))
  })

  it('does not notify again when a Bot updates an existing Human grant', async () => {
    setOctoIdentity(stub({
      verifyBot: async () => ({ uid: 'bot_1', spaceId: 's_real' }),
      lookupSpacePrincipalAsBot: async () => ({ status: 'eligible', principalType: 'human' }),
    }))
    resolveDocRole.mockResolvedValue('admin')
    upsertDirectWithNotification.mockResolvedValueOnce({ created: false })
    const res = await fetch(`${base}/v1/bot/docs/d_bot/members`, {
      method: 'PUT', headers: { authorization: 'Bearer bot-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ uid: 'u_target', role: 'reader' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, created: false, notified: false })
    expect(upsertDirect).not.toHaveBeenCalled()
  })

  it('updates an existing explicitly selected foreign-Space row without revalidating current eligibility', async () => {
    const lookupSpacePrincipalAsBot = vi.fn(async () => ({ status: 'eligible' as const, principalType: 'human' as const }))
    setOctoIdentity(stub({
      verifyBot: async () => ({ uid: 'bot_1', spaceId: 's_bot' }),
      lookupSpacePrincipalAsBot,
    }))
    resolveDocRole.mockResolvedValue('admin')
    updateExistingDirect.mockResolvedValue(true)

    const res = await fetch(`${base}/v1/bot/docs/d_bot/members`, {
      method: 'PUT',
      headers: { authorization: 'Bearer bot-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ uid: 'same_uid', principalSpaceId: 's_other', role: 'writer' }),
    })

    expect(res.status).toBe(200)
    expect(lookupSpacePrincipalAsBot).not.toHaveBeenCalled()
    expect(updateExistingDirect).toHaveBeenCalledWith({
      docId: 'd_bot', uid: 'same_uid', principalSpaceId: 's_other', roleNum: 2, grantedBy: 'bot_1',
    })
    expect(upsertDirect).not.toHaveBeenCalled()
    expect(bumpEpochMock).toHaveBeenCalledTimes(1)
  })

  it('cannot mint a missing explicitly selected foreign-Space row without directory lookup', async () => {
    const lookupSpacePrincipalAsBot = vi.fn(async () => ({ status: 'eligible' as const, principalType: 'human' as const }))
    setOctoIdentity(stub({
      verifyBot: async () => ({ uid: 'bot_1', spaceId: 's_bot' }),
      lookupSpacePrincipalAsBot,
    }))
    resolveDocRole.mockResolvedValue('admin')
    updateExistingDirect.mockResolvedValue(false)

    const res = await fetch(`${base}/v1/bot/docs/d_bot/members`, {
      method: 'PUT',
      headers: { authorization: 'Bearer bot-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ uid: 'same_uid', principalSpaceId: 's_other', role: 'writer' }),
    })

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'member_not_found' })
    expect(lookupSpacePrincipalAsBot).not.toHaveBeenCalled()
    expect(upsertDirect).not.toHaveBeenCalled()
    expect(bumpEpochMock).not.toHaveBeenCalled()
  })

  it('upserts its own Space on a foreign-Home document after exact lookup', async () => {
    const lookupSpacePrincipalAsBot = vi.fn(async () => ({ status: 'eligible' as const, principalType: 'human' as const }))
    setOctoIdentity(stub({
      verifyBot: async () => ({ uid: 'bot_1', spaceId: 's_bot' }),
      lookupSpacePrincipalAsBot,
    }))
    resolveDocRole.mockResolvedValue('admin')

    const res = await fetch(`${base}/v1/bot/docs/d_bot/members`, {
      method: 'PUT',
      headers: { authorization: 'Bearer bot-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ uid: 'u_target', role: 'reader' }),
    })

    expect(res.status).toBe(200)
    expect(lookupSpacePrincipalAsBot).toHaveBeenCalledWith('u_target', 's_bot', 'bot-secret')
    expect(upsertDirectWithNotification).toHaveBeenCalledWith(expect.objectContaining({
      uid: 'u_target', principalSpaceId: 's_bot',
    }))
    expect(updateExistingDirect).not.toHaveBeenCalled()
  })

  it.each([
    ['not_found', 404, 'principal_not_in_space'],
    ['not_eligible', 404, 'principal_not_in_space'],
    ['forbidden', 403, 'principal_lookup_forbidden'],
    ['unavailable', 503, 'identity_directory_unavailable'],
  ] as const)('maps exact principal %s to %i and performs zero writes', async (status, httpStatus, error) => {
    setOctoIdentity(stub({
      verifyBot: async () => ({ uid: 'bot_1', spaceId: 's_real' }),
      lookupSpacePrincipalAsBot: async () => ({ status }),
    }))
    resolveDocRole.mockResolvedValue('admin')
    const res = await fetch(`${base}/v1/bot/docs/d_bot/members`, {
      method: 'PUT',
      headers: { authorization: 'Bearer bot-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ uid: 'u_target', role: 'writer' }),
    })
    expect(res.status).toBe(httpStatus)
    expect(await res.json()).toEqual({ error })
    expect(upsertDirect).not.toHaveBeenCalled()
    expect(updateExistingDirect).not.toHaveBeenCalled()
    expect(bumpEpochMock).not.toHaveBeenCalled()
  })

  it.each(['not_eligible', 'unavailable'] as const)(
    'rejects %s on a Bot own-Space upsert with zero writes or epoch bump',
    async (status) => {
      setOctoIdentity(stub({
        verifyBot: async () => ({ uid: 'bot_1', spaceId: 's_real' }),
        lookupSpacePrincipalAsBot: async () => ({ status }),
      }))
      resolveDocRole.mockResolvedValue('admin')
      const res = await fetch(`${base}/v1/bot/docs/d_bot/members`, {
        method: 'PUT',
        headers: { authorization: 'Bearer bot-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ uid: 'u_target', role: 'writer' }),
      })
      expect(res.status).toBe(status === 'not_eligible' ? 404 : 503)
      expect(upsertDirect).not.toHaveBeenCalled()
      expect(updateExistingDirect).not.toHaveBeenCalled()
      expect(bumpEpochMock).not.toHaveBeenCalled()
    },
  )

  it('requires principalSpaceId for delete before any mutation', async () => {
    setOctoIdentity(stub({ verifyBot: async () => ({ uid: 'bot_1', spaceId: 's_real' }) }))
    resolveDocRole.mockResolvedValue('admin')

    const res = await fetch(`${base}/v1/bot/docs/d_bot/members/u_target`, {
      method: 'DELETE', headers: { authorization: 'Bearer bot-secret' },
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'principalSpaceId required' })
    expect(removePrincipalExact).not.toHaveBeenCalled()
  })

  it('returns an idempotent empty removal without publishing when no exact row exists', async () => {
    setOctoIdentity(stub({ verifyBot: async () => ({ uid: 'bot_1', spaceId: 's_real' }) }))
    resolveDocRole.mockResolvedValue('admin')
    removePrincipalExact.mockResolvedValue({ changed: false, removedUids: [] })

    const res = await fetch(`${base}/v1/bot/docs/d_bot/members/missing?principalSpaceId=s_real`, {
      method: 'DELETE', headers: { authorization: 'Bearer bot-secret' },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, removedUids: [] })
  })

  it('deletes exactly without directory lookup or service token', async () => {
    const spaceBots = vi.fn(async () => { throw new Error('must not be called') })
    setOctoIdentity(stub({
      verifyBot: async () => ({ uid: 'bot_1', spaceId: 's_real' }),
      spaceBots,
    }))
    resolveDocRole.mockResolvedValue('admin')

    const res = await fetch(`${base}/v1/bot/docs/d_bot/members/u_target?principalSpaceId=s_real`, {
      method: 'DELETE', headers: { authorization: 'Bearer bot-secret' },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, removedUids: ['u_target'] })
    expect(spaceBots).not.toHaveBeenCalled()
    expect(removePrincipalExact).toHaveBeenCalledWith({
      docId: 'd_bot', uid: 'u_target', principalSpaceId: 's_real',
    })
  })
})

describe('human mount /api/v1/docs stays unchanged', () => {
  it('still hard-400s space_required when X-Space-Id is missing', async () => {
    setOctoIdentity(stub({ verifyToken: async () => ({ uid: 'u_1' }) }))
    const res = await fetch(`${base}/api/v1/docs`, { headers: { token: 'user-tok' } })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'space_required' })
    expect(listForUser).not.toHaveBeenCalled()
  })

  it('scopes the list to the X-Space-Id header on the happy path', async () => {
    // A confirmed member of the queried space: isSpaceMember => true is what
    // opens the share_scope=anyone_in_space branch inside listForUser. The
    // stub's default `false` is the non-member case, covered below — which is
    // narrowed, not refused.
    setOctoIdentity(stub({ verifyToken: async () => ({ uid: 'u_1' }), isSpaceMember: async () => true }))
    const res = await fetch(`${base}/api/v1/docs`, {
      headers: { token: 'user-tok', 'X-Space-Id': 's_human' },
    })
    expect(res.status).toBe(200)
    expect(listForUser.mock.calls[0]![0]).toMatchObject({ uid: 'u_1', spaceId: 's_human' })
  })

  it('404s a claimed Space the caller is not a member of before any principal-qualified query', async () => {
    // X-Space-Id is only a candidate principal. Collection reads require active
    // membership before it can become req.principalSpaceId; otherwise a caller
    // could select another Space's principal with a spoofed header.
    setOctoIdentity(stub({ verifyToken: async () => ({ uid: 'u_1' }), isSpaceMember: async () => false }))
    const res = await fetch(`${base}/api/v1/docs`, {
      headers: { token: 'user-tok', 'X-Space-Id': 's_someone_elses' },
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
    expect(listForUser).not.toHaveBeenCalled()
  })

  it('continues using req.octoToken for mounted Human member-add directory validation', async () => {
    const spaceMembers = vi.fn(async () => [{ uid: 'u_target', isBot: false }])
    setOctoIdentity(stub({
      verifyToken: async () => ({ uid: 'u_admin' }),
      isSpaceMember: async () => true,
      spaceMembers,
      spaceBots: async () => [],
    }))
    resolveDocRole.mockResolvedValue('admin')

    const res = await fetch(`${base}/api/v1/docs/d_bot/members`, {
      method: 'PUT',
      headers: {
        token: 'human-session-token',
        'X-Space-Id': 's_real',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ uid: 'u_target', role: 'reader' }),
    })

    expect(res.status).toBe(200)
    expect(spaceMembers).toHaveBeenCalledWith('s_real', 'human-session-token')
    expect(upsertDirectWithNotification).toHaveBeenCalledWith({
      docId: 'd_bot',
      uid: 'u_target',
      principalSpaceId: 's_real',
      roleNum: 1,
      grantedBy: 'u_admin',
      notifyRecipient: true,
    })
    expect(upsertDirect).not.toHaveBeenCalled()
  })

  it('threads the Human session token into the member-delete identity lookup', async () => {
    config.octoIdentity.serviceToken = 'configured-service-token'
    const spaceBots = vi.fn(async () => [])
    setOctoIdentity(stub({
      verifyToken: async () => ({ uid: 'u_admin' }),
      isSpaceMember: async () => true,
      spaceBots,
    }))
    resolveDocRole.mockResolvedValue('admin')

    const res = await fetch(`${base}/api/v1/docs/d_bot/members/u_target?principalSpaceId=s_real`, {
      method: 'DELETE',
      headers: { token: 'human-session-token', 'X-Space-Id': 's_real' },
    })

    expect(res.status).toBe(200)
    expect(spaceBots).toHaveBeenCalledWith('s_real', 'human-session-token')
    expect(removePrincipalWithBots).toHaveBeenCalledWith({
      docId: 'd_bot', uid: 'u_target', principalSpaceId: 's_real', botUids: [],
    })
    expect(removePrincipalExact).not.toHaveBeenCalled()
  })

})
