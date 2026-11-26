import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

/**
 * Covers the two surfaces the copy primitive gained in review round 2:
 *   · uk_ user API keys are allow-listed for POST /:docId/duplicate
 *     (middleware-level), everything else stays session-only.
 *   · POST /internal/docs/:docId/discard-copy — the service-authenticated
 *     compensation drive uses when it cannot link a freshly minted copy.
 */
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: { getByDocId: vi.fn(), softDelete: vi.fn() },
}))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({ docMemberRepo: { list: vi.fn() } }))
vi.mock('../src/db/repos/docVersionRepo.js', () => ({ docVersionRepo: { listByDoc: vi.fn() } }))
vi.mock('../src/db/repos/docCommentRepo.js', () => ({ docCommentRepo: { listByDoc: vi.fn() } }))
vi.mock('../src/api/services/htmlPurge.js', () => ({ purgeHtmlDocument: vi.fn() }))
vi.mock('../src/api/routes/internalDocRole.js', () => ({
  requireInternalDocToken: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.header('X-Internal-Token') !== 'internal-secret') {
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    next()
  },
}))

import { createInternalDocsCopyCompensationRouter, COPY_ORPHAN_WINDOW_MS } from '../src/api/routes/internalDocsCopyCompensation.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import { docVersionRepo } from '../src/db/repos/docVersionRepo.js'
import { docCommentRepo } from '../src/db/repos/docCommentRepo.js'
import { purgeHtmlDocument } from '../src/api/services/htmlPurge.js'
import { signDiscardToken } from '../src/api/services/discardToken.js'

const passThrough: express.RequestHandler = (_req, _res, next) => next()

let server: Server | null = null
let baseURL = ''

async function start(): Promise<void> {
  const app = express()
  app.use('/internal/docs', createInternalDocsCopyCompensationRouter(passThrough))
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve) })
  baseURL = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
}

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { owner_uid: 'bot-1', discard_token: signDiscardToken('d_copy', 'bot-1'), ...over }
}

async function discard(body: Record<string, unknown>, token?: string): Promise<{ status: number; body: any }> {
  if (!server) await start()
  const res = await fetch(`${baseURL}/internal/docs/d_copy/discard-copy`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token === undefined ? {} : { 'X-Internal-Token': token }),
    },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

function meta(over: Record<string, unknown> = {}) {
  return {
    doc_id: 'd_copy',
    owner_id: 'bot-1',
    status: 1,
    doc_type: 'doc',
    octo_doc_slug: null,
    space_id: 's1',
    created_at: new Date(),
    ...over,
  }
}

import { afterAll, beforeEach as beforeEachAlias } from 'vitest'

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => { server!.close(() => resolve()) })
})

beforeEachAlias(() => {
  vi.clearAllMocks()
  vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(meta() as never)
  vi.mocked(docMetaRepo.softDelete).mockResolvedValue({ documentName: 'n', permissionEpoch: 1 } as never)
  vi.mocked(docMemberRepo.list).mockResolvedValue([] as never)
  vi.mocked(docVersionRepo.listByDoc).mockResolvedValue({ items: [], nextCursor: null } as never)
  vi.mocked(docCommentRepo.listByDoc).mockResolvedValue([] as never)
  vi.mocked(purgeHtmlDocument).mockResolvedValue({ ok: true, slug: 'slug' } as never)
})

describe('POST /internal/docs/:docId/discard-copy', () => {
  it('soft-deletes an unlinked copy and reports no html cleanup for yjs docs', async () => {
    const res = await discard(body(), 'internal-secret')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ discarded: true, html_cleanup: 'skipped' })
    expect(docMetaRepo.softDelete).toHaveBeenCalledWith('d_copy')
  })

  it('requires the internal token and an owner_uid', async () => {
    expect((await discard(body())).status).toBe(401)
    const noOwner = await discard({ discard_token: signDiscardToken('d_copy', 'bot-1') }, 'internal-secret')
    expect(noOwner.status).toBe(400)
    expect(docMetaRepo.softDelete).not.toHaveBeenCalled()
  })

  it('refuses a document that is not a fresh unlinked copy', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['wrong owner', { owner_id: 'someone-else' }],
      ['already deleted', { status: 0 }],
      ['too old', { created_at: new Date(Date.now() - COPY_ORPHAN_WINDOW_MS - 1000) }],
    ]
    for (const [, override] of cases) {
      vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(meta(override) as never)
      const res = await discard(body(), 'internal-secret')
      expect(res.status).toBe(409)
      expect(res.body).toEqual({ error: 'not_a_copy_orphan' })
    }

    // A copy someone already collaborates on / edited / commented on is a real
    // document now: compensation must not delete it.
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(meta() as never)
    vi.mocked(docMemberRepo.list).mockResolvedValue([{ uid: 'alice' }] as never)
    const withMember = await discard(body(), 'internal-secret')
    expect(withMember.status).toBe(409)

    vi.mocked(docMemberRepo.list).mockResolvedValue([] as never)
    vi.mocked(docVersionRepo.listByDoc).mockResolvedValue({ items: [{ id: 1 }], nextCursor: null } as never)
    const withVersion = await discard(body(), 'internal-secret')
    expect(withVersion.status).toBe(409)
    expect(docMetaRepo.softDelete).not.toHaveBeenCalled()
  })

  it('purges html content for an html copy and reports a failed purge without failing', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(meta({ doc_type: 'html', octo_doc_slug: 'slug' }) as never)
    const ok = await discard(body(), 'internal-secret')
    expect(ok.body.html_cleanup).toBe('done')
    expect(purgeHtmlDocument).toHaveBeenCalledWith('slug', 'd_copy', 's1')

    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(meta({ doc_type: 'html', octo_doc_slug: 'slug' }) as never)
    vi.mocked(purgeHtmlDocument).mockResolvedValue({ ok: false, reason: 'upstream' } as never)
    const failed = await discard(body(), 'internal-secret')
    expect(failed.status).toBe(200)
    expect(failed.body.html_cleanup).toBe('failed')
  })

  it('refuses a discard without a token minted by this service', async () => {
    const missing = await discard({ owner_uid: 'bot-1' }, 'internal-secret')
    expect(missing.status).toBe(400)

    const forged = await discard({ owner_uid: 'bot-1', discard_token: 'v1.forged' }, 'internal-secret')
    expect(forged.status).toBe(409)
    expect(forged.body).toEqual({ error: 'not_a_copy_orphan' })

    // A token minted for ANOTHER doc must not authorize this one.
    const otherDoc = await discard(
      { owner_uid: 'bot-1', discard_token: signDiscardToken('d_other', 'bot-1') }, 'internal-secret',
    )
    expect(otherDoc.status).toBe(409)
    expect(docMetaRepo.softDelete).not.toHaveBeenCalled()
  })
})
