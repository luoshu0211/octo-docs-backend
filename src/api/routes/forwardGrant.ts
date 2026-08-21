/**
 * Forward-grant route (§2 / §9.1, doc_member max-merge).
 *
 *   POST /api/v1/docs/{docId}/forward-grant   { uid, role: "reader"|"commenter"|"writer" }
 *
 * Single-uid granularity: the frontend calls this once per 1v1 recipient and,
 * for a group, loops over the host-expanded member-snapshot uids, aggregating
 * per-uid results into N/M (contract 2 — the backend adds NO batch endpoint).
 *
 * Per-uid status contract:
 *   200 ok              — granted, upgraded, or already >= target (idempotent)
 *   400 bad request     — missing uid / invalid role
 *   403 forbidden       — forwarder is NOT admin/owner (via requireDocRole(admin))
 *   404 user_not_found  — target uid is not a real octo user (anti ghost-member)
 *   404 not_found       — doc missing/deleted ; 409 conflict — archived
 *
 * "Grant only, never downgrade" + epoch bump + owner/admin skip live in the
 * shared grantForwardAccess service. upsertDirect (admin precise set) is NOT
 * touched — this is a physically separate write path.
 */
import { Router, type Router as ExpressRouter, type Request, type Response } from 'express'
import { requireDocRole } from '../guard.js'
import { getOctoIdentity } from '../../auth/octoIdentity.js'
import { isForwardGrantRole, roleToNumber, type ForwardGrantRole, type Role } from '../../permission/role.js'
import { grantForwardAccess } from '../services/grantForward.js'

export const forwardGrantRouter: ExpressRouter = Router()

function parseGrantRole(v: unknown): ForwardGrantRole | null {
  return isForwardGrantRole(v) ? v : null
}

forwardGrantRouter.post('/:docId/forward-grant', async (req: Request, res: Response) => {
  // Authorization to GRANT: only admin/owner may forward-grant (owner => admin).
  // requireDocRole writes 404/409/403 and returns null when blocked.
  const guard = await requireDocRole(req, res, req.params.docId!, 'admin')
  if (!guard) return

  const { uid, role } = req.body ?? {}
  if (typeof uid !== 'string' || uid === '') {
    res.status(400).json({ error: 'uid required' })
    return
  }
  const parsedRole = parseGrantRole(role)
  if (!parsedRole) {
    res.status(400).json({ error: 'role must be reader|commenter|writer' })
    return
  }

  // Anti ghost-member: the target uid must be a real octo user (mirrors PUT members).
  // Bot mount (req.botToken set by verifyBot) resolves with the bot's own token
  // via the bot user-info route; human path resolves with the caller/service token.
  const user = req.botToken
    ? await getOctoIdentity().getUserAsBot(uid, req.botToken)
    : await getOctoIdentity().getUser(uid, req.octoToken)
  if (!user) {
    res.status(404).json({ error: 'user_not_found' })
    return
  }

  const result = await grantForwardAccess({
    docId: guard.meta.doc_id,
    documentName: guard.meta.document_name,
    uid,
    principalSpaceId: guard.meta.space_id,
    roleNum: roleToNumber(parsedRole),
    grantedBy: req.uid!,
  })

  res.status(200).json({ ok: true, role: result.finalRole, changed: result.changed })
})

/**
 * Batch forward-grant (§2, forward-to-large-chat rate-limit fix, XIN-1850/1853).
 *
 *   POST /api/v1/docs/{docId}/forward-grant/batch   { grants: [{ uid, role }] }
 *   POST /v1/bot/docs/{docId}/forward-grant/batch    (same handler, bot mount)
 *
 * One call authorizes many recipients so forwarding a doc to a 38-person group
 * (+ their bots) no longer fires one octo-server identity + grant round-trip per
 * uid and saturates the 300/60s limiter. The single route above is UNCHANGED and
 * still used by 1v1 forwards.
 *
 * Request-level validation is ATOMIC: an invalid body, empty grants, a duplicate
 * uid, an invalid role, or more than MAX_BATCH_GRANTS unique uids returns 400 and
 * performs ZERO writes (never a half-applied batch).
 *
 * Identity is resolved ONCE per shard/auth-realm via the batch resolver — the
 * human path calls getUsersBatch, the bot path getUsersAsBotBatch — NOT the
 * scalar getUser/getUserAsBot per uid. A batch-level identity failure (resolver
 * => null) fails CLOSED with 502 before any write, rather than guessing per uid.
 *
 * Per-item processing then mirrors the single route's max-merge semantics:
 *   - uid absent from the resolved lookup (missing / disabled / malformed row)
 *     => { uid, status: 'user_not_found' }, no grant call.
 *   - uid found => grantForwardAccess; success => { uid, status: 'ok', role,
 *     changed }, a thrown grant => { uid, status: 'grant_failed' }.
 * Earlier successes are NEVER rolled back on a later failure, and later items are
 * still processed. HTTP is always 200 (even on partial failure); `ok` is
 * `failed === 0`.
 */
const MAX_BATCH_GRANTS = 1000

interface BatchGrantResult {
  uid: string
  status: 'ok' | 'user_not_found' | 'grant_failed'
  role?: Role
  changed?: boolean
}

forwardGrantRouter.post('/:docId/forward-grant/batch', async (req: Request, res: Response) => {
  // Single admin/owner guard for the WHOLE batch (owner => admin). Writes
  // 404/409/403 and returns null when blocked.
  const guard = await requireDocRole(req, res, req.params.docId!, 'admin')
  if (!guard) return

  // --- Atomic request-level validation: any failure => 400, zero writes. ---
  const grants = (req.body ?? {}).grants
  if (!Array.isArray(grants) || grants.length === 0) {
    res.status(400).json({ error: 'grants must be a non-empty array' })
    return
  }
  if (grants.length > MAX_BATCH_GRANTS) {
    res.status(400).json({ error: `grants exceeds max of ${MAX_BATCH_GRANTS}` })
    return
  }
  const parsed: Array<{ uid: string; role: ForwardGrantRole }> = []
  const seen = new Set<string>()
  for (const g of grants) {
    if (!g || typeof g !== 'object') {
      res.status(400).json({ error: 'each grant must be an object with uid and role' })
      return
    }
    const { uid, role } = g as { uid?: unknown; role?: unknown }
    if (typeof uid !== 'string' || uid === '') {
      res.status(400).json({ error: 'each grant requires a non-empty uid' })
      return
    }
    if (seen.has(uid)) {
      res.status(400).json({ error: `duplicate uid ${uid}` })
      return
    }
    const parsedRole = parseGrantRole(role)
    if (!parsedRole) {
      res.status(400).json({ error: 'role must be reader|commenter|writer' })
      return
    }
    seen.add(uid)
    parsed.push({ uid, role: parsedRole })
  }

  // --- Resolve every identity in ONE call (never scalar-per-uid). ---
  // Bot mount (req.botToken set by verifyBot) resolves with the bot's own token
  // via the bot batch route; the human path resolves with the caller/service
  // token. A null lookup is a batch-level identity failure => fail closed.
  const uids = parsed.map((g) => g.uid)
  const lookup = req.botToken
    ? await getOctoIdentity().getUsersAsBotBatch(uids, req.botToken)
    : await getOctoIdentity().getUsersBatch(uids, req.octoToken)
  if (!lookup) {
    res.status(502).json({ error: 'identity_unavailable' })
    return
  }

  // --- Iterate in input order; no rollback of earlier successes. ---
  const results: BatchGrantResult[] = []
  let granted = 0
  let failed = 0
  for (const g of parsed) {
    if (!lookup.get(g.uid)) {
      // missing / disabled / malformed row -> per-item user_not_found, no grant.
      results.push({ uid: g.uid, status: 'user_not_found' })
      failed += 1
      continue
    }
    try {
      const result = await grantForwardAccess({
        docId: guard.meta.doc_id,
        documentName: guard.meta.document_name,
        uid: g.uid,
        principalSpaceId: guard.meta.space_id,
        roleNum: roleToNumber(g.role),
        grantedBy: req.uid!,
      })
      results.push({ uid: g.uid, status: 'ok', role: result.finalRole, changed: result.changed })
      granted += 1
    } catch {
      // A single failed grant does not abort the batch or undo prior successes.
      results.push({ uid: g.uid, status: 'grant_failed' })
      failed += 1
    }
  }

  res.status(200).json({ ok: failed === 0, granted, failed, results })
})
