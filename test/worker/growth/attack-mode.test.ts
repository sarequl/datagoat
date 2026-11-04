import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { detect, runAttackDetection } from "../../../src/growth/attack/attack-mode";
import { siteCache } from "../../../src/lib/site-cache";
import { meterEnv, resetDb } from "../../helpers/db";
import { createSession, createSite, createUser, sessionCookie } from "../../helpers/factories";
import { api } from "../../helpers/http";
import { emailEnv, jobCtx } from "./helpers";

beforeEach(() => resetDb());

const NOW = Date.UTC(2026, 10, 4, 12, 0);
const TODAY = "2026-11-04";

async function setup() {
  const owner = await createUser({ email: "owner@example.com" });
  const site = await createSite(owner.id, { name: "Shop" });
  await env.DB.prepare(
    "INSERT INTO attack_mode (site_id, auto_enable, multiplier, min_hits, duration_minutes, updated_at) VALUES (?, 1, 5, 100, 60, 0)",
  )
    .bind(site.id)
    .run();
  return { owner, site, cookie: await sessionCookie(owner.id) };
}

async function botHits(siteId: string, day: string, hits: number) {
  await env.DB.prepare(
    `INSERT INTO bot_daily (site_id, day, reason, hits) VALUES (?, ?, 'ua', ?)
     ON CONFLICT (site_id, day, reason) DO UPDATE SET hits = excluded.hits`,
  )
    .bind(siteId, day, hits)
    .run();
}

const level = async (id: string) =>
  (
    await env.DB.prepare("SELECT bot_level FROM sites WHERE id = ?")
      .bind(id)
      .first<{ bot_level: string }>()
  )?.bot_level;

describe("attack mode detection", () => {
  it("pure detection rules", () => {
    const s = { multiplier: 5, min_hits: 100 };
    const base = {
      botBaselinePerWindow: 2,
      sessions: 0,
      suspicious: 0,
      sessionBaselinePerWindow: 1,
    };
    expect(detect(s, { ...base, botDelta: 99 })).toBeNull();
    expect(detect(s, { ...base, botDelta: 150 })?.reason).toBe("bot_spike");
    expect(detect(s, { ...base, botDelta: 150, botBaselinePerWindow: 40 })).toBeNull();
    // A busy but human-looking spike does not trigger…
    expect(detect(s, { ...base, botDelta: null, sessions: 300, suspicious: 100 })).toBeNull();
    // …a bot-like one does.
    expect(detect(s, { ...base, botDelta: null, sessions: 300, suspicious: 290 })?.reason).toBe(
      "suspicious_traffic_spike",
    );
  });

  it("switches the strict filter on for a period on a bot spike, notifies, then restores", async () => {
    const { site, cookie } = await setup();
    await botHits(site.id, "2026-11-01", 288);
    await botHits(site.id, TODAY, 10);
    // First run only records the counter.
    const first = jobCtx({ now: NOW, env: emailEnv() });
    expect((await runAttackDetection(first)).activated).toEqual([]);
    expect(first.saved).toEqual({ bots: { [site.id]: { day: TODAY, hits: 10 } } });
    await botHits(site.id, TODAY, 400);
    const second = jobCtx({ now: NOW + 5 * 60_000, env: emailEnv(), state: first.saved });
    expect((await runAttackDetection(second)).activated).toEqual([site.id]);
    expect(await level(site.id)).toBe("strict");
    expect(siteCache).toBeTruthy();
    const event = await env.DB.prepare("SELECT * FROM attack_mode_events WHERE site_id = ?")
      .bind(site.id)
      .first();
    expect(event).toMatchObject({ source: "auto", reason: "bot_spike", ended_at: null });
    const notice = await env.DB.prepare("SELECT payload FROM outbox").first<{ payload: string }>();
    expect(JSON.parse(notice?.payload ?? "{}")).toMatchObject({
      channel: "email",
      to: ["owner@example.com"],
      subject: "Attack mode is on for Shop",
    });
    const state = await api(`/api/v1/admin/websites/${site.id}/bot-traffic/attack-mode`, {
      cookie,
    });
    expect(state.body.data[0]).toMatchObject({
      enabled: true,
      autoEnable: true,
      durationMinutes: 60,
    });
    expect(state.body.data[0].autoActiveUntil).toBe(new Date(NOW + 65 * 60_000).toISOString());

    // While active it is not re-triggered; after the period it switches back.
    await runAttackDetection(jobCtx({ now: NOW + 30 * 60_000, state: second.saved }));
    expect(await level(site.id)).toBe("strict");
    const off = await runAttackDetection(jobCtx({ now: NOW + 70 * 60_000, env: emailEnv() }));
    expect(off.expired).toEqual([site.id]);
    expect(await level(site.id)).toBe("standard");
    const ended = await env.DB.prepare("SELECT ended_at FROM attack_mode_events").first<{
      ended_at: number;
    }>();
    expect(ended?.ended_at).toBe(NOW + 70 * 60_000);
  });

  it("detects bot-like session floods and leaves a manually chosen level alone", async () => {
    const { site } = await setup();
    for (let i = 0; i < 120; i++)
      await createSession({ siteId: site.id, startedAt: NOW - 60_000 - i, pageviews: 1 });
    const res = await runAttackDetection(jobCtx({ now: NOW }));
    expect(res.activated).toEqual([site.id]);
    // The owner turns the filter off by hand during the period: expiry must not undo that.
    await env.DB.prepare("UPDATE sites SET bot_level = 'off' WHERE id = ?").bind(site.id).run();
    await runAttackDetection(jobCtx({ now: NOW + 3 * 3_600_000 }));
    expect(await level(site.id)).toBe("off");
  });

  it("costs no writes when nothing is happening", async () => {
    const { site } = await setup();
    await botHits(site.id, TODAY, 10);
    const state = { bots: { [site.id]: { day: TODAY, hits: 10 } } };
    const m = meterEnv();
    const ctx = jobCtx({ now: NOW, db: m.db, state });
    await runAttackDetection(ctx);
    expect(m.d1.rowsWritten).toBe(0);
    expect(ctx.saved).toBeUndefined();
  });
});

describe("attack mode API", () => {
  it("updates auto settings and toggles attack mode manually with an event log", async () => {
    const owner = await createUser();
    const site = await createSite(owner.id);
    const cookie = await sessionCookie(owner.id);
    const path = `/api/v1/admin/websites/${site.id}/bot-traffic/attack-mode`;
    const initial = await api(path, { cookie });
    expect(initial.body.data[0]).toMatchObject({
      enabled: false,
      autoEnable: false,
      multiplier: 5,
      events: [],
    });
    const on = await api(path, {
      cookie,
      method: "PUT",
      body: { enabled: true, autoEnable: true, multiplier: 8 },
    });
    expect(on.body.data[0]).toMatchObject({ enabled: true, autoEnable: true, multiplier: 8 });
    expect(on.body.data[0].events[0]).toMatchObject({ source: "manual", endedAt: null });
    expect(await level(site.id)).toBe("strict");
    const off = await api(path, { cookie, method: "PUT", body: { enabled: false } });
    expect(off.body.data[0].enabled).toBe(false);
    expect(await level(site.id)).toBe("standard");
    expect(off.body.data[0].events[0].endedAt).not.toBeNull();
    expect((await api(path, { cookie, method: "PUT", body: { multiplier: 1 } })).status).toBe(400);
  });
});
