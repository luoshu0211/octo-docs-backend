/**
 * Temporary Human document Space policy.
 *
 * Documents remain docId-first: X-Space-Id never selects a document. Every
 * Human single-document authorization requires a non-empty current Space and
 * verifies the session is a member of that Space. The verified current Space
 * may differ from doc_meta.space_id; direct ACL and share-scope authorization
 * decide document access. Bot requests retain their server-resolved Space and
 * existing same-Space isolation.
 */
import type { Request, Response, NextFunction } from 'express'
import type { DocMeta } from '../../db/repos/docMetaRepo.js'
import { confirmSpaceMembership } from '../../permission/spaceMembership.js'

export type DocSpaceScope =
  | { mode: 'human' }
  | { mode: 'bot' | 'cli'; spaceId: string }

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
 * verifies membership in that current Space after docId lookup; it does not use
 * the header as a document locator or require document-home equality.
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
 * caller's current Space is server-verified. Document authorization remains
 * docId/ACL based; equality with the document home Space is not required.
 */
export type HumanCurrentSpaceResult =
  | { verified: true }
  | { verified: false; status: 400; error: 'space_required' }
  | { verified: false; status: 404; error: 'not_found' }

/** Resolve the Human current-Space proof without writing an HTTP response. */
export async function resolveHumanCurrentSpace(req: Request): Promise<HumanCurrentSpaceResult> {
  const candidate = (req.viewerSpaceId ?? '').trim()
  if (candidate === '') return { verified: false, status: 400, error: 'space_required' }
  const verified = req.verifiedViewerSpaceId === candidate
    || await confirmSpaceMembership(req.uid ?? '', candidate, req.octoToken ?? '')
  if (!verified) return { verified: false, status: 404, error: 'not_found' }
  req.verifiedViewerSpaceId = candidate
  return { verified: true }
}

/**
 * Temporary pre-Space-qualified safety gate.
 *
 * Human requests still locate by docId, but may authorize only while the
 * caller's current Space is server-verified. Document authorization remains
 * docId/ACL based; equality with the document home Space is not required.
 */
export async function requireVerifiedHumanCurrentSpace(
  req: Request,
  res: Response,
  _meta: Pick<DocMeta, 'space_id'>,
): Promise<boolean> {
  const result = await resolveHumanCurrentSpace(req)
  if (!result.verified) {
    res.status(result.status).json({ error: result.error })
    return false
  }
  return true
}
