/**
 * Google Search Console reads (DG): keywords or pages with clicks, impressions, CTR, average
 * position and an estimated revenue per row; an overview with totals and a daily series; and the
 * connection status with the properties the connected Google account can read.
 *
 * Estimated revenue (DataFast docs/google-search-console): each landing page's revenue per
 * organic-search session in the range (payments attributed to sessions whose channel is Organic
 * Search, by the website's attribution model) times the Search Console clicks a keyword sent to
 * that page. `filter_page` narrows keywords to the pages that match.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { SearchConsoleRow } from "../../../shared/api-types";
import { getAccess } from "../../auth/context";
import { requireSiteAccess } from "../../auth/middleware";
import { parseFilterValue } from "../../lib/filters";
import { attributionColumn, revenueKinds } from "../../lib/metrics";
import { toMajor } from "../../lib/money";
import { paginationOf, success } from "../../lib/response";
import type { Site } from "../../lib/sites";
import { escapeLike, join, prepare, raw, type SqlFragment, sql } from "../../lib/sql";
import {
  type DateRange,
  lastNDays,
  localDate,
  parseRange,
  previousPeriod,
  toIsoOrNull,
} from "../../lib/time";
import { parsePagination, parseQuery } from "../../lib/validate";
import type { AppEnv } from "../../types";
import { oauthConfigured } from "../integrations/oauth";
import { freshToken } from "../integrations/tokens";
import { getConnection } from "../shared/connections";
import { errorMessage } from "../shared/http";
import { listProperties } from "./client";
import type { GscCursor, GscSettings } from "./sync";

export const gscRoutes = new Hono<AppEnv>();

const RangeQuery = z.object({
  websiteId: z.string().optional(),
  startAt: z.string().optional(),
  endAt: z.string().optional(),
  timezone: z.string().optional(),
  filter_page: z.string().max(500).optional(),
});

const ListQuery = RangeQuery.extend({
  groupBy: z.enum(["query", "page"]).default("query"),
  limit: z.string().optional(),
  offset: z.string().optional(),
});

/** SQL expression: the path of a Search Console page URL (`https://host/path?x` → `/path`). */
const PATH_SQL = `(CASE WHEN instr(rest, '/') > 0 THEN substr(rest, instr(rest, '/')) ELSE '/' END)`;
function pathExpr(column: string): string {
  const rest = `(CASE WHEN ${column} LIKE 'https://%' THEN substr(${column}, 9) WHEN ${column} LIKE 'http://%' THEN substr(${column}, 8) ELSE ${column} END)`;
  return PATH_SQL.replaceAll("rest", rest);
}

function pageFilter(value: string | undefined, column: string): SqlFragment {
  if (!value) return raw("1=1");
  const f = parseFilterValue("page", value);
  const path = raw(pathExpr(column));
  const parts = f.values.map((v) => {
    const lower = v.toLowerCase();
    switch (f.operator) {
      case "is":
        return sql`lower(${path}) = ${lower}`;
      case "is_not":
        return sql`lower(${path}) != ${lower}`;
      case "contains":
        return sql`lower(${path}) LIKE ${`%${escapeLike(lower)}%`} ESCAPE '\\'`;
      default:
        return sql`lower(${path}) NOT LIKE ${`%${escapeLike(lower)}%`} ESCAPE '\\'`;
    }
  });
  const joiner = f.operator === "is" || f.operator === "contains" ? " OR " : " AND ";
  return join(parts, joiner);
}

function days(range: DateRange): { from: string; to: string } {
  return {
    from: localDate(range.startMs, range.timezone),
    to: localDate(range.endMs - 1, range.timezone),
  };
}

function rpvCte(site: Site, range: DateRange): SqlFragment {
  const attr = raw(attributionColumn(site.attributionModel));
  const kinds = raw(
    `(${revenueKinds(site.includeRenewalRevenue)
      .map((k) => `'${k}'`)
      .join(", ")})`,
  );
  return sql`org AS (
      SELECT s.id, s.entry_path FROM sessions s
      WHERE s.site_id = ${site.id} AND s.started_at >= ${range.startMs} AND s.started_at < ${range.endMs}
        AND s.channel = 'Organic Search'
    ),
    rev AS (
      SELECT org.entry_path AS path, SUM(p.reporting_minor) AS minor FROM payments p JOIN org ON org.id = p.${attr}
      WHERE p.site_id = ${site.id} AND p.occurred_at >= ${range.startMs} AND p.occurred_at < ${range.endMs}
        AND p.kind IN ${kinds}
      GROUP BY org.entry_path
    ),
    rpv AS (
      SELECT o.path, CAST(COALESCE(rev.minor, 0) AS REAL) / o.n AS v
      FROM (SELECT entry_path AS path, COUNT(*) AS n FROM org GROUP BY entry_path) o
      LEFT JOIN rev ON rev.path = o.path
    )`;
}

function rowDto(
  r: Record<string, unknown>,
  site: Site,
  groupBy: "query" | "page",
): SearchConsoleRow {
  const clicks = Number(r.clicks ?? 0);
  const impressions = Number(r.impressions ?? 0);
  const row: SearchConsoleRow = {
    clicks,
    impressions,
    ctr: impressions ? Math.round((clicks / impressions) * 10000) / 100 : 0,
    position: impressions ? Math.round((Number(r.pw ?? 0) / impressions) * 10) / 10 : 0,
    estimatedRevenue: toMajor(Math.round(Number(r.est ?? 0)), site.currency),
  };
  if (groupBy === "query") row.query = String(r.k);
  else row.page = String(r.k);
  return row;
}

gscRoutes.get("/api/v1/search-console", requireSiteAccess("analytics:read"), async (c) => {
  const { site } = getAccess(c);
  const q = parseQuery(c, ListQuery, { strict: true });
  const { limit, offset } = parsePagination(q, { max: 1000 });
  const range =
    parseRange(q, site.timezone, (tz, now) => lastNDays(28, tz, now)) ??
    lastNDays(28, site.timezone);
  const { from, to } = days(range);
  const group = raw(q.groupBy === "query" ? "g.query" : "g.page");
  const stmt = sql`WITH ${rpvCte(site, range)},
    g AS (
      SELECT query, page, ${raw(pathExpr("page"))} AS path, SUM(clicks) AS c, SUM(impressions) AS i,
        SUM(COALESCE(position, 0) * impressions) AS pw
      FROM gsc_daily WHERE site_id = ${site.id} AND day >= ${from} AND day <= ${to} AND query != ''
        AND ${pageFilter(q.filter_page, "page")}
      GROUP BY query, page
    )
    SELECT ${group} AS k, SUM(g.c) AS clicks, SUM(g.i) AS impressions, SUM(g.pw) AS pw,
      SUM(g.c * COALESCE(rpv.v, 0)) AS est, COUNT(*) OVER () AS total_rows
    FROM g LEFT JOIN rpv ON rpv.path = g.path
    GROUP BY k ORDER BY clicks DESC, impressions DESC, k LIMIT ${limit} OFFSET ${offset}`;
  const res = await prepare(c.env.DB, stmt).all<Record<string, unknown>>();
  const rows = res.results ?? [];
  return success(
    c,
    rows.map((r) => rowDto(r, site, q.groupBy)),
    { pagination: paginationOf(limit, offset, Number(rows[0]?.total_rows ?? 0)) },
  );
});

async function totals(
  db: D1Database,
  site: Site,
  range: DateRange,
  filterPage: string | undefined,
) {
  const { from, to } = days(range);
  // Without a page filter the totals rows (query = '' AND page = '') include anonymised queries.
  const base = filterPage
    ? sql`SELECT day, SUM(clicks) AS clicks, SUM(impressions) AS impressions, SUM(COALESCE(position, 0) * impressions) AS pw
          FROM gsc_daily WHERE site_id = ${site.id} AND day >= ${from} AND day <= ${to} AND query != ''
            AND ${pageFilter(filterPage, "page")} GROUP BY day`
    : sql`SELECT day, clicks, impressions, COALESCE(position, 0) * impressions AS pw
          FROM gsc_daily WHERE site_id = ${site.id} AND day >= ${from} AND day <= ${to} AND query = '' AND page = ''`;
  const est = sql`WITH ${rpvCte(site, range)}
    SELECT COALESCE(SUM(g.clicks * COALESCE(rpv.v, 0)), 0) AS est
    FROM (SELECT ${raw(pathExpr("page"))} AS path, clicks FROM gsc_daily
          WHERE site_id = ${site.id} AND day >= ${from} AND day <= ${to} AND query != ''
            AND ${pageFilter(filterPage, "page")}) g
    LEFT JOIN rpv ON rpv.path = g.path`;
  const [series, estimate] = await db.batch([
    prepare(db, sql`${base} ORDER BY day`),
    prepare(db, est),
  ]);
  const rows = (series?.results ?? []) as Array<{
    day: string;
    clicks: number;
    impressions: number;
    pw: number;
  }>;
  const clicks = rows.reduce((s, r) => s + Number(r.clicks), 0);
  const impressions = rows.reduce((s, r) => s + Number(r.impressions), 0);
  const pw = rows.reduce((s, r) => s + Number(r.pw), 0);
  return {
    clicks,
    impressions,
    ctr: impressions ? Math.round((clicks / impressions) * 10000) / 100 : 0,
    position: impressions ? Math.round((pw / impressions) * 10) / 10 : 0,
    estimatedRevenue: toMajor(
      Math.round(Number((estimate?.results?.[0] as { est?: number } | undefined)?.est ?? 0)),
      site.currency,
    ),
    timeseries: rows.map((r) => ({
      date: r.day,
      clicks: Number(r.clicks),
      impressions: Number(r.impressions),
      ctr: r.impressions ? Math.round((r.clicks / r.impressions) * 10000) / 100 : 0,
      position: r.impressions ? Math.round((r.pw / r.impressions) * 10) / 10 : 0,
    })),
  };
}

gscRoutes.get("/api/v1/search-console/overview", requireSiteAccess("analytics:read"), async (c) => {
  const { site } = getAccess(c);
  const q = parseQuery(c, RangeQuery, { strict: true });
  const range =
    parseRange(q, site.timezone, (tz, now) => lastNDays(28, tz, now)) ??
    lastNDays(28, site.timezone);
  const [current, previous] = await Promise.all([
    totals(c.env.DB, site, range, q.filter_page),
    totals(c.env.DB, site, previousPeriod(range), q.filter_page),
  ]);
  const { timeseries: _, ...prev } = previous;
  return success(c, { currency: site.currency, ...current, previous: prev });
});

gscRoutes.get("/api/v1/search-console/status", requireSiteAccess("analytics:read"), async (c) => {
  const { site } = getAccess(c);
  const conn = await getConnection<GscSettings, GscCursor>(c.env.DB, site.id, "gsc");
  const range = await c.env.DB.prepare(
    "SELECT MIN(day) AS oldest, MAX(day) AS newest FROM gsc_daily WHERE site_id = ? AND query = '' AND page = ''",
  )
    .bind(site.id)
    .first<{ oldest: string | null; newest: string | null }>();
  let properties: Array<{ siteUrl: string; permissionLevel: string }> | null = null;
  let propertiesError: string | null = null;
  if (conn?.hasCredentials && c.req.query("properties") !== "0") {
    try {
      const { token } = await freshToken(c.env, (i, init) => fetch(i, init), conn, Date.now());
      properties = await listProperties((i, init) => fetch(i, init), token);
    } catch (err) {
      propertiesError = errorMessage(err);
    }
  }
  return success(c, {
    connected: Boolean(conn?.hasCredentials) && conn?.status !== "disconnected",
    oauthConfigured: oauthConfigured(c.env, "gsc"),
    connectUrl: oauthConfigured(c.env, "gsc")
      ? `/api/connect/google-search-console/start?websiteId=${site.id}&returnTo=search-console`
      : null,
    status: conn?.status ?? null,
    property: conn?.settings.property ?? null,
    properties,
    propertiesError,
    lastSyncedAt: toIsoOrNull(conn?.lastSyncedAt ?? null),
    lastError: conn?.lastError ?? null,
    oldestDay: range?.oldest ?? null,
    newestDay: range?.newest ?? null,
    backfillComplete: conn?.cursor.backfillDone === true,
  });
});
