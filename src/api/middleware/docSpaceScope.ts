/**
 * Temporary Human document Space policy.
 *
 * Documents remain docId-first: X-Space-Id never selects a document. Before the
 * Space-qualified ACL model ships, every Human single-document authorization
 * requires a non-empty current Space, verifies the session is a member of that
 * Space, and requires it to equal doc_meta.space_id. Bot requests retain their
 * server-resolved Space and existing same-Space isolation.
 */
import type { Request, Response, NextFunction } from 'express'
import type { DocMeta } from '../../db/repos/docMetaRepo.js'
import { confirmSpaceMembership } from '../../permission/spaceMembership.js'

export type DocSpaceScope =
  | { mode: 'human' }
  | { mode: 'bot'; spaceId: string }

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * Explicit per-mount doc space-scoping policy (remove-sp §6). Set by
       * {@link humanDocSpaceScopeMiddleware} (human) or verifyBot (bot). Read by
       * requireDocRole and the access-request submit handler to decide whether a
       * cross-space hit is a 404 (bot) or an ordinary docId locate (human).
       */
      docSpaceScope?: DocSpaceScope
      /** Human current Space candidate from X-Space-Id; never a document locator. */
      viewerSpaceId?: string
      /** Server-verified current Human Space, cached for this request only. */
      verifiedViewerSpaceId?: string
    }
  }
}

/**
 * Mark the Human mount and parse its current-Space candidate. The shared guard
 * performs membership and document-home equality checks after docId lookup.
 */
export function humanDocSpaceScopeMiddleware(req: Request, _res: Response, next: NextFunction): void {
  req.docSpaceScope = { mode: 'human' }
  const raw = req.header('X-Space-Id')
  const viewer = typeof raw === 'string' ? raw.trim() : ''
  if (viewer !== '') req.viewerSpaceId = viewer
  next()
}


/**
 * Temporary pre-Space-qualified safety gate.
 *
 * Human requests still locate by docId, but may authorize only while the
 * caller's server-verified current Space is the document's home Space. The full
 * qualified-principal model will replace this equality gate.
 */
export async function requireVerifiedHumanHomeSpace(
  req: Request,
  res: Response,
  meta: Pick<DocMeta, 'space_id'>,
): Promise<boolean> {
  const candidate = (req.viewerSpaceId ?? '').trim()
  if (candidate === '') {
    res.status(400).json({ error: 'space_required' })
    return false
  }
  const verified = req.verifiedViewerSpaceId === candidate
    || await confirmSpaceMembership(req.uid ?? '', candidate, req.octoToken ?? '')
  if (!verified || candidate !== meta.space_id) {
    res.status(404).json({ error: 'not_found' })
    return false
  }
  req.verifiedViewerSpaceId = candidate
  return true
}
