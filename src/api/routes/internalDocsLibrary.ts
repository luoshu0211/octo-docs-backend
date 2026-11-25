/**
 * OCTO-456 资料库二期 — docs-side internal library contract.
 *
 * Four service-to-service routes on the internal listener, authenticated by the
 * same X-Internal-Token as /internal/docs/:docId/role (reusing
 * authorizeInternalDocRequest so the two surfaces can never drift):
 *
 *   POST /internal/docs/status         batch read projection (title/type/owner/
 *                                      space/role/deleted/can_read)
 *   POST /internal/docs/capabilities   batch action matrix (§3.3 doc 段)
 *   GET  /internal/docs/shared         "与我共享" candidates + sources
 *   GET  /internal/docs/readable       every readable doc (search backfill)
 *
 * WIRE CONTRACT IS OWNED BY DRIVE: internal/docsapi/library.go on octo-drive is
 * the authority. Field names here are snake_case to match it and the existing
 * /internal/docs/:docId/role response. Do not rename a field without updating
 * that Go file and its tests.
 *
 * AUTHORITY: the caller (drive) never decides readability. Every route resolves
 * the *user's* role on docs' own data — direct ownership/doc_member through the
 * permission layer, then resolveEffectiveRole for the #64 share scopes and the
 * drive-library-derived reader. The user's `principal_space_id` is forwarded by
 * drive AFTER it verified the caller's identity; docs treats it as the caller's
 * verified principal Space (exactly like the RPC/CLI `verifiedSpaceId` branch),
 * so an `anyone_in_space` doc is visible only when that verified Space IS the
 * document's home Space.
 *
 * FAIL CLOSED: a doc the caller cannot read, a doc id that does not exist, or a
 * soft-deleted doc with no surviving direct grant is ABSENT from the batch
 * response (never a 404 for the whole batch). Drive already treats "absent" as
 * "not readable" (internal/docsapi/library.go DocStatus).
 *
 * DELETION GREY STATE (P0 read, §3.3): a status=0 doc is reported ONLY to a
 * principal that may still observe it — doc_meta.owner_id === uid, any
 * doc_member row, or a doc_legacy_visible row; share_scope alone does not count
 * (a deleted doc is never readable by link). The grey row carries
 * `deleted:true`, `deleted_at` (ISO8601 UTC or null), `expired` (30-day
 * retention window), `can_read:false` and `role:"none"`. deletes made before
 * doc_meta.deleted_at existed keep NULL => "retention deadline unknown" =>
 * `expired:false` (reported, not faked). status=2 (archived) stays absent.
 *
 * Known data gaps (reported, not faked):
 *   - Historical status=0 rows (deleted before 2026-11-24) have deleted_at
 *     NULL, so their retention window cannot be evaluated server-side and is
 *     reported as not expired.
 *   - invite provenance IS distinguishable (doc_member.source 1=direct
 *     2=invite), so `sources` reports direct/invite separately. Legacy 补录
 *     rows come from doc_legacy_visible (empty until a backfill producer
 *     exists); im_card / im_link are intentionally excluded this期.
 */
import {
  Router,
  json as jsonBodyParser,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  type Router as ExpressRouter,
} from 'express'
import { docMemberRepo, SOURCE_INVITE } from '../../db/repos/docMemberRepo.js'
import {
  docMetaRepo,
  MAX_LIBRARY_PAGE_SIZE,
  type ReadableDocItem,
  type SharedDocItem,
} from '../../db/repos/docMetaRepo.js'
import { authorizeInternalDocRequest, requireInternalDocToken } from './internalDocRole.js'
import { resolveShareRole } from '../../permission/resolveEffectiveRole.js'
import { mergeDriveDerivedReader, getDriveDerivedAccess, type DerivedRole } from '../../drive/derivedAccessClient.js'
import { effectiveRole } from '../../permission/shareScope.js'
import { docCapabilitiesFor, type DocCapabilities } from '../../permission/docCapabilities.js'
import { roleAtLeast, roleFromNumber, type ResolvedRole } from '../../permission/role.js'
import { config } from '../../config/env.js'
<<<<<<< HEAD
import { TRASH_RETENTION_DAYS, trashExpireAtIso } from '../../permission/docRetention.js'
=======
>>>>>>> f491b30

/**
 * Route-scoped limiter (OCTO-456 F2): every route in this router shares ONE
 * limiter instance, mounted on each route chain. Mounting the limiter at the app
 * prefix instead would also run it for requests that belong to the sibling
 * `/:docId/role` router (Express falls through when no route matches), so the two
 * surfaces would consume each other's budget.
 */
export function createInternalDocsLibraryRouter(limiter: RequestHandler): ExpressRouter {
  const router = Router()
  // Order is deliberate: limiter -> X-Internal-Token -> JSON body -> handler.
  // The global parser skips /internal/docs, so an unauthenticated caller is
  // rejected before any body parsing; a malformed/oversized body is only read
  // after the token (and the limiter) passed.
  const body = jsonBodyParser({ limit: 64 * 1024 })
  router.post('/status', limiter, requireInternalDocToken, body, asyncHandler(internalDocStatusHandler))
  router.post('/capabilities', limiter, requireInternalDocToken, body, asyncHandler(internalDocCapabilitiesHandler))
  router.get('/shared', limiter, asyncHandler(internalDocsSharedHandler))
  router.get('/readable', limiter, asyncHandler(internalDocsReadableHandler))
  return router
}

/** Max doc_ids per status/capabilities request (drive batches at 500/100). */
export const MAX_INTERNAL_DOC_IDS = 500
/** Default page size for shared/readable when `limit` is absent/invalid. */
export const DEFAULT_LIBRARY_PAGE_SIZE = 200
/** Bound on concurrent effective-role resolutions inside one batch request. */
const ROLE_RESOLUTION_CONCURRENCY = 20

interface BatchRequest {
  uid: string
  principalSpaceId: string
  docIds: string[]
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * Validate {uid, principal_space_id, doc_ids[]}. Returns null after writing 400;
 * the array is de-duplicated IN INPUT ORDER because the status/capabilities
 * response is keyed by doc_id and drive looks items up by id.
 */
function parseBatchRequest(req: Request, res: Response): BatchRequest | null {
  const body = (req.body ?? {}) as Record<string, unknown>
  const uid = nonEmptyString(body.uid)
  const principalSpaceId = nonEmptyString(body.principal_space_id)
  const rawDocIds = body.doc_ids
  if (
    uid === null
    || principalSpaceId === null
    || !Array.isArray(rawDocIds)
    || rawDocIds.some((id) => typeof id !== 'string')
  ) {
    res.status(400).json({ error: 'invalid_request' })
    return null
  }
  const seen = new Set<string>()
  const docIds: string[] = []
  for (const raw of rawDocIds as string[]) {
    const id = raw.trim()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    docIds.push(id)
  }
  if (docIds.length > MAX_INTERNAL_DOC_IDS) {
    res.status(400).json({ error: 'too_many_doc_ids' })
    return null
  }
  return { uid, principalSpaceId, docIds }
}

/** Run `fn` over `items` with a bounded number of concurrent promises. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Math.min(limit, items.length)
  await Promise.all(Array.from({ length: workers }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index]!)
    }
  }))
  return results
}

interface ResolvedDoc {
  meta: Awaited<ReturnType<typeof docMetaRepo.getByDocId>>
  direct: ResolvedRole
  effective: ResolvedRole
}

/**
 * Resolve the caller's direct + effective role for one doc_meta row WITHOUT an
 * express request context (this is a service-to-service route).
 *
 * `verifiedSpaceId` is the forwarded principal Space: drive verified it before
 * calling us, and a principal Space is by definition a Space the user belongs
 * to, so passing it here is the internal equivalent of the REST guard's
 * `req.apiKeySpaceId` verified-space short-circuit. It only ever gates the
 * `anyone_in_space` share branch — a direct role is unaffected.
 */
/** Drive's batch full-decision endpoint accepts at most 50 bindings per call. */
const DRIVE_DECISION_BATCH_SIZE = 50
/**
 * When a batch fails and the page is larger than one batch, do NOT fan out to
 * one full decision per document: that turns one Drive failure into up to 500
 * requests. Fail those docs closed (role none) for 30s instead, then retry the
 * batch. Safety over completeness: temporarily fewer library rows is better
 * than hammering an unavailable Drive.
 */
const DRIVE_LOCAL_FALLBACK_MAX = DRIVE_DECISION_BATCH_SIZE
const DRIVE_BATCH_FAIL_CLOSED_MS = 30_000

let driveBatchFailClosedUntil = 0

/** Test seam for the process-wide batch circuit breaker. */
export function __resetDriveBatchCircuitForTests(): void {
  driveBatchFailClosedUntil = 0
}

interface AccessCandidate {
  meta: NonNullable<ResolvedDoc['meta']>
  direct: ResolvedRole
}

/**
 * Resolve effective roles for a batch of readable docs.
 *
 * Sources 1+2 (direct + space share) are still computed per doc — only the
 * `anyone_in_space` branch does IO, so this is cheap. Source 3 (drive-derived
 * reader) is folded in with the Drive batch full-decision endpoint
 * (`POST /internal/v1/docs/derived-access/batch`, drive !93): at most 50 bindings
 * per request, so a 500-doc status call costs at most 10 Drive round-trips
 * instead of 500.
 *
 * `versions()` must NOT be used here: it returns source fingerprints for
 * already-active bindings, not a role. A failed/absent batch falls back to the
 * exact per-doc full decision (`mergeDriveDerivedReader`), which is fail-closed —
 * a batch failure never widens access.
 */
async function resolveEffectiveRolesBatch(
  candidates: readonly AccessCandidate[],
  uid: string,
  principalSpaceId: string,
): Promise<Map<string, ResolvedRole>> {
  const roles = new Map<string, ResolvedRole>()
  if (candidates.length === 0) return roles

  await mapWithConcurrency(candidates, ROLE_RESOLUTION_CONCURRENCY, async ({ meta, direct }) => {
    roles.set(meta.doc_id, await resolveShareRole(uid, direct, meta, {
      isBot: false,
      principalSpaceId,
      verifiedSpaceId: principalSpaceId,
    }))
  })

  const needsDrive = candidates.filter(({ meta }) => !roleAtLeast(roles.get(meta.doc_id)!, 'reader'))
  if (needsDrive.length === 0) return roles

  if (Date.now() < driveBatchFailClosedUntil) {
    // Circuit open: skip Drive entirely for this page.
    return roles
  }

  const bindings = needsDrive.map(({ meta }) => ({
    docId: meta.doc_id,
    uid,
    principalSpaceId,
  }))
  const decided = new Map<string, DerivedRole>()
  let batchComplete = true
  for (let offset = 0; offset < bindings.length; offset += DRIVE_DECISION_BATCH_SIZE) {
    const chunk = bindings.slice(offset, offset + DRIVE_DECISION_BATCH_SIZE)
    let decisions: Awaited<ReturnType<ReturnType<typeof getDriveDerivedAccess>['batchDerivedAccess']>>
    try {
      decisions = await getDriveDerivedAccess().batchDerivedAccess(chunk)
    } catch {
      decisions = null
    }
    if (!decisions) {
      // Disabled/unconfigured or a protocol failure — do not trust partial
      // results. Keep probing the remaining chunks (at most 10 for a full page)
      // so a transient per-request failure cannot leave the rest unclassified,
      // then fail closed / fall back for ALL unresolved docs below.
      batchComplete = false
      continue
    }
    for (const decision of decisions) decided.set(decision.docId, decision.role)
  }

  if (batchComplete) {
    for (const { meta } of needsDrive) {
      if (decided.get(meta.doc_id) === 'reader') roles.set(meta.doc_id, 'reader')
    }
    return roles
  }

  const driveConfigured = config.driveDerived.enabled
    && config.driveDerived.internalBaseUrl.trim() !== ''
    && config.driveDerived.outboundToken.trim() !== ''
  if (needsDrive.length > DRIVE_LOCAL_FALLBACK_MAX) {
    // One batch failure must not become a 500-request retry storm. Fail closed
    // (roles stay none) and open the circuit for 30s.
    driveBatchFailClosedUntil = Date.now() + DRIVE_BATCH_FAIL_CLOSED_MS
    if (driveConfigured) {
      // eslint-disable-next-line no-console
      console.warn('[octo-docs] drive derived-access batch unavailable; failing closed without per-doc fallback', {
        docs: needsDrive.length,
        failClosedMs: DRIVE_BATCH_FAIL_CLOSED_MS,
      })
    }
    return roles
  }
  if (driveConfigured) {
    // eslint-disable-next-line no-console
    console.warn('[octo-docs] drive derived-access batch unavailable; falling back to per-doc decisions', {
      docs: needsDrive.length,
    })
  }
  await mapWithConcurrency(needsDrive, ROLE_RESOLUTION_CONCURRENCY, async ({ meta }) => {
    const base = roles.get(meta.doc_id) ?? 'none'
    roles.set(meta.doc_id, await mergeDriveDerivedReader(base, meta.doc_id, uid, principalSpaceId))
  })
  return roles
}

/** Direct role from the already-batched doc_member map, owner-first (§4.2). */
function directRoleOf(
  meta: NonNullable<ResolvedDoc['meta']>,
  uid: string,
  principalSpaceId: string,
  memberRoles: Map<string, Exclude<ResolvedRole, 'none'>>,
): ResolvedRole {
  if (uid === meta.owner_id && principalSpaceId === meta.owner_space_id) return 'admin'
  return memberRoles.get(meta.doc_id) ?? 'none'
}

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function iso(value: unknown): string {
  return isoOrNull(value) ?? ''
}

/**
 * OCTO-456 §3.3 retention window: a deleted doc is expired once its deletion
 * timestamp is strictly older than 30 days. A NULL (historical delete, unknown
 * time) or an unparseable value is NEVER expired: the product's temporary rule
 * is "无法判定保留期 → 按未过期处理" rather than guessing.
 *
 * The comparison uses the app clock; deleted_at is written by the DB's NOW(3)
 * and mysql2 hands it back as a Date in the same session/process timezone (the
 * repo's existing `updated_at` convention), so both sides are the same absolute
 * instant.
 */
export const DOC_DELETION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

export function isDeletionExpired(deletedAt: unknown, nowMs: number = Date.now()): boolean {
  if (deletedAt === null || deletedAt === undefined) return false
  const date = deletedAt instanceof Date ? deletedAt : new Date(String(deletedAt))
  const ms = date.getTime()
  if (Number.isNaN(ms)) return false
  return ms < nowMs - DOC_DELETION_RETENTION_MS
}

/** 200 body of POST /internal/docs/status — one item per readable/deleted doc. */
export async function internalDocStatusHandler(req: Request, res: Response): Promise<void> {
  if (!authorizeInternalDocRequest(req, res)) return
  const parsed = parseBatchRequest(req, res)
  if (!parsed) return
  const { uid, principalSpaceId, docIds } = parsed
  if (docIds.length === 0) {
    res.status(200).json({ items: [] })
    return
  }

  const metas = await docMetaRepo.getByDocIds(docIds)
  const metaById = new Map(metas.map((meta) => [meta.doc_id, meta]))
  const memberRoles = await docMemberRepo.getRoles(docIds, uid, principalSpaceId)
  // One extra batched query, only when the batch actually contains deleted
  // rows: the legacy 补录 provenance is a third way to keep observing a grey row.
  const deletedIds = metas.filter((meta) => meta.status === 0).map((meta) => meta.doc_id)
  const legacyVisible = deletedIds.length === 0
    ? new Set<string>()
    : await docMetaRepo.getLegacyVisibleDocIds(deletedIds, uid, principalSpaceId)

  const activeCandidates: AccessCandidate[] = docIds.flatMap((docId) => {
    const meta = metaById.get(docId)
    if (!meta || meta.status !== 1) return []
    return [{ meta, direct: directRoleOf(meta, uid, principalSpaceId, memberRoles) }]
  })
  const effectiveByDoc = await resolveEffectiveRolesBatch(activeCandidates, uid, principalSpaceId)

  const resolved = await mapWithConcurrency(docIds, ROLE_RESOLUTION_CONCURRENCY, async (docId) => {
    const meta = metaById.get(docId)
    if (!meta) return null
    // status=2 (archived) is outside this P0 contract: it is not readable and
    // the wire shape has no archived flag, so it is omitted (fail closed) rather
    // than reported as a live doc.
    if (meta.status === 2) return null
    if (meta.status === 0) {
      // Soft-deleted grey row: disclose the title + deletion state ONLY to a
      // principal that can still observe it (owner, any doc_member row, or a
      // legacy 补录 row). Owner is the compound (uid, owner_space_id) identity,
      // matching resolveRole/directRoleOf: the same uid in a different principal
      // Space must not see the grey row. share_scope is deliberately NOT enough:
      // a deleted doc is not readable by link, so a share-only viewer stays
      // fail-closed.
      const observable = (uid === meta.owner_id && principalSpaceId === meta.owner_space_id)
        || memberRoles.has(meta.doc_id)
        || legacyVisible.has(meta.doc_id)
      if (!observable) return null
      // Never readable and never actionable: drive renders the grey row and
      // hides every action, so the role is 'none' regardless of the member grant.
      return {
        doc_id: meta.doc_id,
        title: meta.title,
        doc_type: meta.doc_type,
        owner_uid: meta.owner_id,
        doc_space_id: meta.space_id,
        role: 'none',
        updated_at: iso(meta.updated_at),
        deleted: true,
        deleted_at: isoOrNull(meta.deleted_at),
<<<<<<< HEAD
        // OCTO-456 P1: 保留期投影，drive 据此渲染灰行的「将于 X 清理」。
        // 期限未知（deleted_at IS NULL）时 expire_at:null，且永不自动清理。
        expire_at: trashExpireAtIso(meta.deleted_at),
        retention_days: TRASH_RETENTION_DAYS,
=======
>>>>>>> f491b30
        expired: isDeletionExpired(meta.deleted_at),
        can_read: false,
      }
    }
    const effective = effectiveByDoc.get(meta.doc_id) ?? 'none'
    if (effective === 'none') return null
    return {
      doc_id: meta.doc_id,
      title: meta.title,
      doc_type: meta.doc_type,
      owner_uid: meta.owner_id,
      doc_space_id: meta.space_id,
      role: effective,
      updated_at: iso(meta.updated_at),
      deleted: false,
      deleted_at: null,
      expired: false,
      can_read: true,
    }
  })

  res.status(200).json({ items: resolved.filter((item): item is NonNullable<typeof item> => item !== null) })
}

/** Snake_case wire projection of the shared capability matrix. */
function capabilitiesWire(caps: DocCapabilities): Record<string, boolean> {
  return {
    can_read: caps.canRead,
    can_comment: caps.canComment,
    can_edit: caps.canEdit,
    can_share: caps.canShare,
    can_export: caps.canExport,
    can_copy: caps.canCopy,
    can_rename_original: caps.canRenameOriginal,
    can_delete_original: caps.canDeleteOriginal,
    can_download_original: caps.canDownloadOriginal,
  }
}

/** 200 body of POST /internal/docs/capabilities. */
export async function internalDocCapabilitiesHandler(req: Request, res: Response): Promise<void> {
  if (!authorizeInternalDocRequest(req, res)) return
  const parsed = parseBatchRequest(req, res)
  if (!parsed) return
  const { uid, principalSpaceId, docIds } = parsed
  if (docIds.length === 0) {
    res.status(200).json({ items: [] })
    return
  }

  const metas = await docMetaRepo.getByDocIds(docIds)
  const metaById = new Map(metas.map((meta) => [meta.doc_id, meta]))
  const memberRoles = await docMemberRepo.getRoles(docIds, uid, principalSpaceId)

  const activeCandidates: AccessCandidate[] = docIds.flatMap((docId) => {
    const meta = metaById.get(docId)
    if (!meta || meta.status !== 1) return []
    return [{ meta, direct: directRoleOf(meta, uid, principalSpaceId, memberRoles) }]
  })
  const effectiveByDoc = await resolveEffectiveRolesBatch(activeCandidates, uid, principalSpaceId)

  const resolved = await mapWithConcurrency(docIds, ROLE_RESOLUTION_CONCURRENCY, async (docId) => {
    const meta = metaById.get(docId)
    // Deleted/archived docs expose NO action bits: drive hides the actions for
    // them, and every docs write path refuses them anyway.
    if (!meta || meta.status !== 1) return null
    const effective = effectiveByDoc.get(meta.doc_id) ?? 'none'
    if (effective === 'none') return null
    return {
      doc_id: meta.doc_id,
      role: effective as string,
      doc: capabilitiesWire(docCapabilitiesFor(effective, meta, uid, principalSpaceId)),
    }
  })

  res.status(200).json({ items: resolved.filter((item): item is NonNullable<typeof item> => item !== null) })
}

function parseListQuery(req: Request, res: Response): {
  uid: string
  principalSpaceId: string
  cursor: string | undefined
  limit: number
} | null {
  const uid = nonEmptyString(req.query.uid)
  const principalSpaceId = nonEmptyString(req.query.principal_space_id)
  if (uid === null || principalSpaceId === null) {
    res.status(400).json({ error: 'invalid_request' })
    return null
  }
  const cursor = typeof req.query.cursor === 'string' && req.query.cursor !== '' ? req.query.cursor : undefined
  const rawLimit = Number(req.query.limit)
  const limit = Number.isFinite(rawLimit) && rawLimit >= 1
    ? Math.min(MAX_LIBRARY_PAGE_SIZE, Math.floor(rawLimit))
    : DEFAULT_LIBRARY_PAGE_SIZE
  return { uid, principalSpaceId, cursor, limit }
}

function sharedSources(row: SharedDocItem): string[] {
  const sources: string[] = []
  // doc_member.source 1=direct, 2=invite. An unexpected stored value is
  // reported as 'direct' (the column default) instead of inventing a source.
  if (row.role !== null) sources.push(row.member_source === SOURCE_INVITE ? 'invite' : 'direct')
  // The legacy 补录 row is a separate provenance; when both exist the item is
  // reported ONCE with both sources (drive dedupes by doc_id anyway).
  if (Number(row.has_legacy) === 1) sources.push('legacy')
  return sources
}

function sharedRole(row: SharedDocItem): string | null {
  const memberRole = row.role === null ? undefined : roleFromNumber(Number(row.role))
  if (memberRole !== undefined) return memberRole
  // A legacy-only row has no doc_member grant; the old-list visibility is the
  // provenance, so it projects at the least-privileged role. The authoritative
  // can_read is still /internal/docs/status — this list is a candidate set.
  return Number(row.has_legacy) === 1 ? 'reader' : null
}

/** Green-path gate shared by both list handlers: 400 invalid_cursor on a bad token. */
function repoErrorToResponse(err: unknown, res: Response): boolean {
  if (err instanceof Error && err.message === 'invalid_cursor') {
    res.status(400).json({ error: 'invalid_cursor' })
    return true
  }
  return false
}

/** 200 body of GET /internal/docs/shared. */
export async function internalDocsSharedHandler(req: Request, res: Response): Promise<void> {
  if (!authorizeInternalDocRequest(req, res)) return
  const query = parseListQuery(req, res)
  if (!query) return
  let page
  try {
    page = await docMetaRepo.listSharedWithUser({
      uid: query.uid,
      principalSpaceId: query.principalSpaceId,
      pageSize: query.limit,
      cursor: query.cursor,
    })
  } catch (err) {
    if (repoErrorToResponse(err, res)) return
    throw err
  }
  const items = page.items.flatMap((row) => {
    const role = sharedRole(row)
    if (role === null) return []
    return [{
      doc_id: row.doc_id,
      title: row.title,
      doc_type: row.doc_type,
      owner_uid: row.owner_id,
      // Drive renders an unmounted shared row's creator separately from its
      // owner; a historical row without a creator reports "" (never the owner).
      created_by: row.created_by ?? '',
      doc_space_id: row.space_id,
      role,
      sources: sharedSources(row),
      updated_at: iso(row.updated_at),
    }]
  })
  res.status(200).json({ items, next_cursor: page.nextCursor, has_more: page.nextCursor !== null })
}

/** 200 body of GET /internal/docs/readable. */
export async function internalDocsReadableHandler(req: Request, res: Response): Promise<void> {
  if (!authorizeInternalDocRequest(req, res)) return
  const query = parseListQuery(req, res)
  if (!query) return
  let page
  try {
    page = await docMetaRepo.listReadableForUser({
      uid: query.uid,
      principalSpaceId: query.principalSpaceId,
      pageSize: query.limit,
      cursor: query.cursor,
    })
  } catch (err) {
    if (repoErrorToResponse(err, res)) return
    throw err
  }
  const items = page.items.flatMap((row: ReadableDocItem) => {
    const direct: ResolvedRole = row.owner_id === query.uid && row.owner_space_id === query.principalSpaceId
      ? 'admin'
      : (row.role === null ? undefined : roleFromNumber(Number(row.role))) ?? 'none'
    // Principal Space == document Space is the internally verified form of the
    // anyone_in_space membership check (see listReadableForUser's predicate).
    const role = effectiveRole(direct, row.space_id === query.principalSpaceId, row.share_scope, row.share_role)
    if (role === 'none') return []
    return [{
      doc_id: row.doc_id,
      title: row.title,
      doc_type: row.doc_type,
      owner_uid: row.owner_id,
      doc_space_id: row.space_id,
      role,
      sources: [] as string[],
      updated_at: iso(row.updated_at),
    }]
  })
  res.status(200).json({ items, next_cursor: page.nextCursor, has_more: page.nextCursor !== null })
}

function asyncHandler(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next)
  }
}
