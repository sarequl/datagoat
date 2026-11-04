import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { growthJobs } from "../../../src/growth";
import { runDigests } from "../../../src/growth/alerts/digest";
import { evaluateEventAlerts, PER_RUN_CAP } from "../../../src/growth/alerts/evaluate";
import { evaluateTrafficSpikes } from "../../../src/growth/alerts/spike";
import {
  cleanupOutbox,
  deliverOutbox,
  enqueueStatement,
  MAX_ATTEMPTS,
} from "../../../src/growth/delivery/outbox";
import { runScheduled } from "../../../src/jobs/scheduler";
import { meterEnv, resetDb } from "../../helpers/db";
import {
  createEvent,
  createPayment,
  createSession,
  createSite,
  createUser,
  sessionCookie,
} from "../../helpers/factories";
import { api } from "../../helpers/http";
import {
  apiWith,
  DAY,
  EMAIL,
  emailEnv,
  HOUR,
  jobCtx,
  jsonResponse,
  mockFetch,
  useGlobalFetch,
} from "./helpers";

beforeEach(() => resetDb());

// Monday 2026-11-02 10:30 UTC
const NOW = Date.UTC(2026, 10, 2, 10, 30);

async function insertAlert(siteId: string, fields: Record<string, unknown>) {
  const id = `alert_${Math.random().toString(16).slice(2, 10)}`;
  const row = {
    id,
    site_id: siteId,
    name: "Alert",
    trigger_type: "goal",
    trigger: "{}",
    channel: "email",
    destination: "{}",
    template_message: null,
    created_at: 0,
    updated_at: 0,
    ...fields,
  };
  const cols = Object.keys(row);
  await env.DB.prepare(
    `INSERT INTO alerts (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
  )
    .bind(...Object.values(row))
    .run();
  return id;
}

// biome-ignore lint/suspicious/noExplicitAny: tests inspect arbitrary rows and payloads
type OutboxRow = Record<string, any>;

async function outbox(): Promise<OutboxRow[]> {
  const res = await env.DB.prepare("SELECT * FROM outbox ORDER BY id").all<OutboxRow>();
  return (res.results ?? []).map((r) => ({ ...r, payload: JSON.parse(String(r.payload)) }));
}

describe("alerts.evaluate", () => {
  it("enqueues goal alerts once per event with visitor details, across overlapping runs", async () => {
    const owner = await createUser({ email: "owner@example.com" });
    const site = await createSite(owner.id, { name: "Shop" });
    const alertId = await insertAlert(site.id, {
      trigger: JSON.stringify({ goalName: "signup" }),
      template_message: "Signup from {{country}} via {{referrer}} on {{page}}",
      template_subject: "{{goal}} on {{website}}",
    });
    const s = await createSession({
      siteId: site.id,
      startedAt: NOW - 60_000,
      country: "FR",
      source: "Google",
    });
    await createEvent({
      siteId: site.id,
      session: s,
      type: "custom",
      name: "signup",
      ts: NOW - 30_000,
      path: "/pricing",
    });
    await createEvent({
      siteId: site.id,
      session: s,
      type: "custom",
      name: "other",
      ts: NOW - 30_000,
    });

    expect((await evaluateEventAlerts(jobCtx({ now: NOW }))).enqueued).toBe(1);
    // The next two minutes rescan the same event: nothing new is stored.
    expect((await evaluateEventAlerts(jobCtx({ now: NOW + 60_000 }))).enqueued).toBe(0);
    expect((await evaluateEventAlerts(jobCtx({ now: NOW + 120_000 }))).enqueued).toBe(0);
    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({
      channel: "email",
      to: ["owner@example.com"],
      subject: "signup on Shop",
      alert: { id: alertId, triggerType: "goal", goalName: "signup", visitorId: s.visitorId },
    });
    expect(rows[0]?.payload.text).toContain("Signup from France via Google on /pricing");
    expect(rows[0]?.payload.html).toContain("Signup from France via Google");
  });

  it("enqueues new sales (renewals and free trials per rule) but not backfilled payments", async () => {
    const owner = await createUser();
    const site = await createSite(owner.id, { currency: "EUR" });
    await insertAlert(site.id, {
      trigger_type: "new_sale",
      trigger: JSON.stringify({ includeRenewals: false, includeFreeTrials: false }),
      channel: "webhook",
      destination: JSON.stringify({ url: "https://hooks.example.com/x" }),
    });
    const before = Date.now;
    Date.now = () => NOW - 30_000;
    try {
      await createPayment({
        siteId: site.id,
        amountMinor: 4900,
        currency: "EUR",
        occurredAt: NOW - 40_000,
      });
      await createPayment({
        siteId: site.id,
        amountMinor: 900,
        kind: "renewal",
        occurredAt: NOW - 40_000,
      });
      await createPayment({ siteId: site.id, amountMinor: 1000, occurredAt: NOW - 10 * DAY });
    } finally {
      Date.now = before;
    }
    const res = await evaluateEventAlerts(jobCtx({ now: NOW }));
    expect(res.enqueued).toBe(1);
    const [row] = await outbox();
    expect(row?.payload.channel).toBe("webhook");
    expect(row?.payload.body).toMatchObject({ event: "alert.new_sale", website: { id: site.id } });
    expect(row?.payload.body.message).toContain("€49.00");
  });

  it("caps notifications per run and per day, then sends one limit notice", async () => {
    const owner = await createUser();
    const site = await createSite(owner.id);
    const alertId = await insertAlert(site.id, {
      trigger: JSON.stringify({ goalName: "click" }),
      template_message: "Clicked {{goal}}",
    });
    const s = await createSession({ siteId: site.id, startedAt: NOW - 100_000 });
    for (let i = 0; i < PER_RUN_CAP + 5; i++) {
      await createEvent({
        siteId: site.id,
        session: s,
        type: "custom",
        name: "click",
        ts: NOW - 50_000 + i,
      });
    }
    expect((await evaluateEventAlerts(jobCtx({ now: NOW }))).enqueued).toBe(PER_RUN_CAP);
    expect((await evaluateEventAlerts(jobCtx({ now: NOW + 60_000 }))).enqueued).toBe(5);

    await env.DB.prepare(
      "UPDATE alerts SET daily_count = 100, daily_count_reset_at = ? WHERE id = ?",
    )
      .bind(Math.floor(NOW / DAY) * DAY, alertId)
      .run();
    await createEvent({
      siteId: site.id,
      session: s,
      type: "custom",
      name: "click",
      ts: NOW + 100_000,
    });
    expect((await evaluateEventAlerts(jobCtx({ now: NOW + 120_000 }))).enqueued).toBe(1);
    const rows = await outbox();
    expect(rows.at(-1)?.dedupe_key).toBe(`limit:${alertId}:2026-11-02`);
    expect(rows.at(-1)?.payload.text).toContain("reached its limit of 100");
  });

  it("an idle minute reads one small table and writes nothing", async () => {
    const owner = await createUser();
    const site = await createSite(owner.id);
    await insertAlert(site.id, {
      trigger: JSON.stringify({ goalName: "signup" }),
      template_message: "Signup now!",
    });
    const m = meterEnv();
    await evaluateEventAlerts(jobCtx({ now: NOW, db: m.db }));
    expect(m.d1.rowsWritten).toBe(0);
    expect(m.d1.queries).toBe(2);
  });
});

describe("outbox.deliver", () => {
  async function seed(payload: unknown, key = "k1", siteId: string | null = null) {
    await enqueueStatement(
      env.DB,
      { siteId, payload: payload as never, dedupeKey: key },
      NOW - 1000,
    ).run();
  }

  it("sends email through Resend and records alert history and counters", async () => {
    const owner = await createUser();
    const site = await createSite(owner.id);
    const alertId = await insertAlert(site.id, { name: "Signups" });
    await seed(
      {
        channel: "email",
        to: ["a@example.com"],
        subject: "Hi",
        text: "Body",
        html: "<p>Body</p>",
        alert: {
          id: alertId,
          name: "Signups",
          triggerType: "goal",
          goalName: "signup",
          visitorId: "v1",
          summary: "signup",
        },
      },
      "goal:1",
      site.id,
    );
    const fetch = mockFetch().on("https://api.resend.com/emails", () =>
      jsonResponse({ id: "em_1" }),
    );
    const res = await deliverOutbox(jobCtx({ now: NOW, fetch, env: emailEnv() }));
    expect(res).toEqual({ sent: 1, failed: 0, retrying: 0 });
    const call = fetch.calls[0];
    expect(call?.headers.get("authorization")).toBe("Bearer re_test_key");
    expect(call?.headers.get("idempotency-key")).toBe("goal:1");
    expect(JSON.parse(call?.body ?? "{}")).toMatchObject({
      from: "DataGoat <alerts@example.com>",
      to: ["a@example.com"],
      subject: "Hi",
      text: "Body",
      html: "<p>Body</p>",
    });
    const [row] = await outbox();
    expect(row).toMatchObject({ status: "sent", attempts: 1 });
    const alert = await api(`/api/v1/admin/websites/${site.id}/alerts`, {
      cookie: await sessionCookie(owner.id),
    });
    expect(alert.body.data[0]).toMatchObject({ triggerCount: 1 });
    expect(alert.body.data[0].recentLogs[0]).toMatchObject({ status: "sent", visitorId: "v1" });
    // A second run finds nothing to do.
    expect(await deliverOutbox(jobCtx({ now: NOW + 60_000, fetch, env: emailEnv() }))).toEqual({
      sent: 0,
      failed: 0,
      retrying: 0,
    });
  });

  it("supports Postmark", async () => {
    await seed({
      channel: "email",
      to: ["a@example.com", "b@example.com"],
      subject: "S",
      text: "T",
    });
    const fetch = mockFetch().on("https://api.postmarkapp.com/email", () =>
      jsonResponse({ MessageID: "pm1", ErrorCode: 0 }),
    );
    const e = {
      ...env,
      POSTMARK_SERVER_TOKEN: "pm-token",
      EMAIL_FROM: "a@x.com",
    } as Cloudflare.Env;
    expect((await deliverOutbox(jobCtx({ now: NOW, fetch, env: e }))).sent).toBe(1);
    expect(fetch.calls[0]?.headers.get("x-postmark-server-token")).toBe("pm-token");
    expect(JSON.parse(fetch.calls[0]?.body ?? "{}")).toMatchObject({
      To: "a@example.com, b@example.com",
      MessageStream: "outbound",
    });
  });

  it("retries with backoff, honours Retry-After, and fails after the last attempt", async () => {
    const owner = await createUser();
    const site = await createSite(owner.id);
    const alertId = await insertAlert(site.id, {
      channel: "telegram",
      destination: JSON.stringify({ chatId: "1" }),
    });
    await seed(
      {
        channel: "telegram",
        chatId: "1",
        text: "x",
        alert: { id: alertId, name: "A", triggerType: "goal", summary: "s" },
      },
      "tg",
      site.id,
    );
    const fetch = mockFetch().on("https://api.telegram.org/", () =>
      jsonResponse({ ok: false, description: "Too Many Requests" }, 429, { "retry-after": "600" }),
    );
    const e = { ...env, TELEGRAM_BOT_TOKEN: "123:ABCDEFGHIJKLMNOPQRSTUVWX" } as Cloudflare.Env;
    expect((await deliverOutbox(jobCtx({ now: NOW, fetch, env: e }))).retrying).toBe(1);
    let [row] = await outbox();
    expect(row?.attempts).toBe(1);
    expect(row?.next_attempt_at).toBe(NOW + 600_000);
    expect(String(row?.last_error)).not.toContain("ABCDEFGHIJ");
    let t = NOW;
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      t = Number((await outbox())[0]?.next_attempt_at);
      await deliverOutbox(jobCtx({ now: t, fetch, env: e }));
    }
    [row] = await outbox();
    expect(row).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS });
    const hist = await env.DB.prepare("SELECT status, error FROM alert_history").all();
    expect(hist.results).toEqual([
      { status: "failed", error: expect.stringContaining("Too Many Requests") },
    ]);
  });

  it("permanent errors fail at once; missing email config is permanent", async () => {
    await seed({ channel: "email", to: ["a@example.com"], subject: "S", text: "T" });
    const res = await deliverOutbox(jobCtx({ now: NOW, fetch: mockFetch() }));
    expect(res.failed).toBe(1);
    expect((await outbox())[0]?.last_error).toContain("Email is not configured");
  });

  it("signs webhook deliveries with the alert's secret", async () => {
    const owner = await createUser();
    const site = await createSite(owner.id);
    const cookie = await sessionCookie(owner.id);
    const created = await api(`/api/v1/admin/websites/${site.id}/alerts`, {
      cookie,
      body: {
        name: "Hook",
        trigger: { type: "weekly_digest" },
        destination: { type: "webhook", url: "https://h.example.com/in" },
      },
    });
    const { id, destination } = created.body.data[0];
    await seed(
      {
        channel: "webhook",
        url: "https://h.example.com/in",
        body: { event: "x" },
        alert: { id, name: "Hook", triggerType: "weekly_digest", summary: "s" },
      },
      "wh",
      site.id,
    );
    const fetch = mockFetch().on("https://h.example.com/in", () => new Response("ok"));
    expect((await deliverOutbox(jobCtx({ now: NOW, fetch }))).sent).toBe(1);
    const sig = fetch.calls[0]?.headers.get("x-datagoat-signature") ?? "";
    const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sig) ?? [];
    const { hmacSha256Hex } = await import("../../../src/lib/crypto");
    expect(v1).toBe(await hmacSha256Hex(destination.signingSecret, `${t}.${fetch.calls[0]?.body}`));
  });

  it("idle delivery writes nothing; cleanup removes old settled rows", async () => {
    const m = meterEnv();
    await deliverOutbox(jobCtx({ now: NOW, db: m.db }));
    expect(m.d1.rowsWritten).toBe(0);
    await env.DB.prepare(
      "INSERT INTO outbox (kind, payload, status, next_attempt_at, created_at) VALUES ('email', '{}', 'sent', 0, ?), ('email', '{}', 'pending', 0, ?)",
    )
      .bind(NOW - 40 * DAY, NOW - 40 * DAY)
      .run();
    await cleanupOutbox(jobCtx({ now: NOW }));
    expect((await outbox()).map((r) => r.status)).toEqual(["pending"]);
  });
});

describe("alerts.traffic-spike", () => {
  it("fires at the configured multiple of the trailing hourly average, once per hour", async () => {
    const owner = await createUser();
    const site = await createSite(owner.id);
    await insertAlert(site.id, {
      trigger_type: "traffic_spike",
      trigger: JSON.stringify({ multiplier: 4, minSessions: 5 }),
      channel: "webhook",
      destination: JSON.stringify({ url: "https://h.example.com/s" }),
    });
    const now = Date.UTC(2026, 10, 2, 11, 3);
    // Baseline: 7 days x 48 sessions/day = 2 per hour.
    for (let d = 1; d <= 7; d++) {
      const day = new Date(now - d * DAY).toISOString().slice(0, 10);
      await env.DB.prepare(
        "INSERT INTO daily_stats (site_id, day, sessions, computed_at) VALUES (?, ?, 48, 0)",
      )
        .bind(site.id, day)
        .run();
    }
    for (let i = 0; i < 7; i++)
      await createSession({ siteId: site.id, startedAt: Date.UTC(2026, 10, 2, 10, 10 + i) });
    expect((await evaluateTrafficSpikes(jobCtx({ now }))).enqueued).toBe(0);
    await createSession({ siteId: site.id, startedAt: Date.UTC(2026, 10, 2, 10, 50) });
    expect((await evaluateTrafficSpikes(jobCtx({ now }))).enqueued).toBe(1);
    expect((await evaluateTrafficSpikes(jobCtx({ now: now + 5 * 60_000 }))).enqueued).toBe(0);
    const [row] = await outbox();
    expect(row?.dedupe_key).toMatch(/^spike:.*:2026-11-02T10$/);
    expect(row?.payload.body.message).toContain("8 sessions");
  });

  it("emails owners of sites with viral traffic alerts on (fallback baseline without rollups)", async () => {
    const owner = await createUser({ email: "o@example.com" });
    const site = await createSite(owner.id);
    await env.DB.prepare("UPDATE sites SET send_viral_traffic_alerts = 1 WHERE id = ?")
      .bind(site.id)
      .run();
    const now = Date.UTC(2026, 10, 2, 11, 3);
    for (let i = 0; i < 24; i++)
      await createSession({ siteId: site.id, startedAt: now - 2 * HOUR - i * HOUR });
    for (let i = 0; i < 25; i++)
      await createSession({ siteId: site.id, startedAt: now - 30 * 60_000 - i * 1000 });
    expect((await evaluateTrafficSpikes(jobCtx({ now, env: emailEnv() }))).enqueued).toBe(1);
    const [row] = await outbox();
    expect(row?.payload).toMatchObject({ channel: "email", to: ["o@example.com"] });
    expect(row?.payload.subject).toContain("Traffic spike");
  });
});

describe("alerts.digest and weekly reports", () => {
  it("sends the Monday weekly report (HTML and text) with week-over-week numbers", async () => {
    const owner = await createUser({ email: "owner@example.com" });
    const site = await createSite(owner.id, { name: "Shop" });
    await env.DB.prepare("UPDATE sites SET send_weekly_reports = 1 WHERE id = ?")
      .bind(site.id)
      .run();
    // Last week: Mon 2026-10-26 .. Sun 2026-11-01.
    const lastWeek = Date.UTC(2026, 9, 28, 12);
    for (let i = 0; i < 4; i++) {
      const s = await createSession({
        siteId: site.id,
        startedAt: lastWeek + i * 1000,
        channel: "Organic Search",
        source: "Google",
        country: "US",
      });
      await createEvent({ siteId: site.id, session: s, path: "/blog", ts: lastWeek + i * 1000 });
    }
    await createSession({ siteId: site.id, startedAt: Date.UTC(2026, 9, 20, 12) });
    await createPayment({ siteId: site.id, amountMinor: 2500, occurredAt: lastWeek });

    const ctx = jobCtx({ now: NOW, env: emailEnv() });
    await runDigests(ctx);
    expect(ctx.saved).toMatchObject({ weekly: { key: "2026-11-02", done: true } });
    const rows = await outbox();
    expect(rows).toHaveLength(1);
    const p = rows[0]?.payload;
    expect(p.subject).toBe("Weekly report for Shop: 4 visitors");
    expect(p.text).toContain("Visitors: 4 (+300% vs previous week)");
    expect(p.text).toContain("Revenue: $25.00");
    expect(p.text).toContain("Organic Search — 4 visitors");
    expect(p.text).toContain("/blog — 4 visitors");
    expect(p.text).toContain("United States — 4 visitors");
    expect(p.html).toContain("<table");
    // Re-running the same Monday sends nothing more.
    await runDigests(jobCtx({ now: NOW + 600_000, env: emailEnv(), state: ctx.saved }));
    expect(await outbox()).toHaveLength(1);
  });

  it("delivers daily digest rules for the previous local day and pages through many sites", async () => {
    const owner = await createUser();
    for (let i = 0; i < 10; i++) {
      const site = await createSite(owner.id);
      await insertAlert(site.id, {
        trigger_type: "daily_digest",
        channel: "telegram",
        destination: JSON.stringify({ chatId: "7" }),
      });
    }
    const tue = NOW + DAY; // Tuesday: no weekly queue
    const first = jobCtx({ now: tue });
    await runDigests(first);
    expect(first.saved).toMatchObject({ daily: { key: "2026-11-03", done: false } });
    expect(await outbox()).toHaveLength(8);
    const second = jobCtx({ now: tue + 600_000, state: first.saved });
    await runDigests(second);
    expect(second.saved).toMatchObject({ daily: { done: true } });
    const rows = await outbox();
    expect(rows).toHaveLength(10);
    expect(rows[0]?.payload.text).toContain("Daily report for");
    expect(rows[0]?.payload.text).toContain("(2026-11-02)");
  });

  it("does nothing before 07:00 UTC and writes no state when idle", async () => {
    const ctx = jobCtx({ now: Date.UTC(2026, 10, 2, 6, 50) });
    await runDigests(ctx);
    expect(ctx.saved).toBeUndefined();
  });
});

describe("account emails", () => {
  it("emails team invites when email is configured", async () => {
    const owner = await createUser({ name: "Ana" });
    const site = await createSite(owner.id, { name: "Shop" });
    const cookie = await sessionCookie(owner.id);
    const res = await apiWith(EMAIL, `/api/v1/admin/websites/${site.id}/team`, {
      cookie,
      body: { email: "new@example.com", role: "member" },
    });
    expect(res.body.data[0]).toMatchObject({
      emailQueued: true,
      message: "Invitation created and emailed to the user.",
    });
    const [row] = await outbox();
    expect(row?.payload).toMatchObject({
      channel: "email",
      to: ["new@example.com"],
      subject: "Join Shop on DataGoat",
    });
    expect(row?.payload.text).toContain(res.body.data[0].inviteUrl);
    expect(row?.payload.text).toContain("Ana invited you");

    const plain = await api(`/api/v1/admin/websites/${site.id}/team`, {
      cookie,
      body: { email: "x@example.com" },
    });
    expect(plain.body.data[0].emailQueued).toBe(false);
  });

  it("emails password reset links without revealing accounts", async () => {
    const user = await createUser({ email: "me@example.com" });
    const res = await apiWith(EMAIL, "/api/auth/password-resets", {
      body: { email: "me@example.com" },
    });
    expect(res.status).toBe(200);
    const unknown = await apiWith(EMAIL, "/api/auth/password-resets", {
      body: { email: "nobody@example.com" },
    });
    expect(unknown.body).toEqual(res.body);
    const again = await apiWith(EMAIL, "/api/auth/password-resets", {
      body: { email: "me@example.com" },
    });
    expect(again.status).toBe(200);
    const rows = await outbox();
    expect(rows).toHaveLength(1);
    const link = /https:\/\/datagoat\.test\/reset-password\/([A-Za-z0-9_-]+)/.exec(
      rows[0]?.payload.text,
    )?.[1];
    expect(link).toBeTruthy();
    const check = await api(`/api/auth/password-resets/${link}`);
    expect(check.body.data).toEqual({ email: "me@example.com" });
    expect(user.id).toBeTruthy();
    expect(
      (await api("/api/auth/password-resets", { body: { email: "me@example.com" } })).status,
    ).toBe(503);
  });
});

describe("growth cron jobs through the scheduler (write budget)", () => {
  it("an idle install costs no writes beyond the scheduler's own bookkeeping", async () => {
    const owner = await createUser();
    await createSite(owner.id);
    // The first run includes the daily IP-range refresh: its downloads fail (mocked) and are recorded.
    useGlobalFetch(mockFetch());
    const m = meterEnv();
    const at = Date.UTC(2026, 10, 3, 5, 0);
    await runScheduled(growthJobs, m.env, createExecutionContext(), at);
    const first = m.d1.rowsWritten;
    m.reset();
    // Next minute: only minute jobs run; with nothing to do they write nothing.
    await runScheduled(growthJobs, m.env, createExecutionContext(), at + 60_000);
    expect(m.d1.rowsWritten).toBe(0);
    expect(m.d1.queries).toBeLessThan(10);
    expect(first).toBeLessThan(40);
  });
});
