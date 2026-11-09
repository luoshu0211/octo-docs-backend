/**
 * onAuthenticate implementation (§4.1).
 *
 * Connection authentication verifies the token, reads current permission_epoch
 * (Redis cache with DB singleflight on miss), and resolves the current effective
 * role on every handshake so same-epoch Drive changes are not trusted from claims.
 *
 * Throws to reject the connection. The thrown Error.message encodes the WS
 * close-code semantics for the front-end (§8.2):
 *   'Unauthorized' -> 4401 (refreshable)
 *   'Forbidden'    -> 4403 (permanent no-access)
 */
import { createHash } from 'node:crypto'
import { verifyCollabToken } from '../auth/collabToken.js'
import { currentEpoch } from '../permission/epoch.js'
import { beginActiveAccessRegistration, type ActiveAccessRegistrationLease } from '../permission/activeAccess.js'
import { recheckCurrentAccess, type CurrentAccess } from '../permission/resolveRole.js'
import { parseDocumentName } from '../permission/documentName.js'
import type { Role } from '../permission/role.js'

/**
 * Auth rejection carrying the WS close-code semantics (§8.2). Hocuspocus reads
 * `.reason` (and `.code` on some paths) from the thrown error.
 *   4401 Unauthorized (refreshable) / 4403 Forbidden (permanent no-access).
 */
export class AuthError extends Error {
  constructor(
    readonly code: 4401 | 4403,
    readonly reason: 'Unauthorized' | 'Forbidden',
  ) {
    super(reason)
    this.name = 'AuthError'
  }
}

const unauthorized = () => new AuthError(4401, 'Unauthorized')
const forbidden = () => new AuthError(4403, 'Forbidden')

export interface AuthContext {
  stateGeneration?: string | null
  cacheGeneration?: string | null
  user: { id: string; name?: string }
  role: Role
  permission_epoch: number
  principal_space_id: string
  source_access?: CurrentAccess
  activeAccessDisposer?: () => void
  activeAccessRegistration: ActiveAccessRegistrationLease | null
  /**
   * (#64) Was this uid a member of the doc's Space at token issuance? Carried
   * from the collab token's optional `space_member` claim (absent => false,
   * fail-closed). The live-socket write recheck combines this token-carried
   * "who the requester is in the space" fact with a FRESH DB read of the doc's
   * share settings ("what the doc allows"), so a scope narrowing takes effect
   * without a new membership call. See design §5.3 case 2.
   */
  space_member: boolean
  /** 'document' (4-seg key) or 'whiteboard' (5-seg `:wb:` key, M2). */
  kind: 'document' | 'whiteboard'
  space: string
  folder: string
  /** doc id for documents; undefined for whiteboards (see `board`). */
  doc?: string
  /** board id for whiteboards; undefined for documents. */
  board?: string
}

export interface AuthInput {
  token: string
  documentName: string
  connectionConfig: { readOnly?: boolean }
}

export async function authenticate(data: AuthInput): Promise<AuthContext> {
  const { token, documentName, connectionConfig } = data

  // 1. verify collab token: signature + exp. Throws => 4401.
  let claims
  try {
    claims = verifyCollabToken(token)
  } catch {
    throw unauthorized() // 4401
  }

  // 2. token.documentName must match the connection documentName (anti-misuse).
  if (claims.documentName !== documentName) throw forbidden() // 4403
  // The current-Space proof is minted only after the issuer has bound the
  // authenticated uid/session to current_space_id through octo-server's active
  // Space-membership context. It deliberately does NOT assert that current
  // Space equals the document home Space: authenticated-scope users and direct
  // cross-Space collaborators are valid. Missing/malformed proof is always
  // forbidden; the old home-space rollout flag must not weaken this contract.
  if (
    claims.current_space_verified !== true
    || typeof claims.current_space_id !== 'string'
    || claims.current_space_id === ''
  ) throw forbidden()

  let parsed
  try {
    parsed = parseDocumentName(documentName)
  } catch {
    throw forbidden() // 4403
  }

  // 3. permission_epoch is authoritative for Docs-owned ACL changes, but it does
  //    not track Drive source changes. Re-resolve the effective role on every
  //    handshake so a same-epoch token cannot preserve revoked derived access.
  let epoch: number
  try {
    epoch = await currentEpoch(documentName)
  } catch {
    throw unauthorized() // 4401 — authoritative source unconfirmable, fail-closed
  }

  const docId = parsed.kind === 'document' ? parsed.doc : parsed.kind === 'whiteboard' ? parsed.board : undefined
  if (docId === undefined) throw forbidden()
  const authorityScope = claims.space_member === true
    ? `collab:share:${createHash('sha256').update(token).digest('hex')}`
    : 'collab:direct'
  const activeAccessRegistration = beginActiveAccessRegistration({
    docId,
    uid: claims.uid,
    principalSpaceId: claims.principal_space_id,
  }, authorityScope)
  let registrationTransferred = false
  try {
    let currentAccess: CurrentAccess
    try {
      currentAccess = await recheckCurrentAccess(
        documentName,
        claims.uid,
        claims.principal_space_id,
        claims.space_member ?? false,
      )
    } catch {
      throw unauthorized() // 4401 — current role unconfirmable
    }
    if (
      currentAccess.sourceRevision !== null &&
      (currentAccess.proofExpiresAt === null || currentAccess.proofExpiresAt <= performance.now())
    ) throw unauthorized()
    const currentRole = currentAccess.role
    if (currentRole === 'none') {
      if (!currentAccess.sourceConfirmed) throw unauthorized()
      throw forbidden() // 4403: no current Docs or Drive access
    }
    if (claims.permission_epoch < epoch || currentRole !== claims.role) {
      throw unauthorized() // 4401: refresh the token after any current-role change
    }

    // The signed role is safe to use only after the authoritative resolver
    // confirms the same effective role.
    const role = claims.role
    // 4b. v2 identity binding (remove-sp §7.3). A v2 token carries docId +
    //     homeSpaceId alongside documentName; bind them to the connection so the
    //     token cannot be replayed against a room whose canonical key disagrees
    //     with the identity it was minted for. Zero-IO: step 2 already proved
    //     `claims.documentName === documentName` (the room key), and that key is
    //     canonical `octo:{space}:{folder}:{doc|wb:board}`, so comparing the token
    //     claims to the parsed segments enforces "token docId == this doc" and
    //     "token homeSpaceId == doc_meta.space_id" without a doc_meta read. Legacy
    //     v1 tokens (no `ver`) skip this — they carry neither claim (compat window).
    if (claims.ver === 2) {
      const boundDocId =
        parsed.kind === 'document' ? parsed.doc : parsed.kind === 'whiteboard' ? parsed.board : undefined
      if (boundDocId === undefined || claims.docId !== boundDocId || claims.homeSpaceId !== parsed.space) {
        throw forbidden() // 4403 — identity claims disagree with the canonical room
      }
    }

    // 5. reader/commenter: set readOnly so body writes are rejected BEFORE being
    //    applied (v4). A commenter may comment via the REST API but must not edit
    //    the doc body over the collab connection, so it is read-only here too.
    if (role === 'reader' || role === 'commenter') {
      connectionConfig.readOnly = true
    }

    // 6. inject context for downstream hooks (kind-tagged). The trusted display
    //    name (resolved at issuance, §4.7(b)) rides along so beforeHandleAwareness
    //    can stamp the presence frame's user.name; uid stays the identity.
    const base = {
      user: { id: claims.uid, ...(claims.name ? { name: claims.name } : {}) },
      role,
      source_access: currentAccess,
      activeAccessRegistration,
      permission_epoch: claims.permission_epoch,
      principal_space_id: claims.principal_space_id,
      // #64: carry the space-membership claim (absent => false) so the write
      // recheck can honor the anyone_in_space scope on already-connected sockets.
      space_member: claims.space_member ?? false,
      space: parsed.space,
      folder: parsed.folder,
    }
    const context: AuthContext = parsed.kind === 'whiteboard'
      ? { ...base, kind: 'whiteboard', board: parsed.board }
      : { ...base, kind: 'document', doc: parsed.doc }
    registrationTransferred = true
    return context
  } finally {
    if (!registrationTransferred) activeAccessRegistration.release()
  }
}
