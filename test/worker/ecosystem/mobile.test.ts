import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { MOBILE_PERMISSIONS } from "../../../src/ecosystem/mobile";
import { resetDb } from "../../helpers/db";
import { createApiKey, createSite, createUser, sessionCookie } from "../../helpers/factories";
import { api } from "../../helpers/http";

beforeEach(() => resetDb());

const PUSH = "ExponentPushToken[abcdefghijklmnop1234]";

async function signIn(email: string, password: string, deviceName = "Pixel 9") {
  return api("/api/v1/mobile/session", {
    body: { email, password, deviceName },
    origin: null,
  });
}

describe("POST /api/v1/mobile/session", () => {
  it("mints a read-only mobile dft_ token and returns the user's websites", async () => {
    const user = await createUser();
    const site = await createSite(user.id, { domain: "shop.example.com" });
    const res = await signIn(user.email, user.password);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.token).toMatch(/^dgt_/);
    expect(data.permissions).toEqual(MOBILE_PERMISSIONS);
    expect(data.user.email).toBe(user.email);
    expect(data.websites.map((w: { _id: string }) => w._id)).toEqual([site.id]);
    const row = await env.DB.prepare("SELECT * FROM api_keys WHERE id = ?")
      .bind(data.tokenId)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      kind: "dft",
      is_mobile: 1,
      include_pii: 0,
      name: "Mobile app (Pixel 9)",
    });
    expect(Number(row?.expires_at)).toBeGreaterThan(Date.now() + 300 * 86_400_000);

    // The token reads analytics-side resources...
    const sites = await api("/api/v1/admin/websites", { token: data.token });
    expect(sites.status).toBe(200);
    // ...but cannot write.
    const write = await api(`/api/v1/admin/websites/${site.id}`, {
      method: "PUT",
      token: data.token,
      body: { name: "Nope" },
    });
    expect(write.status).toBe(403);
  });

  it("rejects a wrong password with 401 and throttles repeated failures", async () => {
    const user = await createUser();
    const bad = await signIn(user.email, "wrong-password");
    expect(bad.status).toBe(401);
    expect(bad.body.error.message).toBe("Invalid email or password");
    const unknown = await signIn("nobody@example.com", "whatever-password");
    expect(unknown.status).toBe(401);
    for (let i = 0; i < 8; i++) await signIn(user.email, "wrong-password");
    const blocked = await signIn(user.email, user.password);
    expect(blocked.status).toBe(429);
  });

  it("validates the body", async () => {
    const res = await api("/api/v1/mobile/session", { body: { email: "x" }, origin: null });
    expect(res.status).toBe(400);
  });

  it("replaces the oldest mobile token when the user is at the token cap", async () => {
    const user = await createUser();
    const first = await signIn(user.email, user.password);
    for (let i = 0; i < 19; i++) await createApiKey({ userId: user.id });
    const second = await signIn(user.email, user.password);
    expect(second.status).toBe(200);
    const gone = await api("/api/v1/admin/websites", { token: first.body.data.token });
    expect(gone.status).toBe(401);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND kind = 'dft'",
    )
      .bind(user.id)
      .first<{ n: number }>();
    expect(count?.n).toBe(20);
  });

  it("fails clearly when the cap is full of non-mobile tokens", async () => {
    const user = await createUser();
    for (let i = 0; i < 20; i++) await createApiKey({ userId: user.id });
    const res = await signIn(user.email, user.password);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("Token limit reached");
  });

  it("DELETE signs out: revokes the token and forgets its devices", async () => {
    const user = await createUser();
    const { token } = (await signIn(user.email, user.password)).body.data;
    await api("/api/v1/mobile/devices", {
      token,
      body: { pushToken: PUSH, platform: "android" },
    });
    const out = await api("/api/v1/mobile/session", { method: "DELETE", token });
    expect(out.status).toBe(200);
    expect((await api("/api/auth/me", { token })).status).toBe(401);
    const devices = await env.DB.prepare("SELECT COUNT(*) AS n FROM mobile_devices").first<{
      n: number;
    }>();
    expect(devices?.n).toBe(0);
  });

  it("DELETE refuses non-mobile credentials", async () => {
    const user = await createUser();
    const key = await createApiKey({ userId: user.id });
    const res = await api("/api/v1/mobile/session", { method: "DELETE", token: key.secret });
    expect(res.status).toBe(403);
    const cookie = await sessionCookie(user.id);
    const viaCookie = await api("/api/v1/mobile/session", { method: "DELETE", cookie });
    expect(viaCookie.status).toBe(403);
  });
});

describe("/api/v1/mobile/devices", () => {
  it("registers, updates (upsert on push token), lists and deletes devices", async () => {
    const user = await createUser();
    const site = await createSite(user.id);
    const { token, tokenId } = (await signIn(user.email, user.password)).body.data;
    const created = await api("/api/v1/mobile/devices", {
      token,
      body: { pushToken: PUSH, platform: "ios", name: "iPhone" },
    });
    expect(created.status).toBe(201);
    const device = created.body.data[0];
    expect(device).toMatchObject({
      platform: "ios",
      name: "iPhone",
      notifySales: true,
      notifyAlerts: true,
      mutedSiteIds: [],
    });
    const updated = await api("/api/v1/mobile/devices", {
      token,
      body: { pushToken: PUSH, platform: "ios", notifySales: false, mutedSiteIds: [site.id] },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.data[0]).toMatchObject({
      id: device.id,
      name: "iPhone",
      notifySales: false,
      notifyAlerts: true,
      mutedSiteIds: [site.id],
    });
    // Omitted preferences are kept.
    const again = await api("/api/v1/mobile/devices", {
      token,
      body: { pushToken: PUSH, platform: "ios" },
    });
    expect(again.body.data[0]).toMatchObject({ notifySales: false, mutedSiteIds: [site.id] });
    const row = await env.DB.prepare("SELECT token_id FROM mobile_devices WHERE id = ?")
      .bind(device.id)
      .first<{ token_id: string }>();
    expect(row?.token_id).toBe(tokenId);

    const list = await api("/api/v1/mobile/devices", { token });
    expect(list.body.data).toHaveLength(1);
    const del = await api(`/api/v1/mobile/devices/${device.id}`, { method: "DELETE", token });
    expect(del.status).toBe(200);
    expect(
      (await api(`/api/v1/mobile/devices/${device.id}`, { method: "DELETE", token })).status,
    ).toBe(404);
  });

  it("re-owns a push token when another account signs in on the same phone", async () => {
    const a = await createUser();
    const b = await createUser();
    const ta = (await signIn(a.email, a.password)).body.data.token;
    const tb = (await signIn(b.email, b.password)).body.data.token;
    await api("/api/v1/mobile/devices", { token: ta, body: { pushToken: PUSH, platform: "ios" } });
    const res = await api("/api/v1/mobile/devices", {
      token: tb,
      body: { pushToken: PUSH, platform: "ios" },
    });
    expect(res.status).toBe(200);
    expect((await api("/api/v1/mobile/devices", { token: ta })).body.data).toHaveLength(0);
    expect((await api("/api/v1/mobile/devices", { token: tb })).body.data).toHaveLength(1);
  });

  it("rejects invalid push tokens, other credentials and unauthenticated calls", async () => {
    const user = await createUser();
    const site = await createSite(user.id);
    const { token } = (await signIn(user.email, user.password)).body.data;
    const bad = await api("/api/v1/mobile/devices", {
      token,
      body: { pushToken: "not-a-token", platform: "ios" },
    });
    expect(bad.status).toBe(400);
    const siteKey = await createApiKey({ userId: user.id, siteId: site.id });
    const viaKey = await api("/api/v1/mobile/devices", {
      token: siteKey.secret,
      body: { pushToken: PUSH, platform: "ios" },
    });
    expect(viaKey.status).toBe(403);
    const anon = await api("/api/v1/mobile/devices", { origin: null });
    expect(anon.status).toBe(401);
  });

  it("cannot delete another user's device", async () => {
    const a = await createUser();
    const b = await createUser();
    const ta = (await signIn(a.email, a.password)).body.data.token;
    const tb = (await signIn(b.email, b.password)).body.data.token;
    const d = await api("/api/v1/mobile/devices", {
      token: ta,
      body: { pushToken: PUSH, platform: "ios" },
    });
    const res = await api(`/api/v1/mobile/devices/${d.body.data[0].id}`, {
      method: "DELETE",
      token: tb,
    });
    expect(res.status).toBe(404);
  });
});
