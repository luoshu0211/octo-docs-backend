/**
 * Docs-to-Drive derived-access contract. Full decisions carry the authoritative
 * source fingerprint and remaining proof lifetime; active bindings use the same
 * source projection through the batch versions endpoint.
 */
import { config } from '../config/env.js'
import { Singleflight } from '../util/singleflight.js'
import { roleAtLeast, roleRank, type ResolvedRole } from '../permission/role.js'

const DERIVED_ACCESS_PATH = '/internal/v1/docs/derived-access'
const DERIVED_ACCESS_VERSIONS_PATH = `${DERIVED_ACCESS_PATH}/versions`
const INTERNAL_TOKEN_HEADER = 'X-Internal-Token'
const MAX_VALID_FOR_MS = 30_000
const MAX_VERSION_BATCH = 50

export type DerivedRole = Extract<ResolvedRole, 'reader' | 'none'>

export interface DerivedAccessBinding {
  docId: string
  uid: string
  principalSpaceId: string
}

export interface DerivedAccessProof extends DerivedAccessBinding {
  role: DerivedRole
  sourceRevision: string
  validForMs: number
  /** Monotonic local deadline; always based on the request start time. */
  expiresAt: number
}

export interface DerivedAccessVersion extends DerivedAccessBinding {
  sourceRevision: string
  validForMs: number
  /** Monotonic local deadline; always based on the request start time. */
  expiresAt: number
}

export interface DriveDerivedAccess {
  /** Complete effective Drive-derived decision for one binding. */
  derivedAccess(docId: string, uid: string, principalSpaceId: string): Promise<DerivedAccessProof | null>
  /** Source-version probes for 1..50 unique bindings. */
  versions(bindings: readonly DerivedAccessBinding[]): Promise<DerivedAccessVersion[] | null>
}

interface HttpDriveDerivedAccessOptions {
  enabled?: boolean
  baseUrl?: string
  token?: string
  timeoutMs?: number
  ttlMs?: number
  /** Monotonic clock seam for deterministic proof-expiry tests. */
  nowMs?: () => number
}

function keyOf(docId: string, uid: string, principalSpaceId: string): string {
  return JSON.stringify([docId, uid, principalSpaceId])
}

function sourceRevision(value: unknown): string | null {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/i.test(value) ? value : null
}

function validForMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_VALID_FOR_MS
    ? value : null
}

export class HttpDriveDerivedAccess implements DriveDerivedAccess {
  private readonly enabled: boolean
  private readonly baseUrl: string
  private readonly token: string
  private readonly timeoutMs: number
  private readonly ttlMs: number
  private readonly nowMs: () => number
  private readonly accessFlights = new Singleflight<DerivedAccessProof | null>()
  private readonly accessCache = new Map<string, DerivedAccessProof>()
  private readonly flightGeneration = new Map<string, number>()
  private readonly inFlightGenerations = new Map<string, Set<number>>()
  private readonly inFlightBindings = new Map<string, DerivedAccessBinding>()

  constructor(opts: HttpDriveDerivedAccessOptions = {}) {
    this.enabled = opts.enabled ?? config.driveDerived.enabled
    this.baseUrl = opts.baseUrl ?? config.driveDerived.internalBaseUrl
    this.token = opts.token ?? config.driveDerived.outboundToken
    this.timeoutMs = opts.timeoutMs ?? config.driveDerived.timeoutMs
    this.ttlMs = opts.ttlMs ?? config.driveDerived.ttlMs
    this.nowMs = opts.nowMs ?? (() => performance.now())
  }

  async derivedAccess(docId: string, uid: string, principalSpaceId: string): Promise<DerivedAccessProof | null> {
    if (!this.enabled || !this.baseUrl || !docId || !uid || !principalSpaceId) return null
    const key = keyOf(docId, uid, principalSpaceId)
    const cached = this.accessCache.get(key)
    if (cached) {
      if (this.nowMs() < cached.expiresAt) return cached
      this.accessCache.delete(key)
    }
    const generation = this.flightGeneration.get(key) ?? 0
    return this.accessFlights.do(`${key}\x00${generation}`, async () => {
      let generations = this.inFlightGenerations.get(key)
      if (!generations) {
        generations = new Set()
        this.inFlightGenerations.set(key, generations)
      }
      generations.add(generation)
      this.inFlightBindings.set(key, { docId, uid, principalSpaceId })
      try {
        const requestStartedAt = this.nowMs()
        const body = await this.postJson(DERIVED_ACCESS_PATH, {
          doc_id: docId,
          uid,
          principal_space_id: principalSpaceId,
        })
        const proof = this.decodeAccess(body, { docId, uid, principalSpaceId }, requestStartedAt)
        if ((this.flightGeneration.get(key) ?? 0) !== generation ||
            !proof || proof.expiresAt <= this.nowMs()) return null
        this.accessCache.set(key, proof)
        return proof
      } finally {
        const generations = this.inFlightGenerations.get(key)!
        generations.delete(generation)
        if (generations.size === 0) {
          this.inFlightGenerations.delete(key)
          this.inFlightBindings.delete(key)
          this.flightGeneration.delete(key)
        }
      }
    })
  }

  async versions(bindings: readonly DerivedAccessBinding[]): Promise<DerivedAccessVersion[] | null> {
    if (!this.enabled || !this.baseUrl || bindings.length === 0 || bindings.length > MAX_VERSION_BATCH) return null
    const seen = new Set<string>()
    for (const binding of bindings) {
      if (!binding.docId || !binding.uid || !binding.principalSpaceId) return null
      const key = keyOf(binding.docId, binding.uid, binding.principalSpaceId)
      if (seen.has(key)) return null
      seen.add(key)
    }

    const requestStartedAt = this.nowMs()
    const body = await this.postJson(DERIVED_ACCESS_VERSIONS_PATH, {
      items: bindings.map(binding => ({
        doc_id: binding.docId,
        uid: binding.uid,
        principal_space_id: binding.principalSpaceId,
      })),
    })
    if (!body || typeof body !== 'object' || !('items' in body)) return null
    const items = body.items
    if (!Array.isArray(items)) return null
    if (items.length !== bindings.length) return null
    const result: DerivedAccessVersion[] = []
    for (let index = 0; index < items.length; index++) {
      const item = items[index]
      const binding = bindings[index]!
      if (!item || typeof item !== 'object') return null
      const value = item as Record<string, unknown>
      if (
        value.doc_id !== binding.docId ||
        value.uid !== binding.uid ||
        value.principal_space_id !== binding.principalSpaceId
      ) return null
      const revision = sourceRevision(value.source_revision)
      const validFor = validForMs(value.valid_for_ms)
      if (revision === null || validFor === null) return null
      result.push({
        ...binding,
        sourceRevision: revision,
        validForMs: validFor,
        expiresAt: requestStartedAt + Math.min(validFor, this.ttlMs, MAX_VALID_FOR_MS),
      })
    }
    return result
  }

  /** Drop only this binding's cached source fact and isolate an older request. */
  invalidate(docId: string, uid: string, principalSpaceId: string): void {
    this.invalidateKey(keyOf(docId, uid, principalSpaceId))
  }

  invalidateSpace(docId: string, principalSpaceId: string, uid?: string): void {
    const keys = new Set<string>()
    for (const [key, proof] of this.accessCache) {
      if (proof.docId === docId && proof.principalSpaceId === principalSpaceId &&
          (uid === undefined || proof.uid === uid)) keys.add(key)
    }
    for (const [key, binding] of this.inFlightBindings) {
      if (binding.docId === docId && binding.principalSpaceId === principalSpaceId &&
          (uid === undefined || binding.uid === uid)) keys.add(key)
    }
    for (const key of keys) this.invalidateKey(key)
  }

  private invalidateKey(key: string): void {
    this.accessCache.delete(key)
    if (this.inFlightGenerations.has(key)) {
      this.flightGeneration.set(key, (this.flightGeneration.get(key) ?? 0) + 1)
    }
  }

  private decodeAccess(
    body: unknown,
    binding: DerivedAccessBinding,
    requestStartedAt: number,
  ): DerivedAccessProof | null {
    if (!body || typeof body !== 'object') return null
    const value = body as Record<string, unknown>
    if (value.role !== 'reader' && value.role !== 'none') return null
    const revision = sourceRevision(value.source_revision)
    const validFor = validForMs(value.valid_for_ms)
    if (revision === null || validFor === null) return null
    return {
      ...binding,
      role: value.role,
      sourceRevision: revision,
      validForMs: validFor,
      expiresAt: requestStartedAt + Math.min(validFor, this.ttlMs, MAX_VALID_FOR_MS),
    }
  }

  private async postJson(path: string, body: unknown): Promise<unknown | null> {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), this.timeoutMs)
    try {
      let response: Response
      try {
        response = await fetch(`${this.baseUrl}${path}`, {
          method: 'POST',
          signal: ac.signal,
          redirect: 'error',
          headers: {
            'Content-Type': 'application/json',
            ...(this.token ? { [INTERNAL_TOKEN_HEADER]: this.token } : {}),
          },
          body: JSON.stringify(body),
        })
      } catch {
        return null
      }
      if (!response.ok) return null
      return await response.json().catch(() => null)
    } finally {
      clearTimeout(timer)
    }
  }
}

let singleton: DriveDerivedAccess | null = null

export function getDriveDerivedAccess(): DriveDerivedAccess {
  if (!singleton) singleton = new HttpDriveDerivedAccess()
  return singleton
}

export function setDriveDerivedAccess(impl: DriveDerivedAccess): void {
  singleton = impl
}

/** Invalidate a confirmed local proof without touching other principals. */
export function invalidateDriveDerivedAccess(docId: string, uid: string, principalSpaceId: string): void {
  if (singleton instanceof HttpDriveDerivedAccess) singleton.invalidate(docId, uid, principalSpaceId)
}

export function invalidateDriveDerivedAccessForSpace(
  docId: string,
  principalSpaceId: string,
  uid?: string,
): void {
  if (singleton instanceof HttpDriveDerivedAccess) singleton.invalidateSpace(docId, principalSpaceId, uid)
}

/** Merge the source's reader-only role into an independently resolved base. */
export async function mergeDriveDerivedReader(
  base: ResolvedRole,
  docId: string | undefined,
  uid: string,
  principalSpaceId: string | undefined,
): Promise<ResolvedRole> {
  if (roleAtLeast(base, 'reader') || !docId || !principalSpaceId) return base
  try {
    const access = await getDriveDerivedAccess().derivedAccess(docId, uid, principalSpaceId)
    if (!access) return base
    return roleRank(base) >= roleRank(access.role) ? base : access.role
  } catch {
    return base
  }
}
