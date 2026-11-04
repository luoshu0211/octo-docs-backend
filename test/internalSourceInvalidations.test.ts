import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { once } from 'node:events'
import { createApp } from '../src/api/app.js'
import { config } from '../src/config/env.js'
import { beginActiveAccessRegistration, registerActiveAccess, type ActiveAccessParticipant } from '../src/permission/activeAccess.js'
import type { CurrentAccess } from '../src/permission/resolveRole.js'
import { consumeLocalSourceInvalidationEcho } from '../src/permission/epoch.js'
import { recheckCurrentRoleCached } from '../src/permission/recheck.js'
interface DocMetaRepoModule {
  [name: string]: unknown
  docMetaRepo: Record<string, unknown>
}
interface EpochModule { [name: string]: unknown }
interface ResolveRoleModule { [name: string]: unknown }



const sourceNoticeMocks = vi.hoisted(() => ({
  getEpochsByDocIds: vi.fn(async (_docIds: readonly string[]) => [{
    doc_id: 'd_source_changed',
    document_name: 'octo:s1:f1:doc:d_source_changed',
    permission_epoch: 12,
    status: 1,
  }]),
  bumpEpoch: vi.fn(async (_docId: string) => 13),
  publishSourceInvalidation: vi.fn(async (
    _documentName: string, _docId: string, _principalSpaceId: string, _uid: string | undefined, _eventId: string,
  ) => undefined),
  recheckCurrentRole: vi.fn(async () => 'reader' as 'reader' | 'none'),
}))

vi.mock('../src/db/repos/docMetaRepo.js', async importOriginal => {
  const actual = await importOriginal<DocMetaRepoModule>()
  return {
    ...actual,
    docMetaRepo: {
      ...actual.docMetaRepo,
      getEpochsByDocIds: sourceNoticeMocks.getEpochsByDocIds,
      bumpEpoch: sourceNoticeMocks.bumpEpoch,
    },
  }
})

vi.mock('../src/permission/epoch.js', async importOriginal => {
  const actual = await importOriginal<EpochModule>()
  return { ...actual, publishSourceInvalidation: sourceNoticeMocks.publishSourceInvalidation }
})
vi.mock('../src/permission/resolveRole.js', async importOriginal => {
  const actual = await importOriginal<ResolveRoleModule>()
  return { ...actual, recheckCurrentRole: sourceNoticeMocks.recheckCurrentRole }
})

const originalDocsInboundToken = config.driveDerived.inboundToken

async function listen(): Promise<{ base: string; close: () => Promise<void> }> {
  const app = createApp({ surface: 'internal' })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing test listener')
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: async () => {
      const closed = once(server, 'close')
      server.close()
      await closed
    },
  }
}

beforeEach(() => {
  sourceNoticeMocks.getEpochsByDocIds.mockClear()
  sourceNoticeMocks.publishSourceInvalidation.mockClear()
  sourceNoticeMocks.bumpEpoch.mockClear()
  sourceNoticeMocks.recheckCurrentRole.mockReset().mockResolvedValue('reader')
})

afterEach(() => {
  const eventId = sourceNoticeMocks.publishSourceInvalidation.mock.calls[0]?.[4]
  if (typeof eventId === 'string') consumeLocalSourceInvalidationEcho(eventId)
  config.driveDerived.inboundToken = originalDocsInboundToken
})

describe('POST /internal/docs/source-invalidations', () => {

  it('rejects a source-change notice without the Docs internal credential', async () => {
    const token = 'octo59-internal-test-token'
    config.driveDerived.inboundToken = token
    const { base, close } = await listen()
    try {
      const response = await fetch(`${base}/internal/docs/source-invalidations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-token': 'wrong-token' },
        body: JSON.stringify({ doc_ids: ['d_source_changed'], principal_space_id: 's1' }),
      })
      expect(response.status).toBe(401)
    } finally {
      await close()
    }
  })
  it('accepts a source notice and revokes its active reader without changing the Docs epoch', async () => {
    const token = 'octo59-internal-test-token'
    config.driveDerived.inboundToken = token
    const state: CurrentAccess = {
      role: 'reader',
      permissionEpoch: 12,
      sourceRevision: `sha256:${'a'.repeat(64)}`,
      proofExpiresAt: performance.now() + 15_000,
      sourceConfirmed: true,
    }
    const reader = {
      freeze: vi.fn(),
      resume: vi.fn(),
      close: vi.fn(),
    } satisfies ActiveAccessParticipant
    const binding = {
      docId: 'd_source_changed',
      uid: 'u_source',
      principalSpaceId: 's1',
      documentName: 'octo:s1:f1:doc:d_source_changed',
    }
    const registration = beginActiveAccessRegistration(binding)
    const dispose = registerActiveAccess(binding, 12, state, async () => ({
      ...state,
      role: 'none',
      sourceRevision: `sha256:${'b'.repeat(64)}`,
    }), reader, registration)
    const { base, close } = await listen()
    try {
      const response = await fetch(`${base}/internal/docs/source-invalidations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-token': token },
        body: JSON.stringify({
          doc_ids: ['d_source_changed'],
          principal_space_id: 's1',
          uid: 'u_source',
        }),
      })
      expect(response.status).toBe(202)
      expect(await response.json()).toEqual({ accepted: true })
      await vi.waitFor(() => expect(reader.close).toHaveBeenCalledWith(4403, 'Forbidden'))
      expect(sourceNoticeMocks.publishSourceInvalidation).toHaveBeenCalledTimes(1)
      expect(sourceNoticeMocks.bumpEpoch).not.toHaveBeenCalled()
    } finally {
      dispose()
      await close()
    }
  })
  it('invalidates cached and in-flight same-epoch role rechecks on a source notice', async () => {
    const token = 'octo59-internal-test-token'
    config.driveDerived.inboundToken = token
    const documentName = 'octo:s1:f1:doc:d_source_changed'
    const cached = await recheckCurrentRoleCached(documentName, 'u_cached', 's1', false, 12)
    expect(cached).toBe('reader')

    let releaseOld!: (role: 'reader' | 'none') => void
    sourceNoticeMocks.recheckCurrentRole
      .mockImplementationOnce(() => new Promise<'reader' | 'none'>(resolve => { releaseOld = resolve }))
      .mockResolvedValue('none')
    const oldInFlight = recheckCurrentRoleCached(documentName, 'u_flight', 's1', false, 12)
    await vi.waitFor(() => expect(sourceNoticeMocks.recheckCurrentRole).toHaveBeenCalledTimes(2))

    const { base, close } = await listen()
    try {
      const response = await fetch(`${base}/internal/docs/source-invalidations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-token': token },
        body: JSON.stringify({ doc_ids: ['d_source_changed'], principal_space_id: 's1' }),
      })
      expect(response.status).toBe(202)
      expect(await response.json()).toEqual({ accepted: true })

      expect(await recheckCurrentRoleCached(documentName, 'u_cached', 's1', false, 12)).toBe('none')
      releaseOld('reader')
      await expect(oldInFlight).resolves.toBe('none')
      expect(sourceNoticeMocks.recheckCurrentRole).toHaveBeenCalledTimes(4)
    } finally {
      releaseOld('reader')
      await close()
    }
  })

  it('rejects more than 50 source document IDs before database lookup or propagation', async () => {
    const token = 'octo59-internal-test-token'
    config.driveDerived.inboundToken = token
    const { base, close } = await listen()
    try {
      const response = await fetch(`${base}/internal/docs/source-invalidations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-token': token },
        body: JSON.stringify({
          doc_ids: Array.from({ length: 51 }, (_, index) => `d_${index}`),
          principal_space_id: 's1',
        }),
      })
      expect(response.status).toBe(400)
      expect(sourceNoticeMocks.getEpochsByDocIds).not.toHaveBeenCalled()
      expect(sourceNoticeMocks.publishSourceInvalidation).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })
  it('rejects a body over 64 KiB before authentication or database lookup', async () => {
    const { base, close } = await listen()
    try {
      const response = await fetch(`${base}/internal/docs/source-invalidations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-token': 'wrong-token' },
        body: JSON.stringify({
          doc_ids: ['d_source_changed'],
          principal_space_id: 's1',
          padding: 'x'.repeat(65 * 1024),
        }),
      })
      expect(response.status).toBe(413)
      expect(await response.json()).toEqual({ error: 'doc_too_large' })
      expect(sourceNoticeMocks.getEpochsByDocIds).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })
})
