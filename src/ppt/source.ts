/**
 * PPT (`html_ppt`) source-content resolution seam (R3-B1, XIN-1495 §3.3 / §4).
 *
 * The GET source route serves one of three logical sources for a deck:
 *   · `draft`     — the writer/admin working deck (recovery / AI upload target).
 *   · `live`      — the current authoritative working snapshot.
 *   · `published` — an immutable, content-addressed published version.
 *
 * This module owns ONLY "what bytes back a given (docId, mode)". The access
 * policy, cache headers, signed-asset bootstrap, and origin safety live in the
 * route layer (`src/api/ppt/source.ts`) so they stay independent of where the
 * content comes from.
 *
 * SCOPE NOTE — this is the R3-B1 boundary. The relay-maintained live snapshot
 * (`ppt_live_snapshot`, R4-B1) and immutable published versions (`ppt_version`,
 * R5-B1) do not exist yet, so the default provider below reads what R2-B1 already
 * persists (`ppt_doc_state.draft_doc`) and returns `null` for a published version
 * that has not been minted. A `null` is NOT an error — the route maps it to
 * `NOT_FOUND`, which is exactly the "no published version yet" reader/commenter
 * empty-state behaviour PPT-UI-003 requires. R4/R5 slot their real stores in
 * behind this same {@link PptSourceProvider} interface without touching the
 * access/cache/asset/origin contract this round finalizes.
 */
import { createHash } from 'node:crypto'
import { pptDocStateRepo } from '../db/repos/pptDocStateRepo.js'
import { readCurrentPpt } from './currentSource.js'
import { getPptVersion } from './versions.js'
import { BENTO_FORMAT, BENTO_FORMAT_VERSION, BENTO_SYNC_V, type BentoDoc } from './bentoDoc.js'

/** The three logical sources a deck can be read from (§4 `mode`). */
export type PptSourceMode = 'published' | 'live' | 'draft'

/** The three wire formats a source can be served as (§4 `format`). */
export type PptSourceFormat = 'bootstrap' | 'bento' | 'html'

export const PPT_SOURCE_MODES: readonly PptSourceMode[] = ['published', 'live', 'draft']
export const PPT_SOURCE_FORMATS: readonly PptSourceFormat[] = ['bootstrap', 'bento', 'html']

/**
 * A media/object-store reference a deck needs a signed GET URL for. Bento
 * offloads any value over `BLOB_INLINE_MAX = 64 KiB` to a SHA-256/object-keyed
 * blob, so a real deck carries these; the R2 bundled templates carry none. The
 * `objectKey` is the storage address the presigner signs — NEVER a token or a
 * pre-signed URL, so no long-lived auth material is persisted on the deck.
 */
export interface PptAssetRef {
  /** Stable id the deck element references the asset by. */
  id: string
  /** SHA-256 content address / object-store key of the stored blob. */
  objectKey: string
  /** Registered, denylist-checked mime the signed GET response must be served with. */
  mime: string
  /** Blob size in bytes, when known (advisory; for the client's loading UI). */
  sizeBytes?: number
}

/**
 * Resolved source content for one (docId, mode). `deck` is always present; the
 * optional fields carry mode-specific extras (an immutable `versionSeq` for
 * published; a pre-rendered `html` string once R5 renders one; `assets` the
 * bootstrap must sign).
 */
export interface PptSourceContent {
  /** The bento/slides deck JSON the runtime hydrates. */
  deck: BentoDoc
  /** Monotonic revision: `draft_revision` for draft/live, `version_seq` for published. */
  revision: number
  /** Stable content hash of the deck (the B content-hash comment-anchor basis, §1). */
  contentHash: string
  /** Immutable published version sequence — present ONLY for a published source. */
  versionSeq?: number
  /** Pre-rendered self-contained HTML — present ONLY once R5 renders one. */
  html?: string
  /** Asset blobs the deck references (empty until R5 populates `ppt_asset`). */
  assets: PptAssetRef[]
}

/**
 * The seam every source read goes through. R4/R5 replace the default impl's
 * live/published resolvers with their real stores; the route never changes.
 */
export interface PptSourceProvider {
  /** Writer/admin working deck. `null` when the doc has no PPT state row. */
  getDraft(docId: string): Promise<PptSourceContent | null>
  /** Current authoritative working snapshot. `null` when there is nothing to serve. */
  getLive(docId: string): Promise<PptSourceContent | null>
  /**
   * Immutable published source. `version` is `'latest'` or a concrete
   * `version_seq`. `null` when the requested version does not exist (including
   * "nothing published yet") — the route maps that to `NOT_FOUND`.
   */
  getPublished(docId: string, version: 'latest' | number): Promise<PptSourceContent | null>
}

/**
 * Canonical SHA-256 (hex) of a deck. Stable for a given logical deck so it can
 * key an ETag and, later, comment anchors. `modified` is intentionally EXCLUDED
 * from the hash: it is a wall-clock stamp that changes on every re-materialize
 * without changing the deck's content, and hashing it would defeat the immutable
 * ETag. Everything else is hashed over a key-sorted JSON serialization so two
 * structurally identical decks hash equal regardless of key order.
 */
export function hashBentoDeck(deck: BentoDoc): string {
  const { modified: _modified, ...rest } = deck
  return createHash('sha256').update(canonicalJson(rest)).digest('hex')
}

/** Deterministic JSON with object keys sorted at every depth (arrays keep order). */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    // A null-prototype accumulator so a reserved key — notably `__proto__`, which
    // `JSON.parse` produces as an OWN enumerable property — is stored as an own
    // key rather than silently walking the prototype setter and vanishing. A
    // plain `{}` inherits `Object.prototype`, so `out['__proto__'] = …` would set
    // the prototype instead of creating a key, dropping the whole `__proto__`
    // subtree from the canonical serialization and letting two structurally
    // different decks collide on the same contentHash (the ETag / comment anchor).
    const out: Record<string, unknown> = Object.create(null)
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

/**
 * The Bento compatibility triple every bootstrap advertises so the frontend
 * runtime can refuse an incompatible deck up front (§12 compatibility row).
 */
export const PPT_BENTO_COMPAT = {
  format: BENTO_FORMAT,
  formatVersion: BENTO_FORMAT_VERSION,
  syncV: BENTO_SYNC_V,
} as const

/**
 * Recovery draft reads the legacy state. Current content replays the durable
 * live snapshot and op tail, falling back only before the one-way handoff.
 * Published versions are separate; publication remains an unimplemented R5 seam.
 */
export const defaultPptSourceProvider: PptSourceProvider = {
  async getDraft(docId: string): Promise<PptSourceContent | null> {
    const src = await pptDocStateRepo.getSource(docId)
    if (!src) return null
    return {
      deck: src.draftDoc,
      revision: src.draftRevision,
      contentHash: hashBentoDeck(src.draftDoc),
      assets: [], // R5-B1 (`ppt_asset`) populates real offloaded blobs.
    }
  },

  async getLive(docId: string): Promise<PptSourceContent | null> {
    const live = await readCurrentPpt(docId)
    if (live) return { ...live, contentHash: hashBentoDeck(live.deck), assets: [] }
    // Before the one-way collaboration handoff, the draft is the current state.
    const src = await pptDocStateRepo.getSource(docId)
    if (!src) return null
    return {
      deck: src.draftDoc,
      revision: src.snapshotVersion,
      contentHash: hashBentoDeck(src.draftDoc),
      assets: [],
    }
  },

  async getPublished(docId, version): Promise<PptSourceContent | null> {
    const stored = await getPptVersion(docId, version)
    return stored ? { deck: stored.deck, revision: stored.versionSeq, versionSeq: stored.versionSeq,
      contentHash: stored.contentHash, html: stored.html, assets: [] } : null
  },
}
