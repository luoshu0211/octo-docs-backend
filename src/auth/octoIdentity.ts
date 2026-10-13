/**
 * octo identity integration (§4.7).
 *
 * docs depends on octo for exactly two identity capabilities:
 *   (a) token -> trusted uid  (CacheTokenParser / AuthMiddleware / POST /v1/auth/verify)
 *   (b) uid   -> user info     (GET /v1/users/:uid; batch needs a small octo addition)
 *
 * This module exposes an injectable `OctoIdentity` interface with:
 *   - an HTTP impl (cross-service fallback calling octo's POST /v1/auth/verify
 *     and GET /v1/users/:uid), and
 *   - a middleware-style placeholder impl for the same-process mount, where uid
 *     would come from octo's AuthMiddleware via c.GetLoginUID() (§4.7(a)).
 */
import { createHash } from 'node:crypto'
import { config } from '../config/env.js'
import { Singleflight, TtlCache } from '../util/singleflight.js'
import { parseOwnedBotUidsStrict } from '../util/botUids.js'

export interface OctoUser {
  uid: string;
  name: string;
  avatar?: string;
}

export interface OctoSpaceBot {
  uid: string;
  /** Display name from the Space Bot directory; absent only on legacy rows. */
  name?: string;
  creatorUid?: string;
}

export interface OctoSpaceMember {
  uid: string;
  isBot: boolean;
}

export type OctoSpacePrincipalLookup =
  | { status: 'eligible'; principalType: 'human' | 'user_bot' }
  | { status: 'not_eligible' }
  | { status: 'not_found' }
  | { status: 'forbidden' }
  | { status: 'unavailable' }

/**
 * octo-server user `status` value that marks an ENABLED account (XIN-1850
 * frozen batch contract). Only enabled users are grantable; every other status
 * is treated exactly like a missing user (anti ghost-member), mirroring the
 * scalar single-user semantics octo-server enforces at the source.
 */
export const OCTO_USER_STATUS_ENABLED = 1

/**
 * Max uids docs-backend may send to octo-server in a single batch user-info
 * request (`POST /v1/users/batch` / `POST /v1/bot/users/batch`). MUST mirror
 * octo-server's `MaxBatchUserUIDs`, which octo-server PR #772 (XIN-1862) lowered
 * from 1000 -> 200 to bound the forward-grant rate-limit amplification.
 *
 * octo-server rejects any over-cap batch with 400. Under this module's
 * fail-closed batch semantics that 400 would sink the WHOLE forward shard for
 * any group > 200 recipients — exactly the large-group case forward-grant
 * exists for. So `getUsersBatch`/`getUsersAsBotBatch` sub-chunk the uid set to
 * <= this cap and issue one octo-server request per chunk. forward-grant/batch's
 * own 1000 request cap and the frontend 1000 shard are UNCHANGED, so a shard is
 * at most ceil(1000/200)=5 sub-calls. Keep in sync if octo-server changes
 * `MaxBatchUserUIDs`.
 */
export const OCTO_SERVER_BATCH_MAX_UIDS = 200

/**
 * Split `uids` into sequential, non-overlapping sub-chunks of at most
 * OCTO_SERVER_BATCH_MAX_UIDS, preserving order. An empty input yields no chunks
 * (the caller then issues zero octo-server requests and returns an empty map).
 */
function chunkUids(uids: string[]): string[][] {
  const chunks: string[][] = []
  for (let i = 0; i < uids.length; i += OCTO_SERVER_BATCH_MAX_UIDS) {
    chunks.push(uids.slice(i, i + OCTO_SERVER_BATCH_MAX_UIDS))
  }
  return chunks
}

/**
 * The leading space-scope prefix octo-server's BOT routes strip before resolving
 * an identity: `s<digits>_` (e.g. `s1_alice` -> `alice`). MUST mirror
 * octo-server `modules/bot_api` (PR #772). Only the bot batch/user routes strip;
 * the human `/v1/users/batch` route does NOT, so this is applied on the bot path
 * only (`getUsersAsBotBatch`). See `stripBotSpacePrefix` below.
 */
const BOT_SPACE_PREFIX_RE = /^s\d+_/

/**
 * Return the BASE uid octo-server's bot routes key a resolved user by, i.e. the
 * requested uid with any leading `s<digits>_` space prefix removed. A bare
 * (unprefixed) uid is returned unchanged.
 */
function stripBotSpacePrefix(uid: string): string {
  return uid.replace(BOT_SPACE_PREFIX_RE, '')
}

/**
 * Parse an octo-server batch user-info body (`POST /v1/users/batch` /
 * `POST /v1/bot/users/batch`, XIN-1850) into a uid-keyed lookup of the
 * GRANTABLE users only. Enforces the two failure granularities the batch
 * forward-grant path relies on:
 *
 *   - BATCH-level malformed (body not an object, or `users` not an array) =>
 *     return `null` so the caller fails CLOSED before any write, instead of
 *     silently treating every uid as missing.
 *   - PER-ROW not-grantable (malformed row, absent uid, or non-enabled status)
 *     => the row is simply omitted from the map, so the handler reports that
 *     uid as `user_not_found`. `missing_uids` needs no special handling: a uid
 *     that is absent from `users` is likewise absent from the map.
 */
function parseBatchUsers(body: unknown): Map<string, OctoUser> | null {
  if (!body || typeof body !== 'object') return null
  const users = (body as { users?: unknown }).users
  if (!Array.isArray(users)) return null
  const out = new Map<string, OctoUser>()
  for (const row of users) {
    if (!row || typeof row !== 'object') continue
    const r = row as { uid?: unknown; status?: unknown; name?: unknown; avatar?: unknown }
    if (typeof r.uid !== 'string' || r.uid === '') continue
    if (r.status !== OCTO_USER_STATUS_ENABLED) continue
    out.set(r.uid, {
      uid: r.uid,
      name: typeof r.name === 'string' ? r.name : '',
      avatar: typeof r.avatar === 'string' ? r.avatar : undefined,
    })
  }
  return out
}

/**
 * One entry of the caller's friend-bot list (GET /v1/robot/my_bots).
 *
 * `creatorUid` is the bot's `robot.creator_uid` — octo-server returns '' for a
 * bot with no recorded creator, so it is surfaced verbatim (possibly empty) and
 * must never be treated as an ownership proof on its own.
 */
export interface OctoCallerBot {
  uid: string
  creatorUid: string
}

/**
 * Stable, non-reversible cache-key component for a session token. Only ever used
 * as a Map key inside this process; the token itself is never logged or stored.
 */
function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 32)
}

export interface OctoIdentity {
  /**
   * (a) Resolve an octo session token to a trusted uid. Returns null when the
   * token is missing/invalid (caller => 401 / login_required).
   *
   * `ownedBots` is octo-server's `owned_bots`: the uids of the bots this human
   * user owns (robot.creator_uid == uid). Surfaced so "my documents" can also
   * include docs a user's bots own. Absent/non-array from octo-server => treated
   * as `[]` (fail-CLOSED: fall back to just the user's own docs, never wider).
   */
  verifyToken(
    token: string,
  ): Promise<{ uid: string; name?: string; ownedBots?: string[] } | null>;

  /**
   * (a-bot) Resolve a bot bearer token to its trusted bot uid, the bot's space,
   * and — when the bot has a human creator — that creator's uid. Calls
   * octo-server's already-existing POST /v1/auth/verify-bot, which validates the
   * token against the `robot` table, reverse-looks-up the bot's space from its
   * most recent active `space_member` row, and returns `owner_uid` (the bot's
   * `robot.creator_uid`). The space is therefore never client-supplied
   * (anti-spoof). `ownerUid` is omitted when the bot has no human creator (e.g. a
   * platform bot). Returns null when the token is missing/invalid (caller => 401 /
   * unauthorized).
   */
  verifyBot(
    token: string,
  ): Promise<{ uid: string; spaceId: string; ownerUid?: string } | null>;

  /**
   * (b) Look up a single user by uid. Returns null if the user does not exist
   * (used by §8.4 PUT members to reject ghost members => 404 user_not_found).
   *
   * octo-server's GET /v1/users/:uid requires auth, so a token is sent as the
   * `token` header: the configured service token when set, else the optional
   * authenticated caller's own octo session token.
   */
  getUser(
    uid: string,
    callerToken?: string,
    signal?: AbortSignal,
  ): Promise<OctoUser | null>;

  /**
   * (b-bot) Look up a single user by uid on the BOT path, authenticating with
   * the bot's own bearer token. Calls octo-server's already-existing bot
   * user-info route GET /v1/bot/user/info?uid=... with `Authorization: Bearer
   * <botToken>` (the authBot realm), not the AuthMiddleware-guarded
   * GET /v1/users/:uid route the human path uses. The 200-vs-404 signal is the
   * same anti ghost-member existence check: 200 -> OctoUser, 404 -> null.
   *
   * Bot-realm callers such as forward-grant therefore do not need
   * OCTO_SERVER_TOKEN for this specific lookup.
   */
  getUserAsBot(uid: string, botToken: string): Promise<OctoUser | null>;

  /**
   * Validate one exact `(uid, spaceId)` target on behalf of a Bot. The endpoint
   * is authoritative for grant eligibility and is authenticated in the Bot
   * bearer realm, so Bot member-add does not need the human/service directory
   * token. Dependency/auth failures remain distinct from a confirmed absence.
   */
  lookupSpacePrincipalAsBot(
    uid: string,
    spaceId: string,
    botToken: string,
  ): Promise<OctoSpacePrincipalLookup>;

  /** (b) Batch profile lookup for awareness cursors (§4.7(b)). */
  getUsers(uids: string[], callerToken?: string): Promise<OctoUser[]>;

  /**
   * (b-batch) Resolve MANY uids in a single call against octo-server's
   * `POST /v1/users/batch` (XIN-1850), for the human forward-grant batch path.
   * Returns a uid-keyed lookup of the GRANTABLE users (present AND enabled) —
   * NOT a positional array — so callers test presence by uid, never by index.
   * A uid that is missing / disabled / malformed is simply absent from the map
   * (=> per-item `user_not_found`).
   *
   * Returns `null` when the batch call itself fails or the body is malformed at
   * the batch level (transport error, non-200, or `users` not an array), so the
   * caller can FAIL CLOSED before any write rather than guessing per uid.
   */
  getUsersBatch(
    uids: string[],
    callerToken?: string,
    signal?: AbortSignal,
  ): Promise<Map<string, OctoUser> | null>

  /**
   * (b-batch-bot) Bot-path counterpart of getUsersBatch: resolves many uids in
   * one call against octo-server's `POST /v1/bot/users/batch` (XIN-1850),
   * authenticating with the bot's own bearer token (the authBot realm). Same
   * uid-keyed grantable-only lookup and same fail-closed `null` contract.
   */
  getUsersAsBotBatch(
    uids: string[],
    botToken: string,
    signal?: AbortSignal,
  ): Promise<Map<string, OctoUser> | null>

  /**
   * (#64) Is the caller (`uid`, holding `token`) an ACTIVE member of Space
   * `spaceId`? Resolved server-side by REUSING octo-server's existing
   * POST /v1/auth/verify?include=context, which returns the token holder's
   * server-validated `spaces` list (active `space_member` row in a live space —
   * the same status-hardening fleet/matter rely on). Membership is therefore
   * `spaceId ∈ spaces`. No dedicated internal endpoint and no service secret:
   * the caller's OWN session token is the authorization, and verify only ever
   * answers for that token's holder — this path never inspects a third party's
   * membership. Used to honor the anyone_in_space share scope for HUMANS (bots
   * derive membership from their server-verified space, so they never call this).
   *
   * `uid` is the caller's trusted uid (already resolved from `token`); it keys
   * the cache and is asserted against verify's resolved uid so a token/uid
   * disagreement can never confirm a membership.
   *
   * FAIL-CLOSED: any transport failure / non-200 / malformed body / a response
   * that did not carry space context returns `false` (treated as NOT a member),
   * mirroring verifyToken / verifyBot returning null on failure. A transient
   * octo-server outage therefore TIGHTENS access (denies share-derived
   * reads/writes), never loosens it.
   */
  isSpaceMember(uid: string, spaceId: string, token: string): Promise<boolean>;

  /**
   * (user-bot grants) Resolve the bot uids the caller (`uid`, holding `token`)
   * OWNS in Space `spaceId` — octo-server's `owned_bots_by_space[spaceId]`,
   * derived from each bot's `robot.creator_uid == uid` AND the bot's active
   * `space_member` row in `spaceId`. Reuses the SAME authoritative path as
   * isSpaceMember: POST /v1/auth/verify?include=context, whose response the
   * server scopes to the TOKEN holder — this never inspects a third party's
   * bots. Used to gate a Docs access request's `bot_uids` snapshot: a submitted
   * bot is admissible only if it is in this set.
   *
   * `uid` is asserted against verify's resolved uid so a token/uid disagreement
   * can never confirm ownership.
   *
   * FAIL-CLOSED: any transport failure / non-200 / malformed body / a response
   * that did not carry space context / a token-uid mismatch returns `[]` (the
   * caller then owns no admissible bots, so a non-empty submitted set is
   * rejected). A transient octo-server outage therefore TIGHTENS the gate
   * (rejects the bot snapshot), never widens it.
   */
  ownedBotsInSpace(uid: string, spaceId: string, token: string): Promise<string[]>

  /**
   * (c) Which User Bots has the CALLER added as friends? Reads octo-server's
   * already-existing GET /v1/robot/my_bots, authenticated with the caller's OWN
   * session token (the `token` header — octo's AuthMiddleware realm, NOT
   * `Authorization: Bearer`). No service secret: that route answers only for the
   * token holder (`c.GetLoginUID()`), so this path can never enumerate a third
   * party's bots.
   *
   * SEMANTICS WORTH KNOWING — octo-server resolves the list as
   * `friend f INNER JOIN user u ON f.to_uid=u.uid AND u.robot=1
   *  INNER JOIN robot r ON r.robot_id=f.to_uid AND r.status=1
   *  WHERE f.uid=<caller> AND f.is_deleted=0 AND f.to_uid!='botfather'`.
   * Membership of this list therefore PROVES BOTH halves at once: the uid is an
   * active User Bot, AND the caller is friends with it. No separate friendship
   * lookup is needed or possible.
   *
   * `spaceId`, when non-empty, is forwarded as `?space_id=` and octo-server
   * additionally requires the bot to be an ACTIVE `space_member` of that space.
   * That only ever NARROWS the answer, and it narrows it to exactly the bots that
   * could act in the document's space at all, so it is always the safer scoping.
   *
   * FAIL-CLOSED: returns null — "could not confirm" — on a missing principal /
   * token, any transport failure, any non-200 (octo-server answers 400 for every
   * error on this route), or a body that is not a JSON array. Callers must treat
   * null as "no friend bots confirmed" and MUST NOT widen anything on it. A null
   * is never cached, so a transient outage does not pin an empty list for the TTL.
   *
   * The response is a BARE JSON array (`c.Response(results)` => 200 + the array,
   * no `{data:...}` envelope); individual entries that carry no usable `uid` are
   * skipped rather than failing the whole list — dropping an entry can only
   * narrow the caller's candidate set.
   */
  listCallerBots(uid: string, spaceId: string, token: string): Promise<OctoCallerBot[] | null>

  /**
   * Resolve the authoritative Bot ownership directory for one Space. Used by
   * member removal so deleting a human can also remove that human's document
   * Bot grants without trusting a client-supplied Bot list.
   *
   * Returns null on transport/auth/malformed responses. Callers must fail the
   * whole removal closed rather than delete only the human and leave orphaned
   * Bot grants behind.
   */
  spaceBots(spaceId: string, token: string): Promise<OctoSpaceBot[] | null>;

  /** Best-effort display name for a Space. Callers must fall back to the id. */
  getSpaceName?(spaceId: string, token: string): Promise<string>;

  /** Resolve an arbitrary target principal from the authoritative active Space roster. */
  spaceMembers(
    spaceId: string,
    token: string,
  ): Promise<OctoSpaceMember[] | null>;
}

/**
 * HTTP impl — cross-service fallback for when the docs backend runs as a
 * separate process (§4.7(a) "备选"). Calls octo's already-existing endpoints:
 *   POST /v1/auth/verify  -> { uid, name, role, owned_bots }
 *   GET  /v1/users/:uid   -> user detail
 *
 * TODO(§4.7(b)): batch profile uses the per-uid endpoint concurrently as a
 * stopgap until octo ships the thin `POST /v1/users/batch` (wraps GetUsers).
 */
export class HttpOctoIdentity implements OctoIdentity {
  constructor(
    private readonly baseUrl: string = config.octoIdentity.serverBaseUrl,
  ) {}

  /**
   * Per-{uid,spaceId} coalescing + short-TTL cache for isSpaceMember (#64,
   * design §4.4). Bounds the extra octo-server QPS on hot anyone_in_space docs;
   * only positive/negative membership answers are cached, never a fail-closed
   * transport error (so a transient outage does not pin a `false` for the whole
   * TTL — the next call retries).
   */
  private readonly membershipSf = new Singleflight<boolean>();
  private readonly membershipCache = new TtlCache<boolean>(
    config.octoIdentity.membershipCacheTtlSeconds * 1000,
  );

  /**
   * Same coalescing + short-TTL pattern for listCallerBots (GET /v1/robot/my_bots).
   *
   * KEY = `${uid} ${spaceId} ${tokenFingerprint(token)}`.
   *
   * The token fingerprint is what makes this safe to share a process between
   * users: the endpoint answers for the TOKEN HOLDER, so the cached value is a
   * property of the token, not of a client-supplied uid. Keying on the token's
   * hash (plus the uid and the space scope the answer was fetched under) means two
   * different callers can never read each other's bot list, even if they somehow
   * presented the same uid. Only a CONFIRMED list is cached — a fail-closed null
   * is not — so an outage is retried instead of pinned.
   */
  private readonly callerBotsSf = new Singleflight<OctoCallerBot[] | null>()
  private readonly callerBotsCache = new TtlCache<OctoCallerBot[]>(
    config.octoIdentity.callerBotsCacheTtlSeconds * 1000,
  )

  async verifyToken(token: string): Promise<{ uid: string; name?: string; ownedBots?: string[] } | null> {
    if (!token) return null
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/v1/auth/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
    } catch {
      // Authoritative identity source unreachable => treat as unverified.
      return null;
    }
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as {
      uid?: string;
      name?: string;
      owned_bots?: Array<{ uid?: string } | string>;
    } | null;
    if (!body || typeof body.uid !== "string" || body.uid === "") return null;
    // octo-server sends `owned_bots` (snake_case) as an OBJECT array
    // [{uid,name},...] (authVerifyTokenResp.ownedBot); older/other shapes may
    // send a bare uid string. Accept both, extracting the bot uid. FAIL-CLOSED:
    // a missing / non-array value degrades to [] (caller then sees only its own
    // docs) — it is NEVER allowed to widen visibility.
    const ownedBots = Array.isArray(body.owned_bots)
      ? body.owned_bots
          .map((b) =>
            typeof b === "string"
              ? b
              : b && typeof b.uid === "string"
                ? b.uid
                : "",
          )
          .filter((uid) => uid !== "")
      : [];
    return { uid: body.uid, name: body.name, ownedBots };
  }

  async verifyBot(
    token: string,
  ): Promise<{ uid: string; spaceId: string; ownerUid?: string } | null> {
    if (!token) return null;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/auth/verify-bot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bot_token: token }),
      });
    } catch {
      // Authoritative identity source unreachable => treat as unverified.
      return null;
    }
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as {
      bot_uid?: string;
      space_id?: string;
      owner_uid?: string;
    } | null;
    if (!body || typeof body.bot_uid !== "string" || body.bot_uid === "")
      return null;
    // The space is whatever octo-server reverse-resolved from the bot's active
    // space_member row; it is never a client-supplied value (anti-spoof).
    //
    // A bot with no resolvable space MUST NOT be authorized: reject it here
    // (return null, the unverified-identity signal) rather than passing an empty
    // spaceId downstream. Every doc guard scopes on req.spaceId, so an empty
    // space would silently defeat that scoping (empty === empty matches nothing
    // real, but bypasses the intended isolation). Enforcing it at the identity
    // layer means verifyBotMiddleware 401s a spaceless bot via its existing
    // null check, with no per-middleware special case, and keeps the invariant
    // "a verified bot identity always carries a real space" in one place.
    if (typeof body.space_id !== "string" || body.space_id === "") return null;
    // owner_uid is the bot's robot.creator_uid (the human who owns the bot).
    // octo-server returns '' for a bot with no human creator (e.g. a platform
    // bot); surface it only when it is a real uid so callers can skip the
    // owner-grant step cleanly.
    const ownerUid =
      typeof body.owner_uid === "string" && body.owner_uid !== ""
        ? body.owner_uid
        : undefined;
    return {
      uid: body.bot_uid,
      spaceId: body.space_id,
      ...(ownerUid ? { ownerUid } : {}),
    };
  }

  async getUser(
    uid: string,
    callerToken?: string,
    signal?: AbortSignal,
  ): Promise<OctoUser | null> {
    // octo-server requires auth on /v1/users/:uid: prefer a configured service
    // token, else fall back to the caller's own session token. Never logged.
    const token = config.octoIdentity.serviceToken || callerToken || "";
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/users/${encodeURIComponent(uid)}`, {
        headers: token ? { token } : {},
        // Caller-provided deadline: an abort reclaims the socket instead of
        // leaving an in-flight request against a stalled identity endpoint.
        ...(signal ? { signal } : {}),
      });
    } catch {
      return null;
    }
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as {
      uid?: string;
      name?: string;
      avatar?: string;
    } | null;
    if (!body || typeof body.uid !== "string") return null;
    return { uid: body.uid, name: body.name ?? "", avatar: body.avatar };
  }

  async getUserAsBot(uid: string, botToken: string): Promise<OctoUser | null> {
    // The bot resolves the target user with its own bearer token against the
    // authBot-guarded bot user-info route — no OCTO_SERVER_TOKEN needed. Never
    // logged. An empty token can never authenticate, so short-circuit to null.
    if (!botToken) return null;
    let res: Response;
    try {
      res = await fetch(
        `${this.baseUrl}/v1/bot/user/info?uid=${encodeURIComponent(uid)}`,
        {
          headers: { Authorization: `Bearer ${botToken}` },
        },
      );
    } catch {
      return null;
    }
    // 404 is the anti ghost-member signal (user does not exist) => null.
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as {
      uid?: string;
      name?: string;
      avatar?: string;
    } | null;
    if (!body || typeof body.uid !== "string") return null;
    return { uid: body.uid, name: body.name ?? "", avatar: body.avatar };
  }

  async lookupSpacePrincipalAsBot(
    uid: string,
    spaceId: string,
    botToken: string,
  ): Promise<OctoSpacePrincipalLookup> {
    if (!uid || !spaceId || !botToken) return { status: 'forbidden' }
    let res: Response
    try {
      res = await fetch(
        `${this.baseUrl}/v1/bot/space/principals/${encodeURIComponent(uid)}?space_id=${encodeURIComponent(spaceId)}`,
        { headers: { Authorization: `Bearer ${botToken}` } },
      )
    } catch {
      return { status: 'unavailable' }
    }
    if (res.status === 200) {
      const body = (await res.json().catch(() => null)) as unknown
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { status: 'unavailable' }
      }
      const principal = body as { uid?: unknown; principal_type?: unknown }
      if (principal.uid !== uid) return { status: 'unavailable' }
      if (principal.principal_type === 'human' || principal.principal_type === 'user_bot') {
        return { status: 'eligible', principalType: principal.principal_type }
      }
      if (principal.principal_type === 'app_bot') return { status: 'not_eligible' }
      return { status: 'unavailable' }
    }
    if (res.status === 404) {
      // The exact endpoint uses a canonical error envelope for a confirmed
      // absence. Gin's default no-route response is also 404 but plain text;
      // treating that as not_found would hide a missing server capability as a
      // product-level "principal not in Space" error during rolling deploys.
      const body = (await res.json().catch(() => null)) as unknown
      if (
        body &&
        typeof body === 'object' &&
        !Array.isArray(body) &&
        (body as { error?: { code?: unknown } }).error?.code ===
          'err.server.bot_api.user_not_found'
      ) {
        return { status: 'not_found' }
      }
      return { status: 'unavailable' }
    }
    if (res.status === 401 || res.status === 403) return { status: 'forbidden' }
    return { status: 'unavailable' }
  }

  async getUsers(uids: string[], callerToken?: string): Promise<OctoUser[]> {
    const results = await Promise.all(
      uids.map((u) => this.getUser(u, callerToken)),
    );
    return results.filter((u): u is OctoUser => u !== null);
  }

  async getUsersBatch(
    uids: string[],
    callerToken?: string,
    signal?: AbortSignal,
  ): Promise<Map<string, OctoUser> | null> {
    // octo-server requires auth on /v1/users/batch: prefer a configured service
    // token, else fall back to the caller's own session token. Never logged.
    const token = config.octoIdentity.serviceToken || callerToken || ''
    const merged = new Map<string, OctoUser>()
    // Sub-chunk to <= OCTO_SERVER_BATCH_MAX_UIDS per octo-server request so a
    // large forward-grant shard never trips octo-server's over-cap 400. Sequential
    // (at most ceil(1000/200)=5 calls) to avoid hammering the identity endpoint.
    for (const chunk of chunkUids(uids)) {
      let res: Response
      try {
        res = await fetch(`${this.baseUrl}/v1/users/batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(token ? { token } : {}) },
          body: JSON.stringify({ uids: chunk }),
          // Caller-provided deadline: an abort reclaims the socket instead of
          // leaving an in-flight request against a stalled identity endpoint.
          ...(signal ? { signal } : {}),
        })
      } catch {
        // Identity source unreachable => fail closed (null), never "all missing".
        return null
      }
      if (!res.ok) return null
      const parsed = parseBatchUsers(await res.json().catch(() => null))
      // Any chunk that fails batch-level parsing sinks the WHOLE call (fail
      // closed): never merge a partial map that would under-report grantees.
      if (parsed === null) return null
      for (const [uid, user] of parsed) merged.set(uid, user)
    }
    return merged
  }

  async getUsersAsBotBatch(
    uids: string[],
    botToken: string,
    signal?: AbortSignal,
  ): Promise<Map<string, OctoUser> | null> {
    // The bot resolves the batch with its own bearer token against the authBot
    // realm — no OCTO_SERVER_TOKEN needed. An empty token can never
    // authenticate, so fail closed before any IO.
    if (!botToken) return null
    const merged = new Map<string, OctoUser>()
    // Same <= OCTO_SERVER_BATCH_MAX_UIDS sequential sub-chunking + fail-closed
    // merge as getUsersBatch, against the bot batch route.
    for (const chunk of chunkUids(uids)) {
      let res: Response
      try {
        res = await fetch(`${this.baseUrl}/v1/bot/users/batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${botToken}` },
          body: JSON.stringify({ uids: chunk }),
          ...(signal ? { signal } : {}),
        })
      } catch {
        return null
      }
      if (!res.ok) return null
      const parsed = parseBatchUsers(await res.json().catch(() => null))
      if (parsed === null) return null
      // octo-server's bot batch route strips a leading `s<digits>_` space prefix
      // and keys resolved users by the BASE uid (PR #772). The forward-grant
      // batch handler looks up `lookup.get(g.uid)` with the ORIGINAL requested
      // string, so key each resolved user under the uid the caller actually SENT
      // — matching the base uid octo-server returned. This keeps the response
      // uid == request uid contract and mirrors the single bot route, without
      // collapsing distinct requested strings (`s1_alice`, `s2_alice`, bare
      // `alice`) that share one base uid: each requested uid gets its own entry.
      // A requested uid whose base has no grantable row is simply left absent
      // (downstream user_not_found). The human `getUsersBatch` path does NOT
      // strip, so this aliasing is bot-path only.
      for (const requestedUid of chunk) {
        const user = parsed.get(requestedUid) ?? parsed.get(stripBotSpacePrefix(requestedUid))
        if (user) merged.set(requestedUid, user)
      }
    }
    return merged
  }

  async spaceBots(
    spaceId: string,
    token: string,
  ): Promise<OctoSpaceBot[] | null> {
    const authToken = config.octoIdentity.serviceToken || token;
    if (!spaceId || !authToken) return null;
    let res: Response;
    try {
      res = await fetch(
        `${this.baseUrl}/v1/robot/space_bots?space_id=${encodeURIComponent(spaceId)}`,
        { headers: { token: authToken } },
      );
    } catch {
      return null;
    }
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as unknown;
    if (!Array.isArray(body)) return null;
    const bots: OctoSpaceBot[] = [];
    const seen = new Set<string>();
    for (const item of body) {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      if (typeof row.uid !== "string" || row.uid.trim() === "") return null;
      const botUid = row.uid.trim();
      if (seen.has(botUid)) return null;
      seen.add(botUid);
      const creatorUid =
        typeof row.creator_uid === "string" ? row.creator_uid.trim() : "";
      const name = typeof row.name === "string" ? row.name.trim() : "";
      bots.push({
        uid: botUid,
        ...(name ? { name } : {}),
        ...(creatorUid ? { creatorUid } : {}),
      });
    }
    return bots;
  }

  async getSpaceName(spaceId: string, token: string): Promise<string> {
    const authToken = config.octoIdentity.serviceToken || token;
    if (!spaceId || !authToken) return "";
    try {
      const res = await fetch(
        `${this.baseUrl}/v1/space/${encodeURIComponent(spaceId)}`,
        { headers: { token: authToken } },
      );
      if (!res.ok) return "";
      const body = (await res.json().catch(() => null)) as { name?: unknown } | null;
      return typeof body?.name === "string" ? body.name.trim() : "";
    } catch {
      return "";
    }
  }

  async spaceMembers(
    spaceId: string,
    token: string,
  ): Promise<OctoSpaceMember[] | null> {
    const authToken = config.octoIdentity.serviceToken || token;
    if (!spaceId || !authToken) return null;
    const members: OctoSpaceMember[] = [];
    const seen = new Map<string, boolean>();
    const pageLimit = 10_000;
    const maxPages = 20;
    for (let page = 1; page <= maxPages; page += 1) {
      let res: Response;
      try {
        res = await fetch(
          `${this.baseUrl}/v1/space/${encodeURIComponent(spaceId)}/members?page=${page}&limit=${pageLimit}`,
          { headers: { token: authToken } },
        );
      } catch {
        return null;
      }
      if (!res.ok) return null;
      const body = (await res.json().catch(() => null)) as unknown;
      if (!Array.isArray(body)) return null;
      for (const item of body) {
        if (!item || typeof item !== "object") return null;
        const row = item as Record<string, unknown>;
        if (typeof row.uid !== "string" || row.uid.trim() === "") return null;
        if (row.robot !== 0 && row.robot !== 1) return null;
        const uid = row.uid.trim();
        const isBot = row.robot === 1;
        const previous = seen.get(uid);
        if (previous !== undefined) {
          if (previous !== isBot) return null;
          continue;
        }
        seen.set(uid, isBot);
        members.push({ uid, isBot });
      }
      if (body.length < pageLimit) return members;
    }
    return null;
  }

  async ownedBotsInSpace(uid: string, spaceId: string, token: string): Promise<string[]> {
    // A missing principal/space can own no admissible bots, and an absent token
    // cannot authorize the verify call. Short out before any IO (fail-closed).
    if (!uid || !spaceId || !token) return [];
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/auth/verify?include=context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
    } catch {
      // Authoritative source unreachable => cannot confirm ownership => [].
      return [];
    }
    if (!res.ok) return [];
    const body = (await res.json().catch(() => null)) as {
      uid?: unknown;
      context_included?: unknown;
      owned_bots_by_space?: unknown;
    } | null;
    if (!body) return [];
    // verify answers for the TOKEN holder, so the uid it resolves must be the
    // uid we are gating on; a mismatch can never confirm ownership.
    if (typeof body.uid !== "string" || body.uid !== uid) return [];
    // context is opt-in: a pre-context octo-server omits these fields. Without
    // context we cannot confirm ownership => fail-closed (never treat an absent
    // map as "owns everything").
    if (body.context_included !== true) return [];
    const map = body.owned_bots_by_space;
    if (typeof map !== "object" || map === null || Array.isArray(map))
      return [];
    // Extract only THIS space's list; parseOwnedBotUidsStrict fails the WHOLE
    // list closed on any illegal/duplicate element (=> []), so a garbled octo-
    // server body can never authorize a partial set. It is NOT count-capped, so
    // an owner of > MAX_BOT_UIDS bots still gets the complete authoritative set.
    const list = (map as Record<string, unknown>)[spaceId];
    return parseOwnedBotUidsStrict(list);
  }

  async isSpaceMember(
    uid: string,
    spaceId: string,
    token: string,
  ): Promise<boolean> {
    // A missing principal or space can never be a real active membership, and an
    // absent caller token cannot authorize a verify call; short out before any
    // IO (also avoids caching a degenerate key).
    if (!uid || !spaceId || !token) return false;
    const key = `${uid} ${spaceId}`;
    const cached = this.membershipCache.get(key);
    if (cached !== undefined) return cached;
    return this.membershipSf.do(key, async () => {
      const member = await this.fetchIsSpaceMember(uid, spaceId, token);
      // Only cache a confirmed answer. A fail-closed `false` from a transport
      // error / un-confirmable context (fetchIsSpaceMember returns null) is NOT
      // cached — fetchIsSpaceMember distinguishes the two by returning null on
      // error, which we map to an uncached false, so a transient outage does not
      // pin a `false` for the whole TTL (the next call retries).
      if (member !== null) this.membershipCache.set(key, member);
      return member ?? false;
    });
  }

  /**
   * Resolve the caller's OWN space membership by reusing octo-server's existing
   * POST /v1/auth/verify?include=context (the authoritative token→identity path
   * fleet/matter already use). verify returns the token holder's server-validated
   * `spaces` list, so membership is `spaceId ∈ spaces`. Returns the membership
   * boolean, or null on any transport failure / non-200 / malformed body / a
   * response that did not carry space context, so the caller can distinguish
   * "confirmed not-a-member" (false) from "could not confirm" (null =>
   * fail-closed, uncached). No service secret is used: the caller's own session
   * token IS the authorization, and verify only answers for that token's holder.
   */
  private async fetchIsSpaceMember(
    uid: string,
    spaceId: string,
    token: string,
  ): Promise<boolean | null> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/auth/verify?include=context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
    } catch (err) {
      // Authoritative source unreachable => cannot confirm => fail-closed.
      this.warnMembershipVerificationFailure("transport_error", {
        error: err instanceof Error ? err.name : "unknown",
      });
      return null;
    }
    if (!res.ok) {
      this.warnMembershipVerificationFailure("non_ok_response", {
        status: res.status,
      });
      return null;
    }
    const body = (await res.json().catch(() => null)) as {
      uid?: unknown;
      context_included?: unknown;
      spaces?: unknown;
    } | null;
    if (!body) {
      this.warnMembershipVerificationFailure("malformed_response");
      return null;
    }
    // Defense-in-depth on the "token holder only" boundary: verify answers for
    // the TOKEN holder, so the uid it resolves must be the uid we are checking.
    // A mismatch (token/uid disagree) can never be a confirmable membership.
    if (typeof body.uid !== "string" || body.uid !== uid) {
      this.warnMembershipVerificationFailure("uid_mismatch");
      return null;
    }
    // The context fields are opt-in: a pre-context octo-server omits
    // context_included/spaces entirely. Without them we cannot confirm
    // membership => fail-closed (never treat an absent list as "zero spaces").
    if (body.context_included !== true || !Array.isArray(body.spaces)) {
      this.warnMembershipVerificationFailure("context_missing");
      return null;
    }
    return body.spaces.includes(spaceId);
  }

  private warnMembershipVerificationFailure(
    reason: string,
    details: Record<string, unknown> = {},
  ): void {
    // Structured event name doubles as a log-derived metric in deployments that
    // do not yet expose a native metrics registry. Deliberately excludes tokens,
    // uid, Space id, and the configured identity-service URL.
    // eslint-disable-next-line no-console
    console.warn("[octo-docs] space_membership_verify_error", {
      reason,
      ...details,
    });
  }

  async listCallerBots(uid: string, spaceId: string, token: string): Promise<OctoCallerBot[] | null> {
    // No principal or no token => nothing can be confirmed and no request could be
    // authorized. Short out BEFORE any IO (and before writing a degenerate key).
    // Note: an empty spaceId is legitimate — the space filter is optional — so it
    // is not part of this guard, only of the key and the query string.
    if (!uid || !token) return null
    const key = `${uid} ${spaceId} ${tokenFingerprint(token)}`
    const cached = this.callerBotsCache.get(key)
    if (cached !== undefined) return cached
    return this.callerBotsSf.do(key, async () => {
      const bots = await this.fetchCallerBots(spaceId, token)
      // Cache confirmed answers only (including a confirmed EMPTY list). A null is
      // "could not confirm" and is deliberately left uncached so the next call
      // retries instead of inheriting a fail-closed answer for the whole TTL.
      if (bots !== null) this.callerBotsCache.set(key, bots)
      return bots
    })
  }

  /**
   * Fetch the caller's friend-bot list from octo-server's GET /v1/robot/my_bots.
   *
   * Auth is the `token` HEADER (octo's AuthMiddleware realm reads `c.GetHeader
   * ("token")`), never `Authorization: Bearer` — the bearer realm is authBot and
   * does not serve this route. The token is never logged.
   *
   * Returns the parsed list, or null on any transport failure / non-200 / non-array
   * body so the caller can distinguish "confirmed: no friend bots" ([]) from "could
   * not confirm" (null => fail-closed, uncached). octo-server answers HTTP 400 for
   * every error on this route (httperr pins transportStatus to StatusBadRequest),
   * so `!res.ok` covers all of them.
   */
  private async fetchCallerBots(spaceId: string, token: string): Promise<OctoCallerBot[] | null> {
    const qs = spaceId ? `?space_id=${encodeURIComponent(spaceId)}` : ''
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/v1/robot/my_bots${qs}`, { headers: { token } })
    } catch {
      // Authoritative source unreachable => cannot confirm => fail-closed.
      return null
    }
    if (!res.ok) return null
    const body = (await res.json().catch(() => null)) as unknown
    // The wire shape is a BARE array (no {data:...} envelope). Anything else is a
    // shape we do not understand and must not interpret as "zero friend bots".
    if (!Array.isArray(body)) return null
    const bots: OctoCallerBot[] = []
    for (const item of body) {
      if (!item || typeof item !== 'object') continue
      const row = item as { uid?: unknown; creator_uid?: unknown }
      // A row with no usable uid names no bot; skipping it can only narrow the
      // caller's candidate set, which is the fail-closed direction.
      if (typeof row.uid !== 'string' || row.uid === '') continue
      bots.push({
        uid: row.uid,
        creatorUid: typeof row.creator_uid === 'string' ? row.creator_uid : '',
      })
    }
    return bots
  }
}

/**
 * Middleware-style placeholder for the same-process mount (§4.7(a) primary
 * path). When docs endpoints are mounted behind octo-server's AuthMiddleware,
 * the trusted uid is taken from c.GetLoginUID() — there is no self-rolled
 * verification. This stub documents that path; wiring it requires running
 * inside the octo-server process.
 *
 * TODO(§4.7(a)): replace with a real bridge to octo AuthMiddleware /
 * CacheTokenParser once docs mounts in-process.
 */
export class MiddlewareOctoIdentity implements OctoIdentity {
  // Optional: when mounted in-process, a request-scoped uid would be injected
  // by the middleware. Kept as an HTTP delegate so this remains runnable.
  constructor(
    private readonly delegate: OctoIdentity = new HttpOctoIdentity(),
  ) {}

  async verifyToken(
    token: string,
  ): Promise<{ uid: string; name?: string; ownedBots?: string[] } | null> {
    // In-process: octo AuthMiddleware would already have populated the uid.
    // Until wired, delegate to the HTTP introspection endpoint (which already
    // parses owned_bots -> ownedBots, keeping the contract identical).
    return this.delegate.verifyToken(token);
  }

  getUser(
    uid: string,
    callerToken?: string,
    signal?: AbortSignal,
  ): Promise<OctoUser | null> {
    return this.delegate.getUser(uid, callerToken, signal);
  }

  getUserAsBot(uid: string, botToken: string): Promise<OctoUser | null> {
    return this.delegate.getUserAsBot(uid, botToken);
  }

  lookupSpacePrincipalAsBot(
    uid: string,
    spaceId: string,
    botToken: string,
  ): Promise<OctoSpacePrincipalLookup> {
    return this.delegate.lookupSpacePrincipalAsBot(uid, spaceId, botToken)
  }

  verifyBot(
    token: string,
  ): Promise<{ uid: string; spaceId: string; ownerUid?: string } | null> {
    return this.delegate.verifyBot(token);
  }

  getUsers(uids: string[], callerToken?: string): Promise<OctoUser[]> {
    return this.delegate.getUsers(uids, callerToken);
  }

  getUsersBatch(
    uids: string[],
    callerToken?: string,
    signal?: AbortSignal,
  ): Promise<Map<string, OctoUser> | null> {
    return this.delegate.getUsersBatch(uids, callerToken, signal)
  }

  getUsersAsBotBatch(
    uids: string[],
    botToken: string,
    signal?: AbortSignal,
  ): Promise<Map<string, OctoUser> | null> {
    return this.delegate.getUsersAsBotBatch(uids, botToken, signal)
  }

  isSpaceMember(uid: string, spaceId: string, token: string): Promise<boolean> {
    return this.delegate.isSpaceMember(uid, spaceId, token);
  }

  ownedBotsInSpace(
    uid: string,
    spaceId: string,
    token: string,
  ): Promise<string[]> {
    return this.delegate.ownedBotsInSpace(uid, spaceId, token);
  }

  spaceBots(spaceId: string, token: string): Promise<OctoSpaceBot[] | null> {
    return this.delegate.spaceBots(spaceId, token);
  }

  spaceMembers(
    spaceId: string,
    token: string,
  ): Promise<OctoSpaceMember[] | null> {
    return this.delegate.spaceMembers(spaceId, token);
  }

  listCallerBots(uid: string, spaceId: string, token: string): Promise<OctoCallerBot[] | null> {
    return this.delegate.listCallerBots(uid, spaceId, token)
  }
}

let singleton: OctoIdentity | null = null;

/** Resolve the configured OctoIdentity impl (OCTO_IDENTITY_MODE). */
export function getOctoIdentity(): OctoIdentity {
  if (!singleton) {
    singleton =
      config.octoIdentity.mode === "middleware"
        ? new MiddlewareOctoIdentity()
        : new HttpOctoIdentity();
  }
  return singleton;
}

/** Test seam: inject a stub identity. */
export function setOctoIdentity(impl: OctoIdentity): void {
  singleton = impl;
}
