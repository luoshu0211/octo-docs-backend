import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * OCTO-456 §4.3 — POST /api/v1/docs/metadata gains `role` + `capabilities`
 * (additive; the historical actor fields are unchanged). The guard is mocked so
 * the projection is exercised without live infra. "Skip unreadable" and the
 * 500-id batch cap must stay exactly as before.
 */
vi.mock('../src/api/guard.js', () => ({
  requireDocRole: vi.fn(),
  resolveDocRole: vi.fn(),
}))

import { docsMetadataHandler } from '../src/api/routes/docs.js'
import { resolveDocRole } from '../src/api/guard.js'

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
function request(body: unknown) {
  return {
    uid: 'u1',
    principalSpaceId: 's1',
    body,
    query: {},
    docSpaceScope: { mode: 'bot' as const, spaceId: 's1' },
  }
}

const meta = {
  doc_id: 'd1',
  title: 'A',
  doc_type: 'doc',
  owner_id: 'owner',
  owner_space_id: 's1',
  space_id: 's1',
  status: 1,
  share_scope: 0,
  share_role: 1,
  created_by: 'u_creator',
  updated_by: 'u_editor',
  updated_at: new Date('2026-11-20T00:00:00.000Z'),
}

beforeEach(() => {
  vi.mocked(resolveDocRole).mockReset()
})

describe('POST /api/v1/docs/metadata — role + capabilities', () => {
  it('adds role + camelCase capabilities to readable items, preserving order and skipping unreadable ones', async () => {
    vi.mocked(resolveDocRole).mockImplementation(async (_req, docId) => {
      if (docId === 'd1') return { ok: true, guard: { role: 'admin', meta: { ...meta } } } as never
      if (docId === 'd2') {
        return {
          ok: true,
          guard: {
            role: 'reader',
            meta: { ...meta, doc_id: 'd2', doc_type: 'html', owner_id: 'u1', title: 'B' },
          },
        } as never
      }
      return { ok: false, status: 403, error: 'forbidden' } as never
    })
    const res = response()
    await docsMetadataHandler(
      request({ docIds: ['d1', 'd2', 'd_missing'] }) as never,
      res as never,
    )
    expect(res.statusCode).toBe(200)
    const body = res.body as { items: Array<Record<string, unknown>> }
    expect(body.items).toHaveLength(2)
    expect(body.items[0]).toMatchObject({
      docId: 'd1',
      createdBy: 'u_creator',
      updatedBy: 'u_editor',
      role: 'admin',
      capabilities: {
        canRead: true, canComment: true, canEdit: true, canShare: true,
        canExport: true, canCopy: true, canRenameOriginal: true,
        canDeleteOriginal: true, canDownloadOriginal: true,
      },
    })
    // html + original author: rename allowed even at reader, everything else reader.
    expect(body.items[1]).toMatchObject({
      docId: 'd2',
      role: 'reader',
      capabilities: {
        canRead: true, canComment: false, canEdit: false, canShare: false,
        canRenameOriginal: true, canDeleteOriginal: false,
      },
    })
    // The historical fields are still snake_case-free (camelCase as before).
    expect(body.items[0]).not.toHaveProperty('doc_id')
  })

  it('keeps the 500-id cap and the invalid_doc_ids 400', async () => {
    const tooMany = { docIds: Array.from({ length: 501 }, (_, i) => `d${i}`) }
    const res = response()
    await docsMetadataHandler(request(tooMany) as never, res as never)
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_doc_ids' })
    expect(resolveDocRole).not.toHaveBeenCalled()

    const notArray = response()
    await docsMetadataHandler(request({ docIds: 'd1' }) as never, notArray as never)
    expect(notArray.statusCode).toBe(400)
  })

  it('still returns an empty items list when every id is unreadable', async () => {
    vi.mocked(resolveDocRole).mockResolvedValue({ ok: false, status: 403, error: 'forbidden' } as never)
    const res = response()
    await docsMetadataHandler(request({ docIds: ['d1'] }) as never, res as never)
    expect(res.body).toEqual({ items: [] })
  })
})
