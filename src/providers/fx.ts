/**
 * Currency conversion (plan §10.5).
 *
 * Every payment keeps its original amount and currency and is converted to the website's
 * reporting currency at ingest with the European Central Bank's daily reference rates, stored in
 * `fx_rates` as units of each currency per 1 USD (ECB publishes per EUR; we rebase on USD).
 *
 * Rate choice for a payment on day D (UTC): the latest published rate on or before D; payments
 * older than the first stored rate use the earliest rate. When a currency has no rate at all
 * (ECB does not publish it, or the FX job has not run yet), the row is stored with
 * `fx_rate = NULL` and the unconverted amount, and `providers.fx` re-converts it once a rate
 * exists. Changing a website's currency re-converts its payments the same way.
 */
import { currencyExponent } from "../lib/money";
import type { FetchFn } from "./types";

export const ECB_DAILY_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
export const ECB_90D_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml";

export interface EcbDay {
  day: string;
  /** Units per EUR. */
  perEur: Record<string, number>;
}

/** Parse ECB's eurofxref XML (daily or historical) into days. */
export function parseEcbXml(xml: string): EcbDay[] {
  const days: EcbDay[] = [];
  const dayRe = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]\s*>([\s\S]*?)<\/Cube>/g;
  const rateRe = /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]\s*\/>/g;
  for (const m of xml.matchAll(dayRe)) {
    const perEur: Record<string, number> = { EUR: 1 };
    for (const r of (m[2] ?? "").matchAll(rateRe)) {
      const rate = Number(r[2]);
      if (r[1] && Number.isFinite(rate) && rate > 0) perEur[r[1]] = rate;
    }
    if (m[1]) days.push({ day: m[1], perEur });
  }
  return days;
}

/** Rebase per-EUR rates on USD: per_usd(c) = perEur(c) / perEur(USD). */
export function toPerUsd(day: EcbDay): Record<string, number> | null {
  const usd = day.perEur.USD;
  if (!usd) return null;
  const out: Record<string, number> = {};
  for (const [c, r] of Object.entries(day.perEur)) out[c] = r / usd;
  out.USD = 1;
  return out;
}

export async function fetchEcb(fetchFn: FetchFn, history: boolean): Promise<EcbDay[]> {
  const res = await fetchFn(history ? ECB_90D_URL : ECB_DAILY_URL, {
    headers: { accept: "application/xml, text/xml" },
  });
  if (!res.ok) throw new Error(`ECB rates request failed with HTTP ${res.status}`);
  return parseEcbXml(await res.text());
}

/** UTC day of an epoch-ms instant. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Rates for a set of currencies, answering "per_usd on or before day D". */
export class RateTable {
  private readonly byCurrency = new Map<string, Array<{ day: string; perUsd: number }>>();

  add(currency: string, day: string, perUsd: number): void {
    const list = this.byCurrency.get(currency) ?? [];
    list.push({ day, perUsd });
    this.byCurrency.set(currency, list);
  }

  finish(): this {
    for (const list of this.byCurrency.values()) list.sort((a, b) => a.day.localeCompare(b.day));
    return this;
  }

  perUsd(currency: string, day: string): number | null {
    if (currency === "USD") return 1;
    const list = this.byCurrency.get(currency);
    if (!list?.length) return null;
    let best = list[0] ?? null;
    for (const entry of list) {
      if (entry.day <= day) best = entry;
      else break;
    }
    return best?.perUsd ?? null;
  }

  /** Units of `to` per unit of `from` on `day`, or null when either rate is missing. */
  rate(from: string, to: string, day: string): number | null {
    if (from === to) return 1;
    const f = this.perUsd(from, day);
    const t = this.perUsd(to, day);
    if (f === null || t === null || f <= 0) return null;
    return t / f;
  }
}

/** Convert minor units between currencies with a major-unit rate. */
export function convertMinor(amountMinor: number, from: string, to: string, rate: number): number {
  const major = amountMinor / 10 ** currencyExponent(from);
  const scaled = major * rate * 10 ** currencyExponent(to);
  return Math.sign(scaled) * Math.round(Math.abs(scaled) + Number.EPSILON);
}

export interface Conversion {
  reportingMinor: number;
  fxRate: number | null;
}

export function convert(
  table: RateTable,
  amountMinor: number,
  from: string,
  to: string,
  occurredAt: number,
): Conversion {
  if (from === to) return { reportingMinor: amountMinor, fxRate: 1 };
  const rate = table.rate(from, to, utcDay(occurredAt));
  if (rate === null) return { reportingMinor: amountMinor, fxRate: null };
  return { reportingMinor: convertMinor(amountMinor, from, to, rate), fxRate: rate };
}

const DAY_MS = 86_400_000;

/**
 * Statements loading the rates needed to convert payments of `currencies` between two instants:
 * every stored day in the window (padded a week back for weekends/holidays) plus the earliest
 * stored day per currency (for payments older than the stored history).
 */
export function rateStatements(
  db: D1Database,
  currencies: readonly string[],
  fromMs: number,
  toMs: number,
): D1PreparedStatement[] {
  const list = [...new Set(currencies.filter((c) => c !== "USD"))];
  if (!list.length) return [];
  const ph = list.map(() => "?").join(", ");
  return [
    db
      .prepare(
        `SELECT day, currency, per_usd FROM fx_rates WHERE currency IN (${ph}) AND day >= ? AND day <= ?`,
      )
      .bind(...list, utcDay(fromMs - 7 * DAY_MS), utcDay(toMs)),
    db
      .prepare(
        `SELECT f.day, f.currency, f.per_usd FROM fx_rates f
         JOIN (SELECT currency, MIN(day) AS day FROM fx_rates WHERE currency IN (${ph}) GROUP BY currency) m
           ON m.currency = f.currency AND m.day = f.day
         UNION ALL
         SELECT f.day, f.currency, f.per_usd FROM fx_rates f
         JOIN (SELECT currency, MAX(day) AS day FROM fx_rates WHERE currency IN (${ph}) GROUP BY currency) m
           ON m.currency = f.currency AND m.day = f.day`,
      )
      .bind(...list, ...list),
  ];
}

export function rateTableFrom(results: D1Result[]): RateTable {
  const table = new RateTable();
  const seen = new Set<string>();
  for (const r of results) {
    for (const row of (r.results ?? []) as Array<{
      day: string;
      currency: string;
      per_usd: number;
    }>) {
      const key = `${row.currency}:${row.day}`;
      if (seen.has(key)) continue;
      seen.add(key);
      table.add(row.currency, row.day, Number(row.per_usd));
    }
  }
  return table.finish();
}

export async function loadRates(
  db: D1Database,
  currencies: readonly string[],
  fromMs: number,
  toMs: number,
): Promise<RateTable> {
  const stmts = rateStatements(db, currencies, fromMs, toMs);
  if (!stmts.length) return new RateTable();
  return rateTableFrom(await db.batch(stmts));
}
