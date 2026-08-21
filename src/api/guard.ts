/**
 * Shared REST permission guards (§4.2 / §8.4 / remove-sp §6).
 */
import type { Request, Response } from 'express'
import { docMetaRepo, type DocMeta } from '../db/repos/docMetaRepo.js'
import { resolveRole } from '../permission/resolveRole.js'
import { roleAtLeast, type ResolvedRole, type Role } from '../permission/role.js'
import { resolveEffectiveRole } from '../permission/resolveEffectiveRole.js'
import type { DocSpaceScope } from './middleware/docSpaceScope.js'
import { requireVerifiedHumanCurrentSpace } from './middleware/docSpaceScope.js'
import { resolveRequestPrincipalSpace } from '../permission/principalSpace.js'

export interface DocGuard {
  meta: DocMeta
  role: ResolvedRole
}

/** Keep Bot-originated access-request submission pinned to the Bot's own Space. */
export function requireSameSpace(res: Response, meta: DocMeta, spaceId: string): boolean {
  if (meta.space_id === spaceId) return true
  res.status(404).json({ error: 'not_found' })
  return false
}

/** Return a non-leaking 404 for a Bot without a principal-qualified direct grant. */
function botNotFound(res: Response): null {
  res.status(404).json({ error: 'not_found' })
  return null
}

/**
 * Resolve the doc space-scoping policy for a request (remove-sp §6). Fails
 * CLOSED: a request that reached a doc guard without a policy set by its mount
 * is a wiring bug, and defaulting to bot-with-empty-space makes every doc read
 * as cross-space (404) rather than silently opening the Human locate. Every
 * real mount installs a policy (humanDocSpaceScopeMiddleware / verifyBot).
 */
function docScopeOf(req: Request): DocSpaceScope {
  return req.docSpaceScope ?? { mode: 'bot', spaceId: '' }
}

/**
 * Load the doc and resolve the caller's effective role, enforcing a minimum
 * role. Writes the appropriate HTTP error and returns null when blocked:
 *   404 doc missing/deleted or unauthorized cross-space Bot, 409 archived,
 *   403 insufficient role.
 *
 * Doc location + space scoping follow the explicit per-mount policy
 * (`req.docSpaceScope`), NOT `req.botToken` (remove-sp §6):
 *   - Human ({ mode: 'human' }): locate by `docId` alone. `X-Space-Id` never
 *     scopes selection or authz, so a cross-Space direct member / owner /
 *     anyone_in_space caller resolves exactly as if `sp` had been correct, and a
 *     missing/wrong header yields the identical result.
 *   - Bot ({ mode: 'bot', spaceId }): same-Space behavior is unchanged. A cross-Space
 *     Bot is admitted ONLY by an exact direct grant keyed by (docId, botUid, Bot Space);
 *     otherwise it receives non-leaking 404 and never inherits link/Space sharing.
 *
 * Link/share-derived access is evaluated only for Humans and same-Space Bots. A
 * cross-Space Bot can use only its exact direct role; this prevents a B Bot from
 * inheriting A's link-sharing policy while allowing an explicitly approved (Bot,B).
 */
export async function requireDocRole(
  req: Request,
  res: Response,
  docId: string,
  minRole: Role,
): Promise<DocGuard | null> {
  const uid = req.uid!
  if (!req.docSpaceScope) return botNotFound(res)
  const scope = docScopeOf(req)
  const meta = await docMetaRepo.getByDocId(docId)
  if (!meta || meta.status === 0) {
    res.status(404).json({ error: 'not_found' })
    return null
  }
  if (scope.mode === 'human' && !(await requireVerifiedHumanCurrentSpace(req, res, meta))) return null
  const principalSpaceId = await resolveRequestPrincipalSpace(req)
  if (!principalSpaceId) {
    res.status(403).json({ error: 'principal_space_unverified' })
    return null
  }
  const direct = await resolveRole(uid, docId, principalSpaceId)
  const crossSpaceBot = scope.mode === 'bot' && scope.spaceId !== meta.space_id
  if (crossSpaceBot) {
    // Explicit direct grant only. Keep 404 for both absent and insufficient grants so
    // a foreign-Space Bot cannot use role distinctions as a document oracle.
    if (direct === 'none' || !roleAtLeast(direct, minRole)) return botNotFound(res)
  }
  const role = crossSpaceBot
    ? direct
    : await resolveEffectiveRole(uid, direct, meta, {
        isBot: scope.mode === 'bot',
        principalSpaceId,
        token: req.octoToken,
      })
  if (role === 'none' || !roleAtLeast(role, minRole)) {
    res.status(403).json({ error: 'forbidden' })
    return null
  }
  // State is disclosed only after authorization. This preserves the Phase-1
  // contract: an existing doc with no effective role is 403, while 409 is
  // visible only to an authorized caller.
  if (meta.status === 2) {
    res.status(409).json({ error: 'conflict' })
    return null
  }
  return { meta, role }
}
