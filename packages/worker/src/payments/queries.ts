import type { Env } from '../env';
import type { CreditModel } from './types';

/**
 * Derived reporting queries (design/attribution.md §8). All of them read
 * `payments` + `events`; no provider is called at query time. Revenue is net:
 * `amount_minor - refunded_minor - disputed_minor` (§9.1), so a refund is
 * reflected everywhere without rewriting history.
 */

const NET = '(amount_minor - refunded_minor - disputed_minor)';

function channelColumn(model: CreditModel): string {
  if (model === 'first_touch') return 'first_touch_channel';
  if (model === 'last_touch') return 'last_touch_channel';
  return 'last_non_direct_channel';
}

export interface RevenueBySourceRow {
  channel: string;
  payments: number;
  revenue: number;
  paying_visitors: number;
}

/** §8.1 — revenue by source for the selected model. */
export async function revenueBySource(
  env: Env,
  websiteId: string,
  from: number,
  to: number,
  model: CreditModel,
): Promise<RevenueBySourceRow[]> {
  const column = channelColumn(model);
  const result = await env.DB.prepare(
    `SELECT ${column} AS channel,
            COUNT(*) AS payments,
            COALESCE(SUM(${NET}), 0) AS revenue,
            COUNT(DISTINCT visitor_id) AS paying_visitors
     FROM payments
     WHERE website_id = ? AND occurred_at BETWEEN ? AND ? AND attributed = 1
     GROUP BY ${column}
     ORDER BY revenue DESC`,
  )
    .bind(websiteId, from, to)
    .all<RevenueBySourceRow>();
  return result.results.map((row) => ({
    channel: row.channel ?? '(unattributed)',
    payments: row.payments,
    revenue: (row.revenue ?? 0) / 100,
    paying_visitors: row.paying_visitors,
  }));
}

export interface LtvBySourceRow {
  channel: string;
  paying_visitors: number;
  ltv: number;
}

/** §8.2 — LTV by source over paying visitors. */
export async function ltvBySource(
  env: Env,
  websiteId: string,
  from: number,
  to: number,
  model: CreditModel,
): Promise<LtvBySourceRow[]> {
  const column = channelColumn(model);
  const result = await env.DB.prepare(
    `SELECT ${column} AS channel,
            COUNT(DISTINCT visitor_id) AS paying_visitors,
            COALESCE(SUM(${NET}), 0) / 100.0 / COUNT(DISTINCT visitor_id) AS ltv
     FROM payments
     WHERE website_id = ? AND occurred_at BETWEEN ? AND ? AND attributed = 1
     GROUP BY ${column}
     ORDER BY ltv DESC`,
  )
    .bind(websiteId, from, to)
    .all<LtvBySourceRow>();
  return result.results.map((row) => ({
    channel: row.channel ?? '(unattributed)',
    paying_visitors: row.paying_visitors,
    ltv: row.ltv ?? 0,
  }));
}

/** §8.2 — LTV by source over all visitors with a touch in the window. */
export async function ltvAllVisitors(
  env: Env,
  websiteId: string,
  from: number,
  to: number,
): Promise<LtvBySourceRow[]> {
  const result = await env.DB.prepare(
    `SELECT e.channel AS channel,
            COUNT(DISTINCT e.visitor_id) AS paying_visitors,
            COALESCE(SUM(${NET}), 0) / 100.0 / COUNT(DISTINCT e.visitor_id) AS ltv
     FROM events e
     LEFT JOIN payments p
       ON p.website_id = e.website_id AND p.visitor_id = e.visitor_id AND p.attributed = 1
     WHERE e.website_id = ? AND e.ts BETWEEN ? AND ? AND e.is_bot = 0
     GROUP BY e.channel
     ORDER BY ltv DESC`,
  )
    .bind(websiteId, from, to)
    .all<LtvBySourceRow>();
  return result.results.map((row) => ({
    channel: row.channel ?? '(unattributed)',
    paying_visitors: row.paying_visitors,
    ltv: row.ltv ?? 0,
  }));
}

export interface RevenuePerVisitorRow {
  channel: string;
  visitors: number;
  revenue: number;
  rpv: number;
}

/** §8.3 — revenue per visitor by channel. */
export async function revenuePerVisitor(
  env: Env,
  websiteId: string,
  from: number,
  to: number,
): Promise<RevenuePerVisitorRow[]> {
  const result = await env.DB.prepare(
    `SELECT e.channel AS channel,
            COUNT(DISTINCT e.visitor_id) AS visitors,
            COALESCE(SUM(${NET}), 0) / 100.0 AS revenue
     FROM events e
     LEFT JOIN payments p
       ON p.website_id = e.website_id AND p.visitor_id = e.visitor_id AND p.attributed = 1
     WHERE e.website_id = ? AND e.ts BETWEEN ? AND ? AND e.is_bot = 0
     GROUP BY e.channel
     ORDER BY revenue DESC`,
  )
    .bind(websiteId, from, to)
    .all<RevenuePerVisitorRow>();
  return result.results.map((row) => ({
    channel: row.channel ?? '(unattributed)',
    visitors: row.visitors,
    revenue: row.revenue ?? 0,
    rpv: row.visitors > 0 ? (row.revenue ?? 0) / row.visitors : 0,
  }));
}

export interface PathStep {
  occurred_at: number;
  channel: string | null;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  landing_page: string | null;
  direct: number;
}

/**
 * §8.4 — the ordered touches that led to one payment. Direct touches are
 * included (the dashboard de-emphasises them) so the non-direct path and the
 * direct tail are both visible.
 */
export async function pathToPurchase(
  env: Env,
  websiteId: string,
  visitorId: string,
  paymentOccurredAt: number,
  limit = 10,
): Promise<PathStep[]> {
  const result = await env.DB.prepare(
    `SELECT ts AS occurred_at, channel, utm_source AS source, utm_medium AS medium,
            utm_campaign AS campaign, path AS landing_page
     FROM events
     WHERE website_id = ? AND visitor_id = ? AND is_bot = 0 AND ts <= ?
     ORDER BY ts DESC, id DESC
     LIMIT ?`,
  )
    .bind(websiteId, visitorId, paymentOccurredAt, limit)
    .all<Omit<PathStep, 'direct'>>();
  return result.results.map((row) => ({ ...row, direct: row.channel === 'direct' ? 1 : 0 }));
}

export interface CohortRow {
  channel: string;
  cohort_day: string;
  weeks_since: number;
  revenue: number;
  payers: number;
}

/** §8.5 — cohort revenue by first-touch week and weeks since first touch. */
export async function cohorts(
  env: Env,
  websiteId: string,
  from: number,
  to: number,
  model: CreditModel = 'first_touch',
): Promise<CohortRow[]> {
  const column = channelColumn(model);
  const result = await env.DB.prepare(
    `SELECT ${column} AS channel,
            date(${column.replace('_channel', '_at')}, 'unixepoch') AS cohort_day,
            CAST((occurred_at - ${column.replace('_channel', '_at')}) / (7 * 86400) AS INTEGER) AS weeks_since,
            COALESCE(SUM(${NET}), 0) / 100.0 AS revenue,
            COUNT(DISTINCT visitor_id) AS payers
     FROM payments
     WHERE website_id = ? AND occurred_at BETWEEN ? AND ? AND attributed = 1
       AND ${column.replace('_channel', '_at')} IS NOT NULL
     GROUP BY channel, cohort_day, weeks_since
     ORDER BY cohort_day ASC, weeks_since ASC`,
  )
    .bind(websiteId, from, to)
    .all<CohortRow>();
  return result.results.map((row) => ({
    channel: row.channel ?? '(unattributed)',
    cohort_day: row.cohort_day ?? '',
    weeks_since: row.weeks_since ?? 0,
    revenue: row.revenue ?? 0,
    payers: row.payers,
  }));
}
