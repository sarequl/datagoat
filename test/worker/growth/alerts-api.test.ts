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
import { apiWith, EMAIL, jsonResponse, mockFetch, useGlobalFetch } from "./helpers";

beforeEach(() => resetDb());

const goalAlert = {
  name: "New signup",
  trigger: { goalName: "Sign Up" },
  template: { subject: "New signup", message: "A visitor completed signup." },
  isEnabled: true,
};

async function setup() {
  const owner = await createUser();
  const site = await createSite(owner.id);
  const cookie = await sessionCookie(owner.id);
  return { owner, site, cookie, base: `/api/v1/admin/websites/${site.id}/alerts` };
}

describe("alerts API (DataFast shapes)", () => {
  it("creates, lists, updates and deletes a goal alert", async () => {
    const { site, cookie, base } = await setup();
    const created = await apiWith(EMAIL, base, { cookie, body: goalAlert });
    expect(created.status).toBe(200);
    const alert = created.body.data[0];
    expect(alert).toMatchObject({
      websiteId: site.id,
      name: "New signup",
      trigger: { type: "goal", goalName: "sign_up" },
      destination: { type: "email" },
      template: { subject: "New signup", message: "A visitor completed signup." },
      isEnabled: true,
      triggerCount: 0,
      monthlyCount: 0,
      dailyCount: 0,
      recentLogs: [],
    });
    expect(alert.lastTriggeredAt).toBeUndefined();
    expect(alert.dailyCountResetAt).toMatch(/T00:00:00.000Z$/);

    const list = await api(base, { cookie });
    expect(list.body.data).toHaveLength(1);

    const updated = await api(`${base}/${alert.id}`, {
      cookie,
      method: "PUT",
      body: { name: "Renamed", isEnabled: false, trigger: { goalName: "purchase" } },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.data[0]).toMatchObject({
      name: "Renamed",
      isEnabled: false,
      trigger: { type: "goal", goalName: "purchase" },
      template: { message: "A visitor completed signup." },
    });

    const del = await api(`${base}/${alert.id}`, { cookie, method: "DELETE" });
    expect(del.body.data).toEqual([{ message: "Alert deleted successfully" }]);
    expect((await api(`${base}/${alert.id}`, { cookie, method: "DELETE" })).status).toBe(404);
  });

  it("validates like DataFast: name, message length, goal name, 25 alerts per website", async () => {
    const { cookie, base } = await setup();
    const bad = async (body: unknown) => (await apiWith(EMAIL, base, { cookie, body })).status;
    expect(await bad({ ...goalAlert, name: "" })).toBe(400);
    expect(await bad({ ...goalAlert, template: { message: "short" } })).toBe(400);
    expect(await bad({ ...goalAlert, trigger: { goalName: "identify" } })).toBe(400);
    expect(await bad({ ...goalAlert, template: undefined })).toBe(400);
    expect(await bad({ ...goalAlert, extra: 1 })).toBe(400);
    for (let i = 0; i < 25; i++) {
      await env.DB.prepare(
        "INSERT INTO alerts (id, site_id, name, created_at, updated_at) VALUES (?, (SELECT id FROM sites LIMIT 1), 'x', 0, 0)",
      )
        .bind(`a${i}`)
        .run();
    }
    const over = await apiWith(EMAIL, base, { cookie, body: goalAlert });
    expect(over.status).toBe(400);
    expect(over.body.error.message).toContain("max 25");
  });

  it("refuses email destinations when no email provider is configured", async () => {
    const { cookie, base } = await setup();
    const res = await api(base, { cookie, body: goalAlert });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("Email delivery is not configured");
  });

  it("supports Telegram and webhook destinations, keeping secrets out of responses", async () => {
    const { site, cookie, base } = await setup();
    const tg = await api(base, {
      cookie,
      body: {
        name: "Sales to Telegram",
        trigger: { type: "new_sale", includeFreeTrials: true },
        destination: {
          type: "telegram",
          chatId: "-100123",
          botToken: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        },
      },
    });
    expect(tg.status).toBe(200);
    expect(tg.body.data[0]).toMatchObject({
      trigger: { type: "new_sale", includeRenewals: true, includeFreeTrials: true },
      destination: { type: "telegram", chatId: "-100123", hasBotToken: true },
    });
    expect(JSON.stringify(tg.body)).not.toContain("ABCDEFGHIJ");
    const row = await env.DB.prepare("SELECT secret_enc FROM alerts WHERE id = ?")
      .bind(tg.body.data[0].id)
      .first<{ secret_enc: string }>();
    expect(row?.secret_enc).toMatch(/^v1\./);

    const wh = await api(base, {
      cookie,
      body: {
        name: "Spikes to webhook",
        trigger: { type: "traffic_spike", multiplier: 3 },
        destination: { type: "webhook", url: "https://hooks.example.com/datagoat" },
      },
    });
    expect(wh.body.data[0].destination.signingSecret).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(wh.body.data[0].trigger).toEqual({
      type: "traffic_spike",
      multiplier: 3,
      minSessions: 20,
    });
    const listed = await api(base, { cookie });
    expect(JSON.stringify(listed.body)).not.toContain("whsec_");

    // Private targets and plain http are refused.
    const local = await api(base, {
      cookie,
      body: {
        name: "x",
        trigger: { type: "daily_digest" },
        destination: { type: "webhook", url: "http://127.0.0.1/hook" },
      },
    });
    expect(local.status).toBe(400);
    expect(site.id).toBeTruthy();
  });

  it("returns history with counts and enforces permissions", async () => {
    const { owner, site, cookie, base } = await setup();
    const created = await api(base, {
      cookie,
      body: {
        name: "Digest",
        trigger: { type: "weekly_digest" },
        destination: { type: "webhook", url: "https://h.example.com/x" },
      },
    });
    const id = created.body.data[0].id;
    const stmt = env.DB.prepare(
      "INSERT INTO alert_history (site_id, alert_id, alert_name, goal_name, status, error, visitor_id, triggered_at) VALUES (?, ?, 'Digest', NULL, ?, ?, NULL, ?)",
    );
    await env.DB.batch([
      stmt.bind(site.id, id, "sent", null, 1000),
      stmt.bind(site.id, id, "failed", "Webhook: endpoint answered HTTP 500", 2000),
      stmt.bind(site.id, "other", "sent", null, 3000),
    ]);
    const hist = await api(`${base}/history?alertId=${id}&limit=1`, { cookie });
    expect(hist.body.data).toHaveLength(1);
    expect(hist.body.data[0]).toMatchObject({
      alertId: id,
      status: "failed",
      error: "Webhook: endpoint answered HTTP 500",
    });
    expect(hist.body.counts).toEqual({ sent: 1, failed: 1, total: 2 });
    expect((await api(`${base}/history?limit=101`, { cookie })).status).toBe(400);
    const listed = await api(base, { cookie });
    expect(listed.body.data[0].recentLogs).toHaveLength(2);

    const viewer = await createUser();
    await addMember(site.id, viewer.id, "viewer");
    const vc = await sessionCookie(viewer.id);
    expect((await api(base, { cookie: vc })).status).toBe(200);
    expect((await api(base, { cookie: vc, body: goalAlert })).status).toBe(403);

    const key = await createApiKey({ userId: owner.id, siteId: site.id });
    expect((await api(base, { token: key.secret })).status).toBe(200);
    const token = await createApiKey({ userId: owner.id, permissions: ["analytics:read"] });
    expect((await api(base, { token: token.secret })).status).toBe(403);
  });

  it("lists available channels", async () => {
    const { owner, cookie, base } = await setup();
    const res = await apiWith(EMAIL, `${base}/channels`, { cookie });
    expect(res.body.data).toMatchObject({
      email: { configured: true, provider: "resend", defaultRecipients: [owner.email] },
      telegram: { configured: true, hasDefaultBotToken: false },
      dailyLimit: 100,
    });
    expect(res.body.data.variables).toContain("country");
  });

  it("sends a test notification through the destination and records it", async () => {
    const { site, cookie, base } = await setup();
    const created = await api(base, {
      cookie,
      body: {
        name: "Telegram sales",
        trigger: { type: "new_sale" },
        destination: {
          type: "telegram",
          chatId: "42",
          botToken: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        },
      },
    });
    const id = created.body.data[0].id;
    const fetch = mockFetch().on("https://api.telegram.org/", () => jsonResponse({ ok: true }));
    useGlobalFetch(fetch);
    const ok = await api(`${base}/${id}/test`, { cookie, method: "POST" });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual([{ message: "Test alert sent" }]);
    expect(fetch.calls[0]?.url).toBe(
      "https://api.telegram.org/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ/sendMessage",
    );
    expect(JSON.parse(fetch.calls[0]?.body ?? "{}")).toMatchObject({ chat_id: "42" });
    expect(JSON.parse(fetch.calls[0]?.body ?? "{}").text).toContain("[Test]");

    const failing = mockFetch().on("https://api.telegram.org/", () =>
      jsonResponse({ ok: false, description: "Bad Request: chat not found" }, 400),
    );
    useGlobalFetch(failing);
    const bad = await api(`${base}/${id}/test`, { cookie, method: "POST" });
    expect(bad.status).toBe(502);
    expect(bad.body.error.message).toContain("chat not found");
    expect(bad.body.error.message).not.toContain("ABCDEFGHIJ");
    const hist = await api(`${base}/history`, { cookie });
    expect(hist.body.counts).toEqual({ sent: 1, failed: 1, total: 2 });
    // Test sends do not count as triggers.
    const alert = await api(`/api/v1/admin/websites/${site.id}/alerts`, { cookie });
    expect(alert.body.data[0].triggerCount).toBe(0);
  });
});
