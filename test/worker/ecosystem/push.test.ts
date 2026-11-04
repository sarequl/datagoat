import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXPO_PUSH_URL, formatMoney, pushJob } from "../../../src/ecosystem/push";
import { runScheduled } from "../../../src/jobs/scheduler";
import { meterEnv, resetDb } from "../../helpers/db";
import { createPayment, createSite, createUser } from "../../helpers/factories";
import { api } from "../../helpers/http";

beforeEach(() => resetDb());
afterEach(() => vi.restoreAllMocks());

const TOKEN_A = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaa]";
const TOKEN_B = "ExponentPushToken[bbbbbbbbbbbbbbbbbbbb]";

interface Sent {
  to: string;
  title: string;
  body: string;
  data: Record<string, string>;
}

function mockExpo(answer?: (messages: Sent[]) => unknown) {
  const sent: Sent[][] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(String(input)).toBe(EXPO_PUSH_URL);
    const messages = JSON.parse(String(init?.body)) as Sent[];
    sent.push(messages);
    const body = answer?.(messages) ?? { data: messages.map(() => ({ status: "ok", id: "x" })) };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  });
  return { sent, spy };
}

const tick = (at: number, base: Cloudflare.Env = env) =>
  runScheduled([pushJob], base, createExecutionContext(), at);

async function device(email: string, password: string, pushToken: string, extra = {}) {
  const session = await api("/api/v1/mobile/session", { body: { email, password }, origin: null });
  const token = session.body.data.token as string;
  await api("/api/v1/mobile/devices", { token, body: { pushToken, platform: "ios", ...extra } });
  return token;
}

describe("ecosystem.push", () => {
  it("does nothing on the first run but set its cursors, and costs one query when idle", async () => {
    const { spy } = mockExpo();
    const now = Date.now();
    await tick(now - 60_000);
    const state = await env.DB.prepare(
      "SELECT state FROM job_state WHERE name = 'ecosystem.push'",
    ).first<{ state: string }>();
    expect(JSON.parse(state?.state ?? "null")).toEqual({ paymentsAt: now - 60_000, alertId: 0 });

    const m = meterEnv();
    await tick(now, m.env);
    // scheduler: read state + (no write: state unchanged); job: one devices query
    expect(m.d1.rowsWritten).toBe(0);
    expect(m.d1.queries).toBe(2);
    expect(spy).not.toHaveBeenCalled();
  });

  it("pushes new sales and alerts to members' devices, honouring preferences and mutes", async () => {
    const owner = await createUser();
    const viewer = await createUser();
    const outsider = await createUser();
    const site = await createSite(owner.id, { domain: "shop.example.com", name: "Shop" });
    const muted = await createSite(owner.id, { domain: "muted.example.com" });
    await env.DB.prepare(
      "INSERT INTO memberships (site_id, user_id, role, created_at) VALUES (?, ?, 'viewer', ?)",
    )
      .bind(site.id, viewer.id, Date.now())
      .run();
    await device(owner.email, owner.password, TOKEN_A, { mutedSiteIds: [muted.id] });
    await device(viewer.email, viewer.password, TOKEN_B, { notifySales: false });
    await device(outsider.email, outsider.password, "ExponentPushToken[cccccccccccccccccccc]");

    const start = Date.now() - 1000;
    await tick(start);
    const { sent } = mockExpo();

    await createPayment({ siteId: site.id, amountMinor: 4900, occurredAt: Date.now() });
    await createPayment({
      siteId: site.id,
      amountMinor: 1500,
      kind: "renewal",
      occurredAt: Date.now(),
    });
    await createPayment({
      siteId: site.id,
      amountMinor: -4900,
      kind: "refund",
      occurredAt: Date.now(),
    });
    await createPayment({ siteId: muted.id, amountMinor: 100, occurredAt: Date.now() });
    // Old sale (backfilled late): never pushed.
    await createPayment({ siteId: site.id, amountMinor: 999, occurredAt: Date.now() - 86_400_000 });
    await env.DB.prepare(
      `INSERT INTO alert_history (site_id, alert_id, alert_name, goal_name, status, triggered_at)
       VALUES (?, 'a1', 'Signup alert', 'signup', 'sent', ?), (?, 'a1', 'Signup alert', 'signup', 'failed', ?)`,
    )
      .bind(site.id, Date.now(), site.id, Date.now())
      .run();

    const result = await tick(Date.now());
    expect(result.results[0]?.status).toBe("ok");
    expect(sent).toHaveLength(1);
    const messages = sent[0] ?? [];
    const toA = messages.filter((m) => m.to === TOKEN_A);
    const toB = messages.filter((m) => m.to === TOKEN_B);
    expect(toA.map((m) => m.body)).toEqual([
      "New sale: $49.00",
      "Renewal: $15.00",
      'Goal "signup" completed on shop.example.com',
    ]);
    expect(toA[0]).toMatchObject({ title: "Shop", data: { type: "sale", websiteId: site.id } });
    // The viewer turned sales off but still gets the alert.
    expect(toB.map((m) => m.data.type)).toEqual(["alert"]);
    expect(messages.some((m) => m.to.includes("cccc"))).toBe(false);

    // Nothing new: no second push, no state write.
    const m = meterEnv();
    await tick(Date.now(), m.env);
    expect(sent).toHaveLength(1);
    expect(m.d1.rowsWritten).toBe(0);
  });

  it("deletes devices Expo reports as unregistered and stops for revoked tokens", async () => {
    const owner = await createUser();
    const site = await createSite(owner.id);
    const token = await device(owner.email, owner.password, TOKEN_A);
    await tick(Date.now() - 1000);
    mockExpo((messages) => ({
      data: messages.map(() => ({ status: "error", details: { error: "DeviceNotRegistered" } })),
    }));
    await createPayment({ siteId: site.id, amountMinor: 100, occurredAt: Date.now() });
    await tick(Date.now());
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM mobile_devices").first<{
      n: number;
    }>();
    expect(left?.n).toBe(0);

    // Revoked token: device rows are ignored.
    await device(owner.email, owner.password, TOKEN_B);
    await env.DB.prepare("UPDATE api_keys SET revoked_at = ? WHERE is_mobile = 1")
      .bind(Date.now())
      .run();
    const { sent } = mockExpo();
    await createPayment({ siteId: site.id, amountMinor: 100, occurredAt: Date.now() });
    await tick(Date.now());
    expect(sent).toHaveLength(0);
    expect(token).toMatch(/^dft_/);
  });

  it("keeps its cursor when Expo fails so the next run retries", async () => {
    const owner = await createUser();
    const site = await createSite(owner.id);
    await device(owner.email, owner.password, TOKEN_A);
    await tick(Date.now() - 1000);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("down", { status: 503 }));
    await createPayment({ siteId: site.id, amountMinor: 100, occurredAt: Date.now() });
    const failed = await tick(Date.now());
    expect(failed.results[0]?.status).toBe("error");
    vi.restoreAllMocks();
    const { sent } = mockExpo();
    await tick(Date.now() + 1);
    expect(sent).toHaveLength(1);
  });

  it("formats money in the reporting currency", () => {
    expect(formatMoney(4900, "USD")).toBe("$49.00");
    expect(formatMoney(1200, "JPY")).toBe("¥1,200");
    expect(formatMoney(1050, "EUR")).toBe("€10.50");
  });
});
