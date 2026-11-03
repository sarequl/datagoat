import type { Env, Website } from '../env';

interface PaymentRow {
  visitor_id: string | null;
  currency: string;
  occurred_at: number;
  net: number;
}

type RateList = Array<{ date: string; rate: number }>;
type RateMap = Map<string, RateList>;

/** FX rates are optional in v0; missing rates fall back to face value. */
export async function loadFxRates(env: Env): Promise<RateMap> {
  const rows = await env.DB.prepare('SELECT date, currency, usd_rate FROM fx_rates').all<{
    date: string;
    currency: string;
    usd_rate: number;
  }>();
  const map: RateMap = new Map();
  for (const row of rows.results) {
    const list = map.get(row.currency) ?? [];
    list.push({ date: row.date, rate: row.usd_rate });
    map.set(row.currency, list);
  }
  for (const list of map.values()) list.sort((a, b) => a.date.localeCompare(b.date));
  return map;
}

function rateOn(list: RateList | undefined, date: string): number | null {
  if (!list || list.length === 0) return null;
  let rate: number | null = null;
  for (const entry of list) {
    if (entry.date <= date) rate = entry.rate;
    else break;
  }
  return rate;
}

/**
 * Converts minor units to the site currency. `fx_rates.usd_rate` is the USD
 * value of one unit, so `site = net * fromRate / toRate`.
 */
export function convertCents(
  cents: number,
  from: string,
  to: string,
  occurredAt: number,
  rates: RateMap,
): number {
  if (from === to) return cents;
  const date = new Date(occurredAt * 1000).toISOString().slice(0, 10);
  const fromRate = rateOn(rates.get(from), date);
  const toRate = rateOn(rates.get(to), date);
  if (fromRate === null || toRate === null || toRate === 0) return cents;
  return Math.round((cents * fromRate) / toRate);
}

const PAYMENT_SELECT = `
  SELECT visitor_id, currency, occurred_at,
         COALESCE(amount_minor, amount_cents) - refunded_minor - disputed_minor AS net
  FROM payments
  WHERE website_id = ? AND occurred_at >= ? AND occurred_at <= ? AND attributed = 1`;

export async function loadVisitorRevenue(
  env: Env,
  site: Website,
  start: number,
  end: number,
): Promise<Map<string, { revenueCents: number; payments: number }>> {
  const rows = await env.DB.prepare(`${PAYMENT_SELECT} AND visitor_id IS NOT NULL`)
    .bind(site.id, start, end)
    .all<PaymentRow>();

  const rates = await loadFxRates(env);
  const map = new Map<string, { revenueCents: number; payments: number }>();
  for (const row of rows.results) {
    const visitorId = row.visitor_id as string;
    const entry = map.get(visitorId) ?? { revenueCents: 0, payments: 0 };
    entry.revenueCents += convertCents(
      row.net,
      row.currency,
      site.currency,
      row.occurred_at,
      rates,
    );
    entry.payments += 1;
    map.set(visitorId, entry);
  }
  return map;
}

export interface RevenueTotals {
  revenue: number;
  payments: number;
  payingVisitors: number;
}

export async function computeRevenue(
  env: Env,
  site: Website,
  start: number,
  end: number,
): Promise<RevenueTotals> {
  const rows = await env.DB.prepare(PAYMENT_SELECT).bind(site.id, start, end).all<PaymentRow>();

  const rates = await loadFxRates(env);
  const paying = new Set<string>();
  let revenueCents = 0;
  for (const row of rows.results) {
    if (row.visitor_id) paying.add(row.visitor_id);
    revenueCents += convertCents(row.net, row.currency, site.currency, row.occurred_at, rates);
  }
  return {
    revenue: revenueCents / 100,
    payments: rows.results.length,
    payingVisitors: paying.size,
  };
}
