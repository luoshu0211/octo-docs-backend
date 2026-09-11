import { Router } from 'express'
import { pptAuthMiddleware, pptSpaceContextMiddleware } from './auth.js'
import { loadPptDocForRead } from './pptDocGuard.js'
import { PptApiError, sendPptData } from './envelope.js'
import { roleAtLeast } from '../../permission/role.js'
import { savePptDraft, validatePptDraft } from '../../ppt/draft.js'

export function createPptDraftRouter(): Router {
  const router = Router()
  router.put('/docs/:docId/draft', pptAuthMiddleware, pptSpaceContextMiddleware, (req, res, next) => {
    void (async () => {
      const docId = req.params.docId!
      const uid = req.uid!
      const spaceId = req.spaceId!
      const { meta, role } = await loadPptDocForRead(uid, spaceId, docId, { token: req.octoToken })
      if (!roleAtLeast(role, 'writer')) throw new PptApiError('FORBIDDEN', 'writer role required')
      const { revision, deck } = validatePptDraft(req.body)
      const result = await savePptDraft({ docId: meta.doc_id, uid, spaceId, authorizedEpoch: Number(meta.permission_epoch), revision, deck })
      res.setHeader('Cache-Control', 'private, no-store')
      sendPptData(res, result)
    })().catch(next)
  })
  return router
}
