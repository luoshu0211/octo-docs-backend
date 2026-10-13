import { Router, type Request, type Response, type NextFunction, type Router as ExpressRouter } from 'express'
import { docMemberNotificationRepo } from '../../db/repos/docMemberNotificationRepo.js'
import { roleFromNumber } from '../../permission/role.js'
import { requireSpaceMembership, spaceContextMiddleware } from '../middleware/spaceContext.js'

export const memberNotificationsRouter: ExpressRouter = Router()

function asyncHandler(handler: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try { await handler(req, res) } catch (error) { next(error) }
  }
}

memberNotificationsRouter.use((_req: Request, res: Response, next) => {
  res.setHeader('Cache-Control', 'private, no-store')
  next()
})

memberNotificationsRouter.get(
  '/notifications/member-added',
  spaceContextMiddleware,
  requireSpaceMembership,
  asyncHandler(async (req: Request, res: Response) => {
    const principal = {
      recipientUid: req.uid!,
      recipientSpaceId: req.spaceId!,
    }
    const { unreadCount, rows } = await docMemberNotificationRepo.listUnread({ ...principal, limit: 100 })
    const items = rows.map((row) => {
      const role = roleFromNumber(Number(row.role))
      if (!role) throw new Error(`invalid member notification role ${row.role}`)
      return {
        docId: row.doc_id,
        documentName: row.document_name,
        title: row.title,
        ownerId: row.owner_id,
        docType: row.doc_type,
        octoDocSlug: row.octo_doc_slug,
        grantedBy: row.granted_by,
        role,
        createdAt: row.event_at,
      }
    })
    res.status(200).json({ unreadCount, items })
  }),
)

memberNotificationsRouter.post(
  '/notifications/member-added/:docId/read',
  spaceContextMiddleware,
  requireSpaceMembership,
  asyncHandler(async (req: Request, res: Response) => {
    await docMemberNotificationRepo.markRead({
      recipientUid: req.uid!,
      recipientSpaceId: req.spaceId!,
      docId: req.params.docId!,
    })
    res.status(200).json({ ok: true })
  }),
)
