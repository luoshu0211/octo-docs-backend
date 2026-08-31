/**
 * Access-request routes (§4.3, screen 4c — "request access" MVP, pull-based).
 *
 *   POST /api/v1/docs/{docId}/access-requests                    submit (any octo login)
 *   GET  /api/v1/docs/{docId}/access-requests?status=pending     list  (needs admin)
 *   POST /api/v1/docs/{docId}/access-requests/{requestId}/approve approve (needs admin)
 *   POST /api/v1/docs/{docId}/access-requests/{requestId}/deny    deny    (needs admin)
 *
 * Approval reuses the SAME max-merge grant path as forward-grant
 * (grantForwardAccess: only-up, epoch bump, owner/admin skip). Denial leaves the
 * requester forbidden.
 *
 * NOTE (§4.2 / scope item 6): the pending list stays PULL-based (admins fetch it
 * in the manage-members panel). The second-phase ACTIVE push to owner+admin is
 * now implemented as a best-effort side effect of submit: a docs-notify card is
 * sent via octo-server's internal notify API (see services/docsNotify.ts). It is
 * fire-and-forget and gated on config — if OCTO_DOCS_NOTIFY_TOKEN is unset it is a
 * silent no-op, and any send failure never affects the submit response.
 */
import { Router, type Router as ExpressRouter, type Request, type Response } from 'express'
import { docMetaRepo } from '../../db/repos/docMetaRepo.js'
import {
  docAccessRequestRepo,
  REQUEST_STATUS_PENDING,
  REQUEST_STATUS_APPROVED,
  REQUEST_STATUS_DENIED,
} from '../../db/repos/docAccessRequestRepo.js'
import { requireDocRole, requireSameSpace } from '../guard.js'
import { requireVerifiedHumanCurrentSpace } from '../middleware/docSpaceScope.js'
import { resolveRole } from '../../permission/resolveRole.js'
import { grantApprovedRequestBots } from '../services/grantRequestWithBots.js'
import { approveAccessRequest } from '../services/approveAccessRequest.js'
import { logBotGrantSummary } from '../services/botGrantAudit.js'
import { getOctoIdentity } from '../../auth/octoIdentity.js'
import { parseRequestBotUids, BotUidsValidationError } from '../../util/botUids.js'
import { notifyDocAccessRequested } from '../services/docsNotify.js'
import { syncDecisionCards } from '../services/docsDecisionCardSync.js'
import { resolveRequestPrincipalSpace } from '../../permission/principalSpace.js'
import { isAccessRequestRole, roleAtLeast, roleToNumber, roleFromNumber } from '../../permission/role.js'


export const accessRequestsRouter: ExpressRouter = Router()

const roleName = (n: number): AccessRequestRole => {
  const role = roleFromNumber(n)
  if (!isAccessRequestRole(role)) throw new Error(`invalid requested_role ${n}`)
  return role
}

type AccessRequestRole = 'reader' | 'commenter' | 'writer' | 'admin'

const requestableRoles = (docType: string): readonly AccessRequestRole[] =>
  docType === 'html' ? ['reader', 'commenter'] : ['reader', 'commenter', 'writer']

const approvableRoles = (docType: string): readonly AccessRequestRole[] =>
  [...requestableRoles(docType), 'admin']

const isRequestableRole = (role: AccessRequestRole, docType: string): boolean =>
  requestableRoles(docType).includes(role)

const isApprovableRole = (role: AccessRequestRole, docType: string): boolean =>
  approvableRoles(docType).includes(role)

/**
 * The decider's authoritative trusted Space for a REST decision — the caller's
 * server-verified current Space (`req.principalSpaceId`). It deliberately does
 * not fall back to the document's Space: those are different facts for a
 * multi-Space user, and guessing would misattribute the approval.
 */
function deciderSpaceId(req: Request): string {
  return req.principalSpaceId ?? ''
}

/**
 * POST submit — any authenticated octo user (no doc role required). Idempotent
 * by (doc_id, uid). If the caller already holds >= the requested role and no
 * bots are requested, returns 200 already_granted without writing a row.
 *
 * ★ Deliberately NOT behind `requireSpaceMembership`, unlike the space-selector
 * routes. The whole persona this route serves is an OUTSIDER: octo-web's
 * forbidden landing (`packages/docs/src/pages/StandaloneDocPage.tsx`, feature
 * #511 screen 4c) renders `RequestAccessButton` for "a receiver who lands on a
 * doc they cannot open", passing `preflightSpace` — which is
 * `standaloneLinkSpace()`, i.e. the `?sp=` value from the doc's OWN space that
 * `util/docShareLink.ts` minted. Such a receiver is by definition not a member of
 * that space; that is the design premise, not an anomaly. A membership gate here
 * makes the preflight 403 render the button and the button itself 404 — the same
 * defect as gating the `/:docId` read path, one route over. Nor does
 * forward-grant substitute for it: `forwardGrant.ts:36` requires `admin`, so it
 * is the doc admin GRANTING, never the outsider ASKING.
 *
 * `requireSameSpace` below therefore stays the only space check, and is honest
 * about what it buys: it compares `meta.space_id` against the same unverified
 * header, so it does not prove membership — it only pins the write to the doc's
 * own space, keeping a cross-space row from ever landing. The residual is a
 * (doc_id, space_id) existence probe, which needs a `newDocId()` guess first:
 * `util/ids.ts:14` is `d_` + `randomBytes(12)`, i.e. 96 bits.
 */
accessRequestsRouter.post('/:docId/access-requests', async (req: Request, res: Response) => {
  const docId = req.params.docId!
  const meta = await docMetaRepo.getByDocId(docId)
  if (!meta || meta.status === 0) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  // Space-scope policy split (remove-sp §6.1). This submit route is the only one
  // in the router that skips requireDocRole (submit needs no doc role), so it
  // must apply the SAME explicit per-mount policy the shared guard uses — never
  // infer the boundary from req.botToken here.
  //   - Bot ({ mode: 'bot', spaceId }): keep the pre-existing cross-space 404
  //     gate against the server-resolved Space, so a bot cannot probe or write an
  //     access-request row against a doc in another Space (existence/state oracle
  //     + cross-space write). Unchanged bot semantics.
  //   - Human ({ mode: 'human' }): locate by path docId ALONE — no requireSameSpace
  //     and no client-supplied home Space — so the 403 "request access" button on
  //     a no-`sp` page works for a doc in any Space the caller can see. This does
  //     NOT widen approval/grant: it only lets the request be submitted.
  // Fail CLOSED (unset scope => bot-empty-space => 404), matching the guard.
  const scope = req.docSpaceScope ?? { mode: 'bot' as const, spaceId: '' }
  if (scope.mode === 'bot' && !requireSameSpace(res, meta, scope.spaceId)) {
    return
  }
  if (scope.mode === 'human' && !(await requireVerifiedHumanCurrentSpace(req, res, meta))) return
  if (meta.status === 2) {
    res.status(409).json({ error: 'conflict' })
    return
  }

  const principalSpaceId = await resolveRequestPrincipalSpace(req)
  if (!principalSpaceId) {
    res.status(403).json({ error: 'principal_space_unverified' })
    return
  }

  const suppliedRole = (req.body ?? {}).requestedRole
  const requestedRole = suppliedRole === undefined ? 'reader' : suppliedRole
  if (!isAccessRequestRole(requestedRole) || !isRequestableRole(requestedRole, meta.doc_type)) {
    res.status(400).json({
      error: meta.doc_type === 'html'
        ? 'requestedRole must be reader|commenter'
        : 'requestedRole must be reader|commenter|writer',
    })
    return
  }

  const reasonRaw = (req.body ?? {}).reason
  const reason = typeof reasonRaw === 'string' ? reasonRaw.slice(0, 512) : ''

  // Strict-parse the optional Space-bot snapshot: omitted => []; otherwise it
  // MUST be an array of trimmed, non-empty, ≤64-char, non-duplicate uids, total
  // ≤50 — any violation is a 400 (never a silent drop/truncate). The owned-set
  // subset gate runs later, only if the caller is not already privileged.
  let requestedBotUids: string[]
  try {
    requestedBotUids = parseRequestBotUids((req.body ?? {}).botUids)
  } catch (err) {
    if (err instanceof BotUidsValidationError) {
      res.status(400).json({ error: err.message })
      return
    }
    throw err
  }

  // Preserve the legacy no-op only for human-only requests. A bot-bearing
  // request must remain pending so an admin explicitly approves the bot grants.
  const current = await resolveRole(req.uid!, docId, principalSpaceId)
  if (requestedBotUids.length === 0 && roleAtLeast(current, requestedRole)) {
    res.status(200).json({ status: 'already_granted', role: current })
    return
  }

  // Admit ONLY bots the caller owns in their verified CURRENT Space — the same
  // principal Space stored on the human request. A cross-Space requester must never
  // carry a Bot from the document Home Space. Resolved from the caller's
  // own session token (never client-supplied, never a third party's bots).
  // FAIL-CLOSED: a bot mount (no session token) or unresolvable context yields
  // an empty owned set, so any submitted bot is rejected (403).
  let botUids: string[] = []
  if (requestedBotUids.length > 0) {
    const owned = new Set(
      await getOctoIdentity().ownedBotsInSpace(req.uid!, principalSpaceId, req.octoToken ?? ''),
    )
    const rejected = requestedBotUids.filter((b) => !owned.has(b))
    if (rejected.length > 0) {
      // Any bot the caller does not own here is a hard 403, not a silent narrow:
      // failing loudly keeps the boundary auditable. A transport failure
      // (owned=[]) also lands here rather than authorizing anything.
      res.status(403).json({ error: 'bot_not_owned_in_space', botUids: rejected })
      return
    }
    botUids = requestedBotUids
  }

  const out = await docAccessRequestRepo.submit({
    docId,
    uid: req.uid!,
    principalSpaceId,
    requestedRoleNum: roleToNumber(requestedRole),
    reason,
    botUids,
  })

  // Best-effort second-phase push: notify owner+admins with a docs-notify card
  // via octo-server's internal notify API. Fire-and-forget — never blocks or
  // fails the 201 (notifyDocAccessRequested swallows all errors internally); the
  // pending list is the source of truth.
  void notifyDocAccessRequested({
    docId,
    requestId: out.requestId,
    spaceId: meta.space_id,
    ownerId: meta.owner_id,
    ownerSpaceId: meta.owner_space_id,
    title: meta.title,
    requesterUid: req.uid!,
    requesterSpaceId: principalSpaceId,
    reason,
    requestedRole,
    botUids,
    requesterToken: req.octoToken ?? '',
  }).catch(() => {})

  res.status(201).json({ requestId: out.requestId, status: 'pending' })
})

/** GET list requests by status (needs admin; default pending). */
accessRequestsRouter.get('/:docId/access-requests', async (req: Request, res: Response) => {
  const guard = await requireDocRole(req, res, req.params.docId!, 'admin')
  if (!guard) return
  const statusParam = req.query.status
  const statusNum =
    statusParam === 'approved'
      ? REQUEST_STATUS_APPROVED
      : statusParam === 'denied'
        ? REQUEST_STATUS_DENIED
        : REQUEST_STATUS_PENDING
  const items = await docAccessRequestRepo.listByStatus(req.params.docId!, statusNum)
  res.status(200).json({
    items: items.map((r) => ({
      requestId: r.request_id,
      uid: r.uid,
      principalSpaceId: r.principal_space_id,
      requestedRole: roleName(Number(r.requested_role)),
      reason: r.reason,
      botUids: r.bot_uids,
      createdAt: r.created_at,
    })),
  })
})

/**
 * POST approve (needs admin). Atomically consumes the pending request and
 * grants the chosen Human role via the shared only-up path; Bot fan-out follows
 * after commit and remains partial-failure tolerant.
 *
 * The transaction-scoped CAS carries the only `WHERE status = pending` guard.
 * Granting only when that CAS wins means a replayed, double-
 * submitted, or already-decided request (denied OR approved) can never授权 —
 * a denial is never silently overwritten and an approval is never double-
 * granted. If the primary Human grant fails, the CAS and epoch change roll back,
 * leaving the request pending and retryable. A non-pending request is a 409.
 */
accessRequestsRouter.post(
  '/:docId/access-requests/:requestId/approve',
  async (req: Request, res: Response) => {
    const guard = await requireDocRole(req, res, req.params.docId!, 'admin')
    if (!guard) return
    const request = await docAccessRequestRepo.getByRequestId(req.params.docId!, req.params.requestId!)
    if (!request) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    // Legacy `{ role }` keeps unified Human/Bot approval compatibility. The new shape permits an
    // administrator to choose the Human role, Bot role, and an exact subset of carried Bots.
    const body = (req.body ?? {}) as Record<string, unknown>
    const suppliedHumanRole = body.humanRole ?? body.role
    const humanRole = suppliedHumanRole === undefined
      ? roleName(Number(request.requested_role))
      : isAccessRequestRole(suppliedHumanRole) ? suppliedHumanRole : null
    const suppliedBotRole = body.botRole ?? body.role ?? humanRole
    const botRole = isAccessRequestRole(suppliedBotRole) ? suppliedBotRole : null
    if (!humanRole || !botRole) {
      res.status(400).json({ error: 'role_invalid' })
      return
    }
    if (!isApprovableRole(humanRole, guard.meta.doc_type) || !isApprovableRole(botRole, guard.meta.doc_type)) {
      res.status(400).json({ error: 'role_not_grantable_for_document_type' })
      return
    }

    const carriedBots = request.bot_uids ?? []
    const selectedBotsRaw = body.botUids === undefined ? carriedBots : body.botUids
    if (!Array.isArray(selectedBotsRaw) || selectedBotsRaw.some((uid) => typeof uid !== 'string')) {
      res.status(400).json({ error: 'bot_uids_invalid' })
      return
    }
    const selectedBots = [...new Set(selectedBotsRaw as string[])]
    const carriedBotSet = new Set(carriedBots)
    if (selectedBots.some((uid) => !carriedBotSet.has(uid))) {
      res.status(400).json({ error: 'bot_not_in_request' })
      return
    }


    const decidedAtUnix = Math.floor(Date.now() / 1000)
    const decidedBySpaceId = deciderSpaceId(req)
    const approval = await approveAccessRequest({
      docId: req.params.docId!,
      requestId: req.params.requestId!,
      documentName: guard.meta.document_name,
      ownerUid: guard.meta.owner_id,
      ownerSpaceId: guard.meta.owner_space_id,
      uid: request.uid,
      principalSpaceId: request.principal_space_id,
      roleNum: roleToNumber(humanRole),
      allowAdmin: humanRole === 'admin',
      decidedBy: req.uid!,
      decidedBySpaceId,
      decidedAtUnix,
    })
    if (!approval.transitioned) {
      // Already denied / approved / cancelled (or lost a concurrent race):
      // the request is no longer pending, so we grant nothing.
      res.status(409).json({ error: 'not_pending' })
      return
    }

    const result = await grantApprovedRequestBots({
      docId: guard.meta.doc_id,
      requestId: req.params.requestId!,
      documentName: guard.meta.document_name,
      uid: request.uid,
      principalSpaceId: request.principal_space_id,
      roleNum: roleToNumber(humanRole),
      botRoleNum: roleToNumber(botRole),
      allowAdmin: humanRole === 'admin',
      allowBotAdmin: botRole === 'admin',
      grantedBy: req.uid!,
      // The selected set is constrained to the stored, already-admissible submission snapshot.
      botUids: selectedBots,
    }, approval.requesterRole!)
    const hadBots = selectedBots.length > 0
    if (hadBots) {
      logBotGrantSummary({
        source: 'rest',
        docId: guard.meta.doc_id,
        requestId: req.params.requestId!,
        result,
      })
    }
    // Best-effort sibling-card sync. REST path has no card-callback finalizer, so
    // the decider (req.uid) holds a live card and is terminalized here too
    // (deciderCardHandledExternally omitted). Carries the authoritative decider
    // IDs + decision time so octo-server renders each card itself.
    void syncDecisionCards({
      requestId: req.params.requestId!,
      spaceId: guard.meta.space_id,
      docId: guard.meta.doc_id,
      title: guard.meta.title,
      deciderUid: req.uid!,
      deciderSpaceId: decidedBySpaceId,
      denied: false,
      decidedAtSeconds: decidedAtUnix,
    }).catch(() => {})
    // Response shape (per scheme): zero-bot requests keep the legacy { ok, role }
    // byte-for-byte (no empty field). Only when the request carried bots do we add
    // botGrantResult, with failures itemized as { uid, reason:'grant_failed' }.
    res.status(200).json({
      ok: true,
      role: result.requesterRole,
      ...(hadBots
        ? {
            botGrantResult: {
              succeeded: result.botsSucceeded,
              failed: result.botsFailed.map((uid) => ({ uid, reason: 'grant_failed' as const })),
            },
          }
        : {}),
    })
  },
)

/**
 * POST deny (needs admin). Marks the request denied; requester stays forbidden.
 * Gated on a genuine pending -> denied transition (same范式 as approve): if the
 * request is unknown -> 404, and if it is no longer pending (already approved /
 * denied / cancelled, or lost a concurrent race) decide() reports no row and we
 * return 409 not_pending instead of a false ok:true.
 */
accessRequestsRouter.post(
  '/:docId/access-requests/:requestId/deny',
  async (req: Request, res: Response) => {
    const guard = await requireDocRole(req, res, req.params.docId!, 'admin')
    if (!guard) return
    const request = await docAccessRequestRepo.getByRequestId(req.params.docId!, req.params.requestId!)
    if (!request) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    // Mirror approve: decide() carries the only WHERE status=pending guard and
    // reports whether it actually transitioned a row. Only report ok when a
    // genuine pending -> denied transition happened; a replayed / already-decided
    // (approved OR denied) request is a 409, never a false success.
    const decidedAtUnix = Math.floor(Date.now() / 1000)
    const decidedBySpaceId = deciderSpaceId(req)
    const decided = await docAccessRequestRepo.decide({
      docId: req.params.docId!,
      requestId: req.params.requestId!,
      status: REQUEST_STATUS_DENIED,
      decidedBy: req.uid!,
      decidedBySpaceId,
      decidedAtUnix,
    })
    if (!decided) {
      res.status(409).json({ error: 'not_pending' })
      return
    }
    // Drive every approver's sibling card to terminal (task
    // docs-access-decision-card-sync). Best-effort. This is the REST path (no
    // card-callback finalizer), so the decider (req.uid) is an approver holding a
    // live card and must be terminalized too — deciderCardHandledExternally
    // omitted (false). The REST deny carries no reviewer reason, so the terminal
    // card omits it (same as a reasonless card deny).
    void syncDecisionCards({
      requestId: req.params.requestId!,
      spaceId: guard.meta.space_id,
      docId: guard.meta.doc_id,
      title: guard.meta.title,
      deciderUid: req.uid!,
      deciderSpaceId: decidedBySpaceId,
      denied: true,
      decidedAtSeconds: decidedAtUnix,
    }).catch(() => {})
    res.status(200).json({ ok: true })
  },
)
