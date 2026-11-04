/**
 * Revenue analytics (DataGoat endpoints, `analytics:read`):
 *
 *   GET /api/v1/analytics/revenue                    RevenueSummary: totals, attribution coverage by
 *                                                    method, lifetime value by first channel
 *   GET /api/v1/analytics/revenue/sources            revenue by source (channel, referrer, UTM, …)
 *                                                    under any attribution model, incl. "Unattributed"
 *   GET /api/v1/analytics/revenue/path-to-purchase   time and sessions from first visit to first
 *                                                    purchase, and first → last channel paths
 *
 * All take `startAt`/`endAt`/`timezone` (default: last 30 days) and `filter_*`. Filters apply to
 * the session each payment is attributed to under the website's attribution model (or `model=`).
 * Revenue follows src/lib/metrics.ts: refunds negative, renewals only when the website includes
 * renewal revenue; amounts in the website currency.
 */
import { Hono } from "hono";
import type { PathToPurchase, RevenueSourceRow, RevenueSummary } from "../../shared/api-types";
import { getAccess } from "../auth/context";
import { requireSiteAccess } from "../auth/middleware";
import { ApiError } from "../lib/errors";
import { compileFilters, type ParsedFilter, parseFilters } from "../lib/filters";
import { attributionColumn, paymentCountKinds, percentage, revenueKinds } from "../lib/metrics";
import { round2, toMajor } from "../lib/money";
import { paginationOf, success } from "../lib/response";
import { ATTRIBUTION_MODELS, type AttributionModel, type Site } from "../lib/sites";
import { prepare, raw, type SqlFragment, sql } from "../lib/sql";
import { type DateRange, lastNDays, parseRange } from "../lib/time";
import { parsePagination } from "../lib/validate";
import type { AppEnv } from "../types";

export const revenueRoutes = new Hono<AppEnv>();

const DAY = 86_400_000;
const kinds = (list: string[]) => raw(`(${list.map((k) => `'${k}'`).join(", ")})`);

interface Common {
  site: Site;
  range: DateRange;
  filters: ParsedFilter[];
  model: AttributionModel;
}

function common(c: Parameters<typeof getAccess>[0]): Common {
  const { site } = getAccess(c);
  const url = new URL(c.req.url);
  const q = Object.fromEntries(url.searchParams) as Record<string, string>;
  const range = parseRange(q, site.timezone, (tz, now) => lastNDays(30, tz, now)) as DateRange;
  const filters = parseFilters(url.searchParams);
  const model = (q.model ?? site.attributionModel) as AttributionModel;
  if (!ATTRIBUTION_MODELS.includes(model))
    throw new ApiError(400, "model must be first_touch, last_touch or last_non_direct");
  return { site, range, filters, model };
}

/** `FROM payments p [JOIN sessions s …] WHERE …` for the range and filters. */
function paymentScope(x: Common): { from: SqlFragment; where: SqlFragment } {
  const col = raw(attributionColumn(x.model));
  const from = x.filters.length
    ? sql`payments p JOIN sessions s ON s.site_id = p.site_id AND s.id = p.${col}`
    : sql`payments p LEFT JOIN sessions s ON s.site_id = p.site_id AND s.id = p.${col}`;
  const parts = [
    sql`p.site_id = ${x.site.id} AND p.occurred_at >= ${x.range.startMs} AND p.occurred_at < ${x.range.endMs}`,
  ];
  if (x.filters.length) {
    parts.push(compileFilters(x.filters, { siteId: x.site.id, range: x.range, sessionAlias: "s" }));
  }
  return { from, where: parts.reduce((a, b) => sql`${a} AND ${b}`) };
}

revenueRoutes.get("/api/v1/analytics/revenue", requireSiteAccess("analytics:read"), async (c) => {
  const x = common(c);
  const { site } = x;
  const { from, where } = paymentScope(x);
  const rev = kinds(revenueKinds(site.includeRenewalRevenue));
  const counted = kinds(paymentCountKinds(site.includeRenewalRevenue));
  const db = c.env.DB;
  const [byMethod, totals, ltv] = await db.batch([
    prepare(
      db,
      sql`SELECT p.attributed_via AS via,
            COALESCE(SUM(CASE WHEN p.kind IN ${rev} THEN p.reporting_minor ELSE 0 END), 0) AS revenue
          FROM ${from} WHERE ${where} GROUP BY p.attributed_via`,
    ),
    prepare(
      db,
      sql`SELECT
            COALESCE(SUM(CASE WHEN p.kind IN ${rev} THEN p.reporting_minor ELSE 0 END), 0) AS revenue,
            COALESCE(SUM(CASE WHEN p.kind = 'payment' THEN p.reporting_minor ELSE 0 END), 0) AS new_revenue,
            COALESCE(SUM(CASE WHEN p.kind = 'renewal' THEN p.reporting_minor ELSE 0 END), 0) AS renewal_revenue,
            COALESCE(SUM(CASE WHEN p.kind = 'refund' THEN p.reporting_minor ELSE 0 END), 0) AS refunds,
            COALESCE(SUM(CASE WHEN p.kind IN ${counted} THEN 1 ELSE 0 END), 0) AS payments,
            COUNT(DISTINCT CASE WHEN p.kind IN ${counted}
              THEN COALESCE(p.visitor_id, p.provider || ':' || p.provider_customer_id, p.email_hash, p.id) END) AS customers
          FROM ${from} WHERE ${where}`,
    ),
    prepare(
      db,
      sql`WITH cust AS (
            SELECT DISTINCT p.visitor_id FROM ${from}
            WHERE ${where} AND p.visitor_id IS NOT NULL AND p.kind IN ${counted}
          ), life AS (
            SELECT q.visitor_id, MIN(q.first_session_id) AS first_session_id,
              SUM(CASE WHEN q.kind IN ${rev} THEN q.reporting_minor ELSE 0 END) AS revenue
            FROM payments q WHERE q.site_id = ${site.id} AND q.visitor_id IN (SELECT visitor_id FROM cust)
            GROUP BY q.visitor_id
          )
          SELECT COALESCE(fs.channel, 'Unknown') AS channel, COUNT(*) AS customers, SUM(life.revenue) AS revenue
          FROM life LEFT JOIN sessions fs ON fs.site_id = ${site.id} AND fs.id = life.first_session_id
          GROUP BY 1 ORDER BY revenue DESC LIMIT 50`,
    ),
  ]);
  const methods: RevenueSummary["attribution"]["byMethod"] = {
    metadata: 0,
    link: 0,
    customer: 0,
    email: 0,
    api: 0,
    none: 0,
  };
  let attributed = 0;
  let unattributed = 0;
  for (const r of (byMethod?.results ?? []) as Array<{
    via: keyof typeof methods;
    revenue: number;
  }>) {
    const major = toMajor(Number(r.revenue), site.currency);
    methods[r.via] = major;
    if (r.via === "none") unattributed += Number(r.revenue);
    else attributed += Number(r.revenue);
  }
  const t = (totals?.results?.[0] ?? {}) as Record<string, number>;
  const gross = Math.abs(attributed) + Math.abs(unattributed);
  const body: RevenueSummary = {
    currency: site.currency,
    revenue: toMajor(Number(t.revenue ?? 0), site.currency),
    newRevenue: toMajor(Number(t.new_revenue ?? 0), site.currency),
    renewalRevenue: toMajor(Number(t.renewal_revenue ?? 0), site.currency),
    refunds: toMajor(Number(t.refunds ?? 0), site.currency),
    payments: Number(t.payments ?? 0),
    customers: Number(t.customers ?? 0),
    attribution: {
      attributedRevenue: toMajor(attributed, site.currency),
      unattributedRevenue: toMajor(unattributed, site.currency),
      coveragePercentage: percentage(Math.abs(attributed), gross),
      byMethod: methods,
    },
    lifetimeValueByChannel: ((ltv?.results ?? []) as Array<Record<string, unknown>>).map((r) => {
      const customers = Number(r.customers);
      const revenue = toMajor(Number(r.revenue ?? 0), site.currency);
      return {
        channel: String(r.channel),
        customers,
        revenue,
        averageValue: customers ? round2(revenue / customers) : 0,
      };
    }),
  };
  return success(c, body);
});

/** groupBy → SQL expression over the attributed session `s`. */
const GROUPS: Record<string, string> = {
  channel: "s.channel",
  referrer: "COALESCE(s.source, s.referrer_domain, 'Direct / None')",
  utm_source: "s.utm_source",
  utm_medium: "s.utm_medium",
  utm_campaign: "s.utm_campaign",
  utm_term: "s.utm_term",
  utm_content: "s.utm_content",
  ref: "s.ref",
  source: "s.source_param",
  via: "s.via",
  country: "s.country",
  region: "s.region",
  city: "s.city",
  device: "s.device",
  browser: "s.browser",
  os: "s.os",
  entry_page: "s.entry_path",
  hostname: "s.hostname",
};

export const UNATTRIBUTED = "Unattributed";

revenueRoutes.get(
  "/api/v1/analytics/revenue/sources",
  requireSiteAccess("analytics:read"),
  async (c) => {
    const x = common(c);
    const { site } = x;
    const q = Object.fromEntries(new URL(c.req.url).searchParams) as Record<string, string>;
    const groupBy = q.groupBy ?? "channel";
    const expr = GROUPS[groupBy];
    if (!expr) throw new ApiError(400, `groupBy must be one of: ${Object.keys(GROUPS).join(", ")}`);
    const { limit, offset } = parsePagination(q);
    const { from, where } = paymentScope(x);
    const rev = kinds(revenueKinds(site.includeRenewalRevenue));
    const counted = kinds(paymentCountKinds(site.includeRenewalRevenue));
    const db = c.env.DB;
    const res = await prepare(
      db,
      sql`SELECT CASE WHEN s.id IS NULL THEN ${UNATTRIBUTED} ELSE COALESCE(${raw(expr)}, '') END AS value,
          COALESCE(SUM(CASE WHEN p.kind IN ${rev} THEN p.reporting_minor ELSE 0 END), 0) AS revenue,
          COALESCE(SUM(CASE WHEN p.kind = 'payment' THEN p.reporting_minor ELSE 0 END), 0) AS new_revenue,
          COALESCE(SUM(CASE WHEN p.kind = 'renewal' THEN p.reporting_minor ELSE 0 END), 0) AS renewal_revenue,
          COALESCE(SUM(CASE WHEN p.kind = 'refund' THEN p.reporting_minor ELSE 0 END), 0) AS refunds,
          COALESCE(SUM(CASE WHEN p.kind IN ${counted} THEN 1 ELSE 0 END), 0) AS payments,
          COUNT(DISTINCT CASE WHEN p.kind IN ${counted} THEN p.visitor_id END) AS customers
        FROM ${from} WHERE ${where} GROUP BY 1 ORDER BY revenue DESC, value LIMIT 1000`,
    ).all<Record<string, unknown>>();
    const all = res.results ?? [];
    const total = all.reduce((n, r) => n + Number(r.revenue), 0);
    const rows: RevenueSourceRow[] = all.slice(offset, offset + limit).map((r) => ({
      value: String(r.value),
      revenue: toMajor(Number(r.revenue), site.currency),
      newRevenue: toMajor(Number(r.new_revenue), site.currency),
      renewalRevenue: toMajor(Number(r.renewal_revenue), site.currency),
      refunds: toMajor(Number(r.refunds), site.currency),
      payments: Number(r.payments),
      customers: Number(r.customers),
      share: percentage(Number(r.revenue), total),
    }));
    return success(c, rows, {
      pagination: paginationOf(limit, offset, all.length),
      extra: { currency: site.currency, groupBy, model: x.model },
    });
  },
);

const TIME_BUCKETS: Array<{
  bucket: PathToPurchase["timeToPurchase"][number]["bucket"];
  maxDays: number;
}> = [
  { bucket: "same_day", maxDays: 1 },
  { bucket: "1_7_days", maxDays: 7 },
  { bucket: "8_30_days", maxDays: 30 },
  { bucket: "31_90_days", maxDays: 90 },
  { bucket: "over_90_days", maxDays: Number.POSITIVE_INFINITY },
];

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

revenueRoutes.get(
  "/api/v1/analytics/revenue/path-to-purchase",
  requireSiteAccess("analytics:read"),
  async (c) => {
    const x = common(c);
    const { site } = x;
    const col = raw(attributionColumn(x.model));
    const counted = kinds(paymentCountKinds(true));
    const filterSql = x.filters.length
      ? sql`AND ${compileFilters(x.filters, { siteId: site.id, range: null, sessionAlias: "s" })}`
      : sql``;
    const res = await prepare(
      c.env.DB,
      sql`WITH firsts AS (
          SELECT * FROM (
            SELECT p.visitor_id, p.occurred_at, p.reporting_minor, p.${col} AS attributed_session,
              ROW_NUMBER() OVER (PARTITION BY p.visitor_id ORDER BY p.occurred_at, p.id) AS rn
            FROM payments p WHERE p.site_id = ${site.id} AND p.visitor_id IS NOT NULL AND p.kind IN ${counted}
          ) WHERE rn = 1 AND occurred_at >= ${x.range.startMs} AND occurred_at < ${x.range.endMs}
        )
        SELECT f.visitor_id, f.occurred_at AS paid_at, f.reporting_minor,
          (SELECT MIN(started_at) FROM sessions a WHERE a.site_id = ${site.id} AND a.visitor_id = f.visitor_id) AS first_seen,
          (SELECT COUNT(*) FROM sessions a WHERE a.site_id = ${site.id} AND a.visitor_id = f.visitor_id AND a.started_at <= f.occurred_at) AS sessions_before,
          (SELECT COALESCE(SUM(a.pageviews), 0) FROM sessions a WHERE a.site_id = ${site.id} AND a.visitor_id = f.visitor_id AND a.started_at <= f.occurred_at) AS pageviews_before,
          (SELECT a.channel FROM sessions a WHERE a.site_id = ${site.id} AND a.visitor_id = f.visitor_id ORDER BY a.started_at LIMIT 1) AS first_channel,
          (SELECT a.channel FROM sessions a WHERE a.site_id = ${site.id} AND a.visitor_id = f.visitor_id AND a.started_at <= f.occurred_at ORDER BY a.started_at DESC LIMIT 1) AS last_channel
        FROM firsts f LEFT JOIN sessions s ON s.site_id = ${site.id} AND s.id = f.attributed_session
        WHERE 1 = 1 ${filterSql}
        LIMIT 5000`,
    ).all<Record<string, unknown>>();
    const rows = (res.results ?? []).filter((r) => r.first_seen !== null);
    const days = rows.map((r) => Math.max(0, (Number(r.paid_at) - Number(r.first_seen)) / DAY));
    const sessions = rows.map((r) => Math.max(1, Number(r.sessions_before)));
    const pageviews = rows.map((r) => Number(r.pageviews_before));
    const n = rows.length;
    const avg = (v: number[]) => (v.length ? round2(v.reduce((a, b) => a + b, 0) / v.length) : 0);
    const timeCounts = TIME_BUCKETS.map(() => 0);
    for (const d of days) {
      const i = TIME_BUCKETS.findIndex((b) => d < b.maxDays);
      timeCounts[i] = (timeCounts[i] ?? 0) + 1;
    }
    const sessionLabels = ["1", "2", "3", "4", "5+"] as const;
    const sessionCounts = sessionLabels.map(() => 0);
    for (const s of sessions) {
      const i = Math.min(4, s - 1);
      sessionCounts[i] = (sessionCounts[i] ?? 0) + 1;
    }
    const paths = new Map<
      string,
      { firstChannel: string; lastChannel: string; customers: number; revenue: number }
    >();
    for (const r of rows) {
      const firstChannel = String(r.first_channel ?? "Unknown");
      const lastChannel = String(r.last_channel ?? firstChannel);
      const key = `${firstChannel}\u0000${lastChannel}`;
      const p = paths.get(key) ?? { firstChannel, lastChannel, customers: 0, revenue: 0 };
      p.customers += 1;
      p.revenue += Number(r.reporting_minor);
      paths.set(key, p);
    }
    const body: PathToPurchase = {
      currency: site.currency,
      model: x.model,
      customers: n,
      averageDaysToPurchase: avg(days),
      medianDaysToPurchase: round2(median(days)),
      averageSessionsToPurchase: avg(sessions),
      medianSessionsToPurchase: median(sessions),
      averagePageviewsToPurchase: avg(pageviews),
      timeToPurchase: TIME_BUCKETS.map((b, i) => ({
        bucket: b.bucket,
        customers: timeCounts[i] ?? 0,
        percentage: percentage(timeCounts[i] ?? 0, n),
      })),
      sessionsToPurchase: sessionLabels.map((label, i) => ({
        sessions: label,
        customers: sessionCounts[i] ?? 0,
        percentage: percentage(sessionCounts[i] ?? 0, n),
      })),
      paths: [...paths.values()]
        .sort((a, b) => b.customers - a.customers || b.revenue - a.revenue)
        .slice(0, 20)
        .map((p) => ({ ...p, revenue: toMajor(p.revenue, site.currency) })),
    };
    return success(c, body);
  },
);
