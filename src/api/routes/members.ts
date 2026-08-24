/**
 * Member management routes (§8.4, doc_member; needs admin).
 *   GET    /api/v1/docs/{docId}/members
 *   PUT    /api/v1/docs/{docId}/members           (direct add/upsert by uid)
 *   DELETE /api/v1/docs/{docId}/members/{uid}
 */
import {
  Router,
  type Router as ExpressRouter,
  type Request,
  type Response,
} from "express";
import { docMemberRepo } from "../../db/repos/docMemberRepo.js";
import { requireDocRole } from "../guard.js";
import { bumpEpoch, refreshAndPublish } from "../../permission/epoch.js";
import { getOctoIdentity } from "../../auth/octoIdentity.js";
import { config } from "../../config/env.js";
import {
  isMemberRole,
  roleToNumber,
  roleFromNumber,
  type Role,
} from "../../permission/role.js";

export const membersRouter: ExpressRouter = Router();

// Canonical stored-number -> role name (covers commenter=4; stored value != rank
// ordinal, so use the shared map rather than a hand-rolled ternary). Falls back
// to 'reader' only for an unknown/corrupt stored value.
const roleName = (n: number): string => {
  const role = roleFromNumber(n);
  if (!role) throw new Error(`invalid member role ${n}`);
  return role;
};

function parseRole(v: unknown): Role | null {
  return isMemberRole(v) ? v : null;
}

/**
 * GET members (needs reader — i.e. any collaborator on the doc).
 *
 * WAS admin-only. That gate broke the @Bot picker for every non-owner: the frontend
 * (mentions/botCandidates.ts) must read this roster to prove a Bot holds writer+ on THIS
 * doc before it may offer it, and it fails CLOSED when the read throws. A writer therefore
 * got `permission-unknown` ("暂时读不到文档权限，无法列出可用的 Bot") and zero Bots, while
 * the owner — implicit admin — saw them. The roster is not a secret from the people already
 * on the doc: the same @ menu lists every human member by name right below the Bot group.
 *
 * `grantedBy` (who granted whom) IS management metadata, so it is disclosed to admins only
 * and nulled for everyone else. No frontend reads the field, so this costs nothing today and
 * keeps the admin-only surface from silently widening with the gate.
 */
membersRouter.get('/:docId/members', async (req: Request, res: Response) => {
  const guard = await requireDocRole(req, res, req.params.docId!, 'reader')
  if (!guard) return
  const isAdmin = guard.role === 'admin'
  const ownerId = guard.meta.owner_id
  const members = await docMemberRepo.list(req.params.docId!)
  // The owner is an implicit admin and intentionally has NO doc_member row
  // (§4.2 owner => admin; DELETE owner_cannot_be_removed). A plain doc_member
  // listing therefore omits it, even though `docs get` reports it as ownerId —
  // an inconsistency between the two reads. Surface the owner explicitly as a
  // synthesized item so `members list` and `docs get` agree on owner
  // visibility. This is display-only: no doc_member row is written, so the
  // implicit-owner semantics above stay intact. doc and sheet share this
  // endpoint, so both gain the owner row identically.
  const directMembers = members
    // Dedup: if a doc_member row for the owner also exists (e.g. a historical
    // PUT that upserted the owner), drop it so the owner appears exactly once,
    // always as admin (owner is not downgradable), never as a duplicate row.
    .filter(
      (m) =>
        !(
          m.uid === ownerId &&
          m.principal_space_id === guard.meta.owner_space_id
        ),
    )
    .map((m) => ({
      uid: m.uid,
      principalSpaceId: m.principal_space_id,
      role: roleName(Number(m.role)),
      source: m.source === 2 ? 'invite' : 'direct',
      grantedBy: isAdmin ? m.granted_by : null,
    }))
  res.status(200).json({
    items: [
      {
        uid: ownerId,
        principalSpaceId: guard.meta.owner_space_id,
        role: "admin",
        source: "owner",
        grantedBy: null,
      },
      ...directMembers,
    ],
  });
});

/**
 * PUT members — direct add / change role (upsert by uid; needs admin).
 * MUST first verify the target uid is a real octo user (§8.4 / §4.6 fix):
 * non-existent uid => 404 user_not_found (no ghost member written).
 */
membersRouter.put("/:docId/members", async (req: Request, res: Response) => {
  const guard = await requireDocRole(req, res, req.params.docId!, "admin");
  if (!guard) return;
  const { uid, role, principalSpaceId } = req.body ?? {};
  if (typeof uid !== "string" || uid === "") {
    res.status(400).json({ error: "uid required" });
    return;
  }
  const requestedPrincipalSpaceId =
    typeof principalSpaceId === "string" ? principalSpaceId.trim() : "";
  const targetPrincipalSpaceId =
    requestedPrincipalSpaceId || guard.meta.space_id;
  const parsedRole = parseRole(role);
  if (!parsedRole) {
    res
      .status(400)
      .json({ error: "role must be reader|commenter|writer|admin" });
    return;
  }

  // The client may name a target principal, but it cannot prove that
  // principal's Space. Validate the exact (uid, principalSpaceId) against
  // Octo's authoritative roster before any write. isSpaceMember() is not used:
  // it answers only for the token holder, not an arbitrary target.
  const identity = getOctoIdentity();
  // The roster endpoints are human/service-directory APIs, not bot-realm APIs.
  // A bot bearer must never be forwarded to them. Human requests retain their
  // caller-session fallback; bot requests require the configured service token
  // and fail closed before any directory call when it is absent.
  const directoryToken = req.botToken
    ? config.octoIdentity.serviceToken
    : (req.octoToken ?? "");
  if (!directoryToken) {
    res.status(503).json({ error: "identity_directory_unavailable" });
    return;
  }
  const roster = await identity.spaceMembers(
    targetPrincipalSpaceId,
    directoryToken,
  );
  if (roster === null) {
    res.status(503).json({ error: "identity_directory_unavailable" });
    return;
  }
  const target = roster.find((member) => member.uid === uid);
  // The Space member roster is authoritative for Humans, but some Octo
  // deployments omit robot rows from that endpoint. When the uid is absent (or
  // explicitly marked as a Bot), resolve it through the authoritative Space Bot
  // directory instead of rejecting a valid Bot before consulting that source.
  if (!target || target.isBot) {
    const bots = await identity.spaceBots(
      targetPrincipalSpaceId,
      directoryToken,
    );
    if (bots === null) {
      res.status(503).json({ error: "identity_directory_unavailable" });
      return;
    }
    const bot = bots.find((candidate) => candidate.uid === uid);
    const owner = bot?.creatorUid
      ? roster.find((member) => member.uid === bot.creatorUid && !member.isBot)
      : undefined;
    if (!bot || !owner) {
      res.status(404).json({ error: "principal_not_in_space" });
      return;
    }
  }
  const write = {
    docId: req.params.docId!,
    uid,
    principalSpaceId: targetPrincipalSpaceId,
    roleNum: roleToNumber(parsedRole),
    grantedBy: req.uid!,
  };
  if (targetPrincipalSpaceId === guard.meta.space_id) {
    // The established home-Space add-member flow remains an upsert.
    await docMemberRepo.upsertDirect(write);
  } else {
    // A non-home-Space principal is update-only. It may have been created by an
    // approved access request/invite, but PUT /members cannot mint it directly.
    const updated = await docMemberRepo.updateExistingDirect(write);
    if (!updated) {
      res.status(404).json({ error: "member_not_found" });
      return;
    }
  }
  // doc_member change => epoch +1 + broadcast invalidation (§4.5).
  await bumpEpoch(guard.meta.doc_id, guard.meta.document_name, uid);
  res.status(200).json({ ok: true });
});

/** DELETE member (needs admin); owner cannot be removed (§4.5). */
membersRouter.delete(
  "/:docId/members/:uid",
  async (req: Request, res: Response) => {
    const guard = await requireDocRole(req, res, req.params.docId!, "admin");
    if (!guard) return;
    const targetUid = req.params.uid!;
    const principalSpaceId =
      typeof req.query.principalSpaceId === "string"
        ? req.query.principalSpaceId.trim()
        : "";
    if (!principalSpaceId) {
      res.status(400).json({ error: "principalSpaceId required" });
      return;
    }
    if (
      targetUid === guard.meta.owner_id &&
      principalSpaceId === guard.meta.owner_space_id
    ) {
      res.status(403).json({ error: "owner_cannot_be_removed" });
      return;
    }
    // An administrator may manage other principals, but cannot revoke the exact
    // principal represented by this authenticated request. Allowing self-remove
    // makes the mutation succeed and the immediate refresh fail with 404, which
    // is both misleading and an easy accidental lockout.
    if (targetUid === req.uid && principalSpaceId === req.principalSpaceId) {
      res.status(403).json({ error: "self_cannot_be_removed" });
      return;
    }
    // Resolve ownership from Octo's authoritative Space Bot directory. A direct
    // Bot removal deletes only that Bot. A human removal cascades to Bots whose
    // creator_uid matches that human in this exact principal Space. Bot-mounted
    // requests must use the service credential for this human/service directory;
    // never forward the Bot bearer. Human requests retain their session token.
    const directoryToken = req.botToken
      ? config.octoIdentity.serviceToken
      : (req.octoToken ?? "");
    if (!directoryToken) {
      res.status(503).json({ error: "bot_directory_unavailable" });
      return;
    }
    const spaceBots = await getOctoIdentity().spaceBots(
      principalSpaceId,
      directoryToken,
    );
    if (spaceBots === null) {
      res.status(503).json({ error: "bot_directory_unavailable" });
      return;
    }
    const targetIsBot = spaceBots.some((bot) => bot.uid === targetUid);
    const botUids = targetIsBot
      ? []
      : spaceBots
          .filter((bot) => bot.creatorUid === targetUid)
          .map((bot) => bot.uid);
    const removal = await docMemberRepo.removePrincipalWithBots({
      docId: req.params.docId!,
      uid: targetUid,
      principalSpaceId,
      botUids,
    });
    if (removal.changed && removal.newEpoch !== undefined) {
      // One unscoped invalidation covers the removed human and every cascaded Bot.
      await refreshAndPublish(guard.meta.document_name, removal.newEpoch);
    }
    res.status(200).json({ ok: true, removedUids: removal.removedUids });
  },
);
