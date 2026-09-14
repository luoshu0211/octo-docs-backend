/** PPT envelope adapter for the shared Human document permission model. */
import { docMetaRepo, type DocMeta } from '../../db/repos/docMetaRepo.js'
import { resolveRole } from '../../permission/resolveRole.js'
import { effectiveRole } from '../../permission/shareScope.js'
import type { ResolvedRole } from '../../permission/role.js'
import { HTML_PPT_DOC_TYPE } from '../../db/docType.js'
import { PptApiError } from './envelope.js'
import { confirmSpaceMembership } from '../../permission/spaceMembership.js'

export interface PptDocGuard {
  meta: DocMeta
  role: ResolvedRole
  /** Verified current principal is in the home Space; signed for rechecks. */
  spaceMember: boolean
}

export interface PptDocGuardCaller {
  token?: string
}

export async function loadPptDocForRead(
  uid: string,
  spaceId: string,
  docId: string,
  caller: PptDocGuardCaller = {},
): Promise<PptDocGuard> {
  const meta = await docMetaRepo.getByDocId(docId)
  if (!meta || meta.status === 0) throw new PptApiError('NOT_FOUND', 'document not found')
  if (!(await confirmSpaceMembership(uid, spaceId, caller.token ?? ''))) {
    throw new PptApiError('FORBIDDEN', 'current Space membership required')
  }
  // Same calculation as Docs/Board collab issuance: qualify owner/direct ACL
  // by the verified CURRENT Space, not by the location of the addressed deck.
  // Resolve membership once so role and signed share eligibility cannot disagree.
  const direct = await resolveRole(uid, meta.doc_id, spaceId)
  const spaceMember = spaceId === meta.space_id
  const role = effectiveRole(direct, spaceMember, meta.share_scope, meta.share_role)
  if (role === 'none') throw new PptApiError('FORBIDDEN', 'no access to this document')
  // Only an authorized caller can learn archived state or document kind.
  if (meta.status === 2) throw new PptApiError('CONFLICT', 'document is archived')
  if (meta.doc_type !== HTML_PPT_DOC_TYPE) {
    throw PptApiError.unsupportedDocumentType('document is not an html_ppt deck')
  }
  return { meta, role, spaceMember }
}
