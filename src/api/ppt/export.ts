import { Router } from 'express'
import { pptAsync, pptPrincipal } from './live.js'
import { pptAuthMiddleware, pptSpaceContextMiddleware } from './auth.js'
import { PptApiError } from './envelope.js'
import { defaultPptSourceProvider } from '../../ppt/source.js'
import { renderPptHtml } from '../../ppt/render.js'

export function createPptExportRouter(bot = false): Router {
  const router = Router()
  const path = bot ? '/:docId/ppt' : '/docs/:docId'
  const guards = bot ? [] : [pptAuthMiddleware, pptSpaceContextMiddleware]
  router.get(`${path}/export`, ...guards, pptAsync(async (req, res) => {
    const principal = await pptPrincipal(req, res)
    if (!principal) return
    if (req.query.format !== undefined && req.query.format !== 'html') throw new PptApiError('VALIDATION_ERROR', 'unsupported export format')
    const content = await defaultPptSourceProvider.getLive(principal.docId)
    if (!content) throw new PptApiError('NOT_FOUND', 'source not found')
    const html = await renderPptHtml(content.deck, principal.docId)
    const again = await pptPrincipal(req, res)
    if (!again) return
    if (again.authorizedEpoch !== principal.authorizedEpoch) throw new PptApiError('FORBIDDEN', 'permissions changed')
    const filename = content.deck.title.replace(/[\\/:*?"<>|\p{Cc}]/gu, '_').slice(0, 100).replace(/[\uD800-\uDFFF]/gu, '_') || 'PPT'
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Disposition', `attachment; filename="presentation.html"; filename*=UTF-8''${encodeURIComponent(filename + '.html')}`)
    res.type('html').send(html)
  }))
  return router
}
