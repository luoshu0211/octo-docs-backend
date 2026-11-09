/**
 * resolveRole — document-autonomous role resolution (§4.2).
 *
 *   resolveRole(uid, docId):
 *     if uid === doc_meta(docId).owner_id: return admin   // owner => admin, not downgradable
 *     memberRole = doc_member(docId, uid).role            // single row
 *     return memberRole ?? none                           // no row => none
 *
 * No group inheritance, no max(...) union — a single doc_member lookup + owner
 * comparison. recheckCurrentRole (§4.1 stale branch) resolves documentName ->
 * doc_id first, then calls this.
 */
import { docMetaRepo, type DocMeta } from '../db/repos/docMetaRepo.js'
import { docMemberRepo } from '../db/repos/docMemberRepo.js'
import { parseDocumentName } from './documentName.js'
import { effectiveRole } from './shareScope.js'
import { getDriveDerivedAccess, type DerivedAccessProof } from '../drive/derivedAccessClient.js'
import { roleAtLeast, roleRank, type ResolvedRole } from './role.js'

export async function resolveRole(uid: string, docId: string, principalSpaceId: string): Promise<ResolvedRole> {
  const meta = await docMetaRepo.getByDocId(docId)
  if (!meta) return 'none'
  if (uid === meta.owner_id && principalSpaceId === meta.owner_space_id) return 'admin' // owner implies admin (§4.2)
  const memberRole = await docMemberRepo.getRole(docId, uid, principalSpaceId)
  return memberRole ?? 'none'
}

/**
 * Shared documentName -> doc_meta resolver (§8.1 key/row consistency).
 *
 * Every server-side path that turns a *connection key* into its doc_meta row —
 * collab-token issuance, fresh WS handshakes and write rechecks — resolves it the
 * SAME way, keyed on document_name. Because a board's document_name IS its
 * 5-segment `:wb:` key, this one path serves documents and whiteboards alike and
 * replaces the doc_id lookup issuance used to special-case boards with. An exact
 * document_name match implicitly validates every segment; the explicit
 * space/folder compare stays as defense-in-depth against a row whose columns
 * disagree with its stored key. Returns the row, or null when the key is
 * malformed, absent, soft-deleted, or fails that consistency check.
 */
export async function resolveDocMetaByName(documentName: string): Promise<DocMeta | null> {
  let parsed
  try {
    parsed = parseDocumentName(documentName)
  } catch {
    return null
  }
  const meta = await docMetaRepo.getByDocumentName(documentName)
  if (!meta || meta.status === 0) return null
  if (parsed.space !== meta.space_id || parsed.folder !== meta.folder_id) return null
  return meta
}


export interface CurrentAccess {
  role: ResolvedRole
  permissionEpoch: number | null
  sourceRevision: string | null
  proofExpiresAt: number | null
  sourceConfirmed: boolean
}

/** Resolve the current Docs role and preserve the Drive proof that supports it. */
export async function recheckCurrentAccess(
  documentName: string,
  uid: string,
  principalSpaceId: string,
  spaceMember = false,
): Promise<CurrentAccess> {
  const meta = await resolveDocMetaByName(documentName)
  if (!meta) return { role: 'none', permissionEpoch: null, sourceRevision: null, proofExpiresAt: null, sourceConfirmed: true }
  const direct = uid === meta.owner_id && principalSpaceId === meta.owner_space_id
    ? 'admin'
    : ((await docMemberRepo.getRole(meta.doc_id, uid, principalSpaceId)) ?? 'none')
  const base = effectiveRole(direct, spaceMember, meta.share_scope, meta.share_role)
  if (roleAtLeast(base, 'reader')) {
    return { role: base, permissionEpoch: Number(meta.permission_epoch), sourceRevision: null, proofExpiresAt: null, sourceConfirmed: true }
  }
  try {
    const proof: DerivedAccessProof | null = await getDriveDerivedAccess()
      .derivedAccess(meta.doc_id, uid, principalSpaceId)
    if (!proof) return { role: base, permissionEpoch: Number(meta.permission_epoch), sourceRevision: null, proofExpiresAt: null, sourceConfirmed: false }
    return {
      role: roleRank(base) >= roleRank(proof.role) ? base : proof.role,
      permissionEpoch: Number(meta.permission_epoch),
      sourceRevision: proof.sourceRevision,
      proofExpiresAt: proof.expiresAt,
      sourceConfirmed: true,
    }
  } catch {
    return { role: base, permissionEpoch: Number(meta.permission_epoch), sourceRevision: null, proofExpiresAt: null, sourceConfirmed: false }
  }
}
/**
 * recheckCurrentRole(documentName, uid, spaceMember) — current effective role.
 *
 * Resolves the doc by document_name, applies direct ownership/membership and
 * Space-share rules, then merges the Drive-derived reader. A fresh WS handshake
 * calls this function directly because permission_epoch does not version Drive
 * sources. Message-triggered rechecks may wrap it with the short-TTL singleflight
 * cache in `permission/recheck.ts`.
 *
 * The doc's share settings are read FRESH from the row (`resolveDocMetaByName`
 * is `SELECT *`, so share_scope/share_role ride along). The requester's
 * `space_member` proof is carried by the token (absent => false, fail-closed,
 * design §5.2f/O1). The documentName shape and folder are validated against
 * doc_meta; a malformed, absent or inconsistent doc resolves to 'none'.
 */
export async function recheckCurrentRole(
  documentName: string,
  uid: string,
  principalSpaceId: string,
  spaceMember = false,
): Promise<ResolvedRole> {
  return (await recheckCurrentAccess(documentName, uid, principalSpaceId, spaceMember)).role
}
