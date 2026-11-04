/**
 * Cached authorization recheck for collaboration hot paths. Cache identity is
 * fully Space-qualified and includes the token-carried share-membership proof,
 * so sockets for the same uid in different principal Spaces cannot share roles.
 */
import { recheckCurrentRole as recheckDb } from './resolveRole.js'
import { Singleflight, TtlCache } from '../util/singleflight.js'
import type { ResolvedRole } from './role.js'

const RECHECK_TTL_MS = 3_000
const sf = new Singleflight<ResolvedRole>()
interface CachedRecheck {
  role: ResolvedRole
  permissionEpoch: number | undefined
  documentName: string
  uid: string
  principalSpaceId: string
}
const cache = new TtlCache<CachedRecheck>(RECHECK_TTL_MS)
interface InFlightRecheck {
  documentName: string
  uid: string
  principalSpaceId: string
  generation: number
  count: number
}
const inFlight = new Map<string, InFlightRecheck>()

/** Invalidate cached source-derived roles and fence older in-flight reads. */
export function invalidateCurrentRoleRecheckCacheForSource(
  documentName: string,
  principalSpaceId: string,
  uid?: string,
): void {
  cache.deleteWhere((_key, cached) =>
    cached.documentName === documentName &&
    cached.principalSpaceId === principalSpaceId &&
    (uid === undefined || cached.uid === uid))
  for (const read of inFlight.values()) {
    if (read.documentName !== documentName || read.principalSpaceId !== principalSpaceId) continue
    if (uid !== undefined && read.uid !== uid) continue
    read.generation++
  }
}

export async function recheckCurrentRoleCached(
  documentName: string,
  uid: string,
  principalSpaceId: string,
  spaceMember = false,
  permissionEpoch?: number,
): Promise<ResolvedRole> {
  const key = `${documentName}\x00${uid}\x00${principalSpaceId}\x00${spaceMember ? 1 : 0}`
  const cached = cache.get(key)
  // Invalidation must bypass both a cached role AND an in-flight read for an
  // earlier source version. Keep only one cache entry per principal, not one per epoch.
  if (cached !== undefined && cached.permissionEpoch === permissionEpoch) return cached.role

  const generation = inFlight.get(key)?.generation ?? 0
  return sf.do(`${key}\x00${permissionEpoch ?? 'unversioned'}\x00${generation}`, async () => {
    const read = inFlight.get(key) ?? {
      documentName,
      uid,
      principalSpaceId,
      generation,
      count: 0,
    }
    read.count++
    inFlight.set(key, read)
    let readGeneration = generation
    try {
      for (;;) {
        const role = await recheckDb(documentName, uid, principalSpaceId, spaceMember)
        if (readGeneration !== read.generation) {
          readGeneration = read.generation
          continue
        }
        cache.set(key, { role, permissionEpoch, documentName, uid, principalSpaceId })
        return role
      }
    } finally {
      read.count--
      if (read.count === 0) inFlight.delete(key)
    }
  })
}
