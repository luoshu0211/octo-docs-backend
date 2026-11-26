/**
 * AuthMiddleware (§4.7 / §8.4).
 *
 * Business/metadata REST endpoints are authenticated with the octo session
 * token. In same-origin octo-web, the apiClient injects a `token` header
 * (NOT Authorization: Bearer — §4.7(c)); we also accept Authorization: Bearer
 * as a generic placeholder. The trusted uid is resolved via OctoIdentity
 * (§4.7(a)) — the client never supplies its own uid.
 */
import type { Request, Response, NextFunction } from 'express'
import { getOctoIdentity } from '../../auth/octoIdentity.js'
import { IdentityUnavailableError } from '../../auth/identityUnavailable.js'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      uid?: string
      octoToken?: string
      apiKeySpaceId?: string
      // Set on the human path (authMiddleware): the uids of bots this human user
      // owns (octo-server verify `owned_bots`). Used so "my documents"
      // (owner=me) also surfaces docs a user's bots own. Defaults to [] when the
      // identity source omits it (fail-closed: caller sees only their own docs).
      ownedBots?: string[]
      // Set only on the bot mount (verifyBot): the bot's own bearer token, used
      // only for bot-realm octo-server lookups, including exact own-Space
      // principal validation. Never set on the human path.
      botToken?: string
      // Set only on the bot mount (verifyBot): the uid of the human who owns the
      // bot (robot.creator_uid, from the verify-bot reverse lookup). Absent for a
      // bot with no human creator. Used by the doc-create path to auto-grant the
      // owner admin so the bot's human owner can see docs the bot creates.
      botOwnerUid?: string
    }
  }
}

/** Extract the octo session token from the request (header `token` or Bearer). */
export function extractOctoToken(req: Request): string {
  const headerToken = req.header('token')
  if (headerToken) return headerToken
  const auth = req.header('authorization')
  if (auth && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim()
  return ''
}

/**
 * Require a valid Octo identity. Native API keys are restricted to the Docs
 * metadata endpoint; all other routes retain session-token authentication.
 */
export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = extractOctoToken(req)
  if (token.startsWith('uk_')) {
    // Native user API keys are deliberately narrow: the docs metadata endpoint
    // (drive's ids-only lookup) and the copy primitive drive calls on the
    // user's behalf. Everything else keeps session-token authentication.
    // `req.path` is router-relative here, so the copy route mounted at
    // `/:docId/duplicate` appears as `/<docId>/duplicate`.
    const allowed = req.method === 'POST'
      && (/^\/metadata\/?$/i.test(req.path) || /^\/[^/]+\/duplicate\/?$/i.test(req.path))
    if (!allowed) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }

    let identity
    try {
      identity = await getOctoIdentity().verifyApiKey(token)
    } catch (err) {
      if (err instanceof IdentityUnavailableError) {
        res.status(503).json({ error: 'identity_unavailable' })
        return
      }
      next(err)
      return
    }
    if (!identity) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    const headerSpace = req.header('X-Space-Id')
    if (headerSpace !== undefined && headerSpace.trim() !== '' && headerSpace.trim() !== identity.spaceId) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    req.uid = identity.uid
    req.ownedBots = []
    req.viewerSpaceId = identity.spaceId
    req.verifiedViewerSpaceId = identity.spaceId
    req.apiKeySpaceId = identity.spaceId
    req.principalSpaceId = identity.spaceId
    next()
    return
  }

  let identity
  try {
    identity = await getOctoIdentity().verifyToken(token)
  } catch (err) {
    if (err instanceof IdentityUnavailableError) {
      res.status(503).json({ error: 'identity_unavailable' })
      return
    }
    // Express 4 does not forward rejected async middleware automatically.
    next(err)
    return
  }
  if (!identity) {
    res.status(401).json({ error: 'unauthorized' })
    return
  }
  req.uid = identity.uid
  // Bots this human user owns (octo verify `owned_bots`). Defaults to [] when
  // absent so the owner=me listing never widens beyond the caller's own docs.
  req.ownedBots = identity.ownedBots ?? []
  // Stash the raw caller token so downstream handlers can authenticate their
  // own octo-server lookups (e.g. members.ts getUser). Never logged.
  req.octoToken = token
  next()
}
