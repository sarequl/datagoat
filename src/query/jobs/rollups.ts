/**
 * `query.rollups` (hourly at :07): rolls closed days (website timezone) up into daily_stats,
 * daily_pages, daily_dimensions and daily_goals, entirely inside D1 with
 * `INSERT … SELECT … GROUP BY … ON CONFLICT DO UPDATE … WHERE <changed>`, so re-rolling an
 * unchanged day writes nothing and idle websites cost one read per run.
 *
 * Per website it rolls from the day before the watermark (`rollup_state.through_day`, catching
 * sessions that crossed midnight) to yesterday, at most MAX_DAYS_PER_RUN days per run (backfill
 * of existing data continues on the next runs). Each website costs one D1 query (one batch).
 * When the website timezone changes, the old rollups are deleted in bounded chunks first; queries
 * ignore rollups whose timezone differs from the website's.
 */
import type { JobContext, JobDefinition } from "../../jobs/registry";
import { log } from "../../lib/log";
import { attributionColumn } from "../../lib/metrics";
import type { AttributionModel } from "../../lib/sites";
import { addDays, bucketKeySql, DAY_MS, localDate, startOfDate } from "../../lib/time";
import { ROLLUP_DIMENSIONS } from "../breakdowns";

export const MAX_DAYS_PER_RUN = 14;
/** Rows deleted per table per run while resetting rollups after a timezone change. */
export const RESET_ROWS_PER_TABLE = 2000;

interface SiteRow {
  id: string;
  timezone: string;
  attribution_model: AttributionModel;
  include_renewal_revenue: number;
  retention_days: number | null;
  r_timezone: string | null;
  first_day: string | null;
  through_day: string | null;
}

const ROLLUP_TABLES = [
  { name: "daily_stats", key: "site_id, day" },
  { name: "daily_pages", key: "site_id, day, hostname, path" },
  { name: "daily_dimensions", key: "site_id, day, dimension, value" },
  { name: "daily_goals", key: "site_id, day, name" },
] as const;

function changed(columns: string[], table: string): string {
  return columns.map((c) => `${table}.${c} IS NOT excluded.${c}`).join(" OR ");
}

/** The four rollup statements for [fromDay, toDay] (inclusive) of one website. */
export function rollupStatements(
  db: D1Database,
  site: Pick<SiteRow, "id" | "timezone" | "attribution_model" | "include_renewal_revenue">,
  fromDay: string,
  toDay: string,
  now: number,
): D1PreparedStatement[] {
  const tz = site.timezone;
  const fromMs = startOfDate(fromDay, tz);
  const toMs = startOfDate(addDays(toDay, 1), tz);
  const dayOf = (col: string) =>
    `date(${bucketKeySql(col, "day", tz, fromMs, toMs).sql} * 86400, 'unixepoch')`;
  const revenueKinds = site.include_renewal_revenue
    ? "('payment', 'renewal', 'refund')"
    : "('payment', 'refund')";
  const paying = site.include_renewal_revenue ? "('payment', 'renewal')" : "('payment')";
  const attr = attributionColumn(site.attribution_model);

  const statsCols = [
    "visitors",
    "new_visitors",
    "returning_visitors",
    "sessions",
    "pageviews",
    "bounces",
    "duration_sum",
    "events",
    "revenue_minor",
    "new_revenue_minor",
    "renewal_revenue_minor",
    "refund_minor",
    "payments",
    "paying_visitors",
  ];
  const stats = db
    .prepare(
      `INSERT INTO daily_stats (site_id, day, ${statsCols.join(", ")}, computed_at)
       SELECT ?1, d, SUM(visitors), SUM(nv), SUM(rv), SUM(n), SUM(pv), SUM(b), SUM(dur), SUM(ev),
         SUM(rev), SUM(newrev), SUM(renrev), SUM(refund), SUM(pays), SUM(payers), ?4
       FROM (
         SELECT d, COUNT(*) AS visitors, SUM(CASE WHEN fn < 2 THEN 1 ELSE 0 END) AS nv,
           SUM(CASE WHEN fn >= 2 THEN 1 ELSE 0 END) AS rv, SUM(n) AS n, SUM(pv) AS pv, SUM(b) AS b,
           SUM(dur) AS dur, 0 AS ev, 0 AS rev, 0 AS newrev, 0 AS renrev, 0 AS refund, 0 AS pays, 0 AS payers
         FROM (SELECT ${dayOf("s.started_at")} AS d, s.visitor_id, COUNT(*) AS n, SUM(s.pageviews) AS pv,
             SUM(CASE WHEN s.pageviews + s.interactions <= 1 THEN 1 ELSE 0 END) AS b,
             SUM(s.last_seen_at - s.started_at) AS dur, MIN(s.session_number) AS fn
           FROM sessions s WHERE s.site_id = ?1 AND s.started_at >= ?2 AND s.started_at < ?3 GROUP BY 1, 2)
         GROUP BY d
         UNION ALL
         SELECT ${dayOf("e.ts")}, 0, 0, 0, 0, 0, 0, 0, COUNT(*), 0, 0, 0, 0, 0, 0
         FROM events e WHERE e.site_id = ?1 AND e.ts >= ?2 AND e.ts < ?3 GROUP BY 1
         UNION ALL
         SELECT ${dayOf("p.occurred_at")}, 0, 0, 0, 0, 0, 0, 0, 0,
           SUM(CASE WHEN p.kind IN ${revenueKinds} THEN p.reporting_minor ELSE 0 END),
           SUM(CASE WHEN p.kind = 'payment' THEN p.reporting_minor ELSE 0 END),
           SUM(CASE WHEN p.kind = 'renewal' THEN p.reporting_minor ELSE 0 END),
           SUM(CASE WHEN p.kind = 'refund' THEN p.reporting_minor ELSE 0 END),
           SUM(CASE WHEN p.kind IN ${paying} THEN 1 ELSE 0 END),
           COUNT(DISTINCT CASE WHEN p.kind IN ${paying} THEN p.visitor_id END)
         FROM payments p WHERE p.site_id = ?1 AND p.occurred_at >= ?2 AND p.occurred_at < ?3 GROUP BY 1)
       WHERE 1 GROUP BY d
       ON CONFLICT (site_id, day) DO UPDATE SET
         ${statsCols.map((c) => `${c} = excluded.${c}`).join(", ")}, computed_at = excluded.computed_at
       WHERE ${changed(statsCols, "daily_stats")}`,
    )
    .bind(site.id, fromMs, toMs, now);

  const pageCols = ["pageviews", "visitors", "entries", "exits"];
  const pages = db
    .prepare(
      `INSERT INTO daily_pages (site_id, day, hostname, path, ${pageCols.join(", ")})
       SELECT ?1, d, h, p, SUM(pv), SUM(v), SUM(en), SUM(ex) FROM (
         SELECT d, h, p, COUNT(*) AS pv, COUNT(DISTINCT vid) AS v, 0 AS en, 0 AS ex FROM (
           SELECT ${dayOf("e.ts")} AS d, COALESCE(e.hostname, '') AS h, COALESCE(e.path, '/') AS p, e.visitor_id AS vid
           FROM events e WHERE e.site_id = ?1 AND e.ts >= ?2 AND e.ts < ?3 AND e.type = 'pageview')
         GROUP BY d, h, p
         UNION ALL
         SELECT ${dayOf("s.started_at")}, COALESCE(s.hostname, ''), s.entry_path, 0, 0, COUNT(*), 0
         FROM sessions s WHERE s.site_id = ?1 AND s.started_at >= ?2 AND s.started_at < ?3 GROUP BY 1, 2, 3
         UNION ALL
         SELECT ${dayOf("s.started_at")}, COALESCE(s.hostname, ''), COALESCE(s.exit_path, s.entry_path), 0, 0, 0, COUNT(*)
         FROM sessions s WHERE s.site_id = ?1 AND s.started_at >= ?2 AND s.started_at < ?3 GROUP BY 1, 2, 3)
       WHERE 1 GROUP BY d, h, p
       ON CONFLICT (site_id, day, hostname, path) DO UPDATE SET
         ${pageCols.map((c) => `${c} = excluded.${c}`).join(", ")}
       WHERE ${changed(pageCols, "daily_pages")}`,
    )
    .bind(site.id, fromMs, toMs);

  const dimCols = [
    "visitors",
    "sessions",
    "pageviews",
    "bounces",
    "duration_sum",
    "revenue_minor",
    "payments",
  ];
  const sessionCols = ROLLUP_DIMENSIONS.map((d, i) => `${d.expr} AS x${i}`).join(", ");
  const trafficBranches = ROLLUP_DIMENSIONS.map(
    (d, i) =>
      `SELECT d, '${d.dimension}' AS dimension, COALESCE(x${i}, '') AS value, COUNT(DISTINCT vid) AS visitors,
         COUNT(*) AS sessions, SUM(pv) AS pageviews, SUM(b) AS bounces, SUM(dur) AS duration_sum,
         0 AS revenue_minor, 0 AS payments FROM ss GROUP BY d, value`,
  );
  const revenueBranches = ROLLUP_DIMENSIONS.map(
    (d, i) =>
      `SELECT d, '${d.dimension}', COALESCE(x${i}, ''), 0, 0, 0, 0, 0, SUM(rev), SUM(cnt) FROM ps GROUP BY d, 3`,
  );
  const dims = db
    .prepare(
      `WITH ss AS MATERIALIZED (
         SELECT ${dayOf("s.started_at")} AS d, s.visitor_id AS vid, s.pageviews AS pv,
           CASE WHEN s.pageviews + s.interactions <= 1 THEN 1 ELSE 0 END AS b,
           s.last_seen_at - s.started_at AS dur, ${sessionCols}
         FROM sessions s WHERE s.site_id = ?1 AND s.started_at >= ?2 AND s.started_at < ?3),
       ps AS MATERIALIZED (
         SELECT ${dayOf("p.occurred_at")} AS d,
           CASE WHEN p.kind IN ${revenueKinds} THEN p.reporting_minor ELSE 0 END AS rev,
           CASE WHEN p.kind IN ${paying} THEN 1 ELSE 0 END AS cnt, ${sessionCols}
         FROM payments p JOIN sessions s ON s.site_id = p.site_id AND s.id = p.${attr}
         WHERE p.site_id = ?1 AND p.occurred_at >= ?2 AND p.occurred_at < ?3)
       INSERT INTO daily_dimensions (site_id, day, dimension, value, ${dimCols.join(", ")})
       SELECT ?1, d, dimension, value, ${dimCols.map((c) => `SUM(${c})`).join(", ")} FROM (
         ${[...trafficBranches, ...revenueBranches].join("\n UNION ALL ")})
       WHERE 1 GROUP BY d, dimension, value
       ON CONFLICT (site_id, day, dimension, value) DO UPDATE SET
         ${dimCols.map((c) => `${c} = excluded.${c}`).join(", ")}
       WHERE ${changed(dimCols, "daily_dimensions")}`,
    )
    .bind(site.id, fromMs, toMs);

  const goals = db
    .prepare(
      `INSERT INTO daily_goals (site_id, day, name, completions, visitors)
       SELECT ?1, d, name, COUNT(*), COUNT(DISTINCT vid) FROM (
         SELECT ${dayOf("e.ts")} AS d, e.name AS name, e.visitor_id AS vid FROM events e
         WHERE e.site_id = ?1 AND e.type <> 'pageview' AND e.type = 'custom' AND e.name IS NOT NULL
           AND e.ts >= ?2 AND e.ts < ?3)
       WHERE 1 GROUP BY d, name
       ON CONFLICT (site_id, day, name) DO UPDATE SET completions = excluded.completions,
         visitors = excluded.visitors
       WHERE ${changed(["completions", "visitors"], "daily_goals")}`,
    )
    .bind(site.id, fromMs, toMs);

  return [stats, pages, dims, goals];
}

function stateUpsert(
  db: D1Database,
  siteId: string,
  timezone: string,
  firstDay: string | null,
  throughDay: string | null,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO rollup_state (site_id, timezone, first_day, through_day, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (site_id) DO UPDATE SET timezone = excluded.timezone, first_day = excluded.first_day,
         through_day = excluded.through_day, updated_at = excluded.updated_at
       WHERE rollup_state.timezone IS NOT excluded.timezone OR rollup_state.first_day IS NOT excluded.first_day
         OR rollup_state.through_day IS NOT excluded.through_day`,
    )
    .bind(siteId, timezone, firstDay, throughDay, now);
}

/** Delete one chunk of every rollup table for a website; returns rows deleted. */
async function resetChunk(db: D1Database, siteId: string): Promise<number> {
  const results = await db.batch(
    ROLLUP_TABLES.map((t) =>
      db
        .prepare(
          `DELETE FROM ${t.name} WHERE (${t.key}) IN (SELECT ${t.key} FROM ${t.name} WHERE site_id = ?1 LIMIT ?2)`,
        )
        .bind(siteId, RESET_ROWS_PER_TABLE),
    ),
  );
  return results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}

export async function runRollups(ctx: JobContext): Promise<void> {
  const { db, now } = ctx;
  const sites =
    (
      await db
        .prepare(
          `SELECT s.id, s.timezone, s.attribution_model, s.include_renewal_revenue, s.retention_days,
             r.timezone AS r_timezone, r.first_day, r.through_day
           FROM sites s LEFT JOIN rollup_state r ON r.site_id = s.id
           WHERE s.deleted_at IS NULL ORDER BY COALESCE(r.updated_at, 0), s.id`,
        )
        .all<SiteRow>()
    ).results ?? [];
  for (const site of sites) {
    if (ctx.remainingQueries() < 3) return;
    const tz = site.timezone;
    if (site.r_timezone !== null && site.r_timezone !== tz) {
      const deleted = await resetChunk(db, site.id);
      if (deleted < RESET_ROWS_PER_TABLE) {
        await stateUpsert(db, site.id, tz, null, null, now).run();
        log.info("rollups.reset", { siteId: site.id });
      }
      continue;
    }
    const yesterday = addDays(localDate(now, tz), -1);
    if (site.through_day !== null && site.through_day >= yesterday) continue;
    let firstDay = site.first_day;
    if (firstDay === null) {
      const first = await db
        .prepare("SELECT MIN(started_at) AS t FROM sessions WHERE site_id = ?")
        .bind(site.id)
        .first<number | null>("t");
      if (first === null || first === undefined) continue; // no traffic yet: nothing to roll
      firstDay = localDate(first, tz);
    }
    let fromDay = site.through_day !== null ? addDays(site.through_day, -1) : firstDay;
    if (fromDay < firstDay) fromDay = firstDay;
    if (site.retention_days) {
      // Never re-roll days whose events the retention job may already have pruned.
      const keepFrom = addDays(localDate(now - site.retention_days * DAY_MS, tz), 1);
      if (fromDay < keepFrom && site.through_day !== null) fromDay = keepFrom;
    }
    let toDay = addDays(fromDay, MAX_DAYS_PER_RUN - 1);
    if (toDay > yesterday) toDay = yesterday;
    if (fromDay > toDay) {
      await stateUpsert(db, site.id, tz, firstDay, yesterday, now).run();
      continue;
    }
    await db.batch([
      ...rollupStatements(db, site, fromDay, toDay, now),
      stateUpsert(db, site.id, tz, firstDay, toDay, now),
    ]);
  }
}

export const rollupJob: JobDefinition = {
  name: "query.rollups",
  schedule: { every: "hour", minute: 7 },
  run: runRollups,
  minQueries: 3,
  description: "Roll closed days up into daily_stats/pages/dimensions/goals (changed rows only)",
};
