/** Credential resolution, scopes, roles and rate limits through real admin endpoints. */
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

async function world() {
  const owner = await createUser();
  const site = await createSite(owner.id, { domain: "a.example.com" });
  const other = await createSite(owner.id, { domain: "b.example.com" });
  return { owner, site, other };
}

describe("Bearer credentials", () => {
  it("rejects malformed, unknown, revoked and expired credentials with 401", async () => {
    const { owner } = await world();
    expect(
      (await api("/api/v1/admin/account", { headers: { authorization: "Token x" } })).status,
    ).toBe(401);
    expect((await api("/api/v1/admin/account", { token: "dft_unknown" })).status).toBe(401);
    expect((await api("/api/v1/admin/account", { token: "sk_live_x" })).status).toBe(401);
    const expired = await createApiKey({ userId: owner.id, expiresAt: Date.now() - 1 });
    expect((await api("/api/v1/admin/account", { token: expired.secret })).status).toBe(401);
    const revoked = await createApiKey({ userId: owner.id });
    await env.DB.prepare("UPDATE api_keys SET revoked_at = 1 WHERE id = ?").bind(revoked.id).run();
    expect((await api("/api/v1/admin/account", { token: revoked.secret })).status).toBe(401);
    expect((await api("/api/v1/admin/account")).status).toBe(401);
  });

  it("issues dg_ / dgt_ secrets and still accepts df_ / dft_ ones made before the rename", async () => {
    const { owner, site } = await world();
    const fresh = await createApiKey({ userId: owner.id, siteId: site.id });
    expect(fresh.secret).toMatch(/^dg_/);
    expect((await createApiKey({ userId: owner.id })).secret).toMatch(/^dgt_/);
    const legacyKey = await createApiKey({
      userId: owner.id,
      siteId: site.id,
      secret: `df_${"a".repeat(40)}`,
    });
    const own = await api(`/api/v1/admin/websites/${site.id}`, { token: legacyKey.secret });
    expect(own.status).toBe(200);
    expect(own.body.data[0]).toMatchObject({ _id: site.id, role: "member" });
    const legacyToken = await createApiKey({ userId: owner.id, secret: `dft_${"b".repeat(40)}` });
    expect((await api("/api/v1/admin/account", { token: legacyToken.secret })).status).toBe(200);
  });

  it("df_ keys infer their website and cannot reach another one", async () => {
    const { owner, site, other } = await world();
    const key = await createApiKey({ userId: owner.id, siteId: site.id });
    const own = await api(`/api/v1/admin/websites/${site.id}`, { token: key.secret });
    expect(own.status).toBe(200);
    expect(own.body.data[0]).toMatchObject({ _id: site.id, role: "member" });
    expect((await api(`/api/v1/admin/websites/${other.id}`, { token: key.secret })).status).toBe(
      403,
    );
    const account = await api("/api/v1/admin/account", { token: key.secret });
    expect(account.body.data[0].websiteId).toBe(site.id);
    const list = await api("/api/v1/admin/websites", { token: key.secret });
    expect(list.body.data.map((w: { _id: string }) => w._id)).toEqual([site.id]);
  });

  it("df_ keys are capped at member and blocked from account-level and owner-only routes", async () => {
    const { owner, site } = await world();
    const key = await createApiKey({ userId: owner.id, siteId: site.id });
    expect((await api("/api/v1/admin/access-tokens", { token: key.secret })).status).toBe(403);
    expect(
      (
        await api("/api/v1/admin/websites", {
          token: key.secret,
          body: { domain: "c.example.com", timezone: "UTC" },
        })
      ).status,
    ).toBe(403);
    const invite = await api(`/api/v1/admin/websites/${site.id}/team`, {
      token: key.secret,
      body: { email: "x@example.com" },
    });
    expect(invite.status).toBe(403);
    const update = await api(`/api/v1/admin/websites/${site.id}`, {
      method: "PUT",
      token: key.secret,
      body: { name: "Via key" },
    });
    expect(update.status).toBe(200);
  });

  it("df_ keys stop working when their creator loses access", async () => {
    const { owner, site } = await world();
    const member = await createUser();
    await addMember(site.id, member.id, "member");
    const key = await createApiKey({ userId: member.id, siteId: site.id });
    expect((await api(`/api/v1/admin/websites/${site.id}`, { token: key.secret })).status).toBe(
      200,
    );
    const cookie = await sessionCookie(owner.id);
    expect(
      (
        await api(`/api/v1/admin/websites/${site.id}/team`, {
          method: "DELETE",
          cookie,
          body: { userId: member.id },
        })
      ).status,
    ).toBe(200);
    expect((await api(`/api/v1/admin/websites/${site.id}`, { token: key.secret })).status).toBe(
      401,
    );
  });

  it("dft_ tokens need websiteId, the permission, the allowlist and a membership", async () => {
    const { owner, site, other } = await world();
    const readOnly = await createApiKey({
      userId: owner.id,
      permissions: ["settings:read"],
      websiteIds: [site.id],
    });
    expect(
      (await api(`/api/v1/admin/websites/${site.id}`, { token: readOnly.secret })).status,
    ).toBe(200);
    expect(
      (await api(`/api/v1/admin/websites/${other.id}`, { token: readOnly.secret })).status,
    ).toBe(403);
    const write = await api(`/api/v1/admin/websites/${site.id}`, {
      method: "PUT",
      token: readOnly.secret,
      body: { name: "x" },
    });
    expect(write.status).toBe(403);
    expect(write.body.error.message).toBe("Missing permission: settings:write");
    const stranger = await createUser();
    const strangerToken = await createApiKey({ userId: stranger.id });
    expect(
      (await api(`/api/v1/admin/websites/${site.id}`, { token: strangerToken.secret })).status,
    ).toBe(404);
    expect(
      (await api("/api/v1/admin/websites/doesnotexist", { token: strangerToken.secret })).status,
    ).toBe(404);
  });

  it("accepts the public tracking id wherever a websiteId is expected", async () => {
    const { owner, site } = await world();
    const token = await createApiKey({ userId: owner.id });
    expect(
      (await api(`/api/v1/admin/websites/${site.publicId}`, { token: token.secret })).body.data[0]
        ._id,
    ).toBe(site.id);
  });

  it("applies roles: viewers read, members write settings, only owners manage the team", async () => {
    const { site } = await world();
    const viewer = await createUser();
    const member = await createUser();
    await addMember(site.id, viewer.id, "viewer");
    await addMember(site.id, member.id, "member");
    const vc = await sessionCookie(viewer.id);
    const mc = await sessionCookie(member.id);
    expect((await api(`/api/v1/admin/websites/${site.id}`, { cookie: vc })).status).toBe(200);
    expect(
      (
        await api(`/api/v1/admin/websites/${site.id}`, {
          method: "PUT",
          cookie: vc,
          body: { name: "v" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api(`/api/v1/admin/websites/${site.id}`, {
          method: "PUT",
          cookie: mc,
          body: { name: "m" },
        })
      ).status,
    ).toBe(200);
    expect((await api(`/api/v1/admin/websites/${site.id}/team`, { cookie: mc })).status).toBe(200);
    const invite = await api(`/api/v1/admin/websites/${site.id}/team`, {
      cookie: mc,
      body: { email: "x@example.com" },
    });
    expect(invite.status).toBe(403);
    expect(invite.body.error.message).toBe("Your role (member) does not allow team:write");
  });

  it("rejects cross-origin writes made with a session cookie but not with a Bearer token", async () => {
    const { owner, site } = await world();
    const cookie = await sessionCookie(owner.id);
    const evil = await api(`/api/v1/admin/websites/${site.id}`, {
      method: "PUT",
      cookie,
      origin: "https://evil.example",
      body: { name: "x" },
    });
    expect(evil.status).toBe(403);
    const token = await createApiKey({ userId: owner.id });
    const ok = await api(`/api/v1/admin/websites/${site.id}`, {
      method: "PUT",
      token: token.secret,
      origin: "https://evil.example",
      body: { name: "x" },
    });
    expect(ok.status).toBe(200);
  });
});

describe("API rate limiting", () => {
  it("sends X-RateLimit headers and answers 429 with DataFast's body after 60 requests a minute", async () => {
    const { owner } = await world();
    const token = await createApiKey({ userId: owner.id });
    const first = await api("/api/v1/admin/account", { token: token.secret });
    expect(first.headers.get("x-ratelimit-limit")).toBe("60");
    expect(first.headers.get("x-ratelimit-remaining")).toBe("59");
    expect(Number(first.headers.get("x-ratelimit-reset"))).toBeGreaterThan(Date.now() / 1000);
    let last = first;
    // Up to two 60-second windows: the limiter resets if the test straddles a minute boundary.
    for (let i = 0; i < 130 && last.status !== 429; i++)
      last = await api("/api/v1/admin/account", { token: token.secret });
    expect(last.status).toBe(429);
    expect(last.body).toMatchObject({ error: "Too many requests", limit: 60, remaining: 0 });
    expect(last.headers.get("x-ratelimit-remaining")).toBe("0");
    // Sessions are not limited.
    const cookie = await sessionCookie(owner.id);
    expect(
      (await api("/api/v1/admin/account", { cookie })).headers.get("x-ratelimit-limit"),
    ).toBeNull();
  });

  it("flushes key usage lazily instead of writing on every request", async () => {
    const { owner } = await world();
    const token = await createApiKey({ userId: owner.id });
    await api("/api/v1/admin/account", { token: token.secret });
    await api("/api/v1/admin/account", { token: token.secret });
    await new Promise((r) => setTimeout(r, 50));
    const row = await env.DB.prepare("SELECT usage_count, last_used_at FROM api_keys WHERE id = ?")
      .bind(token.id)
      .first<{ usage_count: number; last_used_at: number }>();
    expect(row?.usage_count).toBe(1);
    expect(row?.last_used_at).toBeGreaterThan(0);
  });
});
