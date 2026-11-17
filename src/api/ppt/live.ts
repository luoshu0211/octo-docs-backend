import { uploadPptMedia, downloadPptMedia } from './media.js'
import { Router, json, type Request, type Response, type NextFunction } from 'express'
import { config } from '../../config/env.js'
import { pptAuthMiddleware, pptSpaceContextMiddleware } from './auth.js'
import { loadPptDocForRead } from './pptDocGuard.js'
import { PptApiError, sendPptData, pptErrorHandler } from './envelope.js'
import { requireDocRole } from '../guard.js'
import { roleAtLeast, type Role } from '../../permission/role.js'
import { defaultPptSourceProvider } from '../../ppt/source.js'
import { editPptLive, validatePptEdit, type PptPrincipal } from '../../ppt/liveEdit.js'
import { preparePptCollab } from '../../ppt/collabSession.js'
import { createPptExportRouter } from './export.js'

export function pptAsync(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => { void handler(req, res).catch(next) }
}

export async function pptPrincipal(req: Request, res: Response, write: boolean | Role = false): Promise<PptPrincipal | null> {
  const docId = req.params.docId!
  const minimum = typeof write === 'string' ? write : write ? 'writer' : 'reader'
  const bot = req.docSpaceScope?.mode === 'bot'
  const guard = bot || req.docSpaceScope?.mode === 'cli' ? await requireDocRole(req, res, docId, minimum)
    : await loadPptDocForRead(req.uid!, req.spaceId!, docId, { token: req.octoToken })
  if (!guard) return null
  if (guard.meta.doc_type !== 'html_ppt') throw PptApiError.unsupportedDocumentType('document is not a PPT')
  if (!roleAtLeast(guard.role, minimum)) throw new PptApiError('FORBIDDEN', `${minimum} role required`)
  return { docId: guard.meta.doc_id, uid: req.uid!, spaceId: req.spaceId!, authorizedEpoch: Number(guard.meta.permission_epoch), isBot: bot }
}

const read = pptAsync(async (req, res) => {
  const principal = await pptPrincipal(req, res)
  if (!principal) return
  // A read initializes the same genesis as the first editor connection. The
  // returned revision is then directly usable for an optimistic edit.
  await preparePptCollab(principal.docId, principal.authorizedEpoch)
  const source = await defaultPptSourceProvider.getLive(principal.docId)
  if (!source) throw new PptApiError('NOT_FOUND', 'PPT source not found')
  const again = await pptPrincipal(req, res)
  if (!again) return
  if (again.authorizedEpoch !== principal.authorizedEpoch) throw new PptApiError('FORBIDDEN', 'permissions changed; read again')
  res.setHeader('Cache-Control', 'private, no-store')
  sendPptData(res, { docId: principal.docId, deck: source.deck, baseRevision: source.revision, contentHash: source.contentHash })
})

const edit = pptAsync(async (req, res) => {
  const principal = await pptPrincipal(req, res, true)
  if (!principal) return
  const result = await editPptLive(principal, validatePptEdit(req.body))
  res.setHeader('Cache-Control', 'private, no-store')
  sendPptData(res, result)
})

export function createPptLiveRouter(): Router {
  const router = Router()
  router.post('/docs/:docId/media', pptAuthMiddleware, pptSpaceContextMiddleware, pptAsync(uploadPptMedia))
  router.get('/docs/:docId/media/:attachId', pptAuthMiddleware, pptSpaceContextMiddleware, pptAsync(downloadPptMedia))
  router.get('/docs/:docId/live', pptAuthMiddleware, pptSpaceContextMiddleware, read)
  router.patch('/docs/:docId/live', pptAuthMiddleware, pptSpaceContextMiddleware, edit)
  return router
}

/** Mounted AFTER the established verifyBot middleware. Never accepts Human
 * sessions or a client-selected Space as Bot authority. */
export function createBotPptRouter(): Router {
  const router = Router()
  router.post('/:docId/ppt/media', pptAsync(uploadPptMedia))
  router.get('/:docId/ppt/media/:attachId', pptAsync(downloadPptMedia))
  router.get('/:docId/ppt', read)
  router.patch('/:docId/ppt', json({ limit: config.ppt.write.maxRequestBytes }), edit)
  router.use(createPptExportRouter(true))
  router.use(pptErrorHandler)
  return router
}
