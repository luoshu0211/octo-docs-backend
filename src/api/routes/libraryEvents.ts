import { Router, type Router as ExpressRouter } from 'express'
import { docLibraryEventRepo } from '../../db/repos/docLibraryEventRepo.js'
import { roleFromNumber } from '../../permission/role.js'
import { requireSpaceMembership, spaceContextMiddleware } from '../middleware/spaceContext.js'

export const libraryEventsRouter: ExpressRouter = Router()

const eventId = /^[1-9][0-9]{0,19}$/

libraryEventsRouter.get('/notifications/library', spaceContextMiddleware, requireSpaceMembership, async (req, res, next) => {
  const before = req.query.before
  if (before !== undefined && (typeof before !== 'string' || !eventId.test(before))) {
    res.status(400).json({ error: 'invalid_cursor' })
    return
  }
  try {
    res.setHeader('Cache-Control', 'private, no-store')
    const events = await docLibraryEventRepo.list({ uid: req.uid!, spaceId: req.spaceId! }, before)
    const page = events.slice(0, 50)
    res.json({
      items: page.map((event) => ({
        id: event.id,
        docId: event.doc_id,
        title: event.title,
        actorUid: event.actor_uid,
        kind: event.kind,
        requestId: event.request_id,
        previousRole: event.previous_role === null ? null : roleFromNumber(Number(event.previous_role)),
        role: event.new_role === null ? null : roleFromNumber(Number(event.new_role)),
        createdAt: new Date(Number(event.created_at_ms)),
        read: event.read_at !== null,
      })),
      nextCursor: events.length > page.length ? page.at(-1)?.id : null,
    })
  } catch (error) {
    next(error)
  }
})

libraryEventsRouter.post('/notifications/library/:id/read', spaceContextMiddleware, requireSpaceMembership, async (req, res, next) => {
  if (!eventId.test(req.params.id!)) {
    res.status(400).json({ error: 'invalid_event_id' })
    return
  }
  try {
    await docLibraryEventRepo.markRead({ uid: req.uid!, spaceId: req.spaceId! }, req.params.id!)
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})
