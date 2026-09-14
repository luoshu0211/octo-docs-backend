/**
 * Cross-node connection registry (§4.5 step 2).
 *
 * Each active collaboration connection registers
 *   { document_name, uid, node, connectionId, role, permission_epoch }
 * so that on a doc_member change a node can locate the connections to act on
 * (close 4403 / flip readOnly). Cleared on disconnect.
 *
 * Stored as Redis hashes per document: field = connectionId, value = JSON.
 * Expiring awareness lives in a separate hash with a real TTL, so a crashed
 * room is reclaimed even when nobody lists it again. Legacy entries do not expire.
 */
import { getRedis, rkey } from '../db/redis.js'
import type { Role } from './role.js'

export interface RegisteredConnection {
  documentName: string
  uid: string
  node: string
  connectionId: string
  role: Role
  permission_epoch: number
  /** Optional expiring awareness entry; legacy permission registrations do not expire. */
  expiresAt?: number
  name?: string
}

function regKey(documentName: string, leased = false): string {
  return leased ? rkey('conn', documentName, 'leased') : rkey('conn', documentName)
}

export const connectionRegistry = {
  async register(entry: RegisteredConnection): Promise<void> {
    try {
      if (entry.expiresAt === undefined) {
        await getRedis().hset(regKey(entry.documentName), entry.connectionId, JSON.stringify(entry))
      } else {
        // Atomic registration and expiry: a process crash cannot leave a new
        // hash immortal. A shorter lease must not expire longer-lived peers.
        await getRedis().eval(
          "local ttl = redis.call('pttl', KEYS[1]); redis.call('hset', KEYS[1], ARGV[1], ARGV[2]); if ttl < tonumber(ARGV[3]) then redis.call('pexpire', KEYS[1], ARGV[3]) end; return 1",
          1, regKey(entry.documentName, true), entry.connectionId, JSON.stringify(entry), Math.max(1, Math.ceil(entry.expiresAt - Date.now())),
        )
      }
    } catch {
      /* registry is best-effort; beforeHandleMessage recheck is the backstop */
    }
  },

  async unregister(documentName: string, connectionId: string): Promise<void> {
    try {
      await Promise.all([false, true].map(leased => getRedis().hdel(regKey(documentName, leased), connectionId)))
    } catch {
      /* best-effort */
    }
  },

  /** List connections for a document (optionally filtered to a uid). */
  async list(documentName: string, uid?: string): Promise<RegisteredConnection[]> {
    let groups: { key: string; entries: Record<string, string> }[] = []
    try {
      groups = await Promise.all([false, true].map(async leased => {
        const key = regKey(documentName, leased)
        return { key, entries: await getRedis().hgetall(key) }
      }))
    } catch {
      return []
    }
    const out: RegisteredConnection[] = []
    for (const { key, entries } of groups) for (const raw of Object.values(entries)) {
      try {
        const entry = JSON.parse(raw) as RegisteredConnection
        if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
          // A concurrent heartbeat may have replaced the value after HGETALL.
          // Delete only the expired value we actually read.
          void getRedis().eval(
            "if redis.call('hget', KEYS[1], ARGV[1]) == ARGV[2] then return redis.call('hdel', KEYS[1], ARGV[1]) else return 0 end",
            1, key, entry.connectionId, raw,
          ).catch(() => {})
          continue
        }
        if (!uid || entry.uid === uid) out.push(entry)
      } catch {
        /* skip malformed */
      }
    }
    return out
  },
}
