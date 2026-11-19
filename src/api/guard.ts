/**
 * Shared REST permission guards (§4.2 / §8.4 / remove-sp §6).
 */
import type { Request, Response } from 'express'
import { docMetaRepo, type DocMeta } from '../db/repos/docMetaRepo.js'
import { resolveRole } from '../permission/resolveRole.js'
import { roleAtLeast, type ResolvedRole, type Role } from '../permission/role.js'
import { resolveEffectiveRole } from '../permission/resolveEffectiveRole.js'
import { resolveHumanCurrentSpace, type DocSpaceScope } from './middleware/docSpaceScope.js'
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
 * Resolve the doc and caller's effective role without writing an HTTP response.
 * This is shared by single-document guards and batch metadata reads, so every
 * surface uses the same Human/Bot scope and ACL rules.
 */
export type DocRoleResolution =
  | { ok: true; guard: DocGuard }
  | { ok: false; status: number; error: string }

export async function resolveDocRole(
  req: Request,
  docId: string,
  minRole: Role,
): Promise<DocRoleResolution> {
  if (!req.docSpaceScope) return { ok: false, status: 404, error: 'not_found' }
  const scope = docScopeOf(req)
  const meta = await docMetaRepo.getByDocId(docId)
  if (!meta || meta.status === 0 || (scope.mode === 'cli' && meta.space_id !== scope.spaceId)) {
    return { ok: false, status: 404, error: 'not_found' }
  }
  if (scope.mode === 'human') {
    const currentSpace = await resolveHumanCurrentSpace(req)
    if (!currentSpace.verified) {
      return { ok: false, status: currentSpace.status, error: currentSpace.error }
    }
  }
  const principalSpaceId = await resolveRequestPrincipalSpace(req)
  if (!principalSpaceId) return { ok: false, status: 403, error: 'principal_space_unverified' }
  const direct = await resolveRole(req.uid!, docId, principalSpaceId)
  const crossSpaceBot = scope.mode === 'bot' && scope.spaceId !== meta.space_id
  if (crossSpaceBot) {
    // Explicit direct grant only. Keep 404 for both absent and insufficient grants so
    // a foreign-Space Bot cannot use role distinctions as a document oracle.
    if (direct === 'none' || !roleAtLeast(direct, minRole)) {
      return { ok: false, status: 404, error: 'not_found' }
    }
  }
  const role = crossSpaceBot
    ? direct
    : await resolveEffectiveRole(req.uid!, direct, meta, {
        isBot: scope.mode === 'bot',
        principalSpaceId,
        token: req.octoToken,
        verifiedSpaceId: req.apiKeySpaceId,
      })
  if (role === 'none' || !roleAtLeast(role, minRole)) {
    return { ok: false, status: 403, error: 'forbidden' }
  }
  // State is disclosed only after authorization. This preserves the Phase-1
  // contract: an existing doc with no effective role is 403, while 409 is
  // visible only to an authorized caller.
  if (meta.status === 2) return { ok: false, status: 409, error: 'conflict' }
  return { ok: true, guard: { meta, role } }
}

/**
 * Load the doc and resolve the caller's effective role, writing the legacy HTTP
 * error response when blocked.
 */
export async function requireDocRole(
  req: Request,
  res: Response,
  docId: string,
  minRole: Role,
): Promise<DocGuard | null> {
  const result = await resolveDocRole(req, docId, minRole)
  if (!result.ok) {
    res.status(result.status).json({ error: result.error })
    return null
  }
  return result.guard
}
