import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * OCTO-456 P0 — POST /internal/docs/member-added/unread.
 *
 * Offline: mock config + the notification repo and call the exported handler
 * directly (mirrors internalDocRole.test.ts). Pins the auth gate, body
 * validation (≤200 ids), dedupe/order, and the "one item per requested id with an
 * explicit unread boolean" wire shape drive relies on.
 */
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: { driveDerived: { inboundToken: 'drive-tok', outboundToken: 'outbound-only-tok' } },
}))
vi.mock('../src/config/env.js', () => ({ config: mockConfig }))
vi.mock('../src/db/repos/docMemberNotificationRepo.js', () => ({
  docMemberNotificationRepo: { listUnreadForDocs: vi.fn() },
}))

import { internalDocsMemberAddedUnreadHandler } from '../src/api/routes/internalDocsUnread.js'
import { docMemberNotificationRepo } from '../src/db/repos/docMemberNotificationRepo.js'

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

beforeEach(() => {
  vi.clearAllMocks()
  mockConfig.driveDerived.inboundToken = 'drive-tok'
  vi.mocked(docMemberNotificationRepo.listUnreadForDocs).mockResolvedValue([] as never)
})

describe('POST /internal/docs/member-added/unread', () => {
  it('401s without the internal token and never touches the repo', async () => {
    const res = response()
    await internalDocsMemberAddedUnreadHandler(
      request({ uid: 'u1', principal_space_id: 'org1', doc_ids: ['d1'] }, '') as never,
      res as never,
    )
    expect(res.statusCode).toBe(401)
    expect(docMemberNotificationRepo.listUnreadForDocs).not.toHaveBeenCalled()
  })

  it('fails closed when the configured token is empty', async () => {
    mockConfig.driveDerived.inboundToken = ''
    const res = response()
    await internalDocsMemberAddedUnreadHandler(
      request({ uid: 'u1', principal_space_id: 'org1', doc_ids: ['d1'] }, 'anything') as never,
      res as never,
    )
    expect(res.statusCode).toBe(401)
  })

  it.each([
    ['missing body', undefined],
    ['missing uid', { principal_space_id: 'org1', doc_ids: ['d1'] }],
    ['missing principal space', { uid: 'u1', doc_ids: ['d1'] }],
    ['missing doc_ids', { uid: 'u1', principal_space_id: 'org1' }],
    ['non-string doc id', { uid: 'u1', principal_space_id: 'org1', doc_ids: [1] }],
  ])('400s on %s', async (_label, body) => {
    const res = response()
    await internalDocsMemberAddedUnreadHandler(request(body) as never, res as never)
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_request' })
    expect(docMemberNotificationRepo.listUnreadForDocs).not.toHaveBeenCalled()
  })

  it('400s when more than 200 unique ids are requested', async () => {
    const res = response()
    await internalDocsMemberAddedUnreadHandler(
      request({
        uid: 'u1',
        principal_space_id: 'org1',
        doc_ids: Array.from({ length: 201 }, (_, i) => `d${i}`),
      }) as never,
      res as never,
    )
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'too_many_doc_ids' })
    expect(docMemberNotificationRepo.listUnreadForDocs).not.toHaveBeenCalled()
  })

  it('returns an empty list for an empty (or fully blank) doc_ids array without querying', async () => {
    for (const docIds of [[], ['', '  ']]) {
      const res = response()
      await internalDocsMemberAddedUnreadHandler(
        request({ uid: 'u1', principal_space_id: 'org1', doc_ids: docIds }) as never,
        res as never,
      )
      expect(res.statusCode).toBe(200)
      expect(res.body).toEqual({ items: [] })
    }
    expect(docMemberNotificationRepo.listUnreadForDocs).not.toHaveBeenCalled()
  })

  it('dedupes in request order and reports unread=false + event_at=null for the rest', async () => {
    const eventAt = new Date('2026-11-20T08:00:00.000Z')
    vi.mocked(docMemberNotificationRepo.listUnreadForDocs).mockResolvedValueOnce([
      { doc_id: 'd2', event_at: eventAt },
    ] as never)
    const res = response()
    await internalDocsMemberAddedUnreadHandler(
      request({ uid: 'u1', principal_space_id: 'org1', doc_ids: ['d1', 'd2', 'd1'] }) as never,
      res as never,
    )

    expect(docMemberNotificationRepo.listUnreadForDocs).toHaveBeenCalledWith({
      recipientUid: 'u1',
      recipientSpaceId: 'org1',
      docIds: ['d1', 'd2'],
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      items: [
        { doc_id: 'd1', unread: false, event_at: null },
        { doc_id: 'd2', unread: true, event_at: '2026-11-20T08:00:00.000Z' },
      ],
    })
  })

  it('treats a row for an id outside the request as absent (never fabricates an item)', async () => {
    vi.mocked(docMemberNotificationRepo.listUnreadForDocs).mockResolvedValueOnce([
      { doc_id: 'd_other', event_at: new Date('2026-11-20T08:00:00.000Z') },
    ] as never)
    const res = response()
    await internalDocsMemberAddedUnreadHandler(
      request({ uid: 'u1', principal_space_id: 'org1', doc_ids: ['d1'] }) as never,
      res as never,
    )
    expect(res.body).toEqual({ items: [{ doc_id: 'd1', unread: false, event_at: null }] })
  })
})
