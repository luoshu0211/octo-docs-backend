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
const cache = new TtlCache<{ role: ResolvedRole; permissionEpoch: number | undefined }>(RECHECK_TTL_MS)

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
  // earlier epoch. Keep only one cache entry per principal, not one per epoch.
  if (cached !== undefined && cached.permissionEpoch === permissionEpoch) return cached.role
  return sf.do(`${key}\x00${permissionEpoch ?? 'unversioned'}`, async () => {
    const role = await recheckDb(documentName, uid, principalSpaceId, spaceMember)
    cache.set(key, { role, permissionEpoch })
    return role
  })
}
