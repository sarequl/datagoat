/**
 * EXPLAIN QUERY PLAN assertions for the hot analytics queries: every statement the query layer
 * runs must reach `events`, `sessions` and `payments` through an index (never a full table scan),
 * and the specific index each hot path relies on must be used.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { parseFilters } from "../../../src/lib/filters";
import { DIMENSIONS, runBreakdown } from "../../../src/query/breakdowns";
import type { QueryContext } from "../../../src/query/context";
import {
  exitClicks,
  goalProperties,
  goalsBreakdown,
  pagesBreakdown,
} from "../../../src/query/event-breakdowns";
import { computeFunnel } from "../../../src/query/funnels";
import { computeTotals } from "../../../src/query/overview";
import { realtimeMap, realtimeReplay, realtimeVisitors } from "../../../src/query/realtime";
import { computeTimeseries } from "../../../src/query/timeseries";
import { listVisitors, parseVisitorListParams, visitorProfile } from "../../../src/query/visitors";
import { resetDb } from "../../helpers/db";
import { seedFixture, V1 } from "../analytics/fixture";
import { type Captured, capturing, plan, qcFor } from "./helpers";

beforeEach(() => resetDb());

const page = { limit: 100, offset: 0 };
// Base tables and their aliases (subquery/CTE scans such as `SCAN x` or `SCAN sv` are fine).
const FULL_SCAN = /^SCAN (events|sessions|payments|visitors|e|s|p|vis)( |$)(?!USING)/;

async function plans(run: (qc: QueryContext) => Promise<unknown>, qc: QueryContext) {
  const cap = capturing(qc.db);
  await run({ ...qc, db: cap.db });
  const out: Array<{ sql: string; plan: string[] }> = [];
  for (const c of cap.statements as Captured[]) out.push({ sql: c.sql, plan: await plan(c) });
  return out;
}

function expectNoFullScans(results: Array<{ sql: string; plan: string[] }>) {
  for (const r of results) {
    for (const line of r.plan) {
      if (FULL_SCAN.test(line)) throw new Error(`Full scan "${line}" in:\n${r.sql}`);
    }
  }
}

const allPlans = (results: Array<{ plan: string[] }>) => results.flatMap((r) => r.plan).join("\n");

describe("query plans", () => {
  it("overview, timeseries and breakdowns read sessions through sessions_time", async () => {
    const f = await seedFixture();
    const qc = qcFor(f.site, { startAt: "2026-03-10", endAt: "2026-03-11" });
    const filtered = {
      ...qc,
      filters: parseFilters({ filter_country: "US", filter_page: "/pricing" }),
    };
    for (const run of [
      (q: QueryContext) => computeTotals(q),
      (q: QueryContext) =>
        computeTimeseries({ ...q, range: q.range as NonNullable<typeof q.range> }, "day"),
      (q: QueryContext) => runBreakdown(q, DIMENSIONS.referrers, page),
      (q: QueryContext) => runBreakdown(q, DIMENSIONS.campaigns, page),
    ]) {
      for (const q of [qc, filtered]) {
        const res = await plans(run, q);
        expectNoFullScans(res);
        // Filtered queries may enter sessions by visitor (sessions_visitor) from a page filter.
        expect(allPlans(res)).toMatch(
          q === qc ? /sessions_time/ : /sessions_time|sessions_visitor/,
        );
        expect(allPlans(res)).toMatch(/payments_time/);
      }
    }
    // The visitor-level page filter uses the events time index.
    const res = await plans((q) => computeTotals(q), filtered);
    expect(allPlans(res)).toMatch(/events_time/);
  });

  it("goal, exit-click and goal-property queries use the partial events_activity index", async () => {
    const f = await seedFixture();
    const qc = qcFor(f.site, { startAt: "2026-03-10", endAt: "2026-03-11" });
    for (const run of [
      (q: QueryContext) => goalsBreakdown(q, page, true),
      (q: QueryContext) => exitClicks(q, page),
      (q: QueryContext) => goalProperties(q, "signup", null, page),
    ]) {
      const res = await plans(run, qc);
      expectNoFullScans(res);
      expect(allPlans(res)).toMatch(/events_activity/);
    }
    const goalFilter = { ...qc, filters: parseFilters({ filter_goal: "signup" }) };
    expect(allPlans(await plans((q) => computeTotals(q), goalFilter))).toMatch(
      /events_time|events_activity/,
    );
  });

  it("pages and funnels read pageviews through events_time", async () => {
    const f = await seedFixture();
    const qc = qcFor(f.site, { startAt: "2026-03-10", endAt: "2026-03-11" });
    const pages = await plans((q) => pagesBreakdown(q, page), qc);
    expectNoFullScans(pages);
    expect(allPlans(pages)).toMatch(/events_time/);
    const funnel = await plans(
      (q) =>
        computeFunnel(q, [
          { id: "a", name: "A", type: "pageview", url: "/" },
          { id: "b", name: "B", type: "goal", goalName: "signup", goalCompletionType: "completed" },
        ]),
      qc,
    );
    expectNoFullScans(funnel);
    expect(allPlans(funnel)).toMatch(/events_time/);
    expect(allPlans(funnel)).toMatch(/events_activity/);
  });

  it("realtime, visitor list and visitor profile use their indexes", async () => {
    const f = await seedFixture();
    const qc = qcFor(f.site, null);
    const rt = await plans((q) => realtimeVisitors(q.db, q.site.id, Date.now()), qc);
    expect(allPlans(rt)).toMatch(/events_time/);
    const map = await plans((q) => realtimeMap(q), qc);
    expectNoFullScans(map);
    expect(allPlans(map)).toMatch(/events_activity/);
    expect(allPlans(map)).toMatch(/sessions_visitor/);
    expect(allPlans(map)).toMatch(/payments_visitor/);
    const replay = await plans((q) => realtimeReplay(q), qc);
    expectNoFullScans(replay);
    expect(allPlans(replay)).toMatch(/events_time/);
    expect(allPlans(replay)).toMatch(/events_activity/);
    expect(allPlans(replay)).toMatch(/payments_visitor/);
    expect(allPlans(replay)).toMatch(/payments_time/);
    const profile = await plans((q) => visitorProfile(q, V1), qc);
    expectNoFullScans(profile);
    expect(allPlans(profile)).toMatch(/sessions_visitor/);
    expect(allPlans(profile)).toMatch(/events_visitor_activity/);
    expect(allPlans(profile)).toMatch(/payments_visitor/);
    const ranged = qcFor(f.site, { startAt: "2026-03-10", endAt: "2026-03-11" });
    const list = await plans(
      (q) => listVisitors(q, parseVisitorListParams(new URLSearchParams()), page),
      ranged,
    );
    expectNoFullScans(list);
    expect(allPlans(list)).toMatch(/sessions_time/);
  });
});
