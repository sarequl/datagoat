/**
 * Session-dimension breakdowns (referrers, channels, campaigns, countries, regions, cities,
 * devices, browsers, operating systems, hostnames, entry and exit pages). Rows are sorted by
 * visitors (desc), then value, and paginated in SQL.
 *
 * - visitors: distinct visitors of the sessions in the range whose dimension has the value
 *   (rollup mode: sum of daily uniques, `approximate`);
 * - revenue/payments: payments that occurred in the range, joined to the session chosen by the
 *   attribution model, grouped by that session's dimension value (always raw: payments are
 *   small).
 */
import { prepare, raw, type SqlFragment, sql } from "../lib/sql";
import { bucketKeySql } from "../lib/time";
import { type QueryContext, rangeOn, sessionScope } from "./context";
import { paymentAggregates, paymentScope } from "./revenue";
import { chooseSource, rawRemainder, type Source } from "./strategy";

export interface BreakdownColumn {
  /** Output alias (c0, c1, …) is positional; `expr` is SQL over the sessions alias `s`. */
  expr: string;
}

export type RollupSpec =
  | { kind: "dimension"; dimension: string }
  | { kind: "pages"; metric: "entries" | "exits" };

export interface BreakdownSpec {
  columns: BreakdownColumn[];
  /** Extra predicate over `s` (e.g. campaigns: at least one parameter present). */
  where?: string;
  /** Drop rows whose first column is NULL/empty (default true). */
  skipEmpty?: boolean;
  rollup?: RollupSpec;
}

export interface BreakdownRow {
  values: string[];
  visitors: number;
  revenueMinor: number;
  payments: number;
}

export interface BreakdownResult {
  rows: BreakdownRow[];
  total: number;
  approximate: boolean;
}

export interface Page {
  limit: number;
  offset: number;
}

function cols(spec: BreakdownSpec, prefix = ""): string {
  return spec.columns.map((c, i) => `${c.expr} AS ${prefix}c${i}`).join(", ");
}
function colNames(spec: BreakdownSpec): string {
  return spec.columns.map((_, i) => `c${i}`).join(", ");
}
function keyOf(values: unknown[]): string {
  return JSON.stringify(values.map((v) => (v === null || v === undefined ? "" : String(v))));
}

function nonEmpty(spec: BreakdownSpec): string {
  return spec.skipEmpty === false ? "1=1" : "c0 IS NOT NULL AND c0 <> ''";
}

function rawStatement(qc: QueryContext, spec: BreakdownSpec, page: Page): SqlFragment {
  const extra = spec.where ? raw(spec.where) : raw("1=1");
  return sql`SELECT ${raw(colNames(spec))}, COUNT(DISTINCT v) AS visitors, COUNT(*) OVER () AS total_rows
    FROM (SELECT ${raw(cols(spec))}, s.visitor_id AS v FROM sessions s
      WHERE ${sessionScope(qc)} AND ${extra})
    WHERE ${raw(nonEmpty(spec))}
    GROUP BY ${raw(colNames(spec))}
    ORDER BY visitors DESC, ${raw(colNames(spec))}
    LIMIT ${page.limit} OFFSET ${page.offset}`;
}

function rollupStatement(
  qc: QueryContext,
  spec: BreakdownSpec,
  source: Extract<Source, { mode: "rollup" }>,
  page: Page,
): SqlFragment {
  const rollup = spec.rollup;
  if (!rollup) throw new Error("rollupStatement without a rollup spec");
  const from = source.fromDay ?? "0000-00-00";
  const rolled =
    rollup.kind === "dimension"
      ? sql`SELECT value AS c0, visitors FROM daily_dimensions WHERE site_id = ${qc.site.id}
          AND dimension = ${rollup.dimension} AND day >= ${from} AND day <= ${source.toDay}`
      : sql`SELECT hostname AS c0, path AS c1, ${raw(rollup.metric)} AS visitors FROM daily_pages
          WHERE site_id = ${qc.site.id} AND day >= ${from} AND day <= ${source.toDay} AND ${raw(rollup.metric)} > 0`;
  const remainder = rawRemainder(source, qc);
  let union = rolled;
  if (remainder) {
    const day = bucketKeySql(
      "s.started_at",
      "day",
      qc.timezone,
      remainder.startMs,
      remainder.endMs,
    );
    union = sql`${rolled} UNION ALL
      SELECT ${raw(colNames(spec))}, COUNT(DISTINCT v) FROM (
        SELECT ${raw(day.sql)} AS d, ${raw(cols(spec))}, s.visitor_id AS v FROM sessions s
        WHERE s.site_id = ${qc.site.id} AND ${rangeOn("s.started_at", remainder)})
      GROUP BY d, ${raw(colNames(spec))}`;
  }
  return sql`SELECT ${raw(colNames(spec))}, SUM(visitors) AS visitors, COUNT(*) OVER () AS total_rows
    FROM (${union}) WHERE ${raw(nonEmpty(spec))}
    GROUP BY ${raw(colNames(spec))}
    ORDER BY visitors DESC, ${raw(colNames(spec))}
    LIMIT ${page.limit} OFFSET ${page.offset}`;
}

function countStatement(qc: QueryContext, spec: BreakdownSpec): SqlFragment {
  const extra = spec.where ? raw(spec.where) : raw("1=1");
  return sql`SELECT COUNT(*) AS n FROM (SELECT DISTINCT ${raw(colNames(spec))} FROM
    (SELECT ${raw(cols(spec))} FROM sessions s WHERE ${sessionScope(qc)} AND ${extra})
    WHERE ${raw(nonEmpty(spec))})`;
}

function revenueStatement(qc: QueryContext, spec: BreakdownSpec): SqlFragment {
  const pay = paymentScope(qc, true);
  const extra = spec.where ? raw(spec.where) : raw("1=1");
  return sql`SELECT ${raw(cols(spec))}, ${raw(paymentAggregates(qc))}
    FROM ${pay.from} WHERE ${pay.where} AND ${extra}
    GROUP BY ${raw(colNames(spec))}`;
}

export async function runBreakdown(
  qc: QueryContext,
  spec: BreakdownSpec,
  page: Page,
): Promise<BreakdownResult> {
  const source: Source = spec.rollup ? await chooseSource(qc, "breakdown") : { mode: "raw" };
  const main =
    source.mode === "rollup"
      ? rollupStatement(qc, spec, source, page)
      : rawStatement(qc, spec, page);
  const [rowsRes, revRes] = await qc.db.batch([
    prepare(qc.db, main),
    prepare(qc.db, revenueStatement(qc, spec)),
  ]);
  const rows = (rowsRes?.results ?? []) as Array<Record<string, unknown>>;
  const revenue = new Map<string, { revenueMinor: number; payments: number }>();
  for (const r of (revRes?.results ?? []) as Array<Record<string, unknown>>) {
    const k = keyOf(spec.columns.map((_, i) => r[`c${i}`]));
    const prev = revenue.get(k) ?? { revenueMinor: 0, payments: 0 };
    revenue.set(k, {
      revenueMinor: prev.revenueMinor + Number(r.revenue_minor ?? 0),
      payments: prev.payments + Number(r.payments ?? 0),
    });
  }
  let total = Number(rows[0]?.total_rows ?? 0);
  if (rows.length === 0 && page.offset > 0 && source.mode === "raw") {
    total = Number((await prepare(qc.db, countStatement(qc, spec)).first<number>("n")) ?? 0);
  }
  return {
    rows: rows.map((r) => {
      const values = spec.columns.map((_, i) => (r[`c${i}`] === null ? "" : String(r[`c${i}`])));
      const rev = revenue.get(keyOf(values));
      return {
        values,
        visitors: Number(r.visitors ?? 0),
        revenueMinor: rev?.revenueMinor ?? 0,
        payments: rev?.payments ?? 0,
      };
    }),
    total,
    approximate: source.mode === "rollup",
  };
}

// ---------------------------------------------------------------------------
// Dimension specs
// ---------------------------------------------------------------------------

/** Source display name, else referrer domain, else DataFast's "Direct / None". */
export const REFERRER_EXPR = "COALESCE(s.source, s.referrer_domain, 'Direct / None')";
/** DataFast merges Mobile Safari into Safari. */
export const BROWSER_EXPR =
  "CASE WHEN s.browser = 'Mobile Safari' THEN 'Safari' ELSE s.browser END";

export const DIMENSIONS = {
  referrers: {
    columns: [{ expr: REFERRER_EXPR }],
    rollup: { kind: "dimension", dimension: "referrer" },
  },
  channels: {
    columns: [{ expr: "s.channel" }],
    rollup: { kind: "dimension", dimension: "channel" },
  },
  countries: {
    columns: [{ expr: "s.country" }],
    rollup: { kind: "dimension", dimension: "country" },
  },
  regions: { columns: [{ expr: "s.region" }], rollup: { kind: "dimension", dimension: "region" } },
  cities: { columns: [{ expr: "s.city" }], rollup: { kind: "dimension", dimension: "city" } },
  devices: { columns: [{ expr: "s.device" }], rollup: { kind: "dimension", dimension: "device" } },
  browsers: {
    columns: [{ expr: BROWSER_EXPR }],
    rollup: { kind: "dimension", dimension: "browser" },
  },
  os: { columns: [{ expr: "s.os" }], rollup: { kind: "dimension", dimension: "os" } },
  hostnames: {
    columns: [{ expr: "s.hostname" }],
    rollup: { kind: "dimension", dimension: "hostname" },
  },
  entryPages: {
    columns: [{ expr: "COALESCE(s.hostname, '')" }, { expr: "s.entry_path" }],
    skipEmpty: false,
    rollup: { kind: "pages", metric: "entries" },
  },
  exitPages: {
    columns: [
      { expr: "COALESCE(s.hostname, '')" },
      { expr: "COALESCE(s.exit_path, s.entry_path)" },
    ],
    skipEmpty: false,
    rollup: { kind: "pages", metric: "exits" },
  },
  campaigns: {
    columns: [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "ref",
      "source_param",
      "via",
    ].map((c) => ({ expr: `COALESCE(s.${c}, '')` })),
    skipEmpty: false,
    where:
      "(s.utm_source IS NOT NULL OR s.utm_medium IS NOT NULL OR s.utm_campaign IS NOT NULL OR s.utm_term IS NOT NULL OR s.utm_content IS NOT NULL OR s.ref IS NOT NULL OR s.source_param IS NOT NULL OR s.via IS NOT NULL)",
  },
} satisfies Record<string, BreakdownSpec>;

/** Dimensions the rollup job writes into daily_dimensions, as SQL over `s`. */
export const ROLLUP_DIMENSIONS: Array<{ dimension: string; expr: string }> = [
  { dimension: "referrer", expr: REFERRER_EXPR },
  { dimension: "channel", expr: "s.channel" },
  { dimension: "country", expr: "s.country" },
  { dimension: "region", expr: "s.region" },
  { dimension: "city", expr: "s.city" },
  { dimension: "device", expr: "s.device" },
  { dimension: "browser", expr: BROWSER_EXPR },
  { dimension: "os", expr: "s.os" },
  { dimension: "hostname", expr: "s.hostname" },
];

/** Flag emoji for an ISO 3166-1 alpha-2 code (regional indicator symbols). */
export function flagEmoji(code: string): string | null {
  if (!/^[A-Z]{2}$/.test(code) || code === "XX" || code === "T1") return null;
  return String.fromCodePoint(...[...code].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}
