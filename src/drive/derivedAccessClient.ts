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
const DERIVED_ACCESS_BATCH_PATH = `${DERIVED_ACCESS_PATH}/batch`
const INTERNAL_TOKEN_HEADER = 'X-Internal-Token'
const MAX_VALID_FOR_MS = 30_000
const MAX_VERSION_BATCH = 50
const MAX_DECISION_BATCH = 50
/**
 * Hard cap on the process-wide derived-access proof cache. Keys are
 * (docId, uid, principalSpaceId), so a large tenant can otherwise grow this Map
 * without bound; insertion evicts the oldest (LRU refresh on hit) and expired
 * proofs are swept on insert plus by an unref'd interval.
 */
const DEFAULT_MAX_DERIVED_ACCESS_CACHE_ENTRIES = 10_000
const DEFAULT_CACHE_SWEEP_INTERVAL_MS = 60_000

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

/** One full (role-bearing) batch decision; order matches the request bindings. */
export interface DerivedAccessDecision extends DerivedAccessBinding {
  role: DerivedRole
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
  /**
   * Full role decisions for 1..50 unique bindings, in request order. This is the
   * batch counterpart of `derivedAccess` (drive !93). Returns null when the
   * feature is disabled/unconfigured or the response is missing/mismatched/invalid
   * — callers MUST fall back to the per-doc full decision, never treat null as
   * "no access".
   */
  batchDerivedAccess(bindings: readonly DerivedAccessBinding[]): Promise<DerivedAccessDecision[] | null>
}

interface HttpDriveDerivedAccessOptions {
  enabled?: boolean
  baseUrl?: string
  token?: string
  timeoutMs?: number
  ttlMs?: number
  /** Monotonic clock seam for deterministic proof-expiry tests. */
  nowMs?: () => number
  /** Cache budget override (tests use a tiny value). Defaults to 10_000. */
  maxCacheEntries?: number
  /** Expired-entry sweep interval; 0 disables the timer (tests). */
  cacheSweepIntervalMs?: number
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
  private readonly maxCacheEntries: number
  private cacheHits = 0
  private cacheMisses = 0
  private cacheEvictions = 0
  private readonly sweepTimer: ReturnType<typeof setInterval> | null
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
    this.maxCacheEntries = Math.max(1, opts.maxCacheEntries ?? DEFAULT_MAX_DERIVED_ACCESS_CACHE_ENTRIES)
    const sweepMs = opts.cacheSweepIntervalMs ?? DEFAULT_CACHE_SWEEP_INTERVAL_MS
    this.sweepTimer = sweepMs > 0
      ? setInterval(() => { this.sweepExpiredAccessCache() }, sweepMs)
      : null
    // Do not keep the process (or a test worker) alive just for cache sweeping.
    this.sweepTimer?.unref?.()
  }

  /** Observable cache counters (size / hits / misses / evictions). */
  accessCacheStats(): { size: number; hits: number; misses: number; evictions: number } {
    return {
      size: this.accessCache.size,
      hits: this.cacheHits,
      misses: this.cacheMisses,
      evictions: this.cacheEvictions,
    }
  }

  /** Drop every already-expired proof; returns how many were removed. */
  sweepExpiredAccessCache(now = this.nowMs()): number {
    let removed = 0
    for (const [key, proof] of this.accessCache) {
      if (proof.expiresAt <= now) {
        this.accessCache.delete(key)
        removed += 1
      }
    }
    this.cacheEvictions += removed
    return removed
  }

  private rememberProof(key: string, proof: DerivedAccessProof): void {
    // Bound the Map: drop expired first, then the oldest (Map preserves insertion
    // order and hits refresh recency).
    if (this.accessCache.size >= this.maxCacheEntries) {
      this.sweepExpiredAccessCache()
      while (this.accessCache.size >= this.maxCacheEntries) {
        const oldest = this.accessCache.keys().next()
        if (oldest.done) break
        this.accessCache.delete(oldest.value)
        this.cacheEvictions += 1
      }
    }
    this.accessCache.set(key, proof)
  }

  async derivedAccess(docId: string, uid: string, principalSpaceId: string): Promise<DerivedAccessProof | null> {
    if (!this.enabled || !this.baseUrl || !docId || !uid || !principalSpaceId) return null
    const key = keyOf(docId, uid, principalSpaceId)
    const cached = this.accessCache.get(key)
    if (cached) {
      if (this.nowMs() < cached.expiresAt) {
        this.cacheHits += 1
        // LRU: refresh recency without growing the Map.
        this.accessCache.delete(key)
        this.accessCache.set(key, cached)
        return cached
      }
      this.accessCache.delete(key)
      this.cacheEvictions += 1
    }
    this.cacheMisses += 1
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
        this.rememberProof(key, proof)
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

  async batchDerivedAccess(
    bindings: readonly DerivedAccessBinding[],
  ): Promise<DerivedAccessDecision[] | null> {
    if (!this.enabled || !this.baseUrl || bindings.length === 0 || bindings.length > MAX_DECISION_BATCH) {
      return null
    }
    const seen = new Set<string>()
    for (const binding of bindings) {
      if (!binding.docId || !binding.uid || !binding.principalSpaceId) return null
      const key = keyOf(binding.docId, binding.uid, binding.principalSpaceId)
      if (seen.has(key)) return null
      seen.add(key)
    }

    const body = await this.postJson(DERIVED_ACCESS_BATCH_PATH, {
      items: bindings.map(binding => ({
        doc_id: binding.docId,
        uid: binding.uid,
        principal_space_id: binding.principalSpaceId,
      })),
    })
    if (!body || typeof body !== 'object' || !('items' in body)) return null
    const items = body.items
    if (!Array.isArray(items) || items.length !== bindings.length) return null

    const decisions: DerivedAccessDecision[] = []
    for (let index = 0; index < items.length; index++) {
      const item = items[index]
      const binding = bindings[index]!
      if (!item || typeof item !== 'object') return null
      const value = item as Record<string, unknown>
      // Positional contract: a reordered or substituted row is a protocol
      // violation, not something to "match by doc_id" — silently matching would
      // risk assigning one document's role to another.
      if (
        value.doc_id !== binding.docId ||
        value.uid !== binding.uid ||
        value.principal_space_id !== binding.principalSpaceId
      ) return null
      if (value.role !== 'reader' && value.role !== 'none') return null
      decisions.push({ ...binding, role: value.role })
    }
    return decisions
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
