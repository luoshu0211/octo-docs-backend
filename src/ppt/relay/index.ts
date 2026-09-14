import { logPptPersistenceFailure } from './persistenceFailure.js'
/**
 * Production wiring for the PPT relay (R4-B1).
 *
 * Composes the relay's default dependencies: the MySQL-backed durable store, a
 * Redis-backed single-use ticket store (so the ticket contract holds across relay
 * nodes), the authoritative permission-epoch reader (Redis cache -> DB fallback),
 * a share-aware role re-resolver for downgrade enforcement, and the doc-liveness
 * guard. The relay itself is transport-agnostic; {@link PptRelay.attach} binds it
 * to B's existing REST HTTP server on the `/api/v1/ppt/collab` upgrade path — no
 * second service.
 */
import { PptRelay } from './pptRelay.js'
import { DbPptRelayStore } from './dbStore.js'
import { productionAgedOpDropHandler } from './agedOpDrop.js'
export { productionAgedOpDropHandler } from './agedOpDrop.js'
import { RedisTicketStore } from '../../auth/pptCollabToken.js'
import { currentEpoch } from '../../permission/epoch.js'
import { recheckCurrentRole } from '../../permission/resolveRole.js'
import { docMetaRepo } from '../../db/repos/docMetaRepo.js'
import { pptDocStateRepo } from '../../db/repos/pptDocStateRepo.js'

/** Build the production relay wired to DB/Redis-backed dependencies. */
export function createPptRelay(): PptRelay {
  return new PptRelay({
    requireBoundActors: true,
    clustered: true,
    store: new DbPptRelayStore(true),
    // Single-use tickets must be single-use across the whole relay fleet, not
    // just within one process — wire the shared Redis store.
    ticketStore: new RedisTicketStore(),
    epochProvider: (documentName) => currentEpoch(documentName),
    // Downgrade enforcement re-resolves the EFFECTIVE role the same way issuance
    // did (`recheckCurrentRole` = max(direct, share-derived)), folding in an
    // `anyone_in_space` share grant via the token-carried `space_member` claim —
    // so this seam never disagrees with issuance and wrongly revokes a legitimate
    // share writer. It reads share settings FRESH from the doc row, so a scope
    // narrowing still tightens immediately, and returns 'none' for a
    // missing/soft-deleted doc or a removed member (fail-closed).
    roleProvider: (ctx) => recheckCurrentRole(ctx.documentName, ctx.uid, ctx.principalSpaceId, ctx.spaceMember),
    docStatusProvider: async (docId) => {
      const meta = await docMetaRepo.getByDocId(docId)
      // status 0 = soft-deleted, 2 = archived (both refused by pptDocGuard, the
      // REST write path). Treat BOTH as not-writable/readable through the relay so
      // an archived deck cannot be live-edited via the WS path while the REST path
      // returns 409/404 for it — archiving bumps no epoch, so this is the guard
      // (XIN-1693 P2-f). Any other status is live.
      // Refuse an old credential carrying an alias instead of opening another
      // room for the same case-insensitive database identity. Reconnect obtains
      // a fresh ticket containing the canonical ID.
      return meta && meta.doc_id === docId && meta.status !== 0 && meta.status !== 2 ? 'live' : 'deleted'
    },
    // Genesis-deck source for the server-side snapshotter's FIRST reduction, before
    // any durable snapshot exists (XIN-1759 Part B): the materialized starter deck
    // persisted at create time (`ppt_doc_state.draft_doc`). Once the snapshotter has
    // produced a snapshot it reduces onto that instead. Null (no row) degrades safely
    // — the room simply keeps its op log until a base deck is available.
    baseDocProvider: async (docId) => (await pptDocStateRepo.getSource(docId))?.draftDoc ?? null,
    // Escalate an aged-out op to the operational channel (XIN-1807 P1-2): structured
    // ERROR log keyed on `ppt_relay_aged_op_drop` with the dropped `(actor,s)` pairs, so
    // a silent server↔peer divergence is alertable + reconcilable instead of only a
    // `console.warn`. See `productionAgedOpDropHandler` and the operator obligation in
    // `docs/DEPLOYMENT.md`.
    onAgedOpDrop: productionAgedOpDropHandler,
    onPersistenceFailure: logPptPersistenceFailure,
  })
}
