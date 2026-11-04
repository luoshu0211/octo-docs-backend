import { randomUUID } from 'node:crypto'
import { Router, type NextFunction, type Request, type Response, type Router as ExpressRouter } from 'express'
import { docMetaRepo } from '../../db/repos/docMetaRepo.js'
import { invalidateDriveDerivedAccessForSpace } from '../../drive/derivedAccessClient.js'
import { invalidateActiveAccess } from '../../permission/activeAccess.js'
import {
  forgetLocalSourceInvalidationEcho,
  publishSourceInvalidation,
  rememberLocalSourceInvalidationEcho,
} from '../../permission/epoch.js'
import { invalidateCurrentRoleRecheckCacheForSource } from '../../permission/recheck.js'
import { authorizeInternalDocRequest } from './internalDocRole.js'

export const internalSourceInvalidationsRouter: ExpressRouter = Router()
function isNonemptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 &&
    value.every(item => typeof item === 'string' && item.length > 0)
}

export async function internalSourceInvalidationsHandler(req: Request, res: Response): Promise<void> {
  if (!authorizeInternalDocRequest(req, res)) return
  const body = req.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    res.status(400).json({ error: 'invalid_request' })
    return
  }
  const input = body as Record<string, unknown>
  const docIds = input.doc_ids
  const principalSpaceId = input.principal_space_id
  const uid = input.uid
  if (
    !isNonemptyStringArray(docIds) || docIds.length > 50 ||
    typeof principalSpaceId !== 'string' || principalSpaceId.length === 0 ||
    (uid !== undefined && (typeof uid !== 'string' || uid.length === 0))
  ) {
    res.status(400).json({ error: 'invalid_request' })
    return
  }

  const uniqueDocIds = [...new Set(docIds)]
  const uidFilter = typeof uid === 'string' ? uid : undefined
  const rows = await docMetaRepo.getEpochsByDocIds(uniqueDocIds)
  // Freeze matching local sessions before the Redis round trip; the event ID
  // suppresses this node's echo while remote nodes apply the same notice.
  await Promise.all(rows.map(async row => {
    const eventId = randomUUID()
    invalidateDriveDerivedAccessForSpace(row.doc_id, principalSpaceId, uidFilter)
    invalidateCurrentRoleRecheckCacheForSource(row.document_name, principalSpaceId, uidFilter)
    invalidateActiveAccess(row.doc_id, principalSpaceId, uidFilter)
    rememberLocalSourceInvalidationEcho(eventId)
    try {
      await publishSourceInvalidation(row.document_name, row.doc_id, principalSpaceId, uidFilter, eventId)
    } catch (error) {
      forgetLocalSourceInvalidationEcho(eventId)
      throw error
    }
  }))
  res.status(202).json({ accepted: true })
}

function asyncHandler(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next)
  }
}

internalSourceInvalidationsRouter.post('/', asyncHandler(internalSourceInvalidationsHandler))
