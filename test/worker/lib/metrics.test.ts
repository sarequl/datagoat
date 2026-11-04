import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { compileFilters, parseFilters } from "../../../src/lib/filters";
import {
  deriveMetrics,
  paymentAggregatesSql,
  paymentSessionJoinSql,
  pickFields,
  sessionAggregatesSql,
  visitorBreakdown,
  visitorTypeAggregatesSql,
} from "../../../src/lib/metrics";
import { prepare, raw, sql } from "../../../src/lib/sql";
import { resetDb } from "../../helpers/db";
import { createPayment, createSession, createSite } from "../../helpers/factories";

describe("deriveMetrics", () => {
  it("computes DataFast's overview fields with their rounding", () => {
    const m = deriveMetrics(
      {
        visitors: 3,
        sessions: 4,
        pageviews: 9,
        bounces: 1,
        durationSum: 270_000,
        revenueMinor: 4999,
        payments: 2,
        payingVisitors: 1,
        newVisitors: 2,
        returningVisitors: 1,
      },
      "USD",
    );
    expect(m).toMatchObject({
      visitors: 3,
      sessions: 4,
      pageviews: 9,
      bounce_rate: 25,
      avg_session_duration: 68,
      revenue: 49.99,
      payments: 2,
      revenue_per_visitor: 16.66,
      conversion_rate: 33.33,
      currency: "USD",
      visitorBreakdown: { new: 2, returning: 1, newPercentage: 66.67, returningPercentage: 33.33 },
    });
    expect(pickFields(m, ["visitors", "visitor_breakdown"])).toEqual({
      visitors: 3,
      visitorBreakdown: m.visitorBreakdown,
    });
  });

  it("returns zeros instead of NaN for empty ranges", () => {
    const m = deriveMetrics(
      {
        visitors: 0,
        sessions: 0,
        pageviews: 0,
        bounces: 0,
        durationSum: 0,
        revenueMinor: 0,
        payments: 0,
        payingVisitors: 0,
      },
      "EUR",
    );
    expect([
      m.bounce_rate,
      m.avg_session_duration,
      m.revenue_per_visitor,
      m.conversion_rate,
    ]).toEqual([0, 0, 0, 0]);
    expect(visitorBreakdown(0, 0).newPercentage).toBe(0);
  });
});

describe("metric SQL against D1", () => {
  let siteId = "";
  const t0 = Date.UTC(2026, 4, 10, 12);
  const range = { startMs: Date.UTC(2026, 4, 1), endMs: Date.UTC(2026, 5, 1) };
  const firstSession: Record<string, string> = {};

  beforeAll(async () => {
    await resetDb();
    siteId = (await createSite(null)).id;
    // v1: first visit via Google (bounce), returns directly and pays.
    const a1 = await createSession({
      siteId,
      visitorId: "v1",
      startedAt: t0,
      sessionNumber: 1,
      pageviews: 1,
      channel: "Organic Search",
      source: "Google",
      referrerDomain: "google.com",
    });
    const a2 = await createSession({
      siteId,
      visitorId: "v1",
      startedAt: t0 + 3600_000,
      sessionNumber: 2,
      pageviews: 3,
      durationMs: 120_000,
      channel: "Direct",
    });
    // v2: returning visitor, 2 pageviews, 60 s.
    await createSession({
      siteId,
      visitorId: "v2",
      startedAt: t0,
      sessionNumber: 4,
      pageviews: 2,
      durationMs: 60_000,
      channel: "Direct",
    });
    // v3: cookieless; one pageview plus one goal, so not a bounce.
    await createSession({
      siteId,
      visitorId: "v3",
      startedAt: t0,
      sessionNumber: null,
      pageviews: 1,
      interactions: 1,
      durationMs: 30_000,
      channel: "Referral",
      source: "Hacker News",
      referrerDomain: "news.ycombinator.com",
    });
    firstSession.v1 = a1.id;
    await createPayment({
      siteId,
      visitorId: "v1",
      amountMinor: 5000,
      occurredAt: t0 + 3700_000,
      firstSessionId: a1.id,
      lastSessionId: a2.id,
      lastNonDirectSessionId: a1.id,
    });
    await createPayment({
      siteId,
      visitorId: "v1",
      amountMinor: 2000,
      kind: "renewal",
      occurredAt: t0 + 86_400_000,
      firstSessionId: a1.id,
      lastSessionId: a2.id,
      lastNonDirectSessionId: a1.id,
    });
    await createPayment({
      siteId,
      visitorId: "v1",
      amountMinor: -1000,
      kind: "refund",
      occurredAt: t0 + 2 * 86_400_000,
      firstSessionId: a1.id,
      lastSessionId: a2.id,
      lastNonDirectSessionId: a1.id,
    });
    await createPayment({ siteId, visitorId: null, amountMinor: 9900, occurredAt: t0 });
    await createPayment({
      siteId,
      visitorId: "v2",
      amountMinor: 0,
      kind: "free_trial",
      occurredAt: t0,
    });
  });

  const sessionWhere = (query = "") => {
    const filters = compileFilters(parseFilters(new URLSearchParams(query)), { siteId, range });
    return sql`s.site_id = ${siteId} AND s.started_at >= ${range.startMs} AND s.started_at < ${range.endMs} AND ${filters}`;
  };

  it("aggregates sessions", async () => {
    const row = await prepare(
      env.DB,
      sql`SELECT ${raw(sessionAggregatesSql())} FROM sessions s WHERE ${sessionWhere()}`,
    ).first();
    expect(row).toEqual({
      visitors: 3,
      sessions: 4,
      pageviews: 7,
      bounces: 1,
      duration_sum: 210_000,
    });
  });

  it("classifies new and returning visitors by their lowest session number", async () => {
    const row = await prepare(
      env.DB,
      sql`SELECT ${raw(visitorTypeAggregatesSql())} FROM (SELECT s.visitor_id, MIN(s.session_number) AS first_number FROM sessions s WHERE ${sessionWhere()} GROUP BY s.visitor_id)`,
    ).first();
    expect(row).toEqual({ classified_visitors: 2, new_visitors: 1, returning_visitors: 1 });
  });

  it("totals revenue with refunds negative and renewals optional", async () => {
    const q = (renewals: boolean) =>
      prepare(
        env.DB,
        sql`SELECT ${raw(paymentAggregatesSql(renewals))} FROM payments p WHERE p.site_id = ${siteId} AND p.occurred_at >= ${range.startMs} AND p.occurred_at < ${range.endMs}`,
      ).first();
    expect(await q(true)).toEqual({
      revenue_minor: 15900,
      payments: 3,
      paying_visitors: 1,
      new_revenue_minor: 14900,
      renewal_revenue_minor: 2000,
      refund_minor: -1000,
    });
    expect(await q(false)).toMatchObject({ revenue_minor: 13900, payments: 2 });
  });

  it("attributes revenue to dimensions per attribution model", async () => {
    const byChannel = async (
      model: "first_touch" | "last_touch" | "last_non_direct",
      filters = "",
    ) => {
      const res = await prepare(
        env.DB,
        sql`SELECT s.channel AS channel, ${raw(paymentAggregatesSql(true))} FROM payments p ${raw(paymentSessionJoinSql(model))}
            WHERE p.site_id = ${siteId} AND p.occurred_at >= ${range.startMs} AND p.occurred_at < ${range.endMs}
              AND ${compileFilters(parseFilters(new URLSearchParams(filters)), { siteId, range })}
            GROUP BY 1 ORDER BY 1`,
      ).all<{ channel: string; revenue_minor: number }>();
      return Object.fromEntries((res.results ?? []).map((r) => [r.channel, r.revenue_minor]));
    };
    expect(await byChannel("first_touch")).toEqual({ "Organic Search": 6000 });
    expect(await byChannel("last_touch")).toEqual({ Direct: 6000 });
    expect(await byChannel("last_non_direct")).toEqual({ "Organic Search": 6000 });
    expect(await byChannel("first_touch", "filter_referrer=Google")).toEqual({
      "Organic Search": 6000,
    });
    expect(await byChannel("first_touch", "filter_country=US")).toEqual({});
  });
});
