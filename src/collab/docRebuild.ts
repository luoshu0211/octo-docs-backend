/**
 * The pure rebuild logic: no database, no config, no collab server.
 *
 * It lives apart from `compaction.ts` because the compaction WORKER imports it,
 * and a worker entry must not drag in the server and the connection pool the way
 * `compaction.ts` does. One copy, two threads — the checks that stand between a
 * rebuild and a destroyed document must not be allowed to drift between a
 * main-thread version and a worker version.
 */
import * as Y from 'yjs'

/**
 * Rebuild `doc` from its current values, dropping tombstones.
 *
 * Only documents whose every top-level share is a FLAT Y.Map are accepted (see
 * `isFlatMapOnlyDocument`), so each value here is a plain JSON scalar/object and
 * copying it across is lossless.
 */
export function rebuildFromValues(doc: Y.Doc): { rebuilt: Y.Doc; entries: number } {
  const rebuilt = new Y.Doc()
  let entries = 0
  for (const key of doc.share.keys()) {
    const src = doc.getMap(key)
    const dst = rebuilt.getMap(key)
    rebuilt.transact(() => {
      src.forEach((value, k) => {
        dst.set(k, value)
        entries++
      })
    })
  }
  return { rebuilt, entries }
}

/**
 * True when the document is one this rebuild can reproduce faithfully: every
 * top-level share is a Y.Map, and no value inside those maps is itself a Yjs
 * type.
 *
 * Three traps this has to avoid, all verified against yjs directly rather than
 * reasoned about:
 *
 * 1. UNTYPED SHARES. This is the one that matters most, because getting it
 *    wrong is SILENT. Yjs decodes a share as a bare `AbstractType` and only
 *    promotes it to YMap/YText/YXmlFragment when `getMap`/`getText`/… is first
 *    called on that key. Every document reaching compaction was just decoded
 *    from the database, so an `instanceof Y.Map` test on `doc.share` is false
 *    for ALL of them — an earlier version did exactly that, and would have
 *    refused every real document as "not compactable" while its tests, which
 *    built their documents in-process via `getMap()`, all passed.
 *
 *    Probing with `doc.getMap(key)` is not the fix: on an untyped share that
 *    call REINTERPRETS whatever is there as a map, which is precisely the
 *    silent destruction of a rich-text body trap 3 is about. An undecided share
 *    has to be judged by its structure instead.
 *
 * 2. TYPE TEST. The structural test is `_start === null` (no list content) AND a
 *    non-empty `_map`. `_start === null` alone is not enough: a Y.Text/Y.Array
 *    created but never written also has it, as does an empty Y.XmlFragment, so
 *    an untouched ProseMirror body would pass and be rebuilt as an empty Y.Map,
 *    dropping the body. Requiring `_map.size > 0` rules those out — a
 *    never-written type has no map entries either. (Measured: such a type does
 *    not even survive an encode/decode round trip, since it contributes no
 *    structs and its key is simply absent from the decoded document. The
 *    `_map.size` clause is what keeps the predicate correct for an in-process
 *    document too.) A Y.Text whose content was fully deleted still has `_start`
 *    set, so tombstones cannot disguise a list as a map.
 *
 * 3. NESTED TYPES. `rebuildFromValues` copies values as-is. A value that is
 *    itself a Y.Map (whiteboard elements are built with `new Y.Map()`, see
 *    whiteboard/boardEdit.ts) cannot be re-parented into another document, and
 *    flattening it with `toJSON()` would turn a collaboratively-editable
 *    sub-map into a plain object — every future concurrent edit to that element
 *    would then clobber the whole value instead of merging per-field. Sheets
 *    store flat `Y.Map<scalar>`s and qualify; whiteboards do not, and are
 *    refused rather than quietly degraded.
 */
export function isFlatMapOnlyDocument(doc: Y.Doc): boolean {
  for (const key of doc.share.keys()) {
    if (!isMapLike(doc.share.get(key))) return false

    // Safe only after the check above: on an undecided share `getMap` casts.
    let nested = false
    doc.getMap(key).forEach((value) => {
      if (value instanceof Y.AbstractType) nested = true
    })
    if (nested) return false
  }
  return true
}

/**
 * Whether a top-level share holds map entries and no list content — asked of a
 * type that may not have been promoted to a concrete class yet (trap 1).
 */
/** Exactly what `doc.share.get(key)` yields, without restating yjs's generics. */
type Share = ReturnType<Y.Doc['share']['get']>

function isMapLike(share: Share): boolean {
  if (!share) return false
  if (share instanceof Y.Map) return true

  // Anything already promoted to a concrete non-map class is disqualified
  // outright; only a still-undecided share is judged structurally.
  if (share.constructor !== Y.AbstractType) return false

  const internals = share as unknown as { _start: unknown; _map: Map<string, unknown> }
  return internals._start === null && internals._map.size > 0
}

/**
 * Compare two documents by the JSON of every top-level type, returning a short
 * description of the first difference or null when they match.
 *
 * This is the check that stands between a buggy rebuild and a destroyed
 * document, so it compares VALUES rather than trusting that the walk covered
 * everything: a type silently dropped by `rebuildFromValues` shows up here as a
 * missing key, and a mangled one as a differing body.
 */
export function contentDrift(before: Y.Doc, after: Y.Doc): string | null {
  const a = [...before.share.keys()].sort()
  const b = [...after.share.keys()].sort()
  if (a.join('\u0000') !== b.join('\u0000')) {
    return `top-level types differ: [${a.join(', ')}] vs [${b.join(', ')}]`
  }
  for (const key of a) {
    if (JSON.stringify(before.getMap(key).toJSON()) !== JSON.stringify(after.getMap(key).toJSON())) {
      return `"${key}" differs`
    }
  }
  return null
}
