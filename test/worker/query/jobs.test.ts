import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { JOBS } from "../../../src/jobs";
import { runScheduled } from "../../../src/jobs/scheduler";
import { siteCache } from "../../../src/lib/site-cache";
import { DIMENSIONS, runBreakdown } from "../../../src/query/breakdowns";
import { goalsBreakdown, pagesBreakdown } from "../../../src/query/event-breakdowns";
import { predictionJob } from "../../../src/query/jobs/predictions";
import { retentionJob } from "../../../src/query/jobs/retention";
import { rollupJob } from "../../../src/query/jobs/rollups";
import { computeTimeseries } from "../../../src/query/timeseries";
import { meterEnv, resetDb } from "../../helpers/db";
import { createEvent, createPayment, createSession, createSite } from "../../helpers/factories";
import { seedFixture, T, V1 } from "../analytics/fixture";
import { bulkSessions, qcFor } from "./helpers";

beforeEach(() => resetDb());

const HOUR = 3_600_000;
const tick = (jobs: typeof JOBS, at: number, e: Cloudflare.Env = env) =>
  runScheduled(jobs, e, createExecutionContext(), at);

const rollupAt = (iso: string) => T(iso) + 7 * 60_000;

async function rows(sql: string, ...params: unknown[]) {
  return ((
    await env.DB.prepare(sql)
      .bind(...params)
      .all()
  ).results ?? []) as Array<Record<string, unknown>>;
}

describe("registration", () => {
  it("registers the W2 jobs", () => {
    expect(JOBS.map((j) => j.name)).toEqual(
      expect.arrayContaining(["query.rollups", "query.retention", "query.predictions"]),
    );
  });
});

describe("query.rollups", () => {
  it("rolls closed days into the four rollup tables", async () => {
    const f = await seedFixture();
    const r = await tick([rollupJob], rollupAt("2026-03-13T10:00:00Z"));
    expect(r.results[0]?.status).toBe("ok");
    const stats = await rows("SELECT * FROM daily_stats WHERE site_id = ? ORDER BY day", f.site.id);
    expect(stats).toHaveLength(2);
    expect(stats[0]).toMatchObject({
      day: "2026-03-10",
      visitors: 2,
      new_visitors: 2,
      returning_visitors: 0,
      sessions: 2,
      pageviews: 4,
      bounces: 1,
      duration_sum: 300_000,
      events: 5,
      revenue_minor: 4999,
      new_revenue_minor: 4999,
      payments: 1,
      paying_visitors: 1,
    });
    expect(stats[1]).toMatchObject({
      day: "2026-03-11",
      visitors: 2,
      new_visitors: 1,
      returning_visitors: 1,
      events: 5,
      revenue_minor: 1000,
      renewal_revenue_minor: 1000,
    });
    const dims = await rows(
      "SELECT day, value, visitors, sessions, revenue_minor, payments FROM daily_dimensions WHERE site_id = ? AND dimension = 'channel' ORDER BY day, value",
      f.site.id,
    );
    expect(dims).toEqual([
      {
        day: "2026-03-10",
        value: "Direct",
        visitors: 1,
        sessions: 1,
        revenue_minor: 0,
        payments: 0,
      },
      {
        day: "2026-03-10",
        value: "Organic Search",
        visitors: 1,
        sessions: 1,
        revenue_minor: 4999,
        payments: 1,
      },
      {
        day: "2026-03-11",
        value: "Email",
        visitors: 1,
        sessions: 1,
        revenue_minor: 1000,
        payments: 1,
      },
      {
        day: "2026-03-11",
        value: "Organic Social",
        visitors: 1,
        sessions: 1,
        revenue_minor: 0,
        payments: 0,
      },
    ]);
    const browsers = await rows(
      "SELECT value FROM daily_dimensions WHERE site_id = ? AND dimension = 'browser' ORDER BY value",
      f.site.id,
    );
    expect(browsers.map((b) => b.value)).toEqual(["Chrome", "Firefox", "Safari", "Safari"]);
    const pages = await rows(
      "SELECT day, path, pageviews, visitors, entries, exits FROM daily_pages WHERE site_id = ? AND day = '2026-03-10' ORDER BY path",
      f.site.id,
    );
    expect(pages).toEqual([
      { day: "2026-03-10", path: "/", pageviews: 1, visitors: 1, entries: 1, exits: 1 },
      { day: "2026-03-10", path: "/blog/x", pageviews: 1, visitors: 1, entries: 1, exits: 1 },
      { day: "2026-03-10", path: "/pricing", pageviews: 1, visitors: 1, entries: 0, exits: 0 },
      { day: "2026-03-10", path: "/signup", pageviews: 1, visitors: 1, entries: 0, exits: 0 },
    ]);
    const goals = await rows(
      "SELECT day, name, completions, visitors FROM daily_goals WHERE site_id = ? ORDER BY day",
      f.site.id,
    );
    expect(goals).toEqual([
      { day: "2026-03-10", name: "signup", completions: 1, visitors: 1 },
      { day: "2026-03-11", name: "checkout_started", completions: 1, visitors: 1 },
    ]);
    const state = await rows("SELECT * FROM rollup_state WHERE site_id = ?", f.site.id);
    expect(state[0]).toMatchObject({
      timezone: "UTC",
      first_day: "2026-03-10",
      through_day: "2026-03-12",
    });
  });

  it("writes only changed rows (write budget)", async () => {
    const f = await seedFixture();
    await tick([rollupJob], rollupAt("2026-03-13T10:00:00Z"));
    // Same day, next hour: already rolled through yesterday → no rollup work at all.
    let m = meterEnv();
    await tick([rollupJob], rollupAt("2026-03-13T11:00:00Z"), m.env);
    // job_state: claim + result (the scheduler's two rows per hourly job).
    expect(m.d1.rowsWritten).toBe(2);
    // Next day: re-rolls 03-11..03-13; nothing changed except the watermark (1 row).
    m = meterEnv();
    await tick([rollupJob], rollupAt("2026-03-14T10:00:00Z"), m.env);
    expect(m.d1.rowsWritten).toBe(3);
    // A late session on 03-12 (re-rolled the next day) changes only its own rows.
    await createSession({
      siteId: f.site.id,
      startedAt: T("2026-03-13T23:00:00Z"),
      country: "US",
      channel: "Direct",
    });
    m = meterEnv();
    await tick([rollupJob], rollupAt("2026-03-15T10:00:00Z"), m.env);
    const after = await rows(
      "SELECT day, visitors FROM daily_stats WHERE site_id = ? AND day = '2026-03-13'",
      f.site.id,
    );
    expect(after).toEqual([{ day: "2026-03-13", visitors: 1 }]);
    // daily_stats 1 + daily_pages 1 + dimensions (9 dims, one value each; NULL region/city/os/… → '') 9
    // + rollup_state 1 + job_state 2.
    expect(m.d1.rowsWritten).toBe(14);
    expect(m.d1.queries).toBeLessThanOrEqual(6);
  });

  it("idle websites without traffic cost no writes", async () => {
    await createSite(null);
    const m = meterEnv();
    await tick([rollupJob], rollupAt("2026-03-13T10:00:00Z"), m.env);
    expect(m.d1.rowsWritten).toBe(2);
  });

  it("backfills in chunks of 14 days and catches up across runs", async () => {
    const f = await seedFixture();
    await createSession({ siteId: f.site.id, startedAt: T("2026-04-20T10:00:00Z") });
    await tick([rollupJob], rollupAt("2026-05-01T10:00:00Z"));
    expect(
      (await rows("SELECT through_day FROM rollup_state WHERE site_id = ?", f.site.id))[0]
        ?.through_day,
    ).toBe("2026-03-23");
    for (let i = 1; i <= 4; i++)
      await tick([rollupJob], rollupAt("2026-05-01T10:00:00Z") + i * HOUR);
    expect(
      (await rows("SELECT through_day FROM rollup_state WHERE site_id = ?", f.site.id))[0]
        ?.through_day,
    ).toBe("2026-04-30");
    expect(
      (
        await rows(
          "SELECT visitors FROM daily_stats WHERE site_id = ? AND day = '2026-04-20'",
          f.site.id,
        )
      )[0]?.visitors,
    ).toBe(1);
  });

  it("rebuilds after a timezone change", async () => {
    const f = await seedFixture();
    await tick([rollupJob], rollupAt("2026-03-13T10:00:00Z"));
    await env.DB.prepare("UPDATE sites SET timezone = 'Asia/Tokyo' WHERE id = ?")
      .bind(f.site.id)
      .run();
    siteCache.clear();
    await tick([rollupJob], rollupAt("2026-03-13T11:00:00Z"));
    expect(await rows("SELECT * FROM daily_stats WHERE site_id = ?", f.site.id)).toEqual([]);
    expect(
      (
        await rows("SELECT timezone, through_day FROM rollup_state WHERE site_id = ?", f.site.id)
      )[0],
    ).toEqual({
      timezone: "Asia/Tokyo",
      through_day: null,
    });
    await tick([rollupJob], rollupAt("2026-03-13T12:00:00Z"));
    const stats = await rows(
      "SELECT day, sessions FROM daily_stats WHERE site_id = ? ORDER BY day",
      f.site.id,
    );
    // In Tokyo, sessions A/B fall on 03-10 (19:00-20:00), C on 03-11 (18:00) and D on 03-11 (21:00).
    expect(stats).toEqual([
      { day: "2026-03-10", sessions: 2 },
      { day: "2026-03-11", sessions: 2 },
    ]);
  });

  it("rollup reads match raw reads for whole days (visitors as daily uniques)", async () => {
    const f = await seedFixture();
    await tick([rollupJob], rollupAt("2026-03-13T10:00:00Z"));
    const range = { startAt: "2026-03-10", endAt: "2026-03-11" };
    const now = T("2026-03-13T12:00:00Z");
    const rolled = qcFor(f.site, range, { now, envOverrides: { ROLLUP_MIN_SESSIONS: "0" } });
    const rawQc = qcFor(f.site, range, { now, envOverrides: { ROLLUP_MIN_SESSIONS: "999999" } });
    const page = { limit: 100, offset: 0 };
    for (const spec of [DIMENSIONS.referrers, DIMENSIONS.channels, DIMENSIONS.entryPages]) {
      const a = await runBreakdown(rolled, spec, page);
      const b = await runBreakdown(rawQc, spec, page);
      expect(a.approximate).toBe(true);
      expect(b.approximate).toBe(false);
      // Each visitor has one session per value here, so the daily-unique sums are exact.
      expect(a.rows).toEqual(b.rows);
      expect(a.total).toBe(b.total);
    }
    // v2 came from France on both days: rollups count daily uniques (2), raw counts 1.
    const ca = await runBreakdown(rolled, DIMENSIONS.countries, page);
    const cb = await runBreakdown(rawQc, DIMENSIONS.countries, page);
    expect(ca.rows.find((r) => r.values[0] === "FR")?.visitors).toBe(2);
    expect(cb.rows.find((r) => r.values[0] === "FR")?.visitors).toBe(1);
    expect(ca.rows.find((r) => r.values[0] === "US")).toEqual(
      cb.rows.find((r) => r.values[0] === "US"),
    );
    const pa = await pagesBreakdown(rolled, page);
    const pb = await pagesBreakdown(rawQc, page);
    expect(pa.approximate).toBe(true);
    // v2 viewed /pricing on 03-11 and v1 on 03-10: daily uniques sum to the same 3.
    expect(pa.rows).toEqual(pb.rows);
    const ga = await goalsBreakdown(rolled, page, true);
    const gb = await goalsBreakdown(rawQc, page, true);
    expect(ga.rows).toEqual(gb.rows);
    expect(ga.totalVisitors).toBe(4); // daily uniques: 2 + 2
    expect(gb.totalVisitors).toBe(3);
    const ta = await computeTimeseries(
      { ...rolled, range: rolled.range as NonNullable<typeof rolled.range> },
      "day",
      { goals: true },
    );
    const tb = await computeTimeseries(
      { ...rawQc, range: rawQc.range as NonNullable<typeof rawQc.range> },
      "day",
      { goals: true },
    );
    expect(ta.buckets).toEqual(tb.buckets);
    expect(ta.buckets[0]?.goals).toEqual({ signup: 1 });
    expect(ta.approximate).toBe(true);
  });

  it("hybrid reads add raw days after the watermark", async () => {
    const f = await seedFixture();
    await tick([rollupJob], rollupAt("2026-03-11T10:00:00Z")); // rolls 03-10 only
    const qc = qcFor(
      f.site,
      { startAt: "2026-03-10", endAt: "2026-03-11" },
      {
        now: T("2026-03-11T13:00:00Z"),
        envOverrides: { ROLLUP_MIN_SESSIONS: "0" },
      },
    );
    const res = await runBreakdown(qc, DIMENSIONS.channels, { limit: 100, offset: 0 });
    expect(res.approximate).toBe(true);
    expect(res.rows.map((r) => [r.values[0], r.visitors])).toEqual([
      ["Direct", 1],
      ["Email", 1],
      ["Organic Search", 1],
      ["Organic Social", 1],
    ]);
  });
});

describe("query.retention", () => {
  it("prunes events older than retention_days, only for rolled-up days, in bounded chunks", async () => {
    const f = await seedFixture();
    await env.DB.prepare("UPDATE sites SET retention_days = 30 WHERE id = ?").bind(f.site.id).run();
    const at = T("2026-06-01T00:23:00Z");
    // Without rollups nothing is pruned (the rollups must keep long-range history first).
    let m = meterEnv();
    await tick([retentionJob], at, m.env);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE site_id = ?")
        .bind(f.site.id)
        .first("n"),
    ).toBe(10);
    expect(m.d1.rowsWritten).toBe(2);
    await tick([rollupJob], rollupAt("2026-05-31T10:00:00Z"));
    await tick([rollupJob], rollupAt("2026-05-31T11:00:00Z"));
    await tick([rollupJob], rollupAt("2026-05-31T12:00:00Z"));
    await tick([rollupJob], rollupAt("2026-05-31T13:00:00Z"));
    await tick([rollupJob], rollupAt("2026-05-31T14:00:00Z"));
    await tick([rollupJob], rollupAt("2026-05-31T15:00:00Z"));
    m = meterEnv();
    await tick([retentionJob], at + HOUR, {
      ...m.env,
      RETENTION_ROWS_PER_RUN: "4",
    } as Cloudflare.Env);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE site_id = ?")
        .bind(f.site.id)
        .first("n"),
    ).toBe(6);
    // 4 events: rows + events_time entries (+ activity index entries for non-pageviews) + job_state.
    expect(m.d1.rowsWritten).toBeLessThanOrEqual(4 * 4 + 2);
    for (let i = 2; i <= 4; i++) await tick([retentionJob], at + i * HOUR);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE site_id = ?")
        .bind(f.site.id)
        .first("n"),
    ).toBe(0);
    // Sessions, visitors and payments are kept; long-range reads now come from rollups.
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE site_id = ?")
        .bind(f.site.id)
        .first("n"),
    ).toBe(4);
    const qc = qcFor(
      { ...f.site, retentionDays: 30 },
      { startAt: "2026-03-10", endAt: "2026-03-11" },
      { now: at },
    );
    const pages = await pagesBreakdown(qc, { limit: 10, offset: 0 });
    expect(pages.approximate).toBe(true);
    expect(pages.rows[0]).toMatchObject({ path: "/pricing", visitors: 3 });
  });

  it("does nothing for websites without retention", async () => {
    await seedFixture();
    const m = meterEnv();
    await tick([retentionJob], T("2026-06-01T00:23:00Z"), m.env);
    expect(m.d1.rowsWritten).toBe(2);
  });
});

describe("query.predictions", () => {
  async function trainable(payments = 30) {
    const owner = (await import("../../helpers/factories")).createUser;
    const user = await owner();
    const site = await createSite(user.id);
    const now = Date.now();
    await bulkSessions(site.id, 1200, now - 30 * 86_400_000, 29 * 86_400_000);
    // Organic Search visitors (i % 4 = 0) convert.
    await env.DB.batch(
      Array.from({ length: payments }, (_, k) =>
        env.DB.prepare(
          `INSERT INTO payments (site_id, id, provider, provider_txn_id, kind, amount_minor, currency, reporting_minor,
             reporting_currency, visitor_id, first_session_id, attributed_via, source, occurred_at, created_at, updated_at)
           VALUES (?, ?, 'api', ?, 'payment', 5000, 'USD', 5000, 'USD', ?, ?, 'api', 'api', ?, ?, ?)`,
        ).bind(site.id, `p${k}`, `t${k}`, `v${k * 4}`, `sv${k * 4}`, now - 86_400_000, now, now),
      ),
    );
    return { site, now };
  }

  it("trains when activated, writes only when the model changed, and scores visitors", async () => {
    const { site, now } = await trainable();
    const at = Math.floor(now / 86_400_000) * 86_400_000 + (4 * 60 + 43) * 60_000;
    const m = meterEnv();
    await tick([predictionJob], at, m.env);
    const row = (await rows("SELECT * FROM prediction_models WHERE site_id = ?", site.id))[0];
    expect(row).toBeDefined();
    expect(row?.sample_visitors).toBe(1200);
    expect(Number(row?.baseline_conversion_rate)).toBeCloseTo(30 / 1200, 6);
    expect(row?.baseline_average_value).toBe(50);
    const model = JSON.parse(String(row?.model));
    expect(model.dims.channel["Organic Search"]).toEqual([300, 30, 1500]);
    expect(model.dims.browser.Safari[0]).toBe(400); // Mobile Safari merged
    // Re-training the same data writes nothing to prediction_models.
    const again = meterEnv();
    await tick([predictionJob], at + 86_400_000, again.env);
    expect(again.d1.rowsWritten).toBe(2); // job_state only
    expect(
      (await rows("SELECT trained_at FROM prediction_models WHERE site_id = ?", site.id))[0]
        ?.trained_at,
    ).toBe(at);

    // The realtime map scores live visitors; customers get 100.
    const live = await createSession({
      siteId: site.id,
      visitorId: V1,
      startedAt: Date.now() - 60_000,
      channel: "Organic Search",
      country: "US",
      device: "desktop",
      browser: "Chrome",
      os: "Mac OS",
      source: "Google",
      referrerDomain: "google.com",
    });
    await createEvent({ siteId: site.id, session: live, ts: Date.now() - 30_000 });
    const cold = await createSession({
      siteId: site.id,
      startedAt: Date.now() - 60_000,
      channel: "Direct",
      country: "IN",
      device: "tablet",
      browser: "Firefox",
      os: "Windows",
    });
    await createEvent({ siteId: site.id, session: cold, ts: Date.now() - 20_000 });
    const { realtimeMap } = await import("../../../src/query/realtime");
    const map = await realtimeMap(qcFor(site, null));
    expect(map.hasConversionPredictions).toBe(true);
    expect(map.conversionMetrics?.baselineConversionRate).toBeCloseTo(0.025, 6);
    const hot = map.visitors.find((v) => v.visitorId === V1)?.conversionLikelihood as {
      score: number;
    };
    const coldScore = map.visitors.find((v) => v.visitorId === cold.visitorId)
      ?.conversionLikelihood as {
      score: number;
    };
    expect(hot.score).toBeGreaterThan(coldScore.score);
    await createPayment({
      siteId: site.id,
      amountMinor: 100,
      occurredAt: Date.now() - 1000,
      visitorId: V1,
      firstSessionId: live.id,
    });
    const after = await realtimeMap(qcFor(site, null));
    expect(after.visitors.find((v) => v.visitorId === V1)?.conversionLikelihood).toEqual({
      score: 100,
      confidence: 1,
      isCustomer: true,
    });
  });

  it("stays off below 1,000 visitors or 10 payments and removes stale models", async () => {
    const { site, now } = await trainable(9);
    await env.DB.prepare(
      "INSERT INTO prediction_models (site_id, model, baseline_conversion_rate, baseline_average_value, sample_visitors, trained_at) VALUES (?, '{}', 0, 0, 0, 0)",
    )
      .bind(site.id)
      .run();
    await tick([predictionJob], Math.floor(now / 86_400_000) * 86_400_000 + (4 * 60 + 43) * 60_000);
    expect(await rows("SELECT * FROM prediction_models WHERE site_id = ?", site.id)).toEqual([]);
  });
});
