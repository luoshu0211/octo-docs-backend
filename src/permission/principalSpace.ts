import type { Request } from 'express'
import { confirmSpaceMembership } from './spaceMembership.js'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Trusted principal Space. Bot: verify-bot result. Human: active membership verified from candidate header. */
      principalSpaceId?: string
    }
  }
}

export async function resolveRequestPrincipalSpace(req: Request): Promise<string | null> {
  if (req.principalSpaceId) return req.principalSpaceId
  if (req.docSpaceScope?.mode === 'bot') {
    req.principalSpaceId = req.docSpaceScope.spaceId
    return req.principalSpaceId
  }
  const candidate = (req.viewerSpaceId ?? req.spaceId ?? '').trim()
  if (!candidate || !req.uid || !req.octoToken) return null
  if (!(await confirmSpaceMembership(req.uid, candidate, req.octoToken))) return null
  req.principalSpaceId = candidate
  return candidate
}
