/**
 * Drive-library-derived viewer access client (TES-131).
 *
 * The THIRD read-permission source merged by resolveEffectiveRole: when a doc
 * lives inside a drive library the caller can reach, the drive service grants a
 * derived READER role even with no doc_member row / share grant. This client
 * asks the drive service, per (doc, uid, principal space):
 *
 *   POST {DRIVE_INTERNAL_BASE_URL}/internal/v1/docs/derived-access
 *   X-Internal-Token: <DRIVE_INTERNAL_TOKEN>
 *   { "doc_id": "...", "uid": "...", "principal_space_id": "..." }
 *   -> 200 { "role": "reader"|"none" }
 *
 * Drive only ever derives a READER-level grant, so the answer is a role the
 * caller maps to 'reader' ("reader") or 'none' ("none"). FAIL-CLOSED on every
 * failure path (disabled, unconfigured, timeout, non-200, network error,
 * malformed / unknown-role body): the derived role is 'none' and never lowers
 * the direct/share result upstream.
 *
 * A short-TTL per-key cache + singleflight (reused from util/singleflight, the
 * same pattern isSpaceMember uses) bounds drive QPS on hot docs. Only a
 * CONFIRMED answer is cached; a fail-closed error is not, so a transient outage
 * retries on the next call rather than pinning 'none' for the whole TTL.
 *
 * Contract notes (the docs<->drive service boundary):
 *   (a) The lookup carries `uid` in the request BODY (and the sibling inbound
 *       GET /internal/docs/:docId/role reads it from the query), NOT from a
 *       verified credential: the shared X-Internal-Token proves SERVICE identity,
 *       while docs-backend is the authority on which uid maps to which role, so
 *       the uid is a parameter the trusted caller supplies.
 *   (b) A CONFIRMED answer is cached for config.driveDerived.ttlMs (default 15s),
 *       so a drive-side revocation takes at most that TTL to propagate here
 *       (operator-tunable via DRIVE_DERIVED_TTL_MS).
 *   (c) The reverse direction — drive asking docs for a direct role — is
 *       GET /internal/docs/:docId/role -> { role, role_rank, doc_status,
 *       owner_space_id }; the drive consumer compares privilege by role_rank
 *       (admin=40), so role_rank >= 40 means admin.
 */
import { config } from '../config/env.js'
import { Singleflight, TtlCache } from '../util/singleflight.js'
import { roleAtLeast, roleRank, type ResolvedRole } from '../permission/role.js'

const DERIVED_ACCESS_PATH = '/internal/v1/docs/derived-access'
const INTERNAL_TOKEN_HEADER = 'X-Internal-Token'

export interface DriveDerivedAccess {
  /**
   * Resolve the drive-derived role for (doc, uid, principal space). Returns
   * 'reader' when the drive service confirms derived access, else 'none'. Never
   * throws — every failure path fails closed to 'none'.
   */
  derivedRole(docId: string, uid: string, principalSpaceId: string): Promise<ResolvedRole>
}

interface HttpDriveDerivedAccessOptions {
  enabled?: boolean
  baseUrl?: string
  token?: string
  timeoutMs?: number
  ttlMs?: number
  /** Injectable clock so cache-expiry tests are deterministic (see TtlCache). */
  nowMs?: () => number
}

export class HttpDriveDerivedAccess implements DriveDerivedAccess {
  private readonly enabled: boolean
  private readonly baseUrl: string
  private readonly token: string
  private readonly timeoutMs: number
  private readonly sf = new Singleflight<boolean>()
  private readonly cache: TtlCache<boolean>

  constructor(opts: HttpDriveDerivedAccessOptions = {}) {
    this.enabled = opts.enabled ?? config.driveDerived.enabled
    this.baseUrl = opts.baseUrl ?? config.driveDerived.internalBaseUrl
    this.token = opts.token ?? config.driveDerived.outboundToken
    this.timeoutMs = opts.timeoutMs ?? config.driveDerived.timeoutMs
    this.cache = new TtlCache<boolean>(opts.ttlMs ?? config.driveDerived.ttlMs, opts.nowMs)
  }

  async derivedRole(docId: string, uid: string, principalSpaceId: string): Promise<ResolvedRole> {
    // Disabled / unconfigured / degenerate inputs never touch the network and
    // yield no derived access (fail-closed, byte-identical to the feature being
    // off). An unconfigured base URL is a half-configured deploy, not a hard error.
    if (!this.enabled || !this.baseUrl || !docId || !uid || !principalSpaceId) return 'none'

    const key = `${docId} ${uid} ${principalSpaceId}`
    const cached = this.cache.get(key)
    if (cached !== undefined) return cached ? 'reader' : 'none'

    const access = await this.sf.do(key, async () => {
      const confirmed = await this.fetchDerivedAccess(docId, uid, principalSpaceId)
      // Only cache a CONFIRMED answer. A fail-closed null (transport error /
      // non-200 / malformed) is NOT cached, so a transient drive outage is retried
      // on the next call rather than pinning 'none' for the whole TTL.
      if (confirmed !== null) this.cache.set(key, confirmed)
      return confirmed ?? false
    })
    return access ? 'reader' : 'none'
  }

  /**
   * One derived-access POST. Returns the confirmed boolean, or null when the
   * answer could not be confirmed (so the caller fails closed without caching).
   */
  private async fetchDerivedAccess(
    docId: string,
    uid: string,
    principalSpaceId: string,
  ): Promise<boolean | null> {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), this.timeoutMs)
    try {
      let res: Response
      try {
        res = await fetch(`${this.baseUrl}${DERIVED_ACCESS_PATH}`, {
          method: 'POST',
          signal: ac.signal,
          // Never follow a redirect: a 3xx would forward the X-Internal-Token to
          // the redirect target. The base URL is operator-configured (no
          // user-controlled SSRF surface), so this is defense-in-depth — a
          // redirect is treated as a non-confirmable answer (fail-closed).
          redirect: 'error',
          headers: {
            'Content-Type': 'application/json',
            ...(this.token ? { [INTERNAL_TOKEN_HEADER]: this.token } : {}),
          },
          body: JSON.stringify({ doc_id: docId, uid, principal_space_id: principalSpaceId }),
        })
      } catch {
        // Timeout (abort) or network error => cannot confirm => fail closed.
        return null
      }
      if (!res.ok) return null
      const body = (await res.json().catch(() => null)) as { role?: unknown } | null
      if (!body || (body.role !== 'reader' && body.role !== 'none')) return null
      return body.role === 'reader'
    } finally {
      clearTimeout(timer)
    }
  }
}

let singleton: DriveDerivedAccess | null = null

/** Resolve the configured drive derived-access client. */
export function getDriveDerivedAccess(): DriveDerivedAccess {
  if (!singleton) singleton = new HttpDriveDerivedAccess()
  return singleton
}

/** Test seam: inject a stub client. */
export function setDriveDerivedAccess(impl: DriveDerivedAccess): void {
  singleton = impl
}

/**
 * Fold the drive-library-derived reader grant into an already-resolved base role
 * — the single Source-3 merge shared by EVERY effective-role seam (the REST
 * guard, collab-token issuance, the PPT relay ticket, and the WS stale-token
 * recheck), so no seam can disagree about a drive-derived viewer (the
 * issuance/recheck single-resolution invariant, TES-137).
 *
 * Drive only ever grants `reader`, so a base already >= reader short-circuits
 * with NO drive call (no extra IO on the hot path). It is skipped too when the
 * doc_id or the caller's principal Space is absent (the narrow write-service meta
 * / an anonymous caller). The lookup is FAIL-CLOSED: any throw is treated as
 * `none` and never lowers `base`. With the feature OFF, derivedRole returns
 * `none`, so the merged result is byte-identical to the pre-feature role.
 */
export async function mergeDriveDerivedReader(
  base: ResolvedRole,
  docId: string | undefined,
  uid: string,
  principalSpaceId: string | undefined,
): Promise<ResolvedRole> {
  if (roleAtLeast(base, 'reader') || !docId || !principalSpaceId) return base
  let driveDerived: ResolvedRole = 'none'
  try {
    driveDerived = await getDriveDerivedAccess().derivedRole(docId, uid, principalSpaceId)
  } catch {
    driveDerived = 'none'
  }
  return roleRank(base) >= roleRank(driveDerived) ? base : driveDerived
}
