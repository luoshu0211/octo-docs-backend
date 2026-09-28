import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express, { type NextFunction, type Request, type Response } from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

vi.mock('../src/db/repos/docMemberNotificationRepo.js', () => ({
  docMemberNotificationRepo: {
    listUnread: vi.fn(async () => { throw new Error('database unavailable') }),
    markRead: vi.fn(async () => { throw new Error('database unavailable') }),
  },
}))
vi.mock('../src/api/middleware/spaceContext.js', () => ({
  spaceContextMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireSpaceMembership: (_req: Request, _res: Response, next: NextFunction) => next(),
}))
import { memberNotificationsRouter } from '../src/api/routes/memberNotifications.js'

describe('notification database errors over Express 4 HTTP', () => {
  let server: Server
  let base: string
  const caught = vi.fn()
  beforeAll(async () => {
    const app = express()
    app.use((req, _res, next) => { req.uid = 'recipient'; req.spaceId = 'space'; next() })
    app.use(memberNotificationsRouter)
    app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      caught(error)
      res.status(500).json({ error: 'internal_error' })
    })
    server = await new Promise<Server>(resolve => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
    })
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())) })

  it.each([
    ['GET', '/notifications/member-added'],
    ['POST', '/notifications/member-added/d1/read'],
  ])('%s returns an error instead of leaving the request pending', async (method, path) => {
    caught.mockClear()
    const response = await fetch(base + path, { method, signal: AbortSignal.timeout(1500) })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'internal_error' })
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(caught).toHaveBeenCalledTimes(1)
  })
})
