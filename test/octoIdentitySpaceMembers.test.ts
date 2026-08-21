import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpOctoIdentity } from "../src/auth/octoIdentity.js";

afterEach(() => vi.restoreAllMocks());

describe("HttpOctoIdentity.spaceMembers", () => {
  it("reads and classifies the authoritative Space roster", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          { uid: "human-1", robot: 0 },
          { uid: "bot-1", robot: 1 },
        ]),
        { status: 200 },
      ),
    );
    await expect(
      new HttpOctoIdentity("http://octo.test").spaceMembers("s/1", "tok"),
    ).resolves.toEqual([
      { uid: "human-1", isBot: false },
      { uid: "bot-1", isBot: true },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://octo.test/v1/space/s%2F1/members?page=1&limit=10000",
      { headers: { token: "tok" } },
    );
  });

  it.each([
    ["non-array", {}],
    ["missing uid", [{ robot: 0 }]],
    ["invalid robot", [{ uid: "u1", robot: 2 }]],
    [
      "conflicting duplicate",
      [
        { uid: "u1", robot: 0 },
        { uid: "u1", robot: 1 },
      ],
    ],
  ])("fails closed on %s", async (_label, body) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200 }),
    );
    await expect(
      new HttpOctoIdentity("http://octo.test").spaceMembers("s1", "tok"),
    ).resolves.toBeNull();
  });

  it("fails closed on transport and non-OK responses", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("offline"));
    await expect(
      new HttpOctoIdentity("http://octo.test").spaceMembers("s1", "tok"),
    ).resolves.toBeNull();
    fetchMock.mockResolvedValueOnce(new Response("", { status: 503 }));
    await expect(
      new HttpOctoIdentity("http://octo.test").spaceMembers("s1", "tok"),
    ).resolves.toBeNull();
  });
});
