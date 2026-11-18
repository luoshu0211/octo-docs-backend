import { describe, it, expect, vi, beforeEach } from "vitest";

// Offline unit test for PUT /:docId/members (§8.4). The handler runs an
// anti-ghost-member check (getUser(uid) must resolve a real octo user) before
// upserting. Regression: getUser was called without the octo-server `token`
// header, so octo-server returned 401 -> null and every add-member 404'd. We
// mock the guard + member repo + epoch bump and inject a stub OctoIdentity to
// drive the route handler off the router stack (mirrors invitesRoutes.test.ts).
vi.mock("../src/api/guard.js", () => ({
  requireDocRole: vi.fn(),
}));
vi.mock("../src/db/repos/docMemberRepo.js", () => ({
  docMemberRepo: {
    upsertDirect: vi.fn(async () => {}),
    upsertDirectWithNotification: vi.fn(async () => ({ created: true })),
    updateExistingDirect: vi.fn(async () => true),
    removePrincipalExact: vi.fn(async () => ({
      changed: true,
      removedUids: [],
      newEpoch: 2,
    })),
    removePrincipalWithBots: vi.fn(async () => ({
      changed: true,
      removedUids: [],
      newEpoch: 2,
    })),
    list: vi.fn(async () => []),
  },
}));
vi.mock("../src/permission/epoch.js", () => ({
  bumpEpoch: vi.fn(async () => {}),
  refreshAndPublish: vi.fn(async () => {}),
}));

import { membersRouter } from "../src/api/routes/members.js";
import { requireDocRole } from "../src/api/guard.js";
import { docMemberRepo } from "../src/db/repos/docMemberRepo.js";
import {
  getOctoIdentity,
  setOctoIdentity,
  type OctoIdentity,
  type OctoSpaceBot,
  type OctoUser,
} from "../src/auth/octoIdentity.js";
import { refreshAndPublish } from "../src/permission/epoch.js";

interface MockRes {
  statusCode: number;
  body: unknown;
  status(c: number): MockRes;
  json(b: unknown): MockRes;
}

function mockRes(): MockRes {
  return {
    statusCode: 0,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
}

// Resolve the PUT add-member handler from the Express router stack.
function putMemberHandler() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const layer of (membersRouter as unknown as { stack: any[] }).stack) {
    const route = layer.route;
    if (route && route.path === "/:docId/members" && route.methods?.put) {
      return route.stack[route.stack.length - 1].handle as (
        req: unknown,
        res: unknown,
      ) => Promise<void>;
    }
  }
  throw new Error("put-member handler not found");
}

// Resolve the GET list-members handler from the Express router stack.
function getMembersHandler() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const layer of (membersRouter as unknown as { stack: any[] }).stack) {
    const route = layer.route;
    if (route && route.path === "/:docId/members" && route.methods?.get) {
      return route.stack[route.stack.length - 1].handle as (
        req: unknown,
        res: unknown,
      ) => Promise<void>;
    }
  }
  throw new Error("get-members handler not found");
}

function deleteMemberHandler() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const layer of (membersRouter as unknown as { stack: any[] }).stack) {
    const route = layer.route;
    if (
      route &&
      route.path === "/:docId/members/:uid" &&
      route.methods?.delete
    ) {
      return route.stack[route.stack.length - 1].handle as (
        req: unknown,
        res: unknown,
      ) => Promise<void>;
    }
  }
  throw new Error("delete-member handler not found");
}

// Request carrying the authenticated caller's octo token (set by authMiddleware
// as req.octoToken) so we can assert it is threaded into getUser.
function req(
  body: Record<string, unknown>,
  octoToken = "caller-session-token",
) {
  return {
    uid: "u_admin",
    spaceId: "s1",
    principalSpaceId: "s1",
    octoToken,
    params: { docId: "d_1" },
    body,
  } as never;
}

// A stub identity whose getUser resolves only known uids; records the args it
// was called with so we can assert the caller token is forwarded.
function stubIdentity(
  known: Record<string, OctoUser>,
  spaceBots: OctoSpaceBot[] | null = [],
) {
  const getUser = vi.fn(
    async (uid: string, _callerToken?: string): Promise<OctoUser | null> => {
      return known[uid] ?? null;
    },
  );
  const roster = Object.values(known).map((user) => ({
    uid: user.uid,
    isBot: false,
  }));
  const identity: OctoIdentity = {
    verifyToken: vi.fn(async () => null),
    verifyApiKey: vi.fn(async () => null),
    getUser,
    lookupSpacePrincipalAsBot: vi.fn(async () => ({ status: "not_found" })),
    getUsers: vi.fn(async () => []),
    spaceMembers: vi.fn(async () => roster),
    spaceBots: vi.fn(async () => spaceBots),
  };
  setOctoIdentity(identity);
  return getUser;
}

beforeEach(() => {
  vi.mocked(requireDocRole).mockReset();
  vi.mocked(docMemberRepo.upsertDirect).mockClear();
  vi.mocked(docMemberRepo.upsertDirectWithNotification).mockReset();
  vi.mocked(docMemberRepo.upsertDirectWithNotification).mockResolvedValue({ created: true });
  vi.mocked(docMemberRepo.updateExistingDirect).mockReset();
  vi.mocked(docMemberRepo.updateExistingDirect).mockResolvedValue(true);
  vi.mocked(docMemberRepo.removePrincipalExact).mockReset();
  vi.mocked(docMemberRepo.removePrincipalExact).mockResolvedValue({
    changed: true,
    removedUids: [],
    newEpoch: 2,
  });
  vi.mocked(docMemberRepo.removePrincipalWithBots).mockReset();
  vi.mocked(docMemberRepo.removePrincipalWithBots).mockResolvedValue({
    changed: true,
    removedUids: [],
    newEpoch: 2,
  });
  vi.mocked(refreshAndPublish).mockReset();
  vi.mocked(requireDocRole).mockResolvedValue({
    meta: {
      doc_id: "d_1",
      document_name: "doc-d_1",
      space_id: "s1",
      owner_id: "u_admin",
      owner_space_id: "s1",
      doc_type: "html",
    },
    role: "admin",
  } as never);
});

describe("PUT /api/v1/docs/:docId/members — anti ghost-member check", () => {
  it("add member with a resolvable uid -> 200 ok", async () => {
    stubIdentity({ u_real: { uid: "u_real", name: "Real User" } });
    const res = mockRes();
    await putMemberHandler()(
      req({ uid: "u_real", role: "writer" }),
      res as never,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, created: true, notified: true });
    expect(vi.mocked(docMemberRepo.upsertDirectWithNotification)).toHaveBeenCalledTimes(1);
    // The doc guard is scoped to req.spaceId (4th arg).
    expect(vi.mocked(requireDocRole).mock.calls[0]![3]).toBe("admin");
  });

  it("reports an existing member role edit without notifying again", async () => {
    stubIdentity({ u_real: { uid: "u_real", name: "Real User" } });
    vi.mocked(docMemberRepo.upsertDirectWithNotification).mockResolvedValueOnce({ created: false });
    const res = mockRes();

    await putMemberHandler()(req({ uid: "u_real", role: "reader" }), res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, created: false, notified: false });
  });

  it("does not create a notification when the exact document owner is added", async () => {
    stubIdentity({ u_admin: { uid: "u_admin", name: "Owner" } });
    const res = mockRes();

    await putMemberHandler()(
      req({ uid: "u_admin", role: "writer" }),
      res as never,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(docMemberRepo.upsertDirectWithNotification).not.toHaveBeenCalled();
    expect(docMemberRepo.upsertDirect).toHaveBeenCalledTimes(1);
  });

  it("add member with role=commenter -> 200 ok (commentable tier assignable)", async () => {
    stubIdentity({ u_real: { uid: "u_real", name: "Real User" } });
    const res = mockRes();
    await putMemberHandler()(
      req({ uid: "u_real", role: "commenter" }),
      res as never,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, created: true, notified: true });
    // commenter stored value is 4 (rank ordinal != stored number).
    expect(
      vi.mocked(docMemberRepo.upsertDirectWithNotification).mock.calls.at(-1)![0],
    ).toMatchObject({ roleNum: 4 });
  });

  it("supports commenter on a non-HTML document", async () => {
    vi.mocked(requireDocRole).mockResolvedValue({
      meta: {
        doc_id: "d_1",
        document_name: "doc-d_1",
        owner_id: "u_admin",
        doc_type: "doc",
      },
      role: "admin",
    } as never);
    stubIdentity({ u_real: { uid: "u_real", name: "Real User" } });
    const res = mockRes();
    await putMemberHandler()(
      req({ uid: "u_real", role: "commenter" }),
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(docMemberRepo.upsertDirectWithNotification)).toHaveBeenCalledWith(
      expect.objectContaining({ roleNum: 4 }),
    );
  });

  it("rejects an unknown role -> 400", async () => {
    stubIdentity({ u_real: { uid: "u_real", name: "Real User" } });
    const res = mockRes();
    await putMemberHandler()(
      req({ uid: "u_real", role: "superuser" }),
      res as never,
    );

    expect(res.statusCode).toBe(400);
    expect(vi.mocked(docMemberRepo.upsertDirect)).not.toHaveBeenCalled();
  });

  it("add member with an unresolvable uid -> 404 user_not_found", async () => {
    stubIdentity({});
    const res = mockRes();
    await putMemberHandler()(
      req({ uid: "u_ghost", role: "writer" }),
      res as never,
    );

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "principal_not_in_space" });
    expect(vi.mocked(docMemberRepo.upsertDirect)).not.toHaveBeenCalled();
  });

  it("validates the target against the exact requested Space using the caller token", async () => {
    const spaceMembers = vi.fn(async () => [{ uid: "u_real", isBot: false }]);
    setOctoIdentity({
      verifyToken: vi.fn(async () => null),
      getUser: vi.fn(async () => null),
      getUsers: vi.fn(async () => []),
      spaceMembers,
      spaceBots: vi.fn(async () => []),
    } as never);
    const res = mockRes();
    await putMemberHandler()(
      req(
        { uid: "u_real", principalSpaceId: "s_target", role: "reader" },
        "tok-xyz",
      ),
      res as never,
    );

    expect(res.statusCode).toBe(200);
    expect(spaceMembers).toHaveBeenCalledWith("s_target", "tok-xyz");
    expect(docMemberRepo.updateExistingDirect).toHaveBeenCalledWith(
      expect.objectContaining({ uid: "u_real", principalSpaceId: "s_target" }),
    );
  });

  it("precisely updates an existing non-home-Space principal without upserting", async () => {
    vi.mocked(requireDocRole).mockResolvedValue({
      meta: {
        doc_id: "d_1",
        document_name: "doc-d_1",
        space_id: "s_home",
        owner_id: "same_uid",
        owner_space_id: "s_home",
        doc_type: "doc",
      },
      role: "admin",
    } as never);
    stubIdentity({ same_uid: { uid: "same_uid", name: "Same User" } });
    vi.mocked(docMemberRepo.updateExistingDirect).mockResolvedValue(true);
    const res = mockRes();

    await putMemberHandler()(
      req({ uid: "same_uid", principalSpaceId: "s_other", role: "writer" }),
      res as never,
    );

    expect(res.statusCode).toBe(200);
    expect(docMemberRepo.updateExistingDirect).toHaveBeenCalledWith({
      docId: "d_1",
      uid: "same_uid",
      principalSpaceId: "s_other",
      roleNum: 2,
      grantedBy: "u_admin",
      notifyRecipient: true,
    });
    expect(docMemberRepo.upsertDirect).not.toHaveBeenCalled();
  });

  it("cannot create a missing non-home-Space principal through PUT", async () => {
    vi.mocked(requireDocRole).mockResolvedValue({
      meta: {
        doc_id: "d_1",
        document_name: "doc-d_1",
        space_id: "s_home",
        owner_id: "u_admin",
        owner_space_id: "s_home",
        doc_type: "doc",
      },
      role: "admin",
    } as never);
    stubIdentity({ u_real: { uid: "u_real", name: "Real User" } });
    vi.mocked(docMemberRepo.updateExistingDirect).mockResolvedValue(false);
    const res = mockRes();

    await putMemberHandler()(
      req({ uid: "u_real", principalSpaceId: "s_missing", role: "writer" }),
      res as never,
    );

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "member_not_found" });
    expect(docMemberRepo.upsertDirect).not.toHaveBeenCalled();
  });

  it("rejects a globally valid Human that is absent from the requested Space", async () => {
    const spaceMembers = vi.fn(async () => [
      { uid: "other-human", isBot: false },
    ]);
    setOctoIdentity({
      verifyToken: vi.fn(async () => null),
      getUser: vi.fn(async () => ({ uid: "u_real", name: "Real User" })),
      getUsers: vi.fn(async () => []),
      spaceMembers,
      spaceBots: vi.fn(async () => []),
    } as never);
    const res = mockRes();
    await putMemberHandler()(
      req({ uid: "u_real", role: "reader" }),
      res as never,
    );
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "principal_not_in_space" });
    expect(docMemberRepo.upsertDirect).not.toHaveBeenCalled();
  });

  it("accepts a Space Bot omitted from the Human roster when its owner is in that Space", async () => {
    setOctoIdentity({
      verifyToken: vi.fn(async () => null),
      getUsers: vi.fn(async () => []),
      // Real Octo deployments may omit robot rows from this Human roster.
      spaceMembers: vi.fn(async () => [{ uid: "u_owner", isBot: false }]),
      spaceBots: vi.fn(async () => [{ uid: "bot_1", creatorUid: "u_owner" }]),
    } as never);
    const res = mockRes();
    await putMemberHandler()(
      req({ uid: "bot_1", role: "reader" }),
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect(docMemberRepo.upsertDirect).toHaveBeenCalledWith(
      expect.objectContaining({ uid: "bot_1", principalSpaceId: "s1" }),
    );
  });

  it("accepts a Bot only when its same-Space owner is an authoritative Human member", async () => {
    setOctoIdentity({
      verifyToken: vi.fn(async () => null),
      getUsers: vi.fn(async () => []),
      spaceMembers: vi.fn(async () => [
        { uid: "u_owner", isBot: false },
        { uid: "bot_1", isBot: true },
      ]),
      spaceBots: vi.fn(async () => [{ uid: "bot_1", creatorUid: "u_owner" }]),
    } as never);
    const res = mockRes();
    await putMemberHandler()(
      req({ uid: "bot_1", role: "reader" }),
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect(docMemberRepo.upsertDirect).toHaveBeenCalledWith(
      expect.objectContaining({ uid: "bot_1", principalSpaceId: "s1" }),
    );
  });

  it.each([
    [
      "missing directory row",
      [],
      [
        { uid: "u_owner", isBot: false },
        { uid: "bot_1", isBot: true },
      ],
    ],
    ["missing owner", [{ uid: "bot_1" }], [{ uid: "bot_1", isBot: true }]],
    [
      "owner outside Space",
      [{ uid: "bot_1", creatorUid: "u_owner" }],
      [{ uid: "bot_1", isBot: true }],
    ],
  ])(
    "rejects a Bot with invalid same-Space ownership: %s",
    async (_label, bots, roster) => {
      setOctoIdentity({
        verifyToken: vi.fn(async () => null),
        getUsers: vi.fn(async () => []),
        spaceMembers: vi.fn(async () => roster),
        spaceBots: vi.fn(async () => bots),
      } as never);
      const res = mockRes();
      await putMemberHandler()(
        req({ uid: "bot_1", role: "reader" }),
        res as never,
      );
      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ error: "principal_not_in_space" });
      expect(docMemberRepo.upsertDirect).not.toHaveBeenCalled();
    },
  );

  it("fails closed when the authoritative roster is unavailable", async () => {
    setOctoIdentity({
      verifyToken: vi.fn(async () => null),
      getUsers: vi.fn(async () => []),
      spaceMembers: vi.fn(async () => null),
      spaceBots: vi.fn(async () => []),
    } as never);
    const res = mockRes();
    await putMemberHandler()(
      req({ uid: "u_real", role: "reader" }),
      res as never,
    );
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: "identity_directory_unavailable" });
    expect(docMemberRepo.upsertDirect).not.toHaveBeenCalled();
  });
});

// GET list-members synthesizes the implicit owner (§4.2). The owner is an
// implicit admin with no doc_member row, so a plain listing omitted it and
// disagreed with `docs get` (which reports ownerId). The handler now prepends a
// synthesized owner item {role:'admin', source:'owner', grantedBy:null} and
// dedups any doc_member row for the same owner_id. doc and sheet share this
// endpoint, so both are covered by driving the same handler with each doc_type.
function getReq(docId = "d_1") {
  return { uid: "u_admin", spaceId: "s1", params: { docId } } as never;
}

// Point the guard at a specific owner_id + doc_type for one GET call.
function guardWithOwner(ownerId: string, docType = "doc") {
  vi.mocked(requireDocRole).mockResolvedValue({
    meta: {
      doc_id: "d_1",
      document_name: "doc-d_1",
      space_id: "s_home",
      owner_id: ownerId,
      owner_space_id: "s_home",
      doc_type: docType,
    },
    role: "admin",
  } as never);
}

describe("GET /api/v1/docs/:docId/members — synthesized owner row", () => {
  // Each case runs for a document AND a sheet (shared endpoint => identical
  // behavior); the parity assertion is the doc/sheet double-coverage.
  const docTypes = ["doc", "sheet"];

  it("includes the owner (role=admin, source=owner) when there are no other members", async () => {
    for (const docType of docTypes) {
      guardWithOwner("u_owner", docType);
      vi.mocked(docMemberRepo.list).mockResolvedValue([] as never);
      const res = mockRes();
      await getMembersHandler()(getReq(), res as never);

      expect(res.statusCode).toBe(200);
      expect((res.body as { items: unknown[] }).items).toEqual([
        {
          uid: "u_owner",
          principalSpaceId: "s_home",
          role: "admin",
          source: "owner",
          grantedBy: null,
        },
      ]);
    }
  });

  it("dedups an owner that also has a doc_member row into a single admin/owner item", async () => {
    for (const docType of docTypes) {
      guardWithOwner("u_owner", docType);
      // Historical PUT upserted the owner as a writer direct row — must NOT
      // surface as a second item, and must stay admin (owner not downgradable).
      vi.mocked(docMemberRepo.list).mockResolvedValue([
        {
          uid: "u_owner",
          principal_space_id: "s_home",
          role: 2,
          source: 1,
          granted_by: "u_owner",
        },
      ] as never);
      const res = mockRes();
      await getMembersHandler()(getReq(), res as never);

      expect(res.statusCode).toBe(200);
      const items = (res.body as { items: Array<{ uid: string }> }).items;
      expect(items).toEqual([
        {
          uid: "u_owner",
          principalSpaceId: "s_home",
          role: "admin",
          source: "owner",
          grantedBy: null,
        },
      ]);
      expect(items.filter((i) => i.uid === "u_owner")).toHaveLength(1);
    }
  });

  it("keeps direct/invite members alongside the owner without dropping or duplicating them", async () => {
    for (const docType of docTypes) {
      guardWithOwner("u_owner", docType);
      vi.mocked(docMemberRepo.list).mockResolvedValue([
        {
          uid: "u_writer",
          principal_space_id: "s_home",
          role: 2,
          source: 1,
          granted_by: "u_owner",
        }, // direct writer
        {
          uid: "u_commenter",
          principal_space_id: "s_home",
          role: 4,
          source: 1,
          granted_by: "u_owner",
        }, // direct commenter (stored 4)
        {
          uid: "u_reader",
          principal_space_id: "s_home",
          role: 1,
          source: 2,
          granted_by: "u_admin",
        }, // invite reader
      ] as never);
      const res = mockRes();
      await getMembersHandler()(getReq(), res as never);

      expect(res.statusCode).toBe(200);
      expect((res.body as { items: unknown[] }).items).toEqual([
        {
          uid: "u_owner",
          principalSpaceId: "s_home",
          role: "admin",
          source: "owner",
          grantedBy: null,
        },
        {
          uid: "u_writer",
          principalSpaceId: "s_home",
          role: "writer",
          source: "direct",
          grantedBy: "u_owner",
        },
        {
          uid: "u_commenter",
          principalSpaceId: "s_home",
          role: "commenter",
          source: "direct",
          grantedBy: "u_owner",
        },
        {
          uid: "u_reader",
          principalSpaceId: "s_home",
          role: "reader",
          source: "invite",
          grantedBy: "u_admin",
        },
      ]);
    }
  });

  it("keeps a same-uid grant from another Space instead of filtering it as the owner", async () => {
    guardWithOwner("u_owner");
    vi.mocked(docMemberRepo.list).mockResolvedValue([
      {
        uid: "u_owner",
        principal_space_id: "s_home",
        role: 2,
        source: 1,
        granted_by: "u_owner",
      },
      {
        uid: "u_owner",
        principal_space_id: "s_other",
        role: 1,
        source: 1,
        granted_by: "u_admin",
      },
    ] as never);
    const res = mockRes();
    await getMembersHandler()(getReq(), res as never);

    expect(res.statusCode).toBe(200);
    expect((res.body as { items: unknown[] }).items).toEqual([
      {
        uid: "u_owner",
        principalSpaceId: "s_home",
        role: "admin",
        source: "owner",
        grantedBy: null,
      },
      {
        uid: "u_owner",
        principalSpaceId: "s_other",
        role: "reader",
        source: "direct",
        grantedBy: "u_admin",
      },
    ]);
  });

  it("lists two same-uid Spaces then updates only the existing non-owner principal", async () => {
    guardWithOwner("same_uid");
    const rows = [
      {
        uid: "same_uid",
        principal_space_id: "s_home",
        role: 3,
        source: 1,
        granted_by: "same_uid",
      },
      {
        uid: "same_uid",
        principal_space_id: "s_other",
        role: 1,
        source: 1,
        granted_by: "u_admin",
      },
    ];
    vi.mocked(docMemberRepo.list).mockImplementation(async () => rows as never);
    vi.mocked(docMemberRepo.updateExistingDirect).mockImplementation(
      async (write) => {
        const row = rows.find(
          (candidate) =>
            candidate.uid === write.uid &&
            candidate.principal_space_id === write.principalSpaceId,
        );
        if (!row) return false;
        row.role = write.roleNum;
        row.granted_by = write.grantedBy;
        return true;
      },
    );
    stubIdentity({ same_uid: { uid: "same_uid", name: "Same User" } });

    const before = mockRes();
    await getMembersHandler()(getReq(), before as never);
    expect(
      (
        before.body as {
          items: Array<{ uid: string; principalSpaceId: string; role: string }>;
        }
      ).items,
    ).toEqual([
      {
        uid: "same_uid",
        principalSpaceId: "s_home",
        role: "admin",
        source: "owner",
        grantedBy: null,
      },
      {
        uid: "same_uid",
        principalSpaceId: "s_other",
        role: "reader",
        source: "direct",
        grantedBy: "u_admin",
      },
    ]);

    const update = mockRes();
    await putMemberHandler()(
      req({ uid: "same_uid", principalSpaceId: "s_other", role: "writer" }),
      update as never,
    );
    expect(update.statusCode).toBe(200);

    const after = mockRes();
    await getMembersHandler()(getReq(), after as never);
    expect(
      (
        after.body as {
          items: Array<{ uid: string; principalSpaceId: string; role: string }>;
        }
      ).items,
    ).toEqual([
      {
        uid: "same_uid",
        principalSpaceId: "s_home",
        role: "admin",
        source: "owner",
        grantedBy: null,
      },
      {
        uid: "same_uid",
        principalSpaceId: "s_other",
        role: "writer",
        source: "direct",
        grantedBy: "u_admin",
      },
    ]);
    expect(docMemberRepo.updateExistingDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        uid: "same_uid",
        principalSpaceId: "s_other",
        roleNum: 2,
      }),
    );
    expect(docMemberRepo.upsertDirect).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/v1/docs/:docId/members/:uid — Human creator Bot cascade", () => {
  function deleteReq(
    uid: string,
    principalSpaceId = "s_home",
    octoToken = "caller-token",
  ) {
    return {
      uid: "u_admin",
      octoToken,
      params: { docId: "d_1", uid },
      query: { principalSpaceId },
    } as never;
  }

  beforeEach(() => {
    vi.mocked(requireDocRole).mockResolvedValue({
      meta: {
        doc_id: "d_1",
        document_name: "doc-d_1",
        space_id: "s_home",
        owner_id: "u_owner",
        owner_space_id: "s_home",
        doc_type: "doc",
      },
      role: "admin",
    } as never);
  });

  it("uses req.octoToken to remove a Human and their authorized same-Space Bots", async () => {
    stubIdentity({}, [
      { uid: "bot_a", creatorUid: "u_human" },
      { uid: "bot_b", creatorUid: "u_human" },
      { uid: "bot_other", creatorUid: "u_other" },
    ]);
    const identity = getOctoIdentity();
    vi.mocked(docMemberRepo.removePrincipalWithBots).mockResolvedValue({
      changed: true,
      removedUids: ["u_human", "bot_a", "bot_b"],
      newEpoch: 8,
    });
    const res = mockRes();

    await deleteMemberHandler()(deleteReq("u_human"), res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      removedUids: ["u_human", "bot_a", "bot_b"],
    });
    expect(identity.spaceBots).toHaveBeenCalledWith("s_home", "caller-token");
    expect(docMemberRepo.removePrincipalWithBots).toHaveBeenCalledWith({
      docId: "d_1",
      uid: "u_human",
      principalSpaceId: "s_home",
      botUids: ["bot_a", "bot_b"],
      notifyFromUid: "u_admin",
    });
    expect(docMemberRepo.removePrincipalExact).not.toHaveBeenCalled();
    expect(refreshAndPublish).toHaveBeenCalledWith("doc-d_1", 8);
  });

  it("removes an explicitly targeted Bot without cascading sibling Bots", async () => {
    stubIdentity({}, [
      { uid: "bot_a", creatorUid: "u_human" },
      { uid: "bot_b", creatorUid: "u_human" },
    ]);
    const res = mockRes();

    await deleteMemberHandler()(deleteReq("bot_a"), res as never);

    expect(res.statusCode).toBe(200);
    expect(docMemberRepo.removePrincipalWithBots).toHaveBeenCalledWith({
      docId: "d_1", uid: "bot_a", principalSpaceId: "s_home", botUids: [],
    });
  });

  it("does not read OCTO_SERVER_TOKEN and fails closed without req.octoToken", async () => {
    stubIdentity({}, []);
    const identity = getOctoIdentity();
    const res = mockRes();

    await deleteMemberHandler()(deleteReq("u_human", "s_home", ""), res as never);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: "bot_directory_unavailable" });
    expect(identity.spaceBots).not.toHaveBeenCalled();
    expect(docMemberRepo.removePrincipalWithBots).not.toHaveBeenCalled();
  });

  it("fails closed before writes when the Human Bot directory is unavailable", async () => {
    stubIdentity({}, null);
    const res = mockRes();

    await deleteMemberHandler()(deleteReq("u_human"), res as never);

    expect(res.statusCode).toBe(503);
    expect(docMemberRepo.removePrincipalWithBots).not.toHaveBeenCalled();
    expect(refreshAndPublish).not.toHaveBeenCalled();
  });

  it("is idempotent and does not publish when no authorized row exists", async () => {
    stubIdentity({}, []);
    vi.mocked(docMemberRepo.removePrincipalWithBots).mockResolvedValue({
      changed: false, removedUids: [],
    });
    const res = mockRes();

    await deleteMemberHandler()(deleteReq("missing"), res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, removedUids: [] });
    expect(refreshAndPublish).not.toHaveBeenCalled();
  });

  it("protects the Space-qualified owner before loading the Bot directory", async () => {
    stubIdentity({}, null);
    const res = mockRes();

    await deleteMemberHandler()(deleteReq("u_owner"), res as never);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: "owner_cannot_be_removed" });
    expect(docMemberRepo.removePrincipalWithBots).not.toHaveBeenCalled();
  });

  it("protects the authenticated compound principal from self-removal", async () => {
    stubIdentity({}, null);
    const req = deleteReq("u_admin") as unknown as {
      principalSpaceId?: string;
    };
    req.principalSpaceId = "s_home";
    const res = mockRes();

    await deleteMemberHandler()(req as never, res as never);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: "self_cannot_be_removed" });
    expect(docMemberRepo.removePrincipalWithBots).not.toHaveBeenCalled();
    expect(refreshAndPublish).not.toHaveBeenCalled();
  });

  it("does not confuse the same uid in another principal Space with self", async () => {
    stubIdentity({}, []);
    const req = deleteReq("u_admin", "s_other") as unknown as {
      principalSpaceId?: string;
    };
    req.principalSpaceId = "s_home";
    const res = mockRes();

    await deleteMemberHandler()(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(docMemberRepo.removePrincipalWithBots).toHaveBeenCalledWith({
      docId: "d_1",
      uid: "u_admin",
      principalSpaceId: "s_other",
      botUids: [],
      notifyFromUid: "u_admin",
    });
  });
});


// Collaborators may read the roster for the @Bot picker, while management metadata stays admin-only.
describe("GET /api/v1/docs/:docId/members — readable by collaborators, grantedBy admin-only", () => {
  function guardWithRole(role: string) {
    vi.mocked(requireDocRole).mockResolvedValue({
      meta: {
        doc_id: "d_1", document_name: "doc-d_1", space_id: "s_home",
        owner_id: "u_owner", owner_space_id: "s_home", doc_type: "doc",
      },
      role,
    } as never);
  }

  it("gates on reader, not admin", async () => {
    guardWithRole("writer");
    vi.mocked(docMemberRepo.list).mockResolvedValue([] as never);
    await getMembersHandler()(getReq(), mockRes() as never);
    expect(vi.mocked(requireDocRole).mock.calls.at(-1)?.[3]).toBe("reader");
  });

  it("returns Space-qualified roles but hides grantedBy from non-admins", async () => {
    const rows = [{
      uid: "bot_1", principal_space_id: "s_home", role: 2, source: 1, granted_by: "u_owner",
    }];
    guardWithRole("writer");
    vi.mocked(docMemberRepo.list).mockResolvedValue(rows as never);
    const asWriter = mockRes();
    await getMembersHandler()(getReq(), asWriter as never);
    expect((asWriter.body as { items: unknown[] }).items).toContainEqual({
      uid: "bot_1", principalSpaceId: "s_home", role: "writer", source: "direct", grantedBy: null,
    });

    guardWithRole("admin");
    vi.mocked(docMemberRepo.list).mockResolvedValue(rows as never);
    const asAdmin = mockRes();
    await getMembersHandler()(getReq(), asAdmin as never);
    expect((asAdmin.body as { items: unknown[] }).items).toContainEqual({
      uid: "bot_1", principalSpaceId: "s_home", role: "writer", source: "direct", grantedBy: "u_owner",
    });
  });
});
