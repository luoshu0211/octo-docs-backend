import type { SyncEngine, Op } from './sync/crdt.js'

/** Bento's file transport offloads asset strings above 64 KiB. Octo keeps them
 * in bounded durable frames instead; otherwise the upstream differ silently
 * skips them and a reload loses the image. Register stamps are still minted by
 * the unmodified engine. Only the transport payload is replaced. */
export function diffPpt(sync: SyncEngine, before: Parameters<SyncEngine['diff']>[0], after: Parameters<SyncEngine['diff']>[1], text = false): Op[] {
  const original = (after as { assets?: Record<string, unknown> }).assets
  if (!original) return sync.diff(before, after, { text })
  const assets = { ...original }
  for (const [key, value] of Object.entries(assets)) {
    if (typeof value === 'string' && value.length > 65536 && value !== (before as { assets?: Record<string, unknown> }).assets?.[key]) {
      // Objects are not offloaded by the engine. The placeholder never reaches
      // persistence, the document, or the other peer.
      assets[key] = { octoInlineAsset: true }
    }
  }
  const ops = sync.diff(before, { ...after, assets } as typeof after, { text })
  for (const op of ops) {
    if (op.op === 'set' && !op.el && !op.sl && op.k.startsWith('assets.')) {
      const key = op.k.slice(7)
      if (Object.hasOwn(original, key)) op.v = original[key]
    }
  }
  return ops
}
