/**
 * Space-scoped document share permissions (#64) — the ONE new permission rule.
 *
 * Today the doc backend has a single permission source: resolveRole = owner =>
 * admin, else the doc_member row, else none (§4.2). Feature #64 adds a SECOND,
 * supplementary source: a per-document share scope (restricted |
 * anyone_in_space | authenticated) with a share role (read | comment | edit)
 * that grants an eligible authenticated caller an effective role even with no
 * doc_member row.
 *
 * The two sources are merged by `effectiveRole` = max(directRole, shareDerived):
 * the share path only ever RAISES access, never lowers it, so a doc_member/owner
 * is never downgraded by a share setting, and a `restricted` doc is byte-identical
 * to today (shareDerived = 'none'). See the design doc §5.1.
 */
import { roleRank, type ResolvedRole } from './role.js'

/** doc_meta.share_scope values. */
export const SHARE_SCOPE_RESTRICTED = 0
export const SHARE_SCOPE_ANYONE = 1
export const SHARE_SCOPE_AUTHENTICATED = 2

/** doc_meta.share_role values (reuse the persisted role numeric space). */
export const SHARE_ROLE_READ = 1
export const SHARE_ROLE_EDIT = 2
export const SHARE_ROLE_ADMIN = 3
export const SHARE_ROLE_COMMENT = 4

/** doc_meta.discoverability_scope values. Unknown values stay hidden (fail closed). */
export const DISCOVERABILITY_HIDDEN = 0
export const DISCOVERABILITY_SPACE = 1

export type ShareScopeName = 'restricted' | 'anyone_in_space' | 'authenticated'
export type ShareRoleName = 'read' | 'comment' | 'edit'

/** Unknown values normalize to restricted (fail-safe coercion). */
export function shareScopeName(scopeNum: number): ShareScopeName {
  if (scopeNum === SHARE_SCOPE_ANYONE) return 'anyone_in_space'
  if (scopeNum === SHARE_SCOPE_AUTHENTICATED) return 'authenticated'
  return 'restricted'
}

/** Unknown values normalize to read (fail-safe coercion). */
export function shareRoleName(roleNum: number): ShareRoleName {
  if (roleNum === SHARE_ROLE_COMMENT) return 'comment'
  return roleNum === SHARE_ROLE_EDIT ? 'edit' : 'read'
}

/** Map the share-scope wire enum to its stored TINYINT, or null. */
export function parseShareScope(v: unknown): number | null {
  if (v === 'restricted') return SHARE_SCOPE_RESTRICTED
  if (v === 'anyone_in_space') return SHARE_SCOPE_ANYONE
  if (v === 'authenticated') return SHARE_SCOPE_AUTHENTICATED
  return null
}

/** Map the forward-grantable read|comment|edit wire enum to its stored TINYINT, or null. */
export function parseShareRole(v: unknown): number | null {
  if (v === 'read') return SHARE_ROLE_READ
  if (v === 'comment') return SHARE_ROLE_COMMENT
  if (v === 'edit') return SHARE_ROLE_EDIT
  return null
}

/**
 * The single effective-role rule reused by all three enforcement seams
 * (collab-token issuance, the REST guard, the live-socket write recheck).
 *
 *   base         = directRole (owner/admin/doc_member/none — resolveRole today)
 *   shareDerived = writer/reader when the doc is anyone_in_space AND the
 *                  requester is a member of the doc's space; otherwise 'none'
 *   effective    = max(base, shareDerived)          // only ever UP, never down
 *
 * Fail-safe coercion (design §5.1 / §2): any share_scope value other than
 * the two known open scopes is treated as restricted, and unknown share_role
 * values collapse to reader — so an unexpected stored value fails to the most-restrictive
 * interpretation and never opens access. A `restricted` doc therefore yields
 * shareDerived='none', making the result identical to today's resolveRole.
 */
export function effectiveRole(
  directRole: ResolvedRole,
  isSpaceMember: boolean,
  shareScope: number,
  shareRole: number,
): ResolvedRole {
  let shareDerived: ResolvedRole = 'none'
  if (shareScope === SHARE_SCOPE_AUTHENTICATED || (shareScope === SHARE_SCOPE_ANYONE && isSpaceMember)) {
    // Unknown values fail closed to reader rather than gaining comment/write.
    // Historical share_role=admin is no longer grantable and degrades to reader.
    shareDerived = shareRole === SHARE_ROLE_EDIT
        ? 'writer'
        : shareRole === SHARE_ROLE_COMMENT
        ? 'commenter'
        : 'reader'
  }
  return roleRank(directRole) >= roleRank(shareDerived) ? directRole : shareDerived
}
