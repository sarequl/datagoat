/**
 * Read budget (plan §9): a 30-day overview of a website with 100,000 sessions a month must stay
 * well under 300,000 rows read and use one D1 query; with rollups, a 30-day breakdown reads a
 * small fraction of the sessions.
 */
import { createExecutionContext, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { runScheduled } from "../../../src/jobs/scheduler";
import { createD1Meter } from "../../../src/lib/d1";
import type { Site } from "../../../src/lib/sites";
import { addDays, localDate } from "../../../src/lib/time";
import { DIMENSIONS, runBreakdown } from "../../../src/query/breakdowns";
import { rollupJob } from "../../../src/query/jobs/rollups";
import { computeTotals } from "../../../src/query/overview";
import { resetDb } from "../../helpers/db";
import { createSite, createUser } from "../../helpers/factories";
import { bulkSessions, qcFor } from "./helpers";

const DAY = 86_400_000;
let site: Site;
const now = Date.UTC(2026, 9, 31, 12, 0); // 2026-10-31 12:00 UTC
const range = { startAt: "2026-10-01", endAt: "2026-10-30" };

beforeAll(async () => {
  await resetDb();
  const owner = await createUser();
  site = await createSite(owner.id);
  // 100,000 sessions in October (plus 20,000 in September that a 30-day query must not read).
  await bulkSessions(site.id, 100_000, Date.UTC(2026, 9, 1), 30 * DAY, { prefix: "o" });
  await bulkSessions(site.id, 20_000, Date.UTC(2026, 8, 1), 29 * DAY, { prefix: "s" });
  await env.DB.batch(
    Array.from({ length: 300 }, (_, k) =>
      env.DB.prepare(
        `INSERT INTO payments (site_id, id, provider, provider_txn_id, kind, amount_minor, currency, reporting_minor,
           reporting_currency, visitor_id, first_session_id, attributed_via, source, occurred_at, created_at, updated_at)
         VALUES (?, ?, 'api', ?, 'payment', 2900, 'USD', 2900, 'USD', ?, ?, 'api', 'api', ?, 0, 0)`,
      ).bind(
        site.id,
        `p${k}`,
        `t${k}`,
        `o${k * 300}`,
        `so${k * 300}`,
        Date.UTC(2026, 9, 2) + k * 2 * 3_600_000,
      ),
    ),
  );
}, 120_000);

describe("read budget", () => {
  it("a 30-day overview reads under 300,000 rows in one query", async () => {
    const meter = createD1Meter(env.DB);
    const totals = await computeTotals(qcFor(site, range, { db: meter.db, now }));
    expect(totals.metrics.sessions).toBe(100_000);
    expect(totals.metrics.visitors).toBe(100_000);
    expect(totals.metrics.payments).toBe(300);
    expect(meter.usage.queries).toBe(1);
    // Measured: about two rows per session (index entry + row) plus the payments: ~200,300.
    expect(meter.usage.rowsRead).toBeLessThan(250_000);
    expect(meter.usage.rowsWritten).toBe(0);
  });

  it("with rollups a 30-day breakdown reads a few thousand rows instead of every session", async () => {
    const raw = createD1Meter(env.DB);
    const rawRes = await runBreakdown(
      qcFor(site, range, { db: raw.db, now }),
      DIMENSIONS.referrers,
      {
        limit: 100,
        offset: 0,
      },
    );
    expect(rawRes.approximate).toBe(false);
    expect(raw.usage.rowsRead).toBeGreaterThanOrEqual(100_000);

    // Roll September and October up (14 days per run).
    let at = Date.UTC(2026, 9, 31, 1, 7);
    for (let i = 0; i < 6; i++, at += 3_600_000) {
      await runScheduled([rollupJob], env, createExecutionContext(), at);
    }
    const through = await env.DB.prepare("SELECT through_day FROM rollup_state WHERE site_id = ?")
      .bind(site.id)
      .first<string>("through_day");
    expect(through).toBe(addDays(localDate(now, "UTC"), -1));

    const rolled = createD1Meter(env.DB);
    const res = await runBreakdown(
      qcFor(site, range, { db: rolled.db, now }),
      DIMENSIONS.referrers,
      {
        limit: 100,
        offset: 0,
      },
    );
    expect(res.approximate).toBe(true);
    // One session per visitor here, so daily-unique sums equal the exact counts.
    expect(res.rows.map((r) => [r.values[0], r.visitors])).toEqual(
      rawRes.rows.map((r) => [r.values[0], r.visitors]),
    );
    expect(res.rows.reduce((n, r) => n + r.revenueMinor, 0)).toBe(300 * 2900);
    expect(rolled.usage.rowsRead).toBeLessThan(5_000);
  }, 120_000);
});
