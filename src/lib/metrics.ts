/**
 * Metric definitions (plan §3.5, §9), shared by the analytics API, rollups, the MCP server and
 * share links so every surface computes the same numbers. Field names follow DataFast exactly.
 *
 * | field                | definition                                                                  |
 * |----------------------|-----------------------------------------------------------------------------|
 * | visitors             | distinct `sessions.visitor_id` of sessions started in the range              |
 * | new_visitors         | visitors whose lowest session_number in the range is < 2                    |
 * | returning_visitors   | visitors whose lowest session_number in the range is >= 2                   |
 * |                      | (visitors with only NULL session numbers, i.e. cookieless, are neither)     |
 * | sessions             | sessions started in the range                                               |
 * | pageviews            | sum of `sessions.pageviews` for those sessions                              |
 * | bounce_rate          | % of sessions with pageviews + interactions <= 1, 2 decimals                |
 * | avg_session_duration | mean of (last_seen_at - started_at) over sessions, whole seconds            |
 * | revenue              | sum of `payments.reporting_minor` (site currency, major units) for payments |
 * |                      | that occurred in the range; refunds are negative; renewals only when the    |
 * |                      | site includes renewal revenue; with filters, only payments whose attributed |
 * |                      | session (per attribution model) matches                                      |
 * | payments             | count of `payment` (+ `renewal`) rows, refunds and free trials excluded      |
 * | revenue_per_visitor  | revenue / visitors, 2 decimals                                              |
 * | conversion_rate      | % of visitors with a payment in the range, 2 decimals                       |
 */
import { round2, toMajor } from "./money";
import type { AttributionModel } from "./sites";

export const OVERVIEW_FIELDS = [
  "visitors",
  "new_visitors",
  "returning_visitors",
  "visitor_breakdown",
  "pageviews",
  "sessions",
  "bounce_rate",
  "avg_session_duration",
  "currency",
  "revenue",
  "payments",
  "revenue_per_visitor",
  "conversion_rate",
] as const;
export type OverviewField = (typeof OVERVIEW_FIELDS)[number];

export const TIMESERIES_FIELDS = [
  "name",
  "visitors",
  "new_visitors",
  "returning_visitors",
  "visitor_breakdown",
  "pageviews",
  "sessions",
  "revenue",
  "payments",
  "conversion_rate",
] as const;
export type TimeseriesField = (typeof TIMESERIES_FIELDS)[number];

const ALIAS_RE = /^[a-z_][a-z0-9_]*$/i;
function alias(a: string): string {
  if (!ALIAS_RE.test(a)) throw new Error(`Invalid SQL alias: ${a}`);
  return a;
}

/**
 * SELECT-list aggregates over a sessions alias. Produces columns
 * `visitors, sessions, pageviews, bounces, duration_sum`.
 */
export function sessionAggregatesSql(sessionAlias = "s"): string {
  const s = alias(sessionAlias);
  return [
    `COUNT(DISTINCT ${s}.visitor_id) AS visitors`,
    "COUNT(*) AS sessions",
    `COALESCE(SUM(${s}.pageviews), 0) AS pageviews`,
    `COALESCE(SUM(CASE WHEN ${s}.pageviews + ${s}.interactions <= 1 THEN 1 ELSE 0 END), 0) AS bounces`,
    `COALESCE(SUM(${s}.last_seen_at - ${s}.started_at), 0) AS duration_sum`,
  ].join(", ");
}

/**
 * New/returning classification. Wrap your filtered sessions query as
 *   SELECT ${visitorTypeAggregatesSql()} FROM (SELECT s.visitor_id, MIN(s.session_number) AS first_number
 *     FROM sessions s WHERE ... GROUP BY s.visitor_id)
 * Produces `classified_visitors, new_visitors, returning_visitors`.
 */
export function visitorTypeAggregatesSql(): string {
  return [
    "COUNT(first_number) AS classified_visitors",
    "COALESCE(SUM(CASE WHEN first_number < 2 THEN 1 ELSE 0 END), 0) AS new_visitors",
    "COALESCE(SUM(CASE WHEN first_number >= 2 THEN 1 ELSE 0 END), 0) AS returning_visitors",
  ].join(", ");
}

/** Session column a payment is attributed to under each attribution model. */
export function attributionColumn(model: AttributionModel): string {
  switch (model) {
    case "first_touch":
      return "first_session_id";
    case "last_touch":
      return "last_session_id";
    case "last_non_direct":
      return "last_non_direct_session_id";
  }
}

/** `JOIN sessions s ON ...` joining payments to their attributed session. */
export function paymentSessionJoinSql(
  model: AttributionModel,
  paymentAlias = "p",
  sessionAlias = "s",
): string {
  const p = alias(paymentAlias);
  const s = alias(sessionAlias);
  return `JOIN sessions ${s} ON ${s}.site_id = ${p}.site_id AND ${s}.id = ${p}.${attributionColumn(model)}`;
}

/** Payment kinds that count toward revenue. Refunds always count (negative amounts). */
export function revenueKinds(includeRenewalRevenue: boolean): string[] {
  return includeRenewalRevenue ? ["payment", "renewal", "refund"] : ["payment", "refund"];
}

/** Payment kinds that count as a payment (transaction count, paying visitors). */
export function paymentCountKinds(includeRenewalRevenue: boolean): string[] {
  return includeRenewalRevenue ? ["payment", "renewal"] : ["payment"];
}

function kindList(kinds: string[]): string {
  return `(${kinds.map((k) => `'${k}'`).join(", ")})`;
}

/**
 * SELECT-list aggregates over a payments alias. Produces
 * `revenue_minor, payments, paying_visitors, new_revenue_minor, renewal_revenue_minor, refund_minor`.
 * Filter rows to `occurred_at` in range yourself.
 */
export function paymentAggregatesSql(includeRenewalRevenue: boolean, paymentAlias = "p"): string {
  const p = alias(paymentAlias);
  const revenue = kindList(revenueKinds(includeRenewalRevenue));
  const counted = kindList(paymentCountKinds(includeRenewalRevenue));
  return [
    `COALESCE(SUM(CASE WHEN ${p}.kind IN ${revenue} THEN ${p}.reporting_minor ELSE 0 END), 0) AS revenue_minor`,
    `COALESCE(SUM(CASE WHEN ${p}.kind IN ${counted} THEN 1 ELSE 0 END), 0) AS payments`,
    `COUNT(DISTINCT CASE WHEN ${p}.kind IN ${counted} THEN ${p}.visitor_id END) AS paying_visitors`,
    `COALESCE(SUM(CASE WHEN ${p}.kind = 'payment' THEN ${p}.reporting_minor ELSE 0 END), 0) AS new_revenue_minor`,
    `COALESCE(SUM(CASE WHEN ${p}.kind = 'renewal' THEN ${p}.reporting_minor ELSE 0 END), 0) AS renewal_revenue_minor`,
    `COALESCE(SUM(CASE WHEN ${p}.kind = 'refund' THEN ${p}.reporting_minor ELSE 0 END), 0) AS refund_minor`,
  ].join(", ");
}

export interface RawTotals {
  visitors: number;
  sessions: number;
  pageviews: number;
  bounces: number;
  durationSum: number;
  revenueMinor: number;
  payments: number;
  payingVisitors: number;
  newVisitors?: number;
  returningVisitors?: number;
}

export interface VisitorBreakdown {
  new: number;
  returning: number;
  newPercentage: number;
  returningPercentage: number;
}

export interface DerivedMetrics {
  visitors: number;
  new_visitors: number;
  returning_visitors: number;
  visitorBreakdown: VisitorBreakdown;
  pageviews: number;
  sessions: number;
  bounce_rate: number;
  avg_session_duration: number;
  currency: string;
  revenue: number;
  payments: number;
  revenue_per_visitor: number;
  conversion_rate: number;
}

export function percentage(part: number, whole: number): number {
  return whole > 0 ? round2((100 * part) / whole) : 0;
}

export function visitorBreakdown(newVisitors: number, returningVisitors: number): VisitorBreakdown {
  const total = newVisitors + returningVisitors;
  return {
    new: newVisitors,
    returning: returningVisitors,
    newPercentage: percentage(newVisitors, total),
    returningPercentage: percentage(returningVisitors, total),
  };
}

/** Turn raw aggregates into DataFast's overview fields. */
export function deriveMetrics(t: RawTotals, currency: string): DerivedMetrics {
  const revenue = toMajor(t.revenueMinor, currency);
  const newVisitors = t.newVisitors ?? 0;
  const returningVisitors = t.returningVisitors ?? 0;
  return {
    visitors: t.visitors,
    new_visitors: newVisitors,
    returning_visitors: returningVisitors,
    visitorBreakdown: visitorBreakdown(newVisitors, returningVisitors),
    pageviews: t.pageviews,
    sessions: t.sessions,
    bounce_rate: percentage(t.bounces, t.sessions),
    avg_session_duration: t.sessions > 0 ? Math.round(t.durationSum / t.sessions / 1000) : 0,
    currency,
    revenue,
    payments: t.payments,
    revenue_per_visitor: t.visitors > 0 ? round2(revenue / t.visitors) : 0,
    conversion_rate: percentage(t.payingVisitors, t.visitors),
  };
}

/** Pick requested fields from derived metrics; `visitor_breakdown` maps to `visitorBreakdown`. */
export function pickFields(
  metrics: DerivedMetrics,
  fields: readonly OverviewField[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f === "visitor_breakdown") out.visitorBreakdown = metrics.visitorBreakdown;
    else out[f] = metrics[f];
  }
  return out;
}
