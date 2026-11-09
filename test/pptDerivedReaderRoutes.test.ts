import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type Express } from 'express'
import { once } from 'node:events'
import type { Tx } from '../src/db/pool.js'

const fixture = vi.hoisted(() => ({
  meta: {
    doc_id: 'd_ppt_drive_only',
    document_name: 'octo:s1:f_default:ppt:d_ppt_drive_only',
    owner_id: 'someone_else',
    owner_space_id: 's1',
    space_id: 's1',
    folder_id: 'f_default',
    status: 1,
    doc_type: 'html_ppt',
    permission_epoch: 4,
    share_scope: 0,
    share_role: 1,
    title: 'Drive reader deck',
  },
}))

vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: {
    getByDocId: vi.fn(async (docId: string) => docId === fixture.meta.doc_id ? fixture.meta : null),
    getByDocumentName: vi.fn(async (name: string) => name === fixture.meta.document_name ? fixture.meta : null),
  },
}))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  docMemberRepo: {
    getRole: vi.fn(async () => undefined),
    getRoleTx: vi.fn(async () => undefined),
  },
}))
vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(async () => []),
  transaction: async <R>(fn: (tx: Tx) => Promise<R>): Promise<R> => fn({
    query: async <T>(sql: string): Promise<T[]> => {
      if (sql.includes('FROM doc_meta')) return [fixture.meta] as unknown as T[]
      if (sql.includes('FROM ppt_comment')) return []
      throw new Error(`Unexpected SQL: ${sql}`)
    },
    execute: async () => ({ affectedRows: 0 }),
  }),
}))
vi.mock('../src/ppt/collabSession.js', () => ({ preparePptCollab: vi.fn(async () => undefined) }))

import { createPptLiveRouter } from '../src/api/ppt/live.js'
import { pptErrorHandler } from '../src/api/ppt/envelope.js'
import { commentsRouter } from '../src/api/routes/comments.js'
import { documentErrorHandler } from '../src/api/services/documentRoute.js'
import { setOctoIdentity } from '../src/auth/octoIdentity.js'
import { setDriveDerivedAccess, type DriveDerivedAccess, type DerivedRole } from '../src/drive/derivedAccessClient.js'
import { defaultPptSourceProvider } from '../src/ppt/source.js'

function driveAccess(role: DerivedRole): DriveDerivedAccess {
  return {
    async derivedAccess(docId, uid, principalSpaceId) {
      return { docId, uid, principalSpaceId, role, sourceRevision: 'sha256:test',
        validForMs: 15_000, expiresAt: performance.now() + 15_000 }
    },
    async versions(bindings) {
      return bindings.map(binding => ({ ...binding, sourceRevision: 'sha256:test',
        validForMs: 15_000, expiresAt: performance.now() + 15_000 }))
    },
  }
}

function makeApp(): Express {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    if (req.path.startsWith('/api/v1/docs/')) {
      req.uid = 'drive_reader'
      req.octoToken = 'session'
      req.viewerSpaceId = 's1'
      req.principalSpaceId = 's1'
      req.docSpaceScope = { mode: 'human' }
    }
    next()
  })
  app.use('/api/v1/ppt', createPptLiveRouter())
  app.use('/api/v1/docs', commentsRouter)
  app.use(documentErrorHandler)
  app.use(pptErrorHandler)
  return app
}

async function listen(app: Express): Promise<{ base: string; close: () => Promise<void> }> {
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
  setDriveDerivedAccess(driveAccess('reader'))
  setOctoIdentity({
    verifyToken: async token => token === 'session' ? { uid: 'drive_reader' } : null,
    isSpaceMember: async () => true,
  } as never)
})
afterEach(() => {
  vi.restoreAllMocks()
  setDriveDerivedAccess(driveAccess('none'))
})

describe('Human PPT reader access derived only from Drive', () => {
  it('serves the real PPT live-read route to a Drive-only reader', async () => {
    vi.spyOn(defaultPptSourceProvider, 'getLive').mockResolvedValue({
      deck: { slides: [{ id: 'slide-1', elements: [] }] },
      revision: 6,
      contentHash: 'ppt-reader-fixture',
      assets: [],
    } as never)
    const { base, close } = await listen(makeApp())
    try {
      const response = await fetch(`${base}/api/v1/ppt/docs/${fixture.meta.doc_id}/live`, {
        headers: { token: 'session', 'X-Space-Id': 's1' },
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        data: { docId: fixture.meta.doc_id, deck: { slides: [{ id: 'slide-1' }] } },
      })
    } finally {
      await close()
    }
  })

  it('serves PPT comments to a Drive-only reader through the Docs comment route', async () => {
    const { base, close } = await listen(makeApp())
    try {
      const response = await fetch(`${base}/api/v1/docs/${fixture.meta.doc_id}/comments`, {
        headers: { token: 'session', 'X-Space-Id': 's1' },
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ items: [], nextCursor: null })
    } finally {
      await close()
    }
  })

  it('does not let a Drive-only reader create a PPT comment', async () => {
    const { base, close } = await listen(makeApp())
    try {
      const response = await fetch(`${base}/api/v1/docs/${fixture.meta.doc_id}/comments`, {
        method: 'POST',
        headers: { token: 'session', 'X-Space-Id': 's1', 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'reader cannot comment' }),
      })
      expect(response.status).toBe(403)
    } finally {
      await close()
    }
  })
})
