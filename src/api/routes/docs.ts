/**
 * Document CRUD routes (§8.4): create / list / rename / soft-delete.
 * Mounted under /api/v1/docs.
 */
import { Router, type Router as ExpressRouter, type Request, type Response } from 'express'
import { docMetaRepo, type DocMeta } from '../../db/repos/docMetaRepo.js'
import { transaction, type Tx } from '../../db/pool.js'
import {
  CanonicalHtmlArchivedError,
  CanonicalHtmlDeletedError,
  CanonicalHtmlLegacyConflictError,
  DocOwnershipError,
} from '../../db/repos/docMetaRepo.js'
import { documentAsync } from '../services/documentRoute.js'
import { createDocument } from '../services/createDocument.js'
import { createPptDocument } from '../ppt/docs.js'
import { yjsDocumentRepo } from '../../db/repos/yjsDocumentRepo.js'
import { docViewHistoryRepo } from '../../db/repos/docViewHistoryRepo.js'
import { normalizeTypeFilter, isDocType, HTML_DOC_TYPE, HTML_PPT_DOC_TYPE } from '../../db/docType.js'
import { buildDocumentName, buildHtmlDocumentName, DocumentNameError } from '../../permission/documentName.js'
import { enqueueDocIndex, isSearchIndexedDoc } from '../../search/docIndexQueue.js'
import { refreshAndPublish } from '../../permission/epoch.js'
import { roleFromNumber, type Role } from '../../permission/role.js'
import {
  parseShareScope,
  parseShareRole,
  shareScopeName,
  shareRoleName,
  SHARE_SCOPE_RESTRICTED,
  SHARE_SCOPE_AUTHENTICATED,
  SHARE_ROLE_READ,
  SHARE_ROLE_COMMENT,
  SHARE_ROLE_EDIT,
  DISCOVERABILITY_SPACE,
} from '../../permission/shareScope.js'
import { buildWhiteboardName, WhiteboardNameError } from '../../whiteboard/schema/index.js'
import { newDocId } from '../../util/ids.js'
import { buildDocShareUrl } from '../../util/docShareLink.js'
import { config } from '../../config/env.js'
import { getOctoIdentity } from '../../auth/octoIdentity.js'
import { requireDocRole, resolveDocRole } from '../guard.js'
import { resolveRole } from '../../permission/resolveRole.js'
import { resolveRequestPrincipalSpace } from '../../permission/principalSpace.js'
import { editPptLive } from '../../ppt/liveEdit.js'
import { renameHtmlDoc, applyHtmlPublishTitle } from '../services/htmlRenameDoc.js'
import { PptApiError, PPT_ERROR_STATUS } from '../ppt/envelope.js'
import { renameCliDoc, setCliShareSettings } from '../cliv2/access.js'
import { CliError } from '../cliv2/auth.js'
import { resolveEffectiveRole } from '../../permission/resolveEffectiveRole.js'
import { canRenameOriginal, docCapabilitiesFor } from '../../permission/docCapabilities.js'
import { trimTitleWhitespace, titleRuneLength } from '../../util/title.js'
import { type ResolvedRole } from '../../permission/role.js'
import { issueCollabTokenByDocId } from '../../auth/issueCollabToken.js'
import { recordVerifiedRecentView } from '../services/recordRecentView.js'
import { scheduleDriveViewForward } from '../../drive/viewEventForwarder.js'
import { requireSpaceMembership, spaceContextMiddleware } from '../middleware/spaceContext.js'
import { requireVerifiedHumanCurrentSpace, resolveHumanCurrentSpace } from '../middleware/docSpaceScope.js'
import { searchDocs, VisibleTermsTooLargeError, encodeSearchCursor, decodeSearchCursor } from '../../search/osClient.js'

export const docsRouter: ExpressRouter = Router()

/** Project only the share controls that the Bot API is allowed to know about. */
function botShareProjection(
  shareScope: number,
  shareRole: number,
  permissionEpoch: number,
): { shareScope?: string; shareRole?: string; permissionEpoch: number } {
  return {
    ...(shareScope === SHARE_SCOPE_AUTHENTICATED ? {} : {
      shareScope: shareScopeName(shareScope),
      shareRole: shareRoleName(shareRole),
    }),
    permissionEpoch,
  }
}

const DEFAULT_FOLDER = 'f_default'

/** Serialize a validated persisted role to the wire enum. */
const roleName = (n: number): Role | undefined => roleFromNumber(n)

/** Normalize a repeated query param (`?creator=a&creator=b`) to a string[]. */
function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  if (typeof v === 'string') return [v]
  return []
}

/**
 * Resolve whether the caller is a member of the space they are querying — the
 * READ-side twin of resolveEffectiveRole's write-side membership gate. A bot's
 * `req.spaceId` is server-resolved (verifyBot reverse lookup, anti-spoof), so a
 * bot is by definition a member of it — this mirrors resolveEffectiveRole's isBot
 * short-circuit. A human carries an UNVERIFIED `X-Space-Id`, so membership is
 * confirmed via isSpaceMember, which fails closed to `false` on any lookup error.
 * The space-share read branch therefore only opens on a confirmed membership,
 * never on a spoofed header or a transient failure — keeping the read side
 * symmetric with the write side and closing the cross-space metadata leak.
 */
async function resolveViewerSpaceMembership(req: Request): Promise<boolean> {
  if (req.botToken !== undefined || req.docSpaceScope?.mode === 'cli') return true
  // isSpaceMember documents a fail-closed `false` on lookup errors, but a rejected
  // promise would still bubble to a 500 on /docs, /docs/recent and
  // /docs/recent/creators instead of merely dropping the share branch. Catch it
  // here so a transient identity-service failure degrades to "not a member" —
  // symmetric with the write-side gate's fail-closed intent — never a 500.
  return getOctoIdentity()
    .isSpaceMember(req.uid!, req.spaceId!, req.octoToken ?? '')
    .catch(() => false)
}

/**
 * docType value the front-end stamps on whiteboards (DocsHome create menu /
 * docsApi). Boards persist + address under the 5-segment `:wb:` key; everything
 * else is a rich-text document under the 4-segment key.
 */
const WHITEBOARD_DOC_TYPE = 'board'
// Re-export the shared read-only html kind constant (defined in db/docType.ts,
// the doc_type source of truth) so existing importers of this module keep
// working while the collab-token chokepoint reuses the same value.
export { HTML_DOC_TYPE }

/**
 * Build the canonical persistence/routing document_name for a freshly created
 * doc. This is the SINGLE place a new key is minted, and it must agree with the
 * key the client addresses on join and the key onAuthenticate parses:
 *
 *   - whiteboard (docType 'board'): `octo:{space}:{folder}:wb:{docId}` (5-seg) —
 *     the board id is the {board} segment (BoardSession passes `board: docId`),
 *     so collab-token issuance + WS auth resolve the row by the same key the
 *     browser joins with. Minting a 4-seg `d_` key here was the hop-2 join 404:
 *     persistence wrote 4-seg while the client/auth path addressed 5-seg `:wb:`.
 *   - html registration: `octo:{space}:{folder}:html:{docId}` (5-seg).
 *   - document: `octo:{space}:{folder}:{docId}` (4-seg).
 *
 * Throws DocumentNameError / WhiteboardNameError on an illegal segment.
 */
export function buildCreatedDocumentName(
  spaceId: string,
  folder: string,
  docId: string,
  docType: string,
): string {
  // documentName 3rd segment MUST equal folder_id (§8.1 invariant).
  if (docType === WHITEBOARD_DOC_TYPE) return buildWhiteboardName(spaceId, folder, docId)
  if (docType === HTML_DOC_TYPE) return buildHtmlDocumentName(spaceId, folder, docId)
  if (docType === HTML_PPT_DOC_TYPE) {
    // Defense-in-depth: html_ppt keys are minted via buildPptDocumentName in the
    // /api/v1/ppt create path, never here. The legacy create handler rejects
    // html_ppt up front (422), so this throw is only reached if a future caller
    // wires html_ppt into this builder by mistake — fail loud instead of minting
    // a 4-seg document key that would route the deck into the Yjs path.
    throw new DocumentNameError('html_ppt documentName must be built via buildPptDocumentName')
  }
  return buildDocumentName(spaceId, folder, docId)
}

/** POST /api/v1/docs — create. Creator becomes owner (implicit admin, §4.2). */
export async function createDocHandler(req: Request, res: Response) {
  const uid = req.uid!
  const { folderId, title, docType, octoDocSlug, idempotencyKey, mountType } = req.body ?? {}
  // Space isolation (P3): the space is sourced solely from the enforced
  // X-Space-Id header (req.spaceId, set by spaceContextMiddleware, guaranteed
  // non-empty). The transitional body.spaceId fallback (P1) is removed — any
  // spaceId in the request body is ignored; the header is the single source of
  // truth. The empty guard below stays as defense-in-depth for the header.
  const spaceId = req.spaceId ?? ''
  if (spaceId === '') {
    res.status(400).json({ error: 'spaceId required' })
    return
  }
  if (typeof title === 'string' && title.length > 512) {
    res.status(400).json({ error: 'title too long' })
    return
  }
  const folder = typeof folderId === 'string' && folderId !== '' ? folderId : DEFAULT_FOLDER
  const resolvedDocType = typeof docType === 'string' && docType !== '' ? docType : 'doc'
  if (resolvedDocType === HTML_PPT_DOC_TYPE) {
    try { res.status(201).json(await createPptDocument(req)) }
    catch (error) {
      if (!(error instanceof PptApiError)) throw error
      res.status(PPT_ERROR_STATUS[error.code]).json({ error: error.message, code: error.code, details: error.details })
    }
    return
  }
  if (resolvedDocType !== HTML_DOC_TYPE && idempotencyKey !== undefined) {
    res.status(400).json({ error: 'idempotencyKey is only valid for html documents' })
    return
  }
  if (!isDocType(resolvedDocType)) {
    // Make the wrong-kind gate TOTAL, not exact-match-on-html_ppt: any doc_type
    // outside DOC_TYPES would otherwise be persisted verbatim into
    // doc_meta.doc_type (VARCHAR, no CHECK constraint) and fall through to a
    // 4-seg Yjs document. Reject unknown types up front.
    res.status(400).json({ error: 'invalid_doc_type' })
    return
  }
  if (resolvedDocType === HTML_DOC_TYPE) {
    if (req.docSpaceScope?.mode === 'cli') {
      // Go's Unicode whitespace includes NEL; ECMAScript whitespace includes BOM.
      if (typeof idempotencyKey === 'string' && /^[\s\u0085]|[\s\u0085]$/u.test(idempotencyKey)) {
        throw new CliError('VALIDATION_ERROR')
      }
      // The CLI middleware supplies the owner and Space for both HTML modes.
      if (['owner', 'ownerId', 'ownerSpaceId', 'spaceId', 'publisherUid', 'uid', 'slug', 'docId'].some(
        key => Object.hasOwn(req.body, key),
      )) throw new CliError('VALIDATION_ERROR')
    } else if (!req.botToken) {
      res.status(400).json({ error: 'html registration requires bot mount' })
      return
    }
    const canonicalUnmounted = idempotencyKey !== undefined
      && (mountType === undefined || mountType === null || mountType === '')
    if (!canonicalUnmounted && mountType !== 'group' && mountType !== 'space' && mountType !== 'thread') {
      res.status(400).json({ error: 'mountType must be group, space, or thread' })
      return
    }
    if (idempotencyKey !== undefined && octoDocSlug !== undefined) {
      res.status(400).json({ error: 'idempotencyKey and octoDocSlug are mutually exclusive' })
      return
    }
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '')) {
      res.status(400).json({ error: 'idempotencyKey required' })
      return
    }
    if (typeof idempotencyKey === 'string' && idempotencyKey.trim().length > 128) {
      res.status(400).json({ error: 'idempotencyKey too long' })
      return
    }
    if (idempotencyKey === undefined && (typeof octoDocSlug !== 'string' || octoDocSlug === '')) {
      res.status(400).json({ error: 'octoDocSlug required' })
      return
    }
    if (idempotencyKey === undefined && octoDocSlug.length > 128) {
      res.status(400).json({ error: 'octoDocSlug too long' })
      return
    }
  }
  const docId = newDocId()
  let documentName: string
  try {
    documentName = buildCreatedDocumentName(spaceId, folder, docId, resolvedDocType)
  } catch (err) {
    if (err instanceof DocumentNameError || err instanceof WhiteboardNameError) {
      res.status(400).json({ error: err.message })
      return
    }
    throw err
  }
  const normalizedIdempotencyKey = typeof idempotencyKey === 'string' ? idempotencyKey.trim() : undefined
  const createInput = {
    docId,
    documentName,
    title: typeof title === 'string' ? title : '',
    ownerId: uid,
    spaceId,
    folderId: folder,
    docType: resolvedDocType,
    ...(resolvedDocType === HTML_DOC_TYPE ? { octoDocSlug: normalizedIdempotencyKey !== undefined ? docId : octoDocSlug } : {}),
    createdBy: uid,
  }
  let writeResult: {
    meta: Awaited<ReturnType<typeof docMetaRepo.getByDocId>>
    created: boolean
    memberReconciled?: boolean
    permissionEpoch?: number
  }
  if (resolvedDocType === HTML_DOC_TYPE) {
    try {
      if (normalizedIdempotencyKey !== undefined) {
        writeResult = await docMetaRepo.createCanonicalHtml({
          ...createInput,
          octoDocSlug: docId,
          idempotencyKey: normalizedIdempotencyKey,
          humanOwnerUid: req.botOwnerUid,
        })
      } else if (req.docSpaceScope?.mode === 'cli') {
        // A supplied handle may be HTML-owned content without a Docs registration.
        // Only the HTML service can vouch for its owner on first registration.
        const meta = await docMetaRepo.updateOwnedHtmlBySlug(octoDocSlug, spaceId, uid, typeof title === 'string' ? title : undefined)
        if (!meta) throw new CliError('NOT_FOUND')
        writeResult = { meta, created: false }
      } else {
        writeResult = await docMetaRepo.upsertHtmlByOctoDocSlug({
          ...createInput,
          octoDocSlug,
          humanOwnerUid: req.botOwnerUid,
        })
      }
    } catch (err) {
      if (err instanceof CanonicalHtmlDeletedError) {
        res.status(410).json({ error: 'canonical_document_deleted' })
        return
      }
      if (err instanceof CanonicalHtmlArchivedError) {
        res.status(409).json({ error: 'canonical_document_archived' })
        return
      }
      if (err instanceof CanonicalHtmlLegacyConflictError) {
        res.status(409).json({ error: 'canonical_document_conflict' })
        return
      }
      // Default-deny (P0): a non-owner upsert of an existing slug is rejected
      // rather than silently overwriting/reviving another bot's row. Mirrors the
      // 403 the sibling rename/delete (requireDocRole('admin')) paths return.
      if (err instanceof DocOwnershipError) {
        res.status(403).json({ error: 'forbidden' })
        return
      }
      throw err
    }
  } else {
    writeResult = await createDocument({
      input: createInput,
      humanOwnerUid: req.docSpaceScope?.mode === 'bot' ? req.botOwnerUid : undefined,
      complete: async (_tx, meta) => ({ meta, created: true, memberReconciled: false }),
    })
  }
  const meta = writeResult.meta
  // Fresh and historical legacy membership writes happen in the repository
  // transaction. Publish only a committed historical reconcile.
  if (meta && resolvedDocType === HTML_DOC_TYPE && normalizedIdempotencyKey === undefined && writeResult.memberReconciled) {
    await refreshAndPublish(
      meta.document_name ?? documentName,
      writeResult.permissionEpoch ?? Number(meta.permission_epoch),
      req.botOwnerUid,
    )
  }

  const responseDocId = resolvedDocType === HTML_DOC_TYPE ? (meta?.doc_id ?? docId) : docId
  const responseDocumentName = resolvedDocType === HTML_DOC_TYPE ? (meta?.document_name ?? documentName) : documentName
  const responseSpaceId = resolvedDocType === HTML_DOC_TYPE ? (meta?.space_id ?? spaceId) : spaceId
  const responseFolderId = resolvedDocType === HTML_DOC_TYPE ? (meta?.folder_id ?? folder) : folder
  const responseOwnerId = resolvedDocType === HTML_DOC_TYPE ? (meta?.owner_id ?? uid) : uid
  // Legacy slug registration historically signals immediately. Canonical HTML
  // allocation waits for /:docId/published because its body is not durable yet.
  if (resolvedDocType === HTML_DOC_TYPE && normalizedIdempotencyKey === undefined
      && config.search.indexEnabled && isSearchIndexedDoc(responseDocumentName)) {
    void enqueueDocIndex(responseDocumentName)
  }
  res.status(201).json({
    docId: responseDocId,
    documentName: responseDocumentName,
    title: meta?.title ?? '',
    spaceId: responseSpaceId,
    folderId: responseFolderId,
    ownerId: responseOwnerId,
    docType: resolvedDocType,
    ...(resolvedDocType === HTML_DOC_TYPE ? { octoDocSlug: meta?.octo_doc_slug ?? octoDocSlug } : {}),
    ...(resolvedDocType === HTML_DOC_TYPE ? { created: writeResult.created, publisherUid: uid } : {}),
    // The caller is always admin on this response: a fresh create makes the
    // caller the owner (implicit admin, §4.2), and the idempotent update branch
    // (created:false) is now reachable ONLY by the owning bot — the repo's
    // owner固化 gate 403s every non-owner before this line. So 'admin' is the
    // caller's TRUE role on every surviving path (no fail-open).
    role: 'admin',
    createdAt: meta?.created_at,
    // Canonical browser-facing link a caller can pass straight to chat. See
    // buildDocShareUrl / config.webOrigin.
    shareUrl: buildDocShareUrl(config.webOrigin, responseDocId, responseSpaceId),
  })
}

// WRITE routes whose target is chosen by the space alone carry
// requireSpaceMembership: `POST /` mints a NEW row into the named space, so no
// document exists yet to resolve a role from and the header IS the whole
// authorization. Confirming it here is what stops a session holder from planting
// a doc into a space they do not belong to.
//
// Collection reads (`GET /`, `POST /search`, `GET /recent`,
// `GET /recent/creators`) also carry requireSpaceMembership. Their repositories
// query Space-qualified principals, so the client-supplied X-Space-Id must first
// be upgraded into the trusted req.principalSpaceId by an active-membership check.
// A forged Space therefore fails with 404 before any principal-qualified query.
//
// The `/:docId` routes below also do NOT carry it: requireDocRole is strictly
// stronger there (real-uid role resolution + principal-qualified direct-role resolution for Bot/Human requests).
// See api/middleware/spaceContext.ts for why this is per-route, not global.
docsRouter.post('/', requireSpaceMembership, documentAsync(createDocHandler))

async function prepareHtmlPublication(req: Request, res: Response, tx?: Tx) {
  const docId = req.params.docId!
  const meta = tx
    ? (await tx.query<DocMeta>('SELECT * FROM doc_meta WHERE doc_id = ? FOR UPDATE', [docId]))[0]
    : await docMetaRepo.getByDocId(docId)
  if (!meta || meta.space_id !== req.spaceId) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  if (tx && (meta.owner_space_id !== req.principalSpaceId || meta.owner_id !== req.uid)) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  if (meta.owner_id !== req.uid) {
    res.status(403).json({ error: 'forbidden' })
    return
  }
  if (meta.status === 0) {
    res.status(410).json({ error: 'canonical_document_deleted' })
    return
  }
  if (meta.status === 2 || meta.doc_type !== HTML_DOC_TYPE) {
    res.status(409).json({ error: meta.status === 2 ? 'document_archived' : 'wrong_document_type' })
    return
  }
  const { title } = req.body ?? {}
  if (title !== undefined && (typeof title !== 'string' || title.length > 512)) {
    res.status(400).json({ error: typeof title === 'string' ? 'title too long' : 'invalid_title' })
    return
  }
  if (typeof title === 'string') {
    if (tx) await docMetaRepo.rename(meta.doc_id, title, req.uid!, tx)
    else await docMetaRepo.rename(meta.doc_id, title, req.uid!)
  }
  return { meta, title: typeof title === 'string' ? title : meta.title }
}

/** Notify the backend after HTML content is durably published. */
export async function publishHtmlHandler(req: Request, res: Response) {
  const cli = req.docSpaceScope?.mode === 'cli'
  if (!cli && req.botToken === undefined) {
    res.status(403).json({ error: 'forbidden' })
    return
  }
  const prepared = cli
    ? await transaction(tx => prepareHtmlPublication(req, res, tx))
    : await prepareHtmlPublication(req, res)
  if (!prepared) return
  const { meta, title } = prepared
  let indexed = false
  if (config.search.indexEnabled && isSearchIndexedDoc(meta.document_name)) {
    indexed = await enqueueDocIndex(meta.document_name)
  }
  res.status(200).json({ docId: meta.doc_id, title, indexed })
}

docsRouter.post('/:docId/published', publishHtmlHandler)

/**
 * POST /api/v1/docs/{docId}/duplicate — mint an INDEPENDENT copy of a document
 * (§4.4 复制：「复制」产生新的 docId，与原文档后续修改互不影响).
 *
 * This is the deep-copy primitive the Drive "复制到" flow calls. It is NOT a
 * second mount of the source doc: the duplicate gets its own `doc_id`, its own
 * `document_name`, its own `yjs_document` row and its own ACL (the caller owns
 * it; the source's `doc_member` rows are NOT copied, so a copy never silently
 * re-grants anyone).
 *
 * Authorization: `reader` on the source (mirrors "可读即可复制" at the docs
 * layer — the source directory's edit right and the target library's write
 * right are Drive-side concerns and are checked there before this call).
 *
 * Only the Yjs-backed kinds (`doc` / `sheet` / `board`) can be duplicated here:
 * their whole body IS the `yjs_document` row, so copying that row yields a
 * faithful independent document. `html` (body lives in octo-doc) and `html_ppt`
 * (Bento) own their bodies in sibling services and answer 422 until those expose
 * a copy of their own.
 *
 * Body (all optional):
 *   - title:    the copy's title. Defaults to `${source.title}-副本`.
 *   - spaceId:  must equal the source document's space when present. The copy
 *               stays in the document's home space; moving it between *Drive*
 *               libraries is the mount layer's job, not the doc's.
 */
export async function duplicateDocHandler(req: Request, res: Response) {
  const sourceDocId = req.params.docId!
  const guard = await requireDocRole(req, res, sourceDocId, 'reader')
  if (!guard) return
  const { meta } = guard
  const uid = req.uid!
  const body = (req.body ?? {}) as { title?: unknown; spaceId?: unknown }

  if (meta.doc_type === HTML_DOC_TYPE || meta.doc_type === HTML_PPT_DOC_TYPE) {
    res.status(422).json({ error: 'unsupported_document_type' })
    return
  }
  if (typeof body.spaceId === 'string' && body.spaceId !== '' && body.spaceId !== meta.space_id) {
    res.status(400).json({ error: 'space_mismatch' })
    return
  }
  const requestedTitle = typeof body.title === 'string' ? body.title.trim() : ''
  if (requestedTitle.length > 512) {
    res.status(400).json({ error: 'title too long' })
    return
  }
  const title = requestedTitle !== '' ? requestedTitle : `${meta.title}-副本`

  const docId = newDocId()
  let documentName: string
  try {
    documentName = buildCreatedDocumentName(meta.space_id, meta.folder_id, docId, meta.doc_type)
  } catch (err) {
    if (err instanceof DocumentNameError || err instanceof WhiteboardNameError) {
      res.status(400).json({ error: err.message })
      return
    }
    throw err
  }

  // Read BEFORE opening the tx: a source that was never opened or stored has no
  // yjs_document row (persistence only materialises on first store), and the
  // duplicate then legitimately starts empty — exactly like a fresh doc.
  const sourceState = await yjsDocumentRepo.fetchState(meta.document_name)

  await transaction(async (tx) => {
    await docMetaRepo.createTx(tx, {
      docId,
      documentName,
      title,
      ownerId: uid,
      spaceId: meta.space_id,
      folderId: meta.folder_id,
      docType: meta.doc_type,
      createdBy: uid,
    })
    if (sourceState && sourceState.state.length > 0) {
      // fetchState already decoded the storage encoding, so re-encode on write
      // with the SAME generation: a copy must be byte-compatible with how the
      // source is read today, not silently downgraded to the current default.
      await yjsDocumentRepo.upsertStateTx(
        tx,
        documentName,
        Buffer.from(sourceState.state),
        sourceState.encoding,
      )
    }
  })

  // The body was copied behind the collab server's back, so its afterStoreDocument
  // index feed will not fire for this documentName. Enqueue it exactly like the
  // html registration path does. Best-effort: the queue swallows its own errors.
  if (config.search.indexEnabled && isSearchIndexedDoc(documentName)) {
    void enqueueDocIndex(documentName)
  }

  const created = await docMetaRepo.getByDocId(docId)
  res.status(201).json({
    docId,
    documentName,
    title,
    spaceId: meta.space_id,
    folderId: meta.folder_id,
    ownerId: uid,
    docType: meta.doc_type,
    role: 'admin',
    createdAt: created?.created_at,
    shareUrl: buildDocShareUrl(config.webOrigin, docId, meta.space_id),
  })
}

docsRouter.post('/:docId/duplicate', documentAsync(duplicateDocHandler))

/** GET /api/v1/docs/{docId} — fetch one doc's metadata (needs reader). */
export async function getDocHandler(req: Request, res: Response) {
  const docId = req.params.docId!
  const guard = await requireDocRole(req, res, docId, 'reader')
  if (!guard) return
  const { meta, role } = guard
  res.status(200).json({
    docId: meta.doc_id,
    documentName: meta.document_name,
    title: meta.title,
    ownerId: meta.owner_id,
    createdBy: meta.created_by,
    updatedBy: meta.updated_by,
    spaceId: meta.space_id,
    folderId: meta.folder_id,
    docType: meta.doc_type,
    ...(meta.octo_doc_slug ? { octoDocSlug: meta.octo_doc_slug } : {}),
    role,
    createdAt: meta.created_at,
    updatedAt: meta.updated_at,
    // Canonical browser-facing link a caller can pass straight to chat. See
    // buildDocShareUrl / config.webOrigin.
    shareUrl: buildDocShareUrl(config.webOrigin, meta.doc_id, meta.space_id),
    // Human metadata carries the complete dialog state. Bot metadata uses the
    // same restricted projection as the dedicated share endpoints so Human-only
    // controls cannot leak through an alternate response surface.
    ...(req.botToken !== undefined
      ? botShareProjection(meta.share_scope, meta.share_role, meta.permission_epoch)
      : {
          shareScope: shareScopeName(meta.share_scope),
          shareRole: shareRoleName(meta.share_role),
          spaceSearchable: meta.discoverability_scope === DISCOVERABILITY_SPACE,
          ...(meta.permission_epoch != null ? { permissionEpoch: meta.permission_epoch } : {}),
        }),
  })
}

/** GET /api/v1/docs — list docs the caller owns or is a member of. */
export async function listDocsHandler(req: Request, res: Response) {
  const uid = req.uid!
  // Space isolation (P1): the space is the enforced X-Space-Id header
  // (req.spaceId, set by spaceContextMiddleware), never a client-supplied query
  // param. Listing is hard-scoped to that space.
  const spaceId = req.spaceId!
  const folderId = typeof req.query.folderId === 'string' ? req.query.folderId : undefined
  // FEAT-B: `owner=me` narrows to strictly the caller's own docs (excludes
  // shared-with-me); `q` is a filename substring search. Both are optional and
  // additive — omitting them preserves the pre-FEAT-B behavior verbatim.
  const requestedOwner = req.query.owner === 'me' ? 'me' : undefined
  // FEAT: for owner=me, "my documents" also includes docs owned by bots this
  // human owns (req.ownedBots, from octo verify). Defaults to [] so listForUser
  // degrades to strictly the caller's own docs when absent.
  const ownedBots = req.ownedBots ?? []
  const q = typeof req.query.q === 'string' ? req.query.q : undefined
  // Explicit Human-only filename discovery. The repository also requires a
  // nonblank q and confirmed Space membership, so this flag can never widen a
  // blank listing or the Bot collection surface.
  const discoveryRequested = req.query.discoverable === 'true' && (q ?? '').trim() !== ''
  // FEAT-B/XIN-1188: optional multi-value `?type=` kind filter (repeated param,
  // never CSV). Validated against the fixed enum; unknown/absent => no filter.
  const types = normalizeTypeFilter(req.query.type)
  const page = Math.max(1, Number(req.query.page ?? 1) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 20) || 20))
  const sort = req.query.sort === 'updatedAt:asc' ? 'updatedAt:asc' : 'updatedAt:desc'

  // Space-share visibility must match the write side: only a confirmed member of
  // the queried space sees its anyone_in_space docs. owner='me' excludes the share
  // branch outright, so skip the membership lookup entirely in that case.
  const isSpaceMember = requestedOwner === 'me' && !discoveryRequested
    ? false
    : await resolveViewerSpaceMembership(req)
  const includeDiscoverable = discoveryRequested
    && req.botToken === undefined
    && isSpaceMember
  // An explicit discovery search is global within the verified Space, even if
  // a stale client also sends owner=me. Outside discovery mode old semantics
  // stay byte-for-byte compatible.
  const owner = includeDiscoverable ? undefined : requestedOwner

  const { total, items } = await docMetaRepo.listForUser({ uid, spaceId, principalSpaceId: req.principalSpaceId!, isSpaceMember, folderId, owner, ownedBots, includeDiscoverable, q, types, page, pageSize, sort })
  // The SQL list role may be synthetic (owned Bot) or archived; only the shared
  // read guard proves the active access required to disclose actor fields.
  // Discoverable rows without a SQL role may still be Drive-readable.

  const readableDocIds = new Set<string>()
  await Promise.all(items.map(async (d) => {
    const role = roleName(Number(d.role))
    if (!role && !includeDiscoverable) return
    const result = await resolveDocRole(req, d.doc_id, 'reader')
    if (result.ok) readableDocIds.add(d.doc_id)
  }))

  const visibleItems = items.flatMap((d) => {
    const role = roleName(Number(d.role))
    if (!role && !includeDiscoverable) return []
    const canRead = readableDocIds.has(d.doc_id)
    return [{
      docId: d.doc_id,
      title: d.title,
      ownerId: d.owner_id,
      ...(canRead ? { createdBy: d.created_by, updatedBy: d.updated_by } : {}),
      docType: d.doc_type,
      // A discoverable-but-inaccessible row exposes only list metadata. In
      // particular, never disclose the HTML collaboration/body addressing.
      ...(role && d.octo_doc_slug ? { octoDocSlug: d.octo_doc_slug } : {}),
      ...(role ? { role } : {}),
      ...(includeDiscoverable ? { canOpen: !!role } : {}),
      updatedAt: d.updated_at,
    }]
  })
  res.status(200).json({ total, items: visibleItems })
}

docsRouter.get('/', documentAsync(listDocsHandler))

const MAX_METADATA_DOC_IDS = 500
const METADATA_ROLE_LOOKUP_CONCURRENCY = 100

/** Return metadata only for documents the caller can read, without per-doc HTTP errors. */
export async function docsMetadataHandler(req: Request, res: Response): Promise<void> {
  const rawDocIds: unknown = req.body?.docIds
  if (
    !Array.isArray(rawDocIds)
    || rawDocIds.length > MAX_METADATA_DOC_IDS
    || rawDocIds.some((docId: unknown) => typeof docId !== 'string')
  ) {
    res.status(400).json({ error: 'invalid_doc_ids' })
    return
  }

  // Human collection requests still require a verified current Space. This is a
  // request-level failure, not a document result, so preserve the GET guard's
  // existing 400/404 response once rather than repeating it for every ID.
  if (req.docSpaceScope?.mode === 'human') {
    const currentSpace = await resolveHumanCurrentSpace(req)
    if (!currentSpace.verified) {
      res.status(currentSpace.status).json({ error: currentSpace.error })
      return
    }
  }

  // Preserve input order while bounding ACL fan-out below the 500-item batch cap.
  // OCTO-456: each readable item also carries the caller's role + action matrix.
  // They are computed from the SAME guard result that proved readability, so the
  // projection can never disagree with the ACL check; nothing is returned for a
  // doc the caller cannot read (unchanged "skip unreadable" semantics).
  interface MetadataItem {
    docId: string
    createdBy: string
    updatedBy: string
    updatedAt: Date
    role: ResolvedRole
    capabilities: ReturnType<typeof docCapabilitiesFor>
  }

  const docIds = [...new Set(rawDocIds as string[])]
  const itemsByIndex: Array<MetadataItem | undefined> = new Array(docIds.length)
  let nextIndex = 0
  const workers = Math.min(METADATA_ROLE_LOOKUP_CONCURRENCY, docIds.length)
  await Promise.all(Array.from({ length: workers }, async () => {
    for (;;) {
      const index = nextIndex++
      if (index >= docIds.length) return
      const docId = docIds[index]!
      const result = await resolveDocRole(req, docId, 'reader')
      if (!result.ok) continue
      const { meta } = result.guard
      itemsByIndex[index] = {
        docId,
        createdBy: meta.created_by,
        updatedBy: meta.updated_by,
        updatedAt: meta.updated_at,
        role: result.guard.role,
        capabilities: docCapabilitiesFor(result.guard.role, meta, req.uid!, req.principalSpaceId ?? ''),
      }
    }
  }))
  const items = itemsByIndex.filter((item): item is MetadataItem => item !== undefined)
  res.status(200).json({ items })
}

docsRouter.post('/metadata', documentAsync(docsMetadataHandler))

/**
 * OCTO-456 §4.3 — per-hit index freshness for the front-end badge.
 *
 * The enum is ready | processing | failed | unsupported. docs-backend stores NO
 * per-document indexing state anywhere: the indexer is a separate service
 * consuming a Kafka change signal and writing OpenSearch, and neither the doc
 * row nor the OS `_source` carries an index-status column. Any other value here
 * would be invented, so every hit that OpenSearch actually RETURNED (by
 * definition it was indexed) is reported `ready`. The other enum members are
 * reserved for a future indexer-reported state; they are never synthesized.
 */
export type SearchIndexStatus = 'ready' | 'processing' | 'failed' | 'unsupported'

export function searchIndexStatus(): SearchIndexStatus {
  return 'ready'
}

/**
 * POST /api/v1/docs/search — full-text search with permission down-push (P4).
 *
 * MySQL computes the FULL visible set first (§5.3): the caller's visible doc_id
 * set — owner OR doc_member OR (for a confirmed space member) share_scope=anyone,
 * all gated by status=1. That set is pushed DOWN into the OpenSearch query as a
 * `doc_id IN <set>` filter (§5.4), alongside space + status. OS then does the
 * FULL-TEXT match, highlight, AND pagination — every hit
 * is already within the caller's access, so there is NO per-hit MySQL re-check
 * (§6.4). For space members, anyone_in_space docs ARE enumerated into that set
 * in MySQL (docMetaRepo adds `OR m.share_scope = ANYONE`), trading scale for a
 * clean fail-closed doc_id filter that also drops stale/soft-deleted OS copies.
 * NOTE: a very large space can push visibleDocIds past OpenSearch
 * `index.max_terms_count` (default 65536), which surfaces as a 503; bound this
 * before enabling search on large spaces.
 *
 * Registered BEFORE the '/:docId' routes so the '/search' literal is never
 * shadowed by the single-doc param route.
 *
 * Pagination is keyset (search_after), NOT offset: the client omits `cursor` on
 * the first page and echoes back the response's `nextCursor` for each subsequent
 * page. `nextCursor` is an opaque base64url token wrapping the last hit's sort
 * values; it is absent once there is no further page, so the client's stop
 * condition is simply "nextCursor missing" (never `page * size >= total`, which
 * offset paging can get wrong under index churn). `total` is still an exact count
 * for display, but no longer drives the stop.
 *
 *   body: { q: string, docType?: string[], cursor?: string, pageSize?: number }
 *   400 q required         q empty/missing
 *   400 invalid_cursor     cursor present but malformed
 *   503 search unavailable search disabled, OR OpenSearch errored (never fail-open)
 */
export async function searchDocsHandler(req: Request, res: Response) {
  // Gray release gate: with search disabled the endpoint never connects to OS.
  if (config.search.enabled === false) {
    res.status(503).json({ error: 'search unavailable', reason: 'search_disabled' })
    return
  }
  const uid = req.uid!
  const spaceId = req.spaceId!
  const { q, docType: docTypeRaw, cursor: cursorRaw, pageSize: pageSizeRaw } = req.body ?? {}
  if (typeof q !== 'string' || q.trim() === '') {
    res.status(400).json({ error: 'q required' })
    return
  }
  // Decode the opaque keyset cursor (absent => first page). A malformed cursor is
  // a client bug, not a transient failure — answer 400 rather than silently
  // restarting from page one (mirrors listRecentHandler's invalid_cursor path).
  let searchAfter
  try {
    searchAfter = decodeSearchCursor(typeof cursorRaw === 'string' ? cursorRaw : undefined) ?? undefined
  } catch {
    res.status(400).json({ error: 'invalid_cursor' })
    return
  }
  // Optional kind filter (§6.3): validated against the fixed doc_type enum;
  // unknown/absent => no filter. Pushed to both the MySQL constraint and OS filter.
  const docType = normalizeTypeFilter(docTypeRaw)
  const pageSize = Math.min(config.search.pageSizeMax, Math.max(1, Number(pageSizeRaw ?? 20) || 20))
  // Space-share visibility must match the list side: only a confirmed member of
  // the queried space sees its anyone_in_space docs (fail-closed on lookup error).
  const isSpaceMember = await resolveViewerSpaceMembership(req)

  // 1. MySQL: the caller's visible doc_id set (private + explicitly-granted +,
  //    for a confirmed member, space-share). All gated by status=1 in MySQL, so
  //    soft-deleted docs are absent here regardless of what OS still holds.
  //    Capped at maxVisibleTerms+1 rows: an oversized set is rejected below
  //    (searchDocs throws VisibleTermsTooLargeError) before a large terms array
  //    reaches OpenSearch, and the DB scan itself is bounded to limit+1 rather
  //    than the true count. Recomputed on every keyset page (stateless paging),
  //    so the bound also caps the per-page cost.
  const visibleDocIds = await docMetaRepo.listVisibleDocIdSet({
    uid,
    spaceId,
    principalSpaceId: req.principalSpaceId!,
    docType,
    isSpaceMember,
    limit: config.search.maxVisibleTerms,
  })

  // 2. OS: full-text match with the visibility constraint pushed down as a filter,
  //    keyset-paginated by OS via search_after. Empty visible set short-circuits to
  //    total=0 inside searchDocs (no OS call). OS error => 503, never fail-open.
  let result
  try {
    result = await searchDocs({
      spaceId,
      query: q.trim(),
      docType,
      visibleDocIds,
      size: pageSize,
      searchAfter,
    })
  } catch (err) {
    // A visible set too large to push down as a terms filter is a deterministic,
    // caller-observable limit (not a transient OS outage) — surface a distinct
    // reason so clients can narrow the query rather than blindly retry.
    if (err instanceof VisibleTermsTooLargeError) {
      res.status(503).json({ error: 'search unavailable', reason: 'terms_limit_exceeded' })
      return
    }
    res.status(503).json({ error: 'search unavailable' })
    return
  }

  // Hits are already within the visibility constraint and carry their own display
  // metadata from OS _source — no MySQL round-trip, no role (§6.3 response).
  // nextCursor is present only when searchDocs reported a further page; the client
  // stops paginating as soon as it is absent. `indexStatus` is additive
  // (OCTO-456 §4.3) and truthful: see searchIndexStatus().
  res.status(200).json({
    total: result.total,
    items: result.items.map((it) => ({
      docId: it.docId,
      title: it.title,
      docType: it.docType,
      updatedAt: it.updatedAt,
      spaceId: it.spaceId,
      indexStatus: searchIndexStatus(),
      ...(it.highlight ? { highlight: it.highlight } : {}),
    })),
    ...(result.searchAfter ? { nextCursor: encodeSearchCursor(result.searchAfter) } : {}),
  })
}

docsRouter.post('/search', searchDocsHandler)

/**
 * POST /api/v1/docs/{docId}/view — record that the caller opened this doc
 * (FEAT-B ingest, §3.1). Needs reader (reuses requireDocRole guard). The recent-
 * view WRITE is verified-or-skip (remove-sp §7.1): a bot records under its
 * server-resolved Space; a human records ONLY under a viewer Space whose active
 * membership is confirmed (never an unverified header, never the doc home Space),
 * otherwise the write is skipped and the response reports `recorded: false`.
 */
export async function recordDocViewHandler(req: Request, res: Response) {
  const uid = req.uid!
  const docId = req.params.docId!
  const guard = await requireDocRole(req, res, docId, 'reader')
  if (!guard) return
  const recorded = await recordVerifiedRecentView({
    scope: req.docSpaceScope ?? { mode: 'human' },
    uid,
    docId,
    viewerSpaceId: req.viewerSpaceId,
    token: req.octoToken,
    verifiedViewerSpaceId: req.verifiedViewerSpaceId,
  })
  // OCTO-456 §4.5: mirror a SUCCESSFUL view into Drive's 最近访问 read model.
  // Fire-and-forget on purpose — the open response must never wait on, or fail
  // because of, Drive. An unconfigured DRIVE_INTERNAL_URL/TOKEN silently skips.
  // The recorded viewedAt is forwarded verbatim so both recent lists agree.
  //
  // The forwarded principal space MUST be the Space the docs row was actually
  // written under (`recorded.spaceId`), NOT `req.principalSpaceId`: a human's
  // identity Space (S1) and the verified viewer Space (X-Space-Id: S2) can
  // differ, and docs just wrote S2. Using the principal Space would leave S2
  // missing and insert a phantom record into S1 in Drive's 最近访问.
  if (recorded) {
    scheduleDriveViewForward({
      uid,
      principalSpaceId: recorded.spaceId,
      docId: guard.meta.doc_id,
      spaceId: guard.meta.space_id,
      viewedAt: recorded.viewedAt,
    })
  }
  res
    .status(200)
    .json(recorded ? { ok: true, viewedAt: recorded.viewedAt.toISOString() } : { ok: true, recorded: false })
}

docsRouter.post('/:docId/view', recordDocViewHandler)

/**
 * GET /api/v1/docs/recent — the caller's recently-viewed docs (FEAT-B, §3.2).
 * keyset-paginated, viewed_at DESC. Query-time filtering (status + permission)
 * lives in the repo, so revoked / deleted / archived docs drop out immediately.
 */
export async function listRecentHandler(req: Request, res: Response) {
  const uid = req.uid!
  const spaceId = req.spaceId!
  const q = typeof req.query.q === 'string' ? req.query.q : undefined
  const creators = toStringArray(req.query.creator)
  // FEAT-B/XIN-1188: optional multi-value `?type=` kind filter (same convention
  // as `creator`). Validated against the fixed enum; unknown/absent => no filter.
  const types = normalizeTypeFilter(req.query.type)
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 20) || 20))
  const isSpaceMember = await resolveViewerSpaceMembership(req)
  let result
  try {
    result = await docViewHistoryRepo.listRecent({ uid, spaceId, principalSpaceId: req.principalSpaceId!, isSpaceMember, q, creators, types, cursor, pageSize })
  } catch (err) {
    if (err instanceof Error && err.message === 'invalid_cursor') {
      res.status(400).json({ error: 'invalid_cursor' })
      return
    }
    throw err
  }
  // Resolve the last-editor (updated_by) display names server-side so the
  // front-end (XIN-1236 merged-view) can render "<name> 更新于 <time>" without a
  // second round-trip — mirrors the creators handler's name resolution. Batch the
  // distinct non-empty uids through one directory call, authenticated with the
  // caller's own token; a uid that fails to resolve falls back to its own value.
  // updated_by is '' for a doc that has never been edited (schema DEFAULT ''),
  // which maps to updatedBy: null so the client can hide the editor line.
  const editorIds = [...new Set(result.items.map((d) => d.updated_by).filter((id) => id !== ''))]
  const editorNameByUid = new Map<string, string>()
  if (editorIds.length > 0) {
    const users = await getOctoIdentity().getUsers(editorIds, req.octoToken)
    for (const u of users) {
      const name = typeof u.name === 'string' ? u.name.trim() : ''
      if (name !== '') editorNameByUid.set(u.uid, name)
    }
  }
  const visibleItems = result.items.flatMap((d) => {
    const role = roleName(Number(d.role))
    if (!role) return []
    return [{
      docId: d.doc_id,
      title: d.title,
      ownerId: d.owner_id,
      isExternal: d.space_id !== spaceId,
      docType: d.doc_type,
      ...(d.octo_doc_slug ? { octoDocSlug: d.octo_doc_slug } : {}),
      role,
      updatedAt: d.updated_at,
      updatedBy:
        d.updated_by === ''
          ? null
          : { uid: d.updated_by, name: editorNameByUid.get(d.updated_by) ?? d.updated_by },
      viewedAt: new Date(d.viewed_at).toISOString(),
    }]
  })
  res.status(200).json({ total: result.total, items: visibleItems, nextCursor: result.nextCursor })
}

docsRouter.get('/recent', listRecentHandler)

/**
 * GET /manageable — keyset list of docs the caller DIRECTLY administers (owner
 * or a doc_member `admin` row) in the current Space, for the TES-131 drive
 * picker. Direct admin only (no share/drive-derived widening), mirroring the
 * internal role endpoint's direct-role contract. `X-Space-Id` is required
 * (spaceContextMiddleware). `?page_size=` clamps to 1..100; `?cursor=` is the
 * opaque token from the previous page's `nextCursor` (malformed => 400).
 */
export async function listManageableHandler(req: Request, res: Response) {
  const uid = req.uid!
  const spaceId = req.spaceId!
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined
  // OCTO-456 §4.4: optional title substring filter (`%q%`, case-insensitive),
  // ANDed with the existing owner/direct-admin + Space predicates. A blank q is
  // "no filter", so every pre-existing caller keeps its exact result set.
  const q = typeof req.query.q === 'string' && req.query.q.trim() !== '' ? req.query.q.trim() : undefined
  const pageSize = Math.min(100, Math.max(1, Number(req.query.page_size ?? 20) || 20))
  let result
  try {
    result = await docMetaRepo.listManageable({ uid, spaceId, principalSpaceId: req.principalSpaceId!, pageSize, cursor, q })
  } catch (err) {
    if (err instanceof Error && err.message === 'invalid_cursor') {
      res.status(400).json({ error: 'invalid_cursor' })
      return
    }
    throw err
  }
  const items = result.items.map((d) => ({
    docId: d.doc_id,
    title: d.title,
    ownerId: d.owner_id,
    docType: d.doc_type,
    ...(d.octo_doc_slug ? { octoDocSlug: d.octo_doc_slug } : {}),
    updatedAt: new Date(d.updated_at).toISOString(),
  }))
  res.status(200).json({ items, nextCursor: result.nextCursor })
}

/**
 * GET /api/v1/docs/recent/creators — distinct creators of the caller's
 * recently-viewed docs for the CreatorFilter dropdown (FEAT-B, §3.4). Scope:
 * q-filtered, creator-NOT-filtered, pre-pagination, permission-filtered — the
 * full distinct owner set. Display names are resolved server-side so the
 * front-end needs no per-uid lookups; a uid that fails to resolve falls back to
 * its own value as the name (a directory hiccup never drops a candidate).
 */
export async function listRecentCreatorsHandler(req: Request, res: Response) {
  const uid = req.uid!
  const spaceId = req.spaceId!
  const q = typeof req.query.q === 'string' ? req.query.q : undefined
  const isSpaceMember = await resolveViewerSpaceMembership(req)
  const ownerIds = await docViewHistoryRepo.listCreators({ uid, spaceId, principalSpaceId: req.principalSpaceId!, isSpaceMember, q })
  const nameByUid = new Map<string, string>()
  if (ownerIds.length > 0) {
    const users = await getOctoIdentity().getUsers(ownerIds, req.octoToken)
    for (const u of users) {
      const name = typeof u.name === 'string' ? u.name.trim() : ''
      if (name !== '') nameByUid.set(u.uid, name)
    }
  }
  res.status(200).json({
    creators: ownerIds.map((id) => ({ uid: id, name: nameByUid.get(id) ?? id })),
  })
}

docsRouter.get('/recent/creators', listRecentCreatorsHandler)

// Registered after GET '/' so the collection route is matched distinctly from
// the single-doc route (Express treats '/' and '/:docId' as separate paths).
docsRouter.get('/:docId', getDocHandler)

async function resolveDocIdBySlug(req: Request, res: Response): Promise<string | null> {
  const octoDocSlug = req.params.octoDocSlug!
  // A slug is only unique per Space, so it MUST be resolved within a Space. The
  // Space follows the per-mount policy (remove-sp §6): a bot uses its
  // server-resolved Space; a human uses the optional viewer Space (X-Space-Id).
  // octo-doc slug operations are bot-facing (html registration); a human with no
  // viewer Space simply cannot resolve a slug (404) — never another Space's row.
  const scope = req.docSpaceScope
  const slugSpace = scope?.mode === 'bot' ? scope.spaceId : (req.viewerSpaceId ?? '')
  const meta = await docMetaRepo.getByOctoDocSlug(octoDocSlug, slugSpace)
  if (!meta || meta.status === 0) {
    res.status(404).json({ error: 'not_found' })
    return null
  }
  return meta.doc_id
}

/**
 * Resolve a canonical HTML delete target. An already soft-deleted row is visible
 * only to its owning authenticated principal, which makes the retry idempotent
 * without allowing unrelated callers to probe deleted document existence.
 */
async function resolveCanonicalDeleteBySlug(req: Request, res: Response): Promise<{ docId: string; deleted: boolean } | null> {
  const meta = await docMetaRepo.getByOctoDocSlug(req.params.octoDocSlug!, req.spaceId!)
  if (!meta) {
    res.status(404).json({ error: 'not_found' })
    return null
  }
  if (meta.status === 0) {
    // Only the canonical identity contract is idempotent here. Historical
    // slug-registered rows retain their existing 404 behavior.
    //
    // slug === doc_id is a convention, not proof of canonical provenance: the
    // slug charset admits a `d_…` string, so a legacy registration can pick one
    // equal to its own doc id. Only the canonical insert populates
    // html_idempotency_key_hash, so that column is the actual discriminator.
    if (
      meta.owner_id === req.uid &&
      meta.html_idempotency_key_hash != null &&
      meta.octo_doc_slug === meta.doc_id
    ) {
      return { docId: meta.doc_id, deleted: true }
    }
    res.status(404).json({ error: 'not_found' })
    return null
  }
  return { docId: meta.doc_id, deleted: false }
}

/**
 * Parse and validate the rename title exactly once at the entry point.
 *
 * Trimming happens HERE (before any journal/html/doc_meta work): octo-docs-html
 * TrimSpaces the title, so a raw " New Title " would make the strict response
 * comparison fail with a permanent 503. Both stores, the journal from/to and the
 * idempotency key must use the same normalized value.
 */
function readRenameTitle(req: Request, res: Response): { ok: true; title: string } | { ok: false } {
  const rawTitle = (req.body ?? {}).title
  if (typeof rawTitle !== 'string') {
    res.status(400).json({ error: 'title required' })
    return { ok: false }
  }
  const title = trimTitleWhitespace(rawTitle)
  if (title === '') {
    res.status(400).json({ error: 'title required' })
    return { ok: false }
  }
  // Count Unicode code points (rune), matching the utf8mb4 VARCHAR(512) bound.
  if (titleRuneLength(title) > 512) {
    res.status(400).json({ error: 'title too long' })
    return { ok: false }
  }
  return { ok: true, title }
}

/**
 * Optional §4.8 optimistic lock. Empty/absent means "no check" and preserves the
 * historical request behavior; a non-string or over-long value is a 400.
 */
function readExpectedTitle(req: Request, res: Response): { ok: true; expectedTitle?: string } | { ok: false } {
  const body = req.body ?? {}
  // Direct HTTP uses snake_case; the CLI adapter decodes snake_case into
  // camelCase before the handler runs, so accept both spellings.
  const raw = body.expected_title !== undefined ? body.expected_title : body.expectedTitle
  if (raw === undefined || raw === null) return { ok: true }
  if (typeof raw !== 'string' || titleRuneLength(raw) > 512) {
    res.status(400).json({ error: 'invalid_expected_title' })
    return { ok: false }
  }
  const expectedTitle = trimTitleWhitespace(raw)
  return { ok: true, ...(expectedTitle !== '' ? { expectedTitle } : {}) }
}

async function renameDocById(
  req: Request,
  res: Response,
  docId: string,
  options: { inactiveAsDocArchived?: boolean } = {},
): Promise<void> {
  // READ gate first, then the §4.8 rename rule. The owner branch below means an
  // html doc's ORIGINAL AUTHOR may rename it even when they are not its admin,
  // so the historical `requireDocRole(..., 'admin')` gate would 403 exactly the
  // caller §4.8 wants to allow. Reader is the weakest gate that still proves the
  // caller may see the doc at all, and it keeps the 404 (missing/deleted) /
  // 409 (archived) / 403 (no access) semantics byte-identical for everyone else.
  //
  // OCTO-456 deleted grey state: the plain PATCH opts into "inactive as
  // doc_archived" so BOTH a deleted (status=0) and an archived (status=2) doc
  // answer 409 {error:'doc_archived'} — drive's rename proxy maps that code
  // verbatim. A deleted doc is disclosed only to a principal that can still
  // observe it (owner / doc_member / legacy); everyone else keeps the 404.
  const guard = await requireDocRole(req, res, docId, 'reader', options)
  if (!guard) return
  // Defense-in-depth for guards that hand back a non-active row (e.g. a mock or
  // a future relaxation): never rename anything that is not live.
  if (guard.meta.status !== 1) {
    res.status(409).json({ error: 'doc_archived' })
    return
  }
  // §4.8: doc/sheet/board/html_ppt => admin; html => admin OR the original
  // author (doc_meta.owner_id). Shared with the capability projection so the UI
  // and the enforcement cannot disagree.
  if (!canRenameOriginal(
    guard.role,
    guard.meta.doc_type,
    guard.meta.owner_id,
    guard.meta.owner_space_id,
    req.uid!,
    req.principalSpaceId ?? '',
  )) {
    res.status(403).json({ error: 'forbidden' })
    return
  }
  // Captured BEFORE the update: drive's rename receipt diffs it against the new
  // title to decide whether it must refresh its snapshot. The html branch replaces
  // it with the title observed under the rename journal's row lock.
  let beforeTitle = guard.meta.title ?? ''
  const parsedTitle = readRenameTitle(req, res)
  if (!parsedTitle.ok) return
  const title = parsedTitle.title
  // §4.8 optimistic lock: optional `expected_title` must still be the current
  // title when the write actually happens (under its row lock). Absent keeps the
  // old behavior unchanged.
  const parsedExpected = readExpectedTitle(req, res)
  if (!parsedExpected.ok) return
  const expectedTitle = parsedExpected.expectedTitle
  // §4.8 html 改名是**两步**:先让 octo-docs-html 重新 publish 新版本(version+1,
  // 它渲染标题读的是自己那份),成功后才写 doc_meta。renameHtmlDoc 用持久化的
  // doc_rename_operation journal 串行化同一文档的改名,并让重试复用同一个 op id
  // (即 html 的 idempotency_key):
  //   · 同一次逻辑改名的重试(本地写失败/响应丢失) → 同一 id → html 返回同一版本;
  //   · 新的一次改名(含 A→B→A→B) → 新 id → html 真实 +1;
  //   · 并发不同目标 → pending 检测 → 409 rename_in_progress,不会反向提交。
  //
  // 触发条件严格限定 `doc_type === 'html'` + 有 slug:html_ppt 有 PPT 服务自己的
  // 约定(走下面 editPptLive),doc/sheet/board 完全没有这个上游,流程必须一字不变。
  // slug 为空的 html 行(历史旁路数据)没有可发布的版本,保持原行为。
  const htmlSlug = guard.meta.octo_doc_slug
  if (guard.meta.doc_type === 'html' && typeof htmlSlug === 'string' && htmlSlug !== '') {
    const outcome = await renameHtmlDoc({
      docId: guard.meta.doc_id,
      docSpaceId: guard.meta.space_id,
      uid: req.uid!,
      principalSpaceId: req.principalSpaceId ?? null,
      mode: req.docSpaceScope?.mode ?? 'human',
      expectedEpoch: Number(guard.meta.permission_epoch),
      slug: htmlSlug,
      title,
      ...(expectedTitle !== undefined ? { expectedTitle } : {}),
    })
    if (!outcome.ok) {
      res.status(outcome.status).json({
        error: outcome.error,
        // 409 rename_recovery_required: tell the caller which remote title the
        // document actually has, so they can finish that rename first.
        ...(outcome.pendingTitle !== undefined ? { pendingTitle: outcome.pendingTitle } : {}),
        // 409 title_changed: the authoritative title observed under the lock.
        ...(outcome.currentTitle !== undefined ? { currentTitle: outcome.currentTitle } : {}),
        ...(outcome.version !== undefined ? { version: outcome.version } : {}),
      })
      return
    }
    beforeTitle = outcome.beforeTitle
    if (outcome.alreadyApplied) {
      // 当前标题已经等于请求值(响应丢失后的重试/重复提交),或者这个 op 早已
      // 完成(延迟到达的重复请求,期间可能已被后续改名移走):200 且不再发版。
      // 标题用 outcome.title —— 延迟重复时它是 doc_meta 的当前值,不是请求值。
      res.status(200).json({ docId: guard.meta.doc_id, title: outcome.title, beforeTitle })
      return
    }
    // version 只落内部日志:响应体形状是 drive rename receipt 的合同
    // ({docId,title,beforeTitle}),不在这里扩张。
    // eslint-disable-next-line no-console
    console.log('[octo-docs] html republished before rename', {
      docId: guard.meta.doc_id,
      slug: htmlSlug,
      version: outcome.version,
    })
  } else if (guard.meta.doc_type === 'html_ppt') {
    const spaceId = await resolveRequestPrincipalSpace(req)
    if (!spaceId) { res.status(403).json({ error: 'principal_space_unverified' }); return }
    try {
      await editPptLive({ docId: guard.meta.doc_id, uid: req.uid!, spaceId, authorizedEpoch: Number(guard.meta.permission_epoch),
        isBot: req.docSpaceScope?.mode === 'bot' },
        { title, ...(expectedTitle !== undefined ? { expectedTitle } : {}) })
    } catch (error) {
      if (error instanceof PptApiError) {
        // §4.8 optimistic-lock refusal from the PPT write transaction: keep the
        // docs-rename wire shape (bare {error,currentTitle}), not the PPT enum.
        const details = error.details as { reason?: unknown; currentTitle?: unknown } | undefined
        if (error.code === 'CONFLICT' && details?.reason === 'title_changed') {
          res.status(409).json({
            error: 'title_changed',
            currentTitle: typeof details.currentTitle === 'string' ? details.currentTitle : '',
          })
          return
        }
        res.status(error.httpStatus).json({ error: error.code.toLowerCase(), message: error.message })
        return
      }
      throw error
    }
  } else if (req.docSpaceScope?.mode === 'cli') {
    const renamed = await renameCliDoc(req, guard.meta, title, expectedTitle)
    if (!renamed.ok) {
      res.status(409).json({ error: 'title_changed', currentTitle: renamed.currentTitle })
      return
    }
  } else if (expectedTitle !== undefined) {
    // doc/sheet/board (and html without a slug) have no upstream: one transaction
    // locks the row, compares expected_title and writes, so two callers that both
    // expect A cannot both overwrite.
    const renamed = await docMetaRepo.renameWithExpectedTitle({
      docId, title, updatedBy: req.uid!, expectedTitle,
    })
    if (!renamed.ok) {
      if (renamed.reason === 'not_found') {
        res.status(404).json({ error: 'not_found' })
        return
      }
      res.status(409).json({ error: 'title_changed', currentTitle: renamed.currentTitle })
      return
    }
  } else {
    await docMetaRepo.rename(docId, title, req.uid!)
  }
  // Title lives in the search index (matched as title^2, returned as _source.title),
  // so a rename must re-index or the new title is missed / the stale one keeps
  // showing until an unrelated body edit reindexes. Enqueue a body signal: the
  // indexer re-reads the latest authoritative state (including title) by
  // documentName. Best-effort / fire-and-forget (enqueue swallows its own
  // errors); gated OFF by default. html now flows through the same gate
  // (isSearchIndexedDoc accepts 'html') — the indexer reads the S3 body for
  // html docs; doc/sheet/board keep reading the Yjs body.
  if (config.search.indexEnabled) {
    const documentName = await docMetaRepo.resolveDocumentName(docId)
    if (documentName && isSearchIndexedDoc(documentName)) {
      void enqueueDocIndex(documentName)
    }
  }
  // Canonical id (not the raw path param) + the pre-change title: drive's
  // internal/docsapi/rename.go reads {docId, title, beforeTitle}. Additive —
  // existing callers read the same docId/title fields as before.
  res.status(200).json({ docId: guard.meta.doc_id, title, beforeTitle })
}

function requireHumanDocDeletion(req: Request, res: Response): boolean {
  if (req.docSpaceScope?.mode === 'human') return true
  res.status(403).json({ error: 'bot_delete_forbidden' })
  return false
}

async function deleteDocById(req: Request, res: Response, docId: string): Promise<void> {
  if (!requireHumanDocDeletion(req, res)) return
  const guard = await requireDocRole(req, res, docId, 'admin')
  if (!guard) return
  const deleted = await docMetaRepo.softDelete(docId)
  // Broadcast the epoch invalidation so connected writers recheck and get cut
  // off (status===0 -> resolveRole 'none'). Doc-wide (no uid): everyone loses
  // access on delete. Mirrors acceptInvite's refreshAndPublish call.
  if (deleted) {
    await refreshAndPublish(deleted.documentName, deleted.permissionEpoch)
  }
  res.status(200).json({ docId, status: 'deleted' })
}

/**
 * Bot-only PATCH /octo-doc/:slug.
 *
 * Two distinct callers share the slug surface:
 *   · octo-docs-html, immediately AFTER it has already published a new version,
 *     reports the rendered title. That callback must converge doc_meta only — it
 *     must never re-enter the rename journal, or every publish would mint yet
 *     another html version;
 *   · nothing else in production: humans rename through the canonical docId
 *     route (see DocumentResourceRouter).
 *
 * The callback therefore takes a dedicated metadata-only path after the same
 * verified Bot authentication + slug resolution, and validates the published
 * identity under its own row lock.
 */
async function applyHtmlPublishTitleHandler(req: Request, res: Response, docId: string): Promise<void> {
  const guard = await requireDocRole(req, res, docId, 'reader')
  if (!guard) return
  const parsedTitle = readRenameTitle(req, res)
  if (!parsedTitle.ok) return
  const parsedExpected = readExpectedTitle(req, res)
  if (!parsedExpected.ok) return
  const outcome = await applyHtmlPublishTitle({
    docId: guard.meta.doc_id,
    slug: req.params.octoDocSlug!,
    spaceId: guard.meta.space_id,
    uid: req.uid!,
    botOwnerUid: req.botOwnerUid,
    title: parsedTitle.title,
    expectedTitle: parsedExpected.expectedTitle,
    version: Number((req.body ?? {}).version ?? (req.body ?? {}).publish_version ?? 0),
    // Preferred ordering key: distinguishes two titles published under the same
    // content version (explicit republish), which the version watermark cannot.
    publishSeq: Number((req.body ?? {}).publish_seq ?? 0),
  })
  if (!outcome.ok) {
    res.status(outcome.status).json({
      error: outcome.error,
      ...(outcome.currentTitle !== undefined ? { currentTitle: outcome.currentTitle } : {}),
    })
    return
  }
  if (outcome.changed && config.search.indexEnabled) {
    const documentName = await docMetaRepo.resolveDocumentName(guard.meta.doc_id)
    if (documentName && isSearchIndexedDoc(documentName)) {
      void enqueueDocIndex(documentName)
    }
  }
  res.status(200).json({
    docId: guard.meta.doc_id,
    title: outcome.title,
    beforeTitle: outcome.beforeTitle,
  })
}

export async function octoDocRenameHandler(req: Request, res: Response): Promise<void> {
  const docId = await resolveDocIdBySlug(req, res)
  if (!docId) return
  if (req.docSpaceScope?.mode === 'bot') {
    await applyHtmlPublishTitleHandler(req, res, docId)
    return
  }
  await renameDocById(req, res, docId)
}

export async function octoDocDeleteHandler(req: Request, res: Response): Promise<void> {
  if (!requireHumanDocDeletion(req, res)) return
  const target = await resolveCanonicalDeleteBySlug(req, res)
  if (!target) return
  if (target.deleted) {
    res.status(204).end()
    return
  }
  await deleteDocById(req, res, target.docId)
}

/** PATCH /api/v1/docs/{docId} — rename (needs admin). */
export async function renameDocHandler(req: Request, res: Response): Promise<void> {
  await renameDocById(req, res, req.params.docId!, { inactiveAsDocArchived: true })
}

/** DELETE /api/v1/docs/{docId} — soft delete (needs admin). */
export async function deleteDocHandler(req: Request, res: Response): Promise<void> {
  await deleteDocById(req, res, req.params.docId!)
}

docsRouter.patch('/octo-doc/:octoDocSlug', octoDocRenameHandler)
docsRouter.delete('/octo-doc/:octoDocSlug', octoDocDeleteHandler)
docsRouter.patch('/:docId', renameDocHandler)
docsRouter.delete('/:docId', deleteDocHandler)

/**
 * GET /api/v1/docs/{docId}/share — read a doc's share settings (#64, needs
 * reader). Anyone who can see the doc can see its scope, so the client dialog
 * can render current state for any viewer. 404 (not 403) for a missing/deleted
 * or cross-space doc (requireDocRole existence-hiding ordering); 403 when the
 * caller has no effective role on the doc.
 */
export async function getShareHandler(req: Request, res: Response) {
  const guard = await requireDocRole(req, res, req.params.docId!, 'reader')
  if (!guard) return
  // The Bot contract intentionally exposes only Bot-manageable settings. The
  // authenticated-link scope and Space-search discoverability are Human-only:
  // omit them here as well as rejecting writes below, so Bot clients cannot
  // discover or mirror those controls from the read response.
  if (req.botToken !== undefined) {
    res.status(200).json({
      docId: guard.meta.doc_id,
      ...botShareProjection(
        guard.meta.share_scope,
        guard.meta.share_role,
        guard.meta.permission_epoch,
      ),
    })
    return
  }
  res.status(200).json({
    docId: guard.meta.doc_id,
    shareScope: shareScopeName(guard.meta.share_scope),
    shareRole: shareRoleName(guard.meta.share_role),
    spaceSearchable: guard.meta.discoverability_scope === DISCOVERABILITY_SPACE,
    permissionEpoch: guard.meta.permission_epoch,
  })
}

/**
 * PUT /api/v1/docs/{docId}/share — change a doc's share settings (#64, needs
 * admin; owner is implicit admin). Mirrors the members mutation shape: guard,
 * validate, write, bump epoch.
 *
 *   body: { shareScope: "restricted"|"anyone_in_space"|"authenticated",
 *           shareRole?: "read"|"comment"|"edit" }
 *   400 invalid_scope   shareScope not in enum
 *   400 invalid_role    shareScope=anyone_in_space but shareRole missing/invalid
 *   400 invalid_permission_epoch  missing/malformed optimistic-concurrency token
 *   403 forbidden       caller is not admin/owner (requireDocRole admin gate)
 *   404 not_found       doc missing/deleted OR cross-space
 *   409 share_settings_conflict  permissionEpoch no longer current
 *
 * Normalization (design §3.2): when shareScope=restricted the handler persists
 * share_role=read regardless of any shareRole sent (the field is ignored, not
 * rejected), so the stored row stays canonical and the read API is deterministic.
 * The write is followed by a DOC-WIDE epoch bump (no uid) so a narrowing cuts
 * every non-member's live session, exactly like soft-delete.
 */
export async function putShareHandler(req: Request, res: Response) {
  const guard = await requireDocRole(req, res, req.params.docId!, 'admin')
  if (!guard) return
  const isCliRequest = req.docSpaceScope?.mode === 'cli'
  if (isCliRequest && guard.meta.share_scope === SHARE_SCOPE_AUTHENTICATED) throw new CliError('FORBIDDEN')
  const { shareScope, shareRole, spaceSearchable, permissionEpoch } = req.body ?? {}
  if (!Number.isInteger(permissionEpoch) || permissionEpoch < 0) {
    res.status(400).json({ error: 'invalid_permission_epoch' })
    return
  }
  const scopeNum = parseShareScope(shareScope)
  if (scopeNum === null) {
    res.status(400).json({ error: 'invalid_scope' })
    return
  }
  const isBotRequest = req.botToken !== undefined
  if (isBotRequest) {
    // These controls are absent from the Bot API contract. Keep a server-side
    // boundary too: custom Bot clients must not opt all logged-in users into
    // access, toggle Space search, or replace a Human-selected authenticated scope.
    if (
      scopeNum === SHARE_SCOPE_AUTHENTICATED ||
      Object.prototype.hasOwnProperty.call(req.body ?? {}, 'spaceSearchable')
    ) {
      res.status(400).json({ error: 'unsupported_share_settings' })
      return
    }
    if (guard.meta.share_scope === SHARE_SCOPE_AUTHENTICATED) {
      res.status(403).json({ error: 'forbidden' })
      return
    }
  }
  let roleNum: number
  if (scopeNum !== SHARE_SCOPE_RESTRICTED) {
    // anyone_in_space requires an explicit, valid share role.
    const parsed = parseShareRole(shareRole)
    const allowed = guard.meta.doc_type === 'html'
      ? [SHARE_ROLE_READ, SHARE_ROLE_COMMENT]
      : [SHARE_ROLE_READ, SHARE_ROLE_COMMENT, SHARE_ROLE_EDIT]
    if (parsed === null || !allowed.includes(parsed)) {
      res.status(400).json({ error: 'invalid_role' })
      return
    }
    roleNum = parsed
  } else {
    // restricted: normalize+persist read, ignoring any body shareRole.
    roleNum = SHARE_ROLE_READ
  }
  // Bot writes preserve the Human-owned discoverability bit exactly. Human
  // writes retain the existing partial-update behavior.
  const searchable = isBotRequest
    ? guard.meta.discoverability_scope === DISCOVERABILITY_SPACE
    : spaceSearchable ?? guard.meta.discoverability_scope === DISCOVERABILITY_SPACE
  if (typeof searchable !== 'boolean') {
    res.status(400).json({ error: 'invalid_share_settings' })
    return
  }
  // Flip the share settings AND bump the epoch atomically (one transaction), so
  // a narrowing is never observable at the new scope with a stale epoch. Then
  // refresh caches + publish the doc-wide invalidation (no uid) so every
  // non-member's live session re-derives access (§3.2 / §5.3), mirroring the
  // softDelete -> refreshAndPublish path.
  const result = isCliRequest
    ? await setCliShareSettings(req, guard.meta.doc_id, scopeNum, roleNum, permissionEpoch)
    : await docMetaRepo.setShareSettings(guard.meta.doc_id, scopeNum, roleNum, searchable, permissionEpoch)
  if (!result.updated) {
    res.status(409).json({
      error: 'share_settings_conflict',
      ...(result.current ? {
        current: {
          docId: guard.meta.doc_id,
          ...(isBotRequest
            ? botShareProjection(
                result.current.shareScope,
                result.current.shareRole,
                result.current.permissionEpoch,
              )
            : {
                shareScope: shareScopeName(result.current.shareScope),
                shareRole: shareRoleName(result.current.shareRole),
                spaceSearchable: result.current.spaceSearchable,
                permissionEpoch: result.current.permissionEpoch,
              }),
        },
      } : {}),
    })
    return
  }
  await refreshAndPublish(guard.meta.document_name, result.settings.permissionEpoch)
  res.status(200).json({
    docId: guard.meta.doc_id,
    ...(isBotRequest
      ? botShareProjection(scopeNum, roleNum, result.settings.permissionEpoch)
      : {
          shareScope: shareScopeName(scopeNum),
          shareRole: shareRoleName(roleNum),
          spaceSearchable: isCliRequest ? result.settings.spaceSearchable : searchable,
          permissionEpoch: result.settings.permissionEpoch,
        }),
  })
}

// Two-segment paths: distinct from the single-segment '/:docId' route, so
// registration order relative to it does not matter (Express keys on segment
// count). Registered here alongside the other single-doc routes.
docsRouter.get('/:docId/share', getShareHandler)
docsRouter.put('/:docId/share', putShareHandler)

// ---------------------------------------------------------------------------
// remove-sp §4 / §6: Open Context + docId-first physical router split.
// ---------------------------------------------------------------------------

/** doc_id shape gate for the open-context locate (mirrors newDocId/segment charset). */
const DOC_ID_MAX_LEN = 128
function isPlausibleDocId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= DOC_ID_MAX_LEN && /^[A-Za-z0-9_-]+$/.test(id)
}

/**
 * GET /api/v1/docs/{docId}/open-context (remove-sp §4). The browser `/d/:docId`
 * bootstrap: locate the doc by docId ALONE (no `sp`, no `X-Space-Id` for
 * selection) and return the canonical context needed to start REST + collab.
 * Human-only — mounted on the DocumentResourceRouter after authMiddleware,
 * NEVER behind spaceContextMiddleware.
 *
 * Fixed status order so NOTHING is leaked before authorization (§4):
 *   locate/exist → compute role → role=none ⇒ 403 → archived ⇒ 409 → context.
 * A `none` caller gets 403 WITHOUT learning archived/locked state; no failure
 * response carries Space / owner / documentName / role / epoch.
 *
 * The ONE field a 403 does carry is `title`, and only a 403 — product decision
 * (leader): the `/d/:docId` no-access landing must name the document it is asking
 * the viewer to request access to, instead of saying 无法访问此文档 about an unnamed
 * thing. Note what this does and does not assume:
 *   - It is NOT justified by space membership. This route locates by docId alone
 *     and has no same-space gate, so a 403 here can reach a caller from any
 *     Space, or none. Anyone holding the docId can read the title.
 *   - It IS bounded to a caller who already holds the docId AND already learned
 *     the doc exists from getting 403 rather than 404 — the distinction §4 keeps
 *     on purpose so "hold a link, request access" works. The share card that
 *     carries such a link already shows the same title.
 *   - 404 stays bare. That is the response that hides existence, and a title on
 *     it would hand out the one bit 404 exists to withhold.
 * So this widens disclosure from "the doc exists" to "the doc exists and is
 * named X", for a link holder. Accepted deliberately; if enumeration resistance
 * lands in the later sharing-security phase, this field is the first thing it
 * has to revisit.
 *
 * A blank stored title omits the field rather than sending `""`, so the client
 * can tell "no title disclosed" from "the title is empty" and never renders a
 * placeholder as if it were the document's name — the web side depends on that.
 */
export async function openContextHandler(req: Request, res: Response): Promise<void> {
  const uid = req.uid!
  const docId = req.params.docId
  if (!isPlausibleDocId(docId)) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  const meta = await docMetaRepo.getByDocId(docId)
  if (!meta || meta.status === 0) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  if (!(await requireVerifiedHumanCurrentSpace(req, res, meta))) return
  // Resolve the direct ACL against the caller's server-verified CURRENT Space;
  // share-derived access is independently evaluated against the document home Space.
  const principalSpaceId = await resolveRequestPrincipalSpace(req)
  if (!principalSpaceId) {
    res.status(403).json({ error: 'principal_space_unverified' })
    return
  }
  const direct = await resolveRole(uid, docId, principalSpaceId)
  const role = await resolveEffectiveRole(uid, direct, meta, {
    isBot: false,
    principalSpaceId,
    token: req.octoToken,
    verifiedSpaceId: req.verifiedViewerSpaceId,
  })
  if (role === 'none') {
    // See the titleOn403 rationale in this handler's doc comment. Omitted rather than sent empty
    // when the stored title is blank, so the client can distinguish "no title disclosed" from
    // "the title is an empty string" and never renders a placeholder as the document's name.
    const title = typeof meta.title === 'string' && meta.title.trim() !== '' ? meta.title : undefined
    res.status(403).json({
      error: 'forbidden',
      ...(title ? { title } : {}),
      docType: meta.doc_type,
    })
    return
  }
  // Only now — the caller is at least a reader — may archived/locked state be
  // revealed (§4: 409 comes AFTER the role gate, never before).
  if (meta.status === 2) {
    res.status(409).json({ error: 'conflict' })
    return
  }
  res.status(200).json({
    docId: meta.doc_id,
    homeSpaceId: meta.space_id,
    documentName: meta.document_name,
    folderId: meta.folder_id,
    docType: meta.doc_type,
    role,
    permissionEpoch: meta.permission_epoch,
    title: meta.title,
    ...(meta.octo_doc_slug ? { octoDocSlug: meta.octo_doc_slug } : {}),
  })
}

/**
 * POST /api/v1/docs/{docId}/collab-token (remove-sp §7.1) — docId-first, v2.
 * Human-only. Resolves the canonical documentName + home Space by docId and
 * issues a v2 token bound to them; never derives the doc from `sp`/`X-Space-Id`.
 */
export async function docIdCollabTokenHandler(req: Request, res: Response): Promise<void> {
  const candidate = (req.viewerSpaceId ?? '').trim()
  if (!candidate) { res.status(403).json({ error: 'space_required' }); return }
  const principalSpaceId = await resolveRequestPrincipalSpace(req)
  if (!principalSpaceId) { res.status(403).json({ error: 'forbidden' }); return }
  const out = await issueCollabTokenByDocId(req.uid!, req.params.docId!, req.octoToken ?? '', principalSpaceId)
  if (!out.ok) {
    res.status(out.status).json({ error: out.error })
    return
  }
  res.status(200).json(out.result)
}

/**
 * Human SpaceCollectionRouter (remove-sp §6): the Space-scoped collection ops.
 * `X-Space-Id` is REQUIRED here (per-route spaceContextMiddleware, so a
 * single-document request passing through this router without a match never
 * trips the 400). Mounted BEFORE the DocumentResourceRouter so the fixed paths
 * (`/`, `/metadata`, `/search`, `/recent`, `/recent/creators`, `/manageable`) are never
 * shadowed by `/:docId`.
 */
export const spaceCollectionRouter: ExpressRouter = Router()
// Creating a document has no existing doc role to authorize against, so the
// caller must prove membership in the requested Space. Collection reads keep
// their row-level owner/doc_member predicates and only add Space-shared rows for
// confirmed members; gating those reads would subtract legitimate cross-Space
// direct grants.
spaceCollectionRouter.post('/metadata', spaceContextMiddleware, documentAsync(docsMetadataHandler))
spaceCollectionRouter.post('/', spaceContextMiddleware, requireSpaceMembership, documentAsync(createDocHandler))
spaceCollectionRouter.get('/', spaceContextMiddleware, requireSpaceMembership, documentAsync(listDocsHandler))
spaceCollectionRouter.post('/search', spaceContextMiddleware, requireSpaceMembership, searchDocsHandler)
spaceCollectionRouter.get('/recent', spaceContextMiddleware, requireSpaceMembership, listRecentHandler)
spaceCollectionRouter.get('/recent/creators', spaceContextMiddleware, requireSpaceMembership, listRecentCreatorsHandler)
spaceCollectionRouter.get('/manageable', spaceContextMiddleware, requireSpaceMembership, listManageableHandler)

/**
 * Human DocumentResourceRouter (remove-sp §6): every single-document operation,
 * located by path docId with NO spaceContextMiddleware. open-context and the
 * docId-first collab-token are human-only foundation routes and live only here
 * (not on the shared/bot `docsRouter`). The shared single-doc handlers
 * (get/view/rename/delete/share/octo-doc) are reused verbatim — no fork.
 */
export const documentResourceRouter: ExpressRouter = Router()
documentResourceRouter.get('/:docId/open-context', openContextHandler)
documentResourceRouter.post('/:docId/collab-token', docIdCollabTokenHandler)
documentResourceRouter.post('/:docId/view', recordDocViewHandler)
documentResourceRouter.get('/:docId/share', getShareHandler)
documentResourceRouter.put('/:docId/share', putShareHandler)
// `/octo-doc/:slug` is intentionally bot-only on `docsRouter`: a slug is unique
// only within a server-resolved Bot Space and cannot be made docId-first safely
// on the human mount. Humans rename/delete through canonical `/:docId` routes.
documentResourceRouter.get('/:docId', getDocHandler)
documentResourceRouter.patch('/:docId', renameDocHandler)
documentResourceRouter.delete('/:docId', deleteDocHandler)
