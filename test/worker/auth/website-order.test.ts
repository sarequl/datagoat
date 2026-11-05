/**
 * Per-user website order (DataFast's "Reorder websites"): PUT /api/v1/admin/account/website-order
 * and the order of GET /api/v1/admin/websites and GET /api/auth/me.
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "../../helpers/db";
import {
  addMember,
  createApiKey,
  createSite,
  createUser,
  sessionCookie,
} from "../../helpers/factories";
import { api } from "../../helpers/http";

beforeEach(() => resetDb());

async function setup() {
  const user = await createUser();
  const a = await createSite(user.id, { domain: "a.example" });
  const b = await createSite(user.id, { domain: "b.example" });
  const c = await createSite(user.id, { domain: "c.example" });
  const cookie = await sessionCookie(user.id);
  return { user, a, b, c, cookie };
}

const domains = (rows: Array<{ domain: string }>) => rows.map((r) => r.domain);

describe("website order", () => {
  it("lists websites in creation order until the user reorders them", async () => {
    const { a, c, cookie } = await setup();
    expect(domains((await api("/api/v1/admin/websites", { cookie })).body.data)).toEqual([
      "a.example",
      "b.example",
      "c.example",
    ]);
    const res = await api("/api/v1/admin/account/website-order", {
      method: "PUT",
      cookie,
      body: { websiteIds: [c.id, a.publicId] },
    });
    expect(res.status).toBe(200);
    // Listed websites first (ids or tracking ids), the rest after them in their old order.
    expect(domains(res.body.data)).toEqual(["c.example", "a.example", "b.example"]);
    expect(domains((await api("/api/v1/admin/websites", { cookie })).body.data)).toEqual([
      "c.example",
      "a.example",
      "b.example",
    ]);
    expect(domains((await api("/api/auth/me", { cookie })).body.data.websites)).toEqual([
      "c.example",
      "a.example",
      "b.example",
    ]);
  });

  it("is per user and ignores websites the user cannot see", async () => {
    const { user, a, b, c, cookie } = await setup();
    const other = await createUser();
    await addMember(a.id, other.id, "viewer");
    await addMember(b.id, other.id, "viewer");
    const stranger = await createSite(other.id, { domain: "theirs.example" });
    await api("/api/v1/admin/account/website-order", {
      method: "PUT",
      cookie,
      body: { websiteIds: [b.id, stranger.id] },
    });
    const positions = await env.DB.prepare(
      "SELECT site_id, position FROM memberships WHERE user_id = ? ORDER BY position",
    )
      .bind(user.id)
      .all<{ site_id: string; position: number }>();
    expect(positions.results.map((r) => r.site_id)).toEqual([b.id, a.id, c.id]);
    // The other member keeps the default order.
    const theirs = await api("/api/v1/admin/websites", { cookie: await sessionCookie(other.id) });
    expect(domains(theirs.body.data)).toEqual(["a.example", "b.example", "theirs.example"]);
    const again = await api("/api/v1/admin/account/website-order", {
      method: "PUT",
      cookie,
      body: { websiteIds: [b.id, a.id, c.id] },
    });
    expect(domains(again.body.data)).toEqual(["b.example", "a.example", "c.example"]);
  });

  it("accepts account tokens, rejects website keys and validates the body", async () => {
    const { user, a, cookie } = await setup();
    const token = await createApiKey({ userId: user.id, permissions: ["websites:read"] });
    const ok = await api("/api/v1/admin/account/website-order", {
      method: "PUT",
      token: token.secret,
      body: { websiteIds: [a.id] },
    });
    expect(ok.status).toBe(200);
    const key = await createApiKey({ userId: user.id, siteId: a.id });
    const denied = await api("/api/v1/admin/account/website-order", {
      method: "PUT",
      token: key.secret,
      body: { websiteIds: [a.id] },
    });
    expect(denied.status).toBe(403);
    const bad = await api("/api/v1/admin/account/website-order", {
      method: "PUT",
      cookie,
      body: { websiteIds: [] },
    });
    expect(bad.status).toBe(400);
  });
});
