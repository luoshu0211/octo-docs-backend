import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/db/repos/docMemberNotificationRepo.js', () => ({
  docMemberNotificationRepo: {
    listUnread: vi.fn(async () => ({ unreadCount: 0, rows: [] })),
    markRead: vi.fn(async () => {}),
  },
}))

import { memberNotificationsRouter } from '../src/api/routes/memberNotifications.js'
import { docMemberNotificationRepo } from '../src/db/repos/docMemberNotificationRepo.js'

function routeHandler(method: 'get' | 'post', path: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (memberNotificationsRouter as unknown as { stack: any[] }).stack.find(
    ({ route }) => route?.path === path && route.methods?.[method],
  )
  if (!layer) throw new Error(`${method} ${path} handler not found`)
  return layer.route.stack.at(-1).handle as (req: unknown, res: unknown) => Promise<void>
}

function cacheMiddleware() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (memberNotificationsRouter as unknown as { stack: any[] }).stack.find(
    ({ route }) => !route,
  )
  if (!layer) throw new Error('notification cache middleware not found')
  return layer.handle as (req: unknown, res: unknown, next: () => void) => void
}

function response() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) { this.statusCode = code; return this },
    setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value },
    json(body: unknown) { this.body = body; return this },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('member-added notification routes', () => {
  it('lists only the authenticated principal current-Space reminders', async () => {
    const eventAt = new Date('2026-09-22T08:00:00.000Z')
    vi.mocked(docMemberNotificationRepo.listUnread).mockResolvedValueOnce({ unreadCount: 3, rows: [{
      doc_id: 'd_1',
      document_name: 'octo:s1:f1:d_1',
      title: 'Launch plan',
      owner_id: 'u_owner',
      doc_type: 'doc',
      octo_doc_slug: null,
      granted_by: 'u_admin',
      role: 2,
      event_at: eventAt,
    }] })
    const res = response()

    cacheMiddleware()({}, res, () => {})
    await routeHandler('get', '/notifications/member-added')(
      { uid: 'u_member', spaceId: 's1' },
      res,
    )

    expect(docMemberNotificationRepo.listUnread).toHaveBeenCalledWith({
      recipientUid: 'u_member',
      recipientSpaceId: 's1',
      limit: 100,
    })
    expect(res.body).toEqual({
      unreadCount: 3,
      items: [expect.objectContaining({ docId: 'd_1', ownerId: 'u_owner', role: 'writer', createdAt: eventAt })],
    })
    expect(res.headers['cache-control']).toBe('private, no-store')
  })

  it('marks read using auth identity, Space, and path doc id', async () => {
    const res = response()
    cacheMiddleware()({}, res, () => {})
    await routeHandler('post', '/notifications/member-added/:docId/read')(
      { uid: 'u_member', spaceId: 's1', params: { docId: 'd_1' } },
      res,
    )
    expect(docMemberNotificationRepo.markRead).toHaveBeenCalledWith({
      recipientUid: 'u_member',
      recipientSpaceId: 's1',
      docId: 'd_1',
    })
    expect(res.body).toEqual({ ok: true })
    expect(res.headers['cache-control']).toBe('private, no-store')
  })
})
