import { stateGenerationRepo } from '../db/repos/stateGenerationRepo.js'
import { parseGenerationToken, stateGenerationOf } from './stateGeneration.js'
import { durableReceipt } from './durableReceipt.js'
/**
 * Hocuspocus Server instance (§2.1 / §2.2 / §4.1 / §5.1).
 *
 * - extension-database wired to the §3.2 persistence adapter (fetch/store).
 * - extension-redis for multi-instance pub/sub broadcast + document lock (§5.1/§5.3).
 * - extension-logger for structured logs.
 * - onAuthenticate implements §4.1 (verify token, epoch compare, role, readOnly).
 * - beforeHandleMessage does the per-principal write recheck (§4.5 step 4).
 * - beforeHandleAwareness validates presence identity + fields (§8.3.1).
 */
import { Server } from '@hocuspocus/server'
import type { Connection } from '@hocuspocus/server'
import { CollabDatabase } from './collabDatabase.js'
import { createCollabRedis } from './redis.js'
import { Logger } from '@hocuspocus/extension-logger'
import { config } from '../config/env.js'
import { persistence } from './persistence.js'
import { maybeCompactOnUnload } from './autoCompact.js'
import { markLoaded, markUnloaded } from './compactionCluster.js'
import { compactDocument } from './compaction.js'
import { noticeStaleCacheOnJoin } from './compactionNotice.js'
import {
  applyOversizeDecision,
  clearOversized,
  noticeOversizeOnJoin,
  setOversizeAnnouncer,
} from './oversizeGuard.js'
import { authenticate, type AuthContext } from './authenticate.js'
import { connectionRegistry } from '../permission/connectionRegistry.js'
import { recheckCurrentRoleCached } from '../permission/recheck.js'
import { roleAtLeast, roleRank } from '../permission/role.js'
import { recheckCurrentAccess } from '../permission/resolveRole.js'
import {
  registerActiveAccess,
  renewActiveAccess,
  type ActiveAccessParticipant,
} from '../permission/activeAccess.js'
import { handleAfterStore, handleBeforeUnload } from './autoSnapshot.js'
import { parseDocumentName } from '../permission/documentName.js'
import { enqueueDocIndex } from '../search/docIndexQueue.js'
import { attachWhiteboardRepair, coldRepairLiveDoc } from '../whiteboard/repair.js'
import { attachSheetDataValidationGuard } from './sheetDataValidationGuard.js'

/**
 * Per-node epoch watermark (§4.5 step 4): beforeHandleMessage reads this local
 * in-memory value, NOT Redis/DB per write. Refreshed by the epoch invalidation
 * subscriber (wired in index.ts). Keyed by documentName.
 */
const epochWatermark = new Map<string, number>()

/**
 * Per-document disposer for server-authoritative Yjs guards, keyed by documentName.
 * Called in beforeUnloadDocument so observers are torn down with the document.
 */
const repairDisposers = new Map<string, () => void>()

export function setEpochWatermark(documentName: string, epoch: number): void {
  const cur = epochWatermark.get(documentName) ?? 0
  if (epoch > cur) epochWatermark.set(documentName, epoch)
}

function gateYjsConnection(
  connection: Connection,
  context: AuthContext,
): ActiveAccessParticipant {
  const send = connection.send.bind(connection)
  const maxPendingFrames = config.ppt.relay.maxLiveBufferFrames
  const maxPendingBytes = config.ppt.relay.maxLiveBufferBytes
  const pending: Uint8Array[] = []
  let pendingBytes = 0
  let frozen = false
  let closed = false
  let closing = false
  const closeLogicalConnection = (code: 4401 | 4403, reason: string): void => {
    if (closed) return
    frozen = true
    pending.length = 0
    pendingBytes = 0
    closed = true
    connection.readOnly = true
    // The constructor can send awareness before ClientConnection installs its close
    // callbacks and routing entry. Block content now, but close after that setup so
    // the native logical-connection cleanup removes the routing entry as well.
    queueMicrotask(() => {
      closing = true
      try {
        connection.close({ code, reason })
      } finally {
        closing = false
      }
    })
  }
  const queuePending = (message: Uint8Array): void => {
    if (pending.length >= maxPendingFrames || pendingBytes + message.byteLength > maxPendingBytes) {
      closeLogicalConnection(4401, 'Authorization could not be confirmed')
      return
    }
    pending.push(message)
    pendingBytes += message.byteLength
  }
  connection.send = message => {
    if (closing) {
      send(message)
      return
    }
    if (closed) return
    if (frozen) {
      queuePending(message)
      return
    }
    const sourceAccess = context.source_access
    if (sourceAccess && sourceAccess.sourceRevision !== null &&
        (sourceAccess.proofExpiresAt === null || performance.now() >= sourceAccess.proofExpiresAt)) {
      const docId = context.doc ?? context.board
      if (docId && renewActiveAccess({ docId, uid: context.user.id, principalSpaceId: context.principal_space_id })) {
        queuePending(message)
      } else closeLogicalConnection(4401, 'Authorization could not be confirmed')
      return
    }
    send(message)
  }
  return {
    freeze() {
      frozen = true
    },
    resume(state) {
      if (state.role === 'none') return
      if (roleRank(state.role) < roleRank(context.role)) {
        context.role = state.role
        connection.readOnly = true
      }
      if (!roleAtLeast(state.role, 'writer')) connection.readOnly = true
      context.permission_epoch = state.permissionEpoch
      context.source_access = state
      setEpochWatermark(connection.document.name, state.permissionEpoch)
      frozen = false
      const ready = pending.splice(0)
      pendingBytes = 0
      for (const message of ready) connection.send(message)
    },
    close(code, reason) {
      closeLogicalConnection(code, reason)
    },
  }
}

/** Never authorize a message using a role read invalidated while it was pending. */
async function recheckWritePermission(
  documentName: string,
  ctx: AuthContext,
  connection: { readOnly: boolean },
): Promise<void> {
  try {
    for (;;) {
      const watermark = epochWatermark.get(documentName) ?? ctx.permission_epoch
      if (ctx.permission_epoch >= watermark) return // current: no role lookup
      const role = await recheckCurrentRoleCached(
        documentName, ctx.user.id, ctx.principal_space_id, ctx.space_member, watermark,
      )
      if ((epochWatermark.get(documentName) ?? watermark) > watermark) continue
      if (role === 'none' || !roleAtLeast(role, 'writer')) throw new Error('Forbidden')
      ctx.permission_epoch = watermark
      return
    }
  } catch (error) {
    connection.readOnly = true
    throw error
  }
}

const COLOR_RE = /^#[0-9a-fA-F]{6}$/

/**
 * Frame-lightness cap for a relayed presence display name. Longer values are
 * treated as unsafe (the client path already enforced this bound).
 */
const NAME_MAX_LEN = 64

/**
 * Whether a documentName refers to a Yjs-backed document whose body should be
 * fed to the full-text search index via THIS hook (§3.3a). 'document' (doc /
 * sheet, 4-seg) and 'whiteboard' (board, 5-seg `:wb:` key, doc_type='board')
 * both have an authoritative Yjs body flowing through the store path, so both
 * are indexed here. Html docs are EXCLUDED this期 (their body lives in the
 * external octo-doc service and never reaches the Yjs store). Parse failures are
 * treated as non-indexable (never throws — this gates a best-effort side channel).
 */
function isIndexableDocument(documentName: string): boolean {
  try {
    const kind = parseDocumentName(documentName).kind
    return kind === 'document' || kind === 'whiteboard'
  } catch {
    return false
  }
}

/**
 * True if `v` is a presence display name safe to RELAY to peers (§4.7(b) / P2).
 *
 * Like `avatar`, `name` is echoed to every other peer and rendered there
 * (see the header on `validateAwarenessStates`), so a client-controlled value
 * must never carry a script vector. A display name is free text, so — unlike a
 * URL-shaped avatar — we do NOT restrict it to a narrow charset: unicode,
 * spaces and ordinary punctuation are legitimate. We reject FAIL-CLOSED only a
 * value that carries a markup/script vector: an angle bracket (`<` / `>`, the
 * `<img src=x onerror=…>` / `<script>` injection vector) or a C0/C1 control
 * character. Reject-not-escape is deliberate: HTML-escaping here would corrupt
 * the JSON/Yjs awareness contract (a name legitimately containing `<` or `&`
 * would be double-encoded at every consumer); the render sink still owns final
 * escaping, this is the defense-in-depth the sibling `avatar` field already has.
 * Never throws.
 */
export function isSafeName(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > NAME_MAX_LEN) return false
  // eslint-disable-next-line no-control-regex
  return !/[<>\u0000-\u001F\u007F-\u009F]/.test(v)
}

/**
 * Reasonable cap for a relayed avatar reference — enough for a small raster
 * data: thumbnail, short enough to keep awareness frames light. Longer values
 * are treated as unsafe and stripped.
 */
const AVATAR_MAX_LEN = 2048
/** Raster image data: URIs only — never svg/text, which can carry script. */
const DATA_IMAGE_RE = /^data:image\/(png|jpe?g|gif|webp);/i

/**
 * True if `v` is a safe avatar reference to RELAY to peers (§8.3.1 / P2).
 *
 * `avatar` is an optional, cosmetic field the v1 whiteboard binding publishes
 * alongside `{ id, name }`. It is echoed to every other peer and rendered there,
 * so an attacker-controlled value must never carry a script vector. Accept only:
 *   - http(s) URLs,
 *   - `data:image/{png,jpeg,gif,webp}` raster data URIs, and
 *   - scheme-less values that are unambiguously a relative / root-relative PATH
 *     (`/…`, `./…`, `../…`) — a path can't execute.
 * Everything else is rejected FAIL-CLOSED (XIN-604 P1): `javascript:` /
 * `vbscript:` / other schemes, a scheme smuggled behind percent-encoding
 * (`javascript%3Aalert(1)`), a protocol-relative URL (`//host/x` — a
 * cross-origin fetch vector, not a path), a value that only looks scheme-less
 * because its scheme lacks a leading letter (`1javascript:alert(1)`),
 * `data:text/*`, `data:image/svg+xml` (SVG can embed script), any value
 * containing markup or control characters, oversize strings, and non-strings.
 * Never throws.
 */
export function isSafeAvatar(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > AVATAR_MAX_LEN) return false
  // Positive allowlist of URL / data-URI-safe characters: this excludes control
  // chars, whitespace, quotes and angle brackets outright, so no raw markup or
  // smuggled control byte can slip through to a rendering peer.
  if (!/^[A-Za-z0-9\-._~:/?#@!$&*+,;=%()]+$/.test(v)) return false

  const schemeOf = (s: string): string | null => {
    const m = /^([a-z][a-z0-9+.-]*):/i.exec(s)
    return m ? (m[1] ?? '').toLowerCase() : null
  }
  const rawScheme = schemeOf(v)

  // Fail-closed against percent-encoded scheme smuggling: the allowlist permits
  // `%`, so `javascript%3Aalert(1)` carries NO bare colon and would otherwise
  // reach the scheme-less path. If percent-decoding introduces a scheme the raw
  // value did not have, a downstream sink that decodes before use would
  // resurrect it — reject. A malformed percent sequence (decode throws) is
  // itself unsafe → reject.
  if (v.includes('%')) {
    let decoded: string
    try {
      decoded = decodeURIComponent(v)
    } catch {
      return false
    }
    if (rawScheme === null && schemeOf(decoded) !== null) return false
  }

  if (rawScheme === null) {
    // Scheme-less: accept ONLY an unambiguous relative / root-relative path,
    // which carries neither an executable scheme nor a cross-origin host. A
    // leading `//` is a protocol-relative URL (cross-origin fetch vector), NOT a
    // path — reject it. Bare `host/x`-style values and everything else are
    // rejected fail-closed.
    if (v.startsWith('//')) return false
    return v.startsWith('/') || v.startsWith('./') || v.startsWith('../')
  }

  if (rawScheme === 'http' || rawScheme === 'https') return true
  if (rawScheme === 'data') return DATA_IMAGE_RE.test(v) // raster data URIs only
  return false // javascript:, vbscript:, file:, data:text/*, data:image/svg+xml, …
}

/**
 * §8.3.1 presence identity + field validation — source-scoped and NON-FATAL.
 *
 * `beforeHandleAwareness` hands us the awareness states decoded from THIS
 * source connection's inbound frame, keyed by Yjs clientId, as a MUTABLE map
 * (not the full broadcast set). So every entry here is something this very
 * connection is adding/updating; we validate only those and never touch other
 * peers' pre-existing presence — which is why legitimate multi-user cursors
 * flow through untouched.
 *
 * Two tiers, by design:
 *
 *  1. IMPERSONATION is the only security-relevant rejection: a frame whose
 *     `user.id` is not this connection's own uid is dropping the whole state
 *     (a client must never publish presence claiming to be someone else).
 *
 *  2. `color` and `avatar` are OPTIONAL, cosmetic fields, and `name` is
 *     server-authoritative. None of them may cause the WHOLE presence state to
 *     be dropped — doing so silently kills the user's entire presence broadcast
 *     for that frame, and because Hocuspocus re-encodes the awareness update
 *     from only the surviving states, a dropped state is never applied to the
 *     document awareness and therefore never relayed (neither the local
 *     broadcast nor the Redis cross-node publish fires). The v1 whiteboard
 *     binding publishes `{ id, name, avatar }` with NO color at all, so the old
 *     whole-state drop on a missing/invalid color meant the receiving peer got
 *     ZERO awareness frames (presence A->B = 0) even though doc (type0) sync
 *     relayed fine. We instead SANITIZE the offending field in place (strip an
 *     invalid/unsafe color so no CSS injection value propagates) and let the
 *     rest of the presence broadcast — standard Hocuspocus relay behavior.
 *
 *     For `name` specifically (§4.7(b) / XIN-694): the trusted display name
 *     resolved at token issuance rides the collab token into `ctx`. When it is
 *     present we STAMP it over whatever the client published, so every relayed
 *     presence frame carries the real display name rather than the raw uid a
 *     client whose own directory lookup has not yet resolved would broadcast.
 *     `uid` always stays in `user.id`; only `user.name` is rewritten. When no
 *     trusted name is available (an older token, or the directory supplied
 *     none) we fall back to relaying the client value only when it is
 *     script-safe (`isSafeName`): a name carrying a markup/script vector, or a
 *     non-string/oversized one, is stripped fail-closed, never dropping the state.
 *
 * We MUST NOT throw: a malformed or impostor awareness frame must never crash
 * the process or break other users' live collaboration (an earlier
 * implementation iterated the full broadcast set and threw, which crashed the
 * whole backend the moment a second user joined — a remotely triggerable DoS).
 */
export function validateAwarenessStates(
  states: Map<number, Record<string, unknown>>,
  ctx: AuthContext | undefined,
): void {
  if (!ctx) return // server-internal awareness (DirectConnection) carries no client ctx
  for (const [clientId, state] of states) {
    // Shape guard first: a malformed frame may carry a null / non-object state,
    // and reading `.user` off it would throw — violating the MUST-NOT-throw
    // contract below (a remotely triggerable crash). Skip it as non-presence.
    if (!state || typeof state !== 'object') continue
    const user = (state as {
      user?: { id?: unknown; name?: unknown; color?: unknown; avatar?: unknown }
    }).user
    if (!user) continue // non-presence awareness data — nothing to validate

    // (1) Identity binding: a connection may only publish presence under its OWN
    // uid. A frame claiming a different id is impersonation -> drop the whole
    // state. This is the single hard, security-relevant rejection.
    if (user.id !== ctx.user.id) {
      states.delete(clientId)
      continue
    }

    // (2) Cosmetic fields are sanitized, never fatal to the state. color is
    // optional; only strip it when it is PRESENT and not a safe #RRGGBB hex (no
    // CSS injection). A missing color is legitimate (whiteboard presence).
    if ('color' in user && !(typeof user.color === 'string' && COLOR_RE.test(user.color))) {
      delete (user as { color?: unknown }).color
    }
    // name (§4.7(b) / XIN-694): the display name is server-authoritative. When a
    // trusted name rode the collab token into ctx, it is the source of truth for
    // THIS connection's presence — stamp it over whatever the client published
    // (a client whose own directory lookup has not resolved broadcasts its raw
    // uid as name). uid stays in user.id; only user.name changes. Same tier as
    // the id binding above: the client does not get to pick its own display name.
    // Clamp to the 64-char frame-lightness cap the client path already enforced.
    const trustedName = ctx.user.name
    if (typeof trustedName === 'string' && trustedName.length > 0) {
      ;(user as { name?: unknown }).name =
        trustedName.length > NAME_MAX_LEN ? trustedName.slice(0, NAME_MAX_LEN) : trustedName
    } else if ('name' in user && !isSafeName(user.name)) {
      // No trusted name at this layer (token minted before this change, or the
      // directory supplied none): fall back to the client value, but relay it
      // only when it is script-safe. A client-published name is attacker-chosen
      // (the impersonation guard above checks user.id, not user.name), and this
      // frame is rendered on every peer, so strip a name carrying a markup/script
      // vector (e.g. `<img src=x onerror=…>`) or that is non-string/oversized —
      // fail-closed, exactly as the sibling `avatar` field is hardened below.
      // Reject-not-escape: HTML-escaping would corrupt the JSON awareness contract.
      delete (user as { name?: unknown }).name
    }
    // avatar is optional (the v1 whiteboard binding publishes { id, name,
    // avatar }); strip it when present and not a safe image reference so no
    // script vector (javascript: URL, raw HTML, svg/text data URI) is relayed to
    // peers that render it (P2). Sanitize-in-place, never fatal — same tier as
    // color/name.
    if ('avatar' in user && !isSafeAvatar(user.avatar)) {
      delete (user as { avatar?: unknown }).avatar
    }
  }
}

export function createServer(redis = createCollabRedis(config.redis)) {
  const server = new Server({
    name: `octo-docs-${config.hostname}`,
    port: config.hocuspocusPort,

    // connection limits & timeouts (§2.1)
    timeout: 30_000,
    maxDebounce: 10_000,
    debounce: 2_000,
    unloadImmediately: false, // single-writer affinity prereq (§5.2)

    extensions: [
      new Logger(),
      // Our own persistence extension instead of @hocuspocus/extension-database:
      // that one hardcodes the v1 update format on both sides, and we persist v2
      // (see collabDatabase.ts / the 2026-08-21-yjs-document-encoding-v2 migration).
      new CollabDatabase({
        fetch: (documentName) => persistence.fetch(documentName),
        loaded: (documentName, doc) => persistence.loaded(documentName, doc),
        // lastContext flows through so store can write doc_meta.updated_by (P2-A).
        store: (documentName, doc, context) => persistence.store(documentName, doc, context),
      }),
      redis,
    ],

    // §4.1 onAuthenticate
    async onAuthenticate(data) {
      const envelope = parseGenerationToken(data.token)
      const ctx = await authenticate({
        token: envelope.token,
        documentName: data.documentName,
        connectionConfig: data.connectionConfig,
      })
      try {
        ctx.stateGeneration = await stateGenerationRepo.ensureSheet(data.documentName)
        ctx.cacheGeneration = envelope.generation
        if (ctx.stateGeneration && ctx.cacheGeneration !== ctx.stateGeneration) data.connectionConfig.readOnly = true
        return ctx
      } catch (error) {
        ctx.activeAccessRegistration?.release()
        ctx.activeAccessRegistration = null
        throw error
      }
    },

    async beforeSync(data) {
      const ctx = data.context as AuthContext | undefined
      if (!ctx) return
      const generation = stateGenerationOf(data.document)
      if (!generation) return
      try {
        for (;;) {
          await recheckWritePermission(data.documentName, ctx, data.connection)
          const current = ctx.cacheGeneration === generation
            ? await stateGenerationRepo.current(data.documentName)
            : null
          // SQL is the last IO before apply. An invalidation during it restarts
          // authorization AND the generation read, so neither check can go stale
          // while waiting for the other. Permission cache/singleflight is epoch-bound.
          if (ctx.permission_epoch < (epochWatermark.get(data.documentName) ?? ctx.permission_epoch)) continue
          if (current !== generation || stateGenerationOf(data.document) !== generation) {
            data.connection.readOnly = true
            data.connection.sendStateless(JSON.stringify({ type: 'doc.generation-stale', generation }))
          }
          return
        }
      } catch (error) {
        data.connection.readOnly = true
        throw error
      }
    },

    // register the connection in the cross-node registry (§4.5 step 2)
    async connected(data) {
      // An initial-awareness send may have already scheduled a logical close.
      // Do not race its onDisconnect cleanup by registering a closed connection.
      if (!data.connection.document.hasConnection(data.connection)) return
      const ctx = data.context as AuthContext
      setEpochWatermark(data.documentName, ctx.permission_epoch)
      const generation = stateGenerationOf(data.connection.document)
      if (generation && ctx.cacheGeneration !== generation) {
        data.connection.readOnly = true
        data.connection.sendStateless(JSON.stringify({ type: 'doc.generation-stale', generation }))
      }
      const receipt = durableReceipt(data.connection.document)
      if (receipt) data.connection.sendStateless(receipt)

      // A document already over the cap has to tell THIS connection so, on its
      // way in — see noticeOversizeOnJoin for why the broadcast alone is not
      // enough for someone who arrives after the rejection.
      const overCap = noticeOversizeOnJoin(data.documentName, (payload) =>
        data.connection.sendStateless(payload),
      )

      // If this document was compacted since the client last saw it, its
      // IndexedDB copy still carries the history the compaction removed and will
      // sync it straight back — undoing the saving entirely (compactionNotice.ts
      // has the production capture: 659,725 bytes served, 10,483,130 pushed back).
      // Tell it to drop that cache and re-fetch.
      //
      // Passing `overCap` is the interlock, not a detail: a capped document
      // cannot persist what the client is holding, so asking it to drop its
      // cache would destroy exactly the unsaved edits the over-size-cap banner
      // is telling the user to copy out. The notice waits until a store succeeds
      // and clears the mark.
      //
      // Not awaited: a Redis round trip must not sit in front of the sync this
      // connection is here for. The frame is advisory and the client acts on it
      // whenever it arrives — and `noticeStaleCacheOnJoin` never throws, so a
      // floating rejection is not possible.
      void noticeStaleCacheOnJoin(data.documentName, overCap, (payload) =>
        data.connection.sendStateless(payload),
      )

      await connectionRegistry.register({
        documentName: data.documentName,
        uid: ctx.user.id,
        node: config.hostname,
        connectionId: data.connection.socketId ?? data.socketId,
        role: ctx.role,
        permission_epoch: ctx.permission_epoch,
      })
    },

    async onDisconnect(data) {
      const ctx = data.context as AuthContext | undefined
      if (ctx) {
        ctx.activeAccessRegistration?.release()
        ctx.activeAccessRegistration = null
        ctx.activeAccessDisposer?.()
        ctx.activeAccessDisposer = undefined
        await connectionRegistry.unregister(data.documentName, data.socketId)
      }
    },

    // §4.5 step 4: per-principal write recheck against the LOCAL epoch watermark.
    // Pure in-memory compare on the hot path; only stale connections hit recheck.
    async beforeHandleMessage(data) {
      const ctx = data.context as AuthContext | undefined
      if (!ctx) return // server-internal writes (DirectConnection) carry no client ctx

      // Oversize guard (incident 2026-08-21). A document whose last store was
      // rejected for size can never persist another byte, so accepting writes
      // only inflates the in-memory state — which is re-encoded on every store
      // attempt and blocks the single JS thread until the liveness probe fails.
      //
      // The decision lives in oversizeGuard.applyOversizeDecision, which flips
      // the connection read-only and RETURNS. It must not throw and neither must
      // this branch: throwing here closes the connection, and this hook runs on
      // every inbound message including SyncStep1 — the client asking for the
      // document. See that function's comment for the production measurement.
      //
      // It deliberately does NOT return early. Returning here would skip the
      // §4.5 recheck below, so a user whose access was revoked while connected
      // would stop being rechecked the moment the document went over the cap —
      // the cap would silently switch off revocation enforcement. Read-only is
      // a write guard, not an authorization decision, and the two are not
      // interchangeable: read-only still serves document CONTENT, which is
      // exactly what a revoked principal must no longer receive. Enforcement
      // order is authorization first, capacity second.
      applyOversizeDecision(data.documentName, data.connection)
      // Preserve the capacity read-only state; authorization may refresh only
      // the epoch and never re-enable writes on a capped/stale-generation socket.
      await recheckWritePermission(data.documentName, ctx, data.connection)
    },

    // §8.3.1 awareness identity + field validation (MUST-level).
    // We use beforeHandleAwareness (not onAwarenessUpdate): its `states` map is
    // the source connection's OWN inbound frame (keyed by clientId) and is
    // mutable, so dropping an entry rejects just that part of the frame and the
    // broadcast reflects it — clean source-scoped, reject-the-frame semantics
    // with no way to crash the process. See validateAwarenessStates above.
    async beforeHandleAwareness(data) {
      validateAwarenessStates(data.states, data.context as AuthContext | undefined)
    },

    // M2 (§4.1): for whiteboard keys, attach the server-authoritative repair
    // observer to the freshly loaded live Y.Doc, then run one cold-start pass to
    // converge any persisted illegal state. The observer scopes work to changed
    // ids and skips its own REPAIR_ORIGIN writes (anti-self-excitation gates).
    async afterLoadDocument(data) {
      // Native Connection registers itself before sending constructor awareness.
      // Gate each logical connection here, not in the later connected hook.
      const addConnection = data.document.addConnection.bind(data.document)
      data.document.addConnection = connection => {
        addConnection(connection)
        const ctx = connection.context as AuthContext | undefined
        const docId = ctx?.doc ?? ctx?.board
        if (ctx?.source_access && docId) {
          const registration = ctx.activeAccessRegistration
          if (registration === null) throw new Error('Active access registration lease missing')
          ctx.activeAccessDisposer = registerActiveAccess(
            { docId, uid: ctx.user.id, principalSpaceId: ctx.principal_space_id, documentName: data.documentName },
            ctx.source_access.permissionEpoch ?? ctx.permission_epoch,
            ctx.source_access,
            () => recheckCurrentAccess(data.documentName, ctx.user.id, ctx.principal_space_id, ctx.space_member),
            gateYjsConnection(connection, ctx),
            registration,
          )
          ctx.activeAccessRegistration = null
        } else {
          ctx?.activeAccessRegistration?.release()
          if (ctx) ctx.activeAccessRegistration = null
        }
        return data.document
      }
      // Announce to the fleet that this replica now holds the document in
      // memory, so no other replica compacts it out from under us. Done first
      // and unconditionally: the early returns below are about whiteboard
      // repair, and every document kind needs this. Best-effort — a failure
      // here makes compaction elsewhere possible, which the compaction path's
      // own transaction-time checks still catch.
      void markLoaded(data.documentName).catch(() => {
        /* see above */
      })

      let kind: string
      try {
        kind = parseDocumentName(data.documentName).kind
      } catch {
        return // malformed key: nothing to repair (auth already rejected it)
      }
      if (kind === 'whiteboard') {
        const dispose = attachWhiteboardRepair(data.document)
        repairDisposers.set(data.documentName, dispose)
        // Converge persisted state on load through the fixed-clientID
        // materialization so two nodes cold-repairing the same blob on failover
        // emit byte-identical structs (BE-M11); a plain repairLiveDoc here would
        // attribute the corrective writes to this node's RANDOM clientID and
        // diverge on failover.
        coldRepairLiveDoc(data.document)
        return
      }
      if (kind === 'document') {
        repairDisposers.set(data.documentName, attachSheetDataValidationGuard(data.document, {
          maxRules: config.sheetWrite.maxDataValidations,
          maxBytes: config.sheetWrite.maxDataValidationBytes,
        }))
      }
    },

    // A4 (§5.2): backend-autonomous KIND_AUTO snapshots. afterStoreDocument
    // fires after the authoritative state is persisted; the auto-snapshot
    // module owns the idle timer / min-interval fallback / Redis dedup. Gated
    // behind AUTO_SNAPSHOT_ENABLED (default off) inside the module.
    async afterStoreDocument(data) {
      await handleAfterStore(
        data.documentName,
        data.lastContext as AuthContext | undefined,
        data.document,
      )

      // §3.3a: feed the full-text search indexer. Enqueue only a tiny
      // {documentName} signal; the consumer re-reads the latest body. Best-effort
      // and fire-and-forget (enqueue swallows its own errors) so it can never add
      // latency to, or fail, the authoritative store path above. Gated OFF by
      // default; whiteboards (no searchable body) are skipped.
      if (config.search.indexEnabled && isIndexableDocument(data.documentName)) {
        void enqueueDocIndex(data.documentName, 'body')
      }
    },

    // A4 (§5.2): flush the last editing burst + clear the per-doc idle timer
    // when the document unloads. Also tear down the whiteboard repair observer.
    async beforeUnloadDocument(data) {
      const dispose = repairDisposers.get(data.documentName)
      if (dispose) {
        dispose()
        repairDisposers.delete(data.documentName)
      }
      await handleBeforeUnload(data.documentName, data.document)
    },

    /**
     * History compaction, at the one moment it is safe to rebuild a document:
     * it has just unloaded, so nobody is connected and the next client loads the
     * compacted state fresh. See autoCompact.ts for why the stale-reconnect case
     * costs part of the saving but never correctness.
     *
     * Deliberately NOT awaited: this is an optimisation, and a slow or failing
     * compaction must not hold up teardown. That is safe here ONLY because the
     * expensive half runs on a worker thread (compactionRunner.ts) — not
     * awaiting a promise never moves synchronous work off this thread, so on the
     * main thread this hook would stall teardown and the liveness probe alike.
     */
    async afterUnloadDocument(data) {
      // Drop the oversize mark with the document itself — and do it HERE, not in
      // beforeUnloadDocument.
      //
      // Byte-verified in the pinned @hocuspocus/server 4.4.0 dist:
      // `unloadDocument` awaits the beforeUnloadDocument hook and only THEN
      // re-checks whether the document should still unload; a connection arriving
      // during the hook (our hook awaits an async flush, and with snapshots on it
      // also takes a Redis lock and writes a snapshot, so the window is real)
      // ABORTS the unload and leaves the document in the `documents` map — live
      // and oversized, but with the mark already cleared. The reconnecting
      // client's sync delta then passes beforeHandleMessage unchallenged and is
      // applied immediately, re-opening the write amplification this MR exists to
      // stop.
      //
      // afterUnloadDocument fires only after the document is really removed and
      // destroyed, so clearing here cannot disarm a document that stayed live. A
      // later load re-derives the mark from its own first store attempt, and
      // clearing at all is what keeps this from leaking one slot per document
      // that ever tripped the cap.
      //
      // This clears ONLY the write guard, NOT the shared over-cap condition.
      // Unloading resolves nothing — the oversized copy sits in the client's
      // IndexedDB, and it will re-inflate and be rejected again on reconnect — so
      // the cross-replica mark must keep blocking cache-stale stamping until a
      // store actually succeeds. `oversizeGuard` holds that condition in a
      // durable set the over-cap heartbeat refreshes, so the interlock survives
      // this unload and the idle period after it (MR98-003); only a successful
      // store (persistence.store -> clearOverCapResolved) lets it go.
      clearOversized(data.documentName)

      // Withdraw this replica from the document's holder set BEFORE attempting
      // compaction, and await it: while this entry stands, every other replica
      // correctly refuses to compact the document, so leaving it behind would
      // block the fleet rather than just this node.
      try {
        await markUnloaded(data.documentName)
      } catch {
        // The entry stays until this node's liveness key expires, which costs a
        // delayed compaction and nothing else. Never worth failing an unload.
      }

      void maybeCompactOnUnload(data.documentName, {
        storedBytes: async (name) => (await persistence.fetch(name))?.state.length ?? null,
        compact: compactDocument,
        log: (message) => {
          // eslint-disable-next-line no-console
          console.info(`[octo-docs] compaction: ${message}`)
        },
      })
    },
  })

  collabServer = server

  // Wire the oversize notifier now that `server` exists. oversizeGuard cannot
  // import this module (server.ts already imports it, and persistence.ts sits
  // between them), so the direction is inverted: the guard is handed a closure.
  //
  // `documents.get` returning nothing is normal, not an error — a store can be
  // rejected during an unload flush, by which point the document is already off
  // the map and there is nobody left to notify anyway.
  setOversizeAnnouncer((documentName, payload) => {
    server.hocuspocus.documents.get(documentName)?.broadcastStateless(payload)
  })

  return server
}

/**
 * Process-local handle to the running Hocuspocus server, set by createServer().
 * Server-side write paths (e.g. REST version restore) need it to call
 * openDirectConnection and reach the LIVE in-memory document of connected
 * clients. Single-process scaffold; under multi-node owner routing (§5.2 / §9.1)
 * the restore must run on the document's owner node, same as agent writes (§7.3).
 */
let collabServer: Server | null = null

export function getCollabServer(): Server {
  if (!collabServer) throw new Error('collab server not initialized')
  return collabServer
}
