/**
 * Online-document action matrix (OCTO-456 §3.3 doc 段 / §4.8 rename).
 *
 * ONE place maps a caller's effective role + the document's own facts to the
 * action bits both surfaces expose:
 *   - the internal contract `POST /internal/docs/capabilities` (drive's menu /
 *     capability projection, snake_case wire), and
 *   - the additive `capabilities` field on `POST /api/v1/docs/metadata`
 *     (camelCase wire).
 *
 * The bits are DERIVED from the role rank, never from stored numeric role
 * values, so the commenter-between-reader-and-writer ranking (§4.2) is honored
 * automatically.
 *
 *   reader     -> read, export, copy, download
 *   commenter  -> + comment
 *   writer     -> + edit
 *   admin      -> + share, rename original, delete original
 *
 * Known caveats (deliberate, documented in the OCTO-456 delivery report):
 *   - `canExport` is a COPY of `canRead`: docs-backend has no independent
 *     export permission bit, and export is bounded by read (§3.3).
 *   - `canDownloadOriginal` is also a copy of `canRead`: an online document has
 *     no separate "original file" grant; a reader may always download its
 *     rendered/converted form.
 *   - rename follows §4.8: `role >= admin` OR (doc_type = 'html' AND the caller
 *     is the row's original author `doc_meta.owner_id`). §7.2's stricter "html
 *     only the original author" wording is the reason the owner branch exists;
 *     the admin branch is the §4.8 rule shared with the PATCH endpoint
 *     (src/api/routes/docs.ts renameDocById), so the projection and the
 *     enforcement can never disagree.
 *   - delete original requires admin for all four online kinds (deletion is
 *     additionally human-only at the route layer; that mount-level rule is not
 *     part of this per-document matrix).
 */
import { HTML_DOC_TYPE } from '../db/docType.js'
import { roleAtLeast, type ResolvedRole } from './role.js'

/** The document facts the matrix depends on. */
export interface CapabilitySubject {
  doc_type: string
  owner_id: string
  /** Owner's home Space; the author identity is (uid, owner Space). */
  owner_space_id: string
}

/** One document's action matrix, camelCase (the public REST convention). */
export interface DocCapabilities {
  canRead: boolean
  canComment: boolean
  canEdit: boolean
  canShare: boolean
  canExport: boolean
  canCopy: boolean
  canRenameOriginal: boolean
  canDeleteOriginal: boolean
  canDownloadOriginal: boolean
}

/**
 * §4.8 rename authority: admin, or the original author of an `html` doc.
 *
 * The author identity is the COMPOUND (uid, owner Space), consistent with grey
 * visibility and every other mutation: `owner_id === uid` alone would let the
 * same UID acting in a different principal Space impersonate the author while
 * holding only a reader grant there. v3.1 §4.8 is read as "the original author
 * in the same Space"; a cross-Space owner keeps only the reader role it has.
 *
 * Used by BOTH the capability projection and the rename enforcement, so a caller
 * is never told it may rename a document that the route would reject (or vice
 * versa).
 */
export function canRenameOriginal(
  role: ResolvedRole,
  docType: string,
  ownerId: string,
  ownerSpaceId: string,
  uid: string,
  principalSpaceId: string,
): boolean {
  if (roleAtLeast(role, 'admin')) return true
  return docType === HTML_DOC_TYPE
    && ownerId !== ''
    && ownerId === uid
    && ownerSpaceId !== ''
    && ownerSpaceId === principalSpaceId
}

/** Delete-original authority: admin of the document (all online kinds). */
export function canDeleteOriginal(role: ResolvedRole): boolean {
  return roleAtLeast(role, 'admin')
}

/**
 * Build the action matrix for `uid` on one document.
 *
 * `role` is the caller's EFFECTIVE role (resolveEffectiveRole), so a
 * share-scope / drive-derived reader is projected exactly like a direct one.
 */
export function docCapabilitiesFor(
  role: ResolvedRole,
  subject: CapabilitySubject,
  uid: string,
  principalSpaceId: string,
): DocCapabilities {
  // Fail closed: a 'none' caller gets nothing, even though canExport/canCopy are
  // documented as copies of canRead (both are false here).
  const canRead = roleAtLeast(role, 'reader')
  return {
    canRead,
    canComment: roleAtLeast(role, 'commenter'),
    canEdit: roleAtLeast(role, 'writer'),
    canShare: roleAtLeast(role, 'admin'),
    canExport: canRead,
    canCopy: canRead,
    canRenameOriginal: canRenameOriginal(
      role, subject.doc_type, subject.owner_id, subject.owner_space_id, uid, principalSpaceId,
    ),
    canDeleteOriginal: canDeleteOriginal(role),
    canDownloadOriginal: canRead,
  }
}
