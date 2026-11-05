import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../../src/lib/crypto";
import { resetDb } from "../../helpers/db";
import {
  addMember,
  createApiKey,
  createSite,
  createUser,
  sessionCookie,
} from "../../helpers/factories";
import { api, cookieFrom } from "../../helpers/http";

beforeEach(() => resetDb());

describe("account", () => {
  it("returns and updates the account profile", async () => {
    const user = await createUser({ name: "Jane" });
    const token = await createApiKey({ userId: user.id, permissions: ["analytics:read"] });
    const res = await api("/api/v1/admin/account", { token: token.secret });
    expect(res.body.data[0]).toMatchObject({
      _id: user.id,
      email: user.email,
      name: "Jane",
      hasAccess: true,
      planType: "self_hosted",
    });
    const upd = await api("/api/v1/admin/account", {
      method: "PUT",
      token: token.secret,
      body: { name: "Jane Doe" },
    });
    expect(upd.body.data[0]).toMatchObject({ id: user.id, name: "Jane Doe" });
    expect(
      (
        await api("/api/v1/admin/account", {
          method: "PUT",
          token: token.secret,
          body: { name: "" },
        })
      ).status,
    ).toBe(400);
  });
});

describe("access tokens", () => {
  it("creates a token shown once, lists it masked, and deletes it", async () => {
    const user = await createUser();
    const site = await createSite(user.id);
    const cookie = await sessionCookie(user.id);
    const created = await api("/api/v1/admin/access-tokens", {
      cookie,
      body: {
        name: "Read only agent",
        permissions: ["analytics:read", "websites:read"],
        websiteIds: [site.id],
      },
    });
    expect(created.status).toBe(200);
    const token = created.body.data[0];
    expect(token.key).toMatch(/^dgt_[0-9A-Za-z]{40}$/);
    expect(token).toMatchObject({
      name: "Read only agent",
      scope: "user",
      websiteId: null,
      websiteIds: [site.id],
      usageCount: 0,
    });
    expect(token.displayKey).toMatch(/^dgt_.{3}\.\.\..{4}$/);
    const stored = await env.DB.prepare("SELECT key_hash FROM api_keys WHERE id = ?")
      .bind(token.id)
      .first<{ key_hash: string }>();
    expect(stored?.key_hash).toBe(await sha256Hex(token.key));

    const list = await api("/api/v1/admin/access-tokens", { cookie });
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].key).toBeUndefined();

    // The new token works and is limited to what it was granted.
    expect((await api("/api/v1/admin/websites", { token: token.key })).status).toBe(200);
    expect((await api("/api/v1/admin/access-tokens", { token: token.key })).status).toBe(403);

    expect(
      (await api(`/api/v1/admin/access-tokens/${token.id}`, { method: "DELETE", cookie })).status,
    ).toBe(200);
    expect((await api("/api/v1/admin/websites", { token: token.key })).status).toBe(401);
    expect(
      (await api(`/api/v1/admin/access-tokens/${token.id}`, { method: "DELETE", cookie })).status,
    ).toBe(404);
  });

  it("cannot widen the caller's permissions or website scope", async () => {
    const user = await createUser();
    const a = await createSite(user.id);
    const b = await createSite(user.id);
    const limited = await createApiKey({
      userId: user.id,
      permissions: ["api-keys:write", "analytics:read"],
      websiteIds: [a.id],
    });
    const wider = await api("/api/v1/admin/access-tokens", {
      token: limited.secret,
      body: { permissions: ["settings:write"], websiteIds: [a.id] },
    });
    expect(wider.status).toBe(403);
    const all = await api("/api/v1/admin/access-tokens", {
      token: limited.secret,
      body: { permissions: ["analytics:read"] },
    });
    expect(all.status).toBe(403);
    const otherSite = await api("/api/v1/admin/access-tokens", {
      token: limited.secret,
      body: { permissions: ["analytics:read"], websiteIds: [b.id] },
    });
    expect(otherSite.status).toBe(403);
    const ok = await api("/api/v1/admin/access-tokens", {
      token: limited.secret,
      body: { permissions: ["analytics:read"], websiteIds: [a.id] },
    });
    expect(ok.status).toBe(200);
  });

  it("validates permissions, website ids and the 20-token limit", async () => {
    const user = await createUser();
    const cookie = await sessionCookie(user.id);
    expect(
      (await api("/api/v1/admin/access-tokens", { cookie, body: { permissions: ["admin:all"] } }))
        .status,
    ).toBe(400);
    expect(
      (await api("/api/v1/admin/access-tokens", { cookie, body: { websiteIds: ["nope"] } })).status,
    ).toBe(400);
    for (let i = 0; i < 20; i++) await createApiKey({ userId: user.id });
    const over = await api("/api/v1/admin/access-tokens", { cookie, body: {} });
    expect(over.status).toBe(400);
    expect(over.body.error.message).toContain("max 20");
  });
});

describe("websites", () => {
  it("creates, lists, reads and updates websites", async () => {
    const user = await createUser();
    const token = await createApiKey({ userId: user.id });
    const created = await api("/api/v1/admin/websites", {
      token: token.secret,
      body: { domain: "Example.com", timezone: "America/New_York", name: "Example" },
    });
    expect(created.status).toBe(200);
    const { websiteId, trackingId } = created.body.data[0];
    expect(created.body.data[0].domain).toBe("example.com");
    const dup = await api("/api/v1/admin/websites", {
      token: token.secret,
      body: { domain: "example.com", timezone: "UTC" },
    });
    expect(dup.status).toBe(409);
    expect(
      (
        await api("/api/v1/admin/websites", {
          token: token.secret,
          body: { domain: "not a domain", timezone: "UTC" },
        })
      ).status,
    ).toBe(400);

    const list = await api("/api/v1/admin/websites", { token: token.secret });
    expect(list.body.data).toEqual([
      expect.objectContaining({
        _id: websiteId,
        domain: "example.com",
        trackingId,
        timezone: "America/New_York",
        currency: "USD",
        role: "owner",
      }),
    ]);

    const upd = await api(`/api/v1/admin/websites/${websiteId}`, {
      method: "PUT",
      token: token.secret,
      body: {
        currency: "eur",
        kpi: "Signup",
        isCookieless: true,
        isAttackModeEnabled: true,
        excludedIps: ["203.0.113.10", "10.0.0.0/8", "2001:db8::/32"],
        excludedPaths: ["/admin", "/admin/*"],
        excludedCountries: ["France", "de"],
        allowedHostnames: ["https://app.example.com/"],
        isPublicDashboardEnabled: true,
        attributionModel: "last_non_direct",
        retentionDays: 365,
      },
    });
    expect(upd.status).toBe(200);
    expect(upd.body.data[0]).toMatchObject({
      currency: "EUR",
      kpi: "signup",
      isCookieless: true,
      privacyMode: "cookieless",
      isAttackModeEnabled: true,
      botLevel: "strict",
      excludedCountries: ["FR", "DE"],
      allowedHostnames: ["app.example.com"],
      isPublicDashboardEnabled: true,
      attributionModel: "last_non_direct",
      retentionDays: 365,
    });
    expect(upd.body.data[0].shareToken).toMatch(/^[A-Za-z0-9_-]{24}$/);
    const read = await api(`/api/v1/admin/websites/${websiteId}`, { token: token.secret });
    expect(read.body.data[0].excludedIps).toEqual(["203.0.113.10", "10.0.0.0/8", "2001:db8::/32"]);
  });

  it("rejects invalid settings and empty updates", async () => {
    const user = await createUser();
    const site = await createSite(user.id);
    const cookie = await sessionCookie(user.id);
    const put = (body: unknown) =>
      api(`/api/v1/admin/websites/${site.id}`, { method: "PUT", cookie, body });
    expect((await put({})).status).toBe(400);
    expect((await put({ timezone: "Mars/Olympus" })).status).toBe(400);
    expect((await put({ excludedIps: ["999.1.1.1"] })).status).toBe(400);
    expect((await put({ excludedPaths: ["admin"] })).status).toBe(400);
    expect((await put({ excludedCountries: ["Atlantis"] })).status).toBe(400);
    expect((await put({ unknownField: 1 })).status).toBe(400);
    expect((await put({ retentionDays: 1 })).status).toBe(400);
  });

  it("allows deletion only from the dashboard by an owner, then soft-deletes", async () => {
    const owner = await createUser();
    const site = await createSite(owner.id);
    const key = await createApiKey({ userId: owner.id, siteId: site.id });
    const token = await createApiKey({ userId: owner.id });
    const viaApi = await api(`/api/v1/admin/websites/${site.id}`, {
      method: "DELETE",
      token: token.secret,
    });
    expect(viaApi.status).toBe(403);
    expect(viaApi.body.error.message).toContain("cannot be done programmatically");
    const member = await createUser();
    await addMember(site.id, member.id, "member");
    expect(
      (
        await api(`/api/v1/admin/websites/${site.id}`, {
          method: "DELETE",
          cookie: await sessionCookie(member.id),
        })
      ).status,
    ).toBe(403);
    const ok = await api(`/api/v1/admin/websites/${site.id}`, {
      method: "DELETE",
      cookie: await sessionCookie(owner.id),
    });
    expect(ok.status).toBe(200);
    expect((await api(`/api/v1/admin/websites/${site.id}`, { token: token.secret })).status).toBe(
      404,
    );
    expect((await api("/api/v1/admin/account", { token: key.secret })).status).toBe(401);
    const row = await env.DB.prepare("SELECT deleted_at FROM sites WHERE id = ?")
      .bind(site.id)
      .first<{ deleted_at: number }>();
    expect(row?.deleted_at).toBeGreaterThan(0);
  });
});

describe("website API keys", () => {
  it("creates, lists, rolls and deletes dg_ keys", async () => {
    const owner = await createUser();
    const site = await createSite(owner.id);
    const cookie = await sessionCookie(owner.id);
    const base = `/api/v1/admin/websites/${site.id}/apikeys`;
    const created = await api(base, { cookie, body: { name: "Production key" } });
    const key = created.body.data[0];
    expect(key.key).toMatch(/^dg_[0-9A-Za-z]{40}$/);
    expect(key).toMatchObject({
      name: "Production key",
      websiteId: site.id,
      isMobile: false,
      includePii: false,
    });
    expect(key.keyPrefix).toBe(key.key.slice(0, 8));
    expect((await api(base, { cookie })).body.data).toHaveLength(1);

    const rolled = await api(`${base}/${key.id}`, { method: "PUT", cookie });
    expect(rolled.body.data[0].id).toBe(key.id);
    expect(rolled.body.data[0].key).not.toBe(key.key);
    expect((await api("/api/v1/admin/account", { token: key.key })).status).toBe(401);
    expect((await api("/api/v1/admin/account", { token: rolled.body.data[0].key })).status).toBe(
      200,
    );

    expect((await api(`${base}/${key.id}`, { method: "DELETE", cookie })).body.data).toEqual([
      { deleted: true },
    ]);
    expect((await api("/api/v1/admin/account", { token: rolled.body.data[0].key })).status).toBe(
      401,
    );
    expect((await api(`${base}/${key.id}`, { method: "DELETE", cookie })).status).toBe(404);
  });

  it("limits websites to 10 keys and viewers cannot create keys", async () => {
    const owner = await createUser();
    const site = await createSite(owner.id);
    for (let i = 0; i < 10; i++) await createApiKey({ userId: owner.id, siteId: site.id });
    const over = await api(`/api/v1/admin/websites/${site.id}/apikeys`, {
      cookie: await sessionCookie(owner.id),
      body: {},
    });
    expect(over.status).toBe(400);
    const viewer = await createUser();
    await addMember(site.id, viewer.id, "viewer");
    expect(
      (
        await api(`/api/v1/admin/websites/${site.id}/apikeys`, {
          cookie: await sessionCookie(viewer.id),
          body: {},
        })
      ).status,
    ).toBe(403);
  });
});

describe("team and invites", () => {
  it("invites a new user who accepts by creating an account", async () => {
    const owner = await createUser({ email: "owner@example.com" });
    const site = await createSite(owner.id);
    const cookie = await sessionCookie(owner.id);
    const team = `/api/v1/admin/websites/${site.id}/team`;
    expect((await api(team, { cookie, body: { email: "owner@example.com" } })).status).toBe(400);
    const inv = await api(team, { cookie, body: { email: "New@Example.com", role: "member" } });
    expect(inv.status).toBe(200);
    expect(inv.body.data[0]).toMatchObject({ email: "new@example.com", role: "member" });
    expect((await api(team, { cookie, body: { email: "new@example.com" } })).status).toBe(409);
    const token = inv.body.data[0].inviteUrl.split("/invite/")[1];
    expect((await api(`${team}/invites`, { cookie })).body.data).toHaveLength(1);

    const info = await api(`/api/auth/invites/${token}`);
    expect(info.body.data).toMatchObject({
      email: "new@example.com",
      role: "member",
      userExists: false,
      website: { id: site.id },
    });
    expect((await api(`/api/auth/invites/${token}/accept`, { body: {} })).status).toBe(400);
    const accept = await api(`/api/auth/invites/${token}/accept`, {
      body: { name: "Newbie", password: "a-good-password" },
    });
    expect(accept.status).toBe(200);
    expect(accept.body.data.websites[0]).toMatchObject({ _id: site.id, role: "member" });
    expect(cookieFrom(accept.cookies, "dg_session")).toBeDefined();
    expect(
      (await api(`/api/auth/invites/${token}/accept`, { body: { password: "a-good-password" } }))
        .status,
    ).toBe(410);

    const members = await api(team, { cookie });
    expect(members.body.data.map((m: { role: string }) => m.role)).toEqual(["owner", "member"]);
  });

  it("requires existing users to sign in with the invited email", async () => {
    const owner = await createUser();
    const invitee = await createUser({ email: "member@example.com" });
    const site = await createSite(owner.id);
    const inv = await api(`/api/v1/admin/websites/${site.id}/team`, {
      cookie: await sessionCookie(owner.id),
      body: { email: invitee.email },
    });
    const token = inv.body.data[0].inviteUrl.split("/invite/")[1];
    expect((await api(`/api/auth/invites/${token}/accept`, { body: {} })).status).toBe(401);
    const someoneElse = await createUser();
    expect(
      (
        await api(`/api/auth/invites/${token}/accept`, {
          cookie: await sessionCookie(someoneElse.id),
          body: {},
        })
      ).status,
    ).toBe(403);
    const ok = await api(`/api/auth/invites/${token}/accept`, {
      cookie: await sessionCookie(invitee.id),
      body: {},
    });
    expect(ok.status).toBe(200);
    expect(ok.body.data.websites[0].role).toBe("viewer");
  });

  it("revokes invites and expires old ones", async () => {
    const owner = await createUser();
    const site = await createSite(owner.id);
    const cookie = await sessionCookie(owner.id);
    const inv = await api(`/api/v1/admin/websites/${site.id}/team`, {
      cookie,
      body: { email: "a@example.com" },
    });
    const { invitationId, inviteUrl } = inv.body.data[0];
    expect(
      (
        await api(`/api/v1/admin/websites/${site.id}/team/invites/${invitationId}`, {
          method: "DELETE",
          cookie,
        })
      ).status,
    ).toBe(200);
    expect((await api(`/api/auth/invites/${inviteUrl.split("/invite/")[1]}`)).status).toBe(404);
    const inv2 = await api(`/api/v1/admin/websites/${site.id}/team`, {
      cookie,
      body: { email: "a@example.com" },
    });
    await env.DB.prepare("UPDATE invites SET expires_at = 1 WHERE id = ?")
      .bind(inv2.body.data[0].invitationId)
      .run();
    expect(
      (await api(`/api/auth/invites/${inv2.body.data[0].inviteUrl.split("/invite/")[1]}`)).status,
    ).toBe(410);
  });

  it("changes roles, keeps at least one owner, and removes members", async () => {
    const owner = await createUser();
    const site = await createSite(owner.id);
    const member = await createUser();
    await addMember(site.id, member.id, "viewer");
    const cookie = await sessionCookie(owner.id);
    const team = `/api/v1/admin/websites/${site.id}/team`;
    expect(
      (await api(team, { method: "PUT", cookie, body: { userId: owner.id, role: "member" } }))
        .status,
    ).toBe(400);
    expect(
      (await api(team, { method: "PUT", cookie, body: { userId: member.id, role: "member" } }))
        .status,
    ).toBe(200);
    expect((await api(team, { method: "DELETE", cookie, body: { userId: owner.id } })).status).toBe(
      400,
    );
    expect(
      (await api(team, { method: "DELETE", cookie, body: { userId: member.id } })).status,
    ).toBe(200);
    expect(
      (await api(team, { method: "DELETE", cookie, body: { userId: member.id } })).status,
    ).toBe(404);
    expect(
      (await api(`/api/v1/admin/websites/${site.id}`, { cookie: await sessionCookie(member.id) }))
        .status,
    ).toBe(404);
  });
});

describe("password reset links", () => {
  it("resets a password with a one-time link and signs out all sessions", async () => {
    const user = await createUser();
    const cookie = await sessionCookie(user.id);
    const token = "reset-token-0123456789abcdefghij";
    await env.DB.prepare(
      "INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    )
      .bind(await sha256Hex(`reset:${token}`), user.id, Date.now(), Date.now() + 3600_000)
      .run();
    expect((await api(`/api/auth/password-resets/${token}`)).body.data.email).toBe(user.email);
    expect(
      (await api(`/api/auth/password-resets/${token}`, { body: { password: "brand-new-pass" } }))
        .status,
    ).toBe(200);
    expect((await api("/api/auth/me", { cookie })).status).toBe(401);
    expect(
      (await api(`/api/auth/password-resets/${token}`, { body: { password: "brand-new-pass" } }))
        .status,
    ).toBe(410);
    expect(
      (await api("/api/auth/login", { body: { email: user.email, password: "brand-new-pass" } }))
        .status,
    ).toBe(200);
  });
});
