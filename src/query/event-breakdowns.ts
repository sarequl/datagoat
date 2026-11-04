/**
 * Event-based breakdowns: pages (visitors who viewed each page), exit clicks (outbound
 * `external_link` events), goals and goal properties (custom events).
 *
 * Non-pageview queries add `type <> 'pageview'` so the partial `events_activity` index
 * (site_id, type, ts) serves them; pageview queries read `events_time`. Session filters join the
 * event's session by primary key only when filters are present.
 */
import { compileFilters } from "../lib/filters";
import { prepare, raw, type SqlFragment, sql } from "../lib/sql";
import { bucketKeySql } from "../lib/time";
import type { Page } from "./breakdowns";
import {
  ACTIVITY,
  eventScope,
  filterSql,
  hasFilters,
  type QueryContext,
  rangeOn,
  sessionsFrom,
} from "./context";
import { payingKindsSql, paymentScope, revenueKindsSql } from "./revenue";
import { chooseSource, rawRemainder } from "./strategy";

/** Goals created by payment providers (W3) rather than by the site. */
export const PAYMENT_GOALS = new Set([
  "payment",
  "free_trial",
  "subscription_started",
  "subscription_renewed",
  "subscription_upgraded",
  "subscription_downgraded",
  "subscription_cancel_scheduled",
  "subscription_reactivated",
  "subscription_ended",
]);

/** Event property keys DataFast reserves (not custom properties). */
export const RESERVED_PROPERTY_KEYS = ["eventName", "eventType", "isServer"];

function sessionJoin(qc: QueryContext): SqlFragment {
  return hasFilters(qc)
    ? raw("JOIN sessions s ON s.site_id = e.site_id AND s.id = e.session_id")
    : raw("");
}
function sessionFilter(qc: QueryContext): SqlFragment {
  return hasFilters(qc) ? filterSql(qc, "s") : raw("1=1");
}

/** Per-visitor revenue of payments in the range (CTE body; columns v, rev, n). */
export function payByVisitorSql(qc: QueryContext): SqlFragment {
  const pay = paymentScope(qc);
  return sql`SELECT p.visitor_id AS v,
      SUM(CASE WHEN p.kind IN ${raw(revenueKindsSql(qc))} THEN p.reporting_minor ELSE 0 END) AS rev,
      SUM(CASE WHEN p.kind IN ${raw(payingKindsSql(qc))} THEN 1 ELSE 0 END) AS n
    FROM ${pay.from} WHERE ${pay.where} AND p.visitor_id IS NOT NULL GROUP BY p.visitor_id`;
}

export interface PageRowRaw {
  hostname: string;
  path: string;
  visitors: number;
  pageviews: number;
  revenueMinor: number;
  payments: number;
}

export async function pagesBreakdown(
  qc: QueryContext,
  page: Page,
): Promise<{ rows: PageRowRaw[]; total: number; approximate: boolean }> {
  const source = await chooseSource(qc, "breakdown");
  if (source.mode === "raw") {
    const res = await prepare(
      qc.db,
      sql`WITH pay AS MATERIALIZED (${payByVisitorSql(qc)})
        SELECT c0, c1, COUNT(*) AS visitors, SUM(pv) AS pageviews,
          COALESCE(SUM(pay.rev), 0) AS revenue_minor, COALESCE(SUM(pay.n), 0) AS payments,
          COUNT(*) OVER () AS total_rows
        FROM (SELECT COALESCE(e.hostname, '') AS c0, COALESCE(e.path, '/') AS c1, e.visitor_id AS v,
            COUNT(*) AS pv
          FROM events e ${sessionJoin(qc)}
          WHERE ${eventScope(qc)} AND e.type = 'pageview' AND ${sessionFilter(qc)}
          GROUP BY 1, 2, 3) x
        LEFT JOIN pay ON pay.v = x.v
        GROUP BY c0, c1 ORDER BY visitors DESC, c0, c1
        LIMIT ${page.limit} OFFSET ${page.offset}`,
    ).all<Record<string, unknown>>();
    const rows = res.results ?? [];
    let total = Number(rows[0]?.total_rows ?? 0);
    if (!rows.length && page.offset > 0) {
      total = Number(
        (await prepare(
          qc.db,
          sql`SELECT COUNT(*) AS n FROM (SELECT DISTINCT e.hostname, e.path FROM events e ${sessionJoin(qc)}
            WHERE ${eventScope(qc)} AND e.type = 'pageview' AND ${sessionFilter(qc)})`,
        ).first<number>("n")) ?? 0,
      );
    }
    return { rows: rows.map(toPageRow), total, approximate: false };
  }
  // Rollup mode: daily_pages for closed days, raw events per day after the watermark. Revenue
  // walks only the paying visitors' sessions (sessions_visitor) and their events by time range.
  const remainder = rawRemainder(source, qc);
  const rolled = sql`SELECT hostname AS c0, path AS c1, visitors, pageviews FROM daily_pages
    WHERE site_id = ${qc.site.id} AND day >= ${source.fromDay ?? "0000-00-00"} AND day <= ${source.toDay}`;
  let union = rolled;
  if (remainder) {
    const day = bucketKeySql("e.ts", "day", qc.timezone, remainder.startMs, remainder.endMs);
    union = sql`${rolled} UNION ALL
      SELECT c0, c1, COUNT(DISTINCT v), COUNT(*) FROM (
        SELECT ${raw(day.sql)} AS d, COALESCE(e.hostname, '') AS c0, COALESCE(e.path, '/') AS c1, e.visitor_id AS v
        FROM events e WHERE e.site_id = ${qc.site.id} AND ${rangeOn("e.ts", remainder)} AND e.type = 'pageview')
      GROUP BY d, c0, c1`;
  }
  const [main, rev] = await qc.db.batch([
    prepare(
      qc.db,
      sql`SELECT c0, c1, SUM(visitors) AS visitors, SUM(pageviews) AS pageviews, COUNT(*) OVER () AS total_rows
        FROM (${union}) GROUP BY c0, c1 ORDER BY visitors DESC, c0, c1
        LIMIT ${page.limit} OFFSET ${page.offset}`,
    ),
    prepare(
      qc.db,
      sql`WITH pay AS MATERIALIZED (${payByVisitorSql(qc)}),
        ps AS MATERIALIZED (SELECT s.id, s.visitor_id, s.started_at, s.last_seen_at FROM sessions s
          WHERE s.site_id = ${qc.site.id} AND s.visitor_id IN (SELECT v FROM pay)
            AND ${rangeOn("s.started_at", qc.range)})
        SELECT c0, c1, SUM(pay.rev) AS revenue_minor, SUM(pay.n) AS payments FROM (
          SELECT DISTINCT COALESCE(e.hostname, '') AS c0, COALESCE(e.path, '/') AS c1, e.visitor_id AS v
          FROM ps JOIN events e ON e.site_id = ${qc.site.id} AND e.ts >= ps.started_at
            AND e.ts <= ps.last_seen_at AND e.session_id = ps.id
          WHERE e.type = 'pageview') x JOIN pay ON pay.v = x.v
        GROUP BY c0, c1`,
    ),
  ]);
  const revenue = new Map<string, { r: number; n: number }>();
  for (const r of (rev?.results ?? []) as Array<Record<string, unknown>>) {
    revenue.set(`${r.c0}\u0000${r.c1}`, {
      r: Number(r.revenue_minor ?? 0),
      n: Number(r.payments ?? 0),
    });
  }
  const rows = (main?.results ?? []) as Array<Record<string, unknown>>;
  return {
    rows: rows.map((r) => {
      const x = revenue.get(`${r.c0}\u0000${r.c1}`);
      return toPageRow({ ...r, revenue_minor: x?.r ?? 0, payments: x?.n ?? 0 });
    }),
    total: Number(rows[0]?.total_rows ?? 0),
    approximate: true,
  };
}

function toPageRow(r: Record<string, unknown>): PageRowRaw {
  return {
    hostname: String(r.c0 ?? ""),
    path: String(r.c1 ?? ""),
    visitors: Number(r.visitors ?? 0),
    pageviews: Number(r.pageviews ?? 0),
    revenueMinor: Number(r.revenue_minor ?? 0),
    payments: Number(r.payments ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Exit clicks
// ---------------------------------------------------------------------------

export async function exitClicks(qc: QueryContext, page: Page) {
  const res = await prepare(
    qc.db,
    sql`SELECT c0, COUNT(DISTINCT v) AS visitors, COUNT(*) AS clicks, COUNT(*) OVER () AS total_rows
      FROM (SELECT json_extract(CASE WHEN json_valid(e.props) THEN e.props ELSE '{}' END, '$.url') AS c0,
          e.visitor_id AS v
        FROM events e ${sessionJoin(qc)}
        WHERE ${eventScope(qc)} AND e.${raw(ACTIVITY)} AND e.type = 'external_link' AND ${sessionFilter(qc)})
      WHERE c0 IS NOT NULL AND c0 <> ''
      GROUP BY c0 ORDER BY visitors DESC, clicks DESC, c0
      LIMIT ${page.limit} OFFSET ${page.offset}`,
  ).all<Record<string, unknown>>();
  const rows = res.results ?? [];
  return {
    rows: rows.map((r) => ({
      url: String(r.c0),
      visitors: Number(r.visitors ?? 0),
      clicks: Number(r.clicks ?? 0),
    })),
    total: Number(rows[0]?.total_rows ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

export interface GoalRowRaw {
  goal: string;
  completions: number;
  visitors: number;
  revenueMinor: number;
}

export async function goalsBreakdown(
  qc: QueryContext,
  page: Page,
  withExtras: boolean,
): Promise<{ rows: GoalRowRaw[]; total: number; totalVisitors: number; approximate: boolean }> {
  const source = await chooseSource(qc, "breakdown");
  if (source.mode === "raw") {
    const stmts = [
      prepare(
        qc.db,
        sql`WITH pay AS MATERIALIZED (${payByVisitorSql(qc)})
          SELECT c0, SUM(k) AS completions, COUNT(*) AS visitors, COALESCE(SUM(pay.rev), 0) AS revenue_minor,
            COUNT(*) OVER () AS total_rows
          FROM (SELECT e.name AS c0, e.visitor_id AS v, COUNT(*) AS k FROM events e ${sessionJoin(qc)}
            WHERE ${eventScope(qc)} AND e.${raw(ACTIVITY)} AND e.type = 'custom' AND e.name IS NOT NULL
              AND ${sessionFilter(qc)}
            GROUP BY 1, 2) x
          LEFT JOIN pay ON pay.v = x.v
          GROUP BY c0 ORDER BY visitors DESC, completions DESC, c0
          LIMIT ${page.limit} OFFSET ${page.offset}`,
      ),
    ];
    if (withExtras) {
      stmts.push(
        prepare(
          qc.db,
          sql`SELECT COUNT(DISTINCT s.visitor_id) AS n FROM ${sessionsFrom(qc.range)} WHERE ${filterSql(qc, "s")}
            AND s.site_id = ${qc.site.id} AND ${rangeOn("s.started_at", qc.range)}`,
        ),
      );
    }
    const [main, tv] = await qc.db.batch(stmts);
    const rows = (main?.results ?? []) as Array<Record<string, unknown>>;
    return {
      rows: rows.map(toGoalRow),
      total: Number(rows[0]?.total_rows ?? 0),
      totalVisitors: Number((tv?.results?.[0] as { n?: number } | undefined)?.n ?? 0),
      approximate: false,
    };
  }
  const remainder = rawRemainder(source, qc);
  const from = source.fromDay ?? "0000-00-00";
  let union = sql`SELECT name AS c0, completions, visitors FROM daily_goals
    WHERE site_id = ${qc.site.id} AND day >= ${from} AND day <= ${source.toDay}`;
  let visitorsUnion = sql`SELECT COALESCE(SUM(visitors), 0) AS n FROM daily_stats
    WHERE site_id = ${qc.site.id} AND day >= ${from} AND day <= ${source.toDay}`;
  if (remainder) {
    const day = bucketKeySql("e.ts", "day", qc.timezone, remainder.startMs, remainder.endMs);
    union = sql`${union} UNION ALL SELECT c0, COUNT(*), COUNT(DISTINCT v) FROM (
        SELECT ${raw(day.sql)} AS d, e.name AS c0, e.visitor_id AS v FROM events e
        WHERE e.site_id = ${qc.site.id} AND ${rangeOn("e.ts", remainder)} AND e.${raw(ACTIVITY)}
          AND e.type = 'custom' AND e.name IS NOT NULL)
      GROUP BY d, c0`;
    const sday = bucketKeySql(
      "s.started_at",
      "day",
      qc.timezone,
      remainder.startMs,
      remainder.endMs,
    );
    visitorsUnion = sql`SELECT (${visitorsUnion}) + (SELECT COALESCE(SUM(n), 0) FROM (
        SELECT COUNT(DISTINCT s.visitor_id) AS n FROM sessions s INDEXED BY sessions_time
        WHERE s.site_id = ${qc.site.id} AND ${rangeOn("s.started_at", remainder)}
        GROUP BY ${raw(sday.sql)})) AS n`;
  }
  const [main, tv, rev] = await qc.db.batch([
    prepare(
      qc.db,
      sql`SELECT c0, SUM(completions) AS completions, SUM(visitors) AS visitors, COUNT(*) OVER () AS total_rows
        FROM (${union}) GROUP BY c0 ORDER BY visitors DESC, completions DESC, c0
        LIMIT ${page.limit} OFFSET ${page.offset}`,
    ),
    prepare(qc.db, visitorsUnion),
    prepare(
      qc.db,
      sql`WITH pay AS MATERIALIZED (${payByVisitorSql(qc)})
        SELECT c0, SUM(pay.rev) AS revenue_minor FROM (
          SELECT DISTINCT e.name AS c0, e.visitor_id AS v FROM events e
          WHERE e.site_id = ${qc.site.id} AND e.${raw(ACTIVITY)} AND e.visitor_id IN (SELECT v FROM pay)
            AND e.type = 'custom' AND ${rangeOn("e.ts", qc.range)}) x
        JOIN pay ON pay.v = x.v GROUP BY c0`,
    ),
  ]);
  const revenue = new Map<string, number>();
  for (const r of (rev?.results ?? []) as Array<Record<string, unknown>>) {
    revenue.set(String(r.c0), Number(r.revenue_minor ?? 0));
  }
  const rows = (main?.results ?? []) as Array<Record<string, unknown>>;
  return {
    rows: rows.map((r) => toGoalRow({ ...r, revenue_minor: revenue.get(String(r.c0)) ?? 0 })),
    total: Number(rows[0]?.total_rows ?? 0),
    totalVisitors: Number((tv?.results?.[0] as { n?: number } | undefined)?.n ?? 0),
    approximate: true,
  };
}

function toGoalRow(r: Record<string, unknown>): GoalRowRaw {
  return {
    goal: String(r.c0),
    completions: Number(r.completions ?? 0),
    visitors: Number(r.visitors ?? 0),
    revenueMinor: Number(r.revenue_minor ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Goal properties
// ---------------------------------------------------------------------------

export const GOAL_PROPERTY_FILTERS = [
  "country",
  "region",
  "city",
  "browser",
  "os",
  "device",
  "referrer",
  "ref",
  "source",
  "via",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "page",
] as const;

export async function goalProperties(
  qc: QueryContext,
  eventName: string,
  propertyName: string | null,
  page: Page,
) {
  if (PAYMENT_GOALS.has(eventName)) return { rows: [], total: 0 };
  const filters = compileFilters(qc.filters, {
    siteId: qc.site.id,
    range: qc.range,
    sessionAlias: "s",
    eventAlias: "e",
  });
  const needsSession = qc.filters.some((f) => f.key !== "page");
  const join = needsSession
    ? raw("JOIN sessions s ON s.site_id = e.site_id AND s.id = e.session_id")
    : raw("");
  const reserved = raw(`(${RESERVED_PROPERTY_KEYS.map((k) => `'${k}'`).join(", ")})`);
  const label = propertyName
    ? raw(
        "CASE j.type WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' ELSE CAST(j.value AS TEXT) END",
      )
    : raw("j.key");
  const keyFilter = propertyName ? sql`j.key = ${propertyName}` : raw("1=1");
  const res = await prepare(
    qc.db,
    sql`SELECT c0, COUNT(*) AS completions, COUNT(DISTINCT v) AS visitors, COUNT(*) OVER () AS total_rows
      FROM (SELECT ${label} AS c0, e.visitor_id AS v
        FROM events e ${join},
          json_each(CASE WHEN json_valid(e.props) AND json_type(e.props) = 'object' THEN e.props ELSE '{}' END) j
        WHERE ${eventScope(qc)} AND e.${raw(ACTIVITY)} AND e.type = 'custom' AND e.name = ${eventName}
          AND j.key NOT IN ${reserved} AND substr(j.key, 1, 1) <> '$' AND j.type <> 'null'
          AND NOT (j.type = 'text' AND j.atom = '') AND ${keyFilter} AND ${filters})
      GROUP BY c0 ORDER BY completions DESC, c0 ASC
      LIMIT ${page.limit} OFFSET ${page.offset}`,
  ).all<Record<string, unknown>>();
  const rows = res.results ?? [];
  let total = Number(rows[0]?.total_rows ?? 0);
  if (!rows.length && page.offset > 0) total = page.offset; // beyond the end: nothing to show
  return {
    rows: rows.map((r) => ({
      value: String(r.c0),
      completions: Number(r.completions ?? 0),
      visitors: Number(r.visitors ?? 0),
    })),
    total,
  };
}
