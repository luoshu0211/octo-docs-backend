/**
 * Faithful JS execution of the two atomic Lua scripts in compactionNotice.ts,
 * for the in-memory Redis doubles the suite uses.
 *
 * The doubles cannot run Lua, so this reproduces each script's read-merge-write
 * (record) and read-check-delete (resolve) SYNCHRONOUSLY — no await inside — so
 * two `eval` calls driven concurrently through a double run one-then-the-other,
 * exactly as Redis serialises EVAL. That is what lets the deterministic
 * interleaving tests assert the operations are atomic: revert the production
 * code to the old get-then-set split and the same drivers would interleave and
 * lose a floor.
 *
 * Scripts are dispatched by the marker comment on their first line
 * (`RECORD_UNRESTORED` / `RESOLVE_UNRESTORED`), matching the source.
 */

/** Mirror of compactionNotice's parseStateVector: drop anything not a positive finite clock. */
function parse(raw: string | null): Record<string, number> {
  if (raw === null) return {}
  try {
    const p: unknown = JSON.parse(raw)
    if (!p || typeof p !== 'object') return {}
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
      const n = Number(v)
      if (Number.isFinite(n) && n > 0) out[k] = n
    }
    return out
  } catch {
    return {}
  }
}

/** The narrow slice of a string keyspace the two scripts touch. `set` receives the EX ttl in seconds. */
export interface UnrestoredStringStore {
  get(key: string): string | null
  set(key: string, value: string, ttlSeconds: number): void
  del(key: string): void
}

/**
 * Execute one of the unrestored-marker scripts against `store`, returning the
 * same integer the real EVAL returns (record: field count / 0; resolve: 0 = no
 * marker, 1 = cleared, 2 = kept).
 */
export function evalUnrestored(
  script: string,
  key: string,
  argv: string[],
  store: UnrestoredStringStore,
): number {
  if (script.includes('RECORD_UNRESTORED')) {
    const merged = parse(store.get(key))
    const rejected = parse(argv[0] ?? '{}')
    for (const [k, clock] of Object.entries(rejected)) {
      if (clock > (merged[k] ?? 0)) merged[k] = clock
    }
    const count = Object.keys(merged).length
    if (count === 0) return 0
    store.set(key, JSON.stringify(merged), Number(argv[1]))
    return count
  }
  if (script.includes('RESOLVE_UNRESTORED')) {
    const required = parse(store.get(key))
    if (Object.keys(required).length === 0) return 0
    const have = parse(argv[0] ?? '{}')
    for (const [k, clock] of Object.entries(required)) {
      if ((have[k] ?? 0) < clock) return 2
    }
    store.del(key)
    return 1
  }
  throw new Error('fake eval: unrecognised script')
}
