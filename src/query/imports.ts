/**
 * Imported history (W6's Plausible import, `imported_daily`) merged into analytics, following the
 * contract in docs/architecture/data-model.md:
 *
 * - only rows of completed imports count;
 * - only days before the website's first native session (the import cutoff), so a period covered
 *   by both sources is never counted twice;
 * - `dimension = ''` rows are daily totals (`visits` = sessions, `duration_sum` in ms);
 * - visitors summed over days are sums of daily uniques, so merged responses are `approximate`.
 *
 * Imported days are whole days in the website timezone and carry no cross-dimension detail, so
 * they are merged only when the request has no filters, uses the website timezone and covers whole
 * days (or all time), and only at day granularity or coarser. Imports have no revenue, goals or
 * new/returning split, so those stay native-only.
 *
 * Merged dimensions: totals, timeseries (day/week/month), referrers, channels, countries, devices,
 * browsers, operating systems, pages, entry pages and exit pages. Not merged because Plausible's
 * export cannot be mapped onto DataGoat's values: regions (ISO 3166-2 codes, DataGoat stores
 * names), cities (GeoNames ids, DataGoat stores names), hostnames (not exported) and campaigns
 * (Plausible exports each UTM field separately, not the combinations).
 */
import { raw, type SqlFragment, sql } from "../lib/sql";
import { addDays, localDate, startOfDate } from "../lib/time";
import type { QueryContext } from "./context";

export interface ImportScope {
  fromDay: string;
  toDay: string;
}

/** Merge imported data for this request? Costs one tiny query (index seeks only). */
export async function resolveImportScope(qc: QueryContext): Promise<ImportScope | null> {
  if (qc.filters.length > 0) return null;
  const tz = qc.site.timezone;
  if (qc.timezone !== tz) return null;
  if (qc.range) {
    const aligned = (ms: number) => startOfDate(localDate(ms, tz), tz) === ms;
    if (!aligned(qc.range.startMs) || !aligned(qc.range.endMs)) return null;
  }
  const row = await qc.db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM imports WHERE site_id = ?1 AND status = 'completed') AS has,
         (SELECT MIN(started_at) FROM sessions WHERE site_id = ?1) AS first`,
    )
    .bind(qc.site.id)
    .first<{ has: number; first: number | null }>();
  if (!row?.has) return null;
  const cutoff = row.first === null || row.first === undefined ? null : localDate(row.first, tz);
  const fromDay = qc.range ? localDate(qc.range.startMs, tz) : "0000-00-00";
  let toDay = qc.range ? localDate(qc.range.endMs - 1, tz) : "9999-12-31";
  if (cutoff && toDay >= cutoff) toDay = addDays(cutoff, -1);
  return fromDay <= toDay ? { fromDay, toDay } : null;
}

function scopeWhere(qc: QueryContext, scope: ImportScope, dimension: string): SqlFragment {
  return sql`site_id = ${qc.site.id} AND dimension = ${dimension} AND day >= ${scope.fromDay}
    AND day <= ${scope.toDay}
    AND import_id IN (SELECT id FROM imports WHERE site_id = ${qc.site.id} AND status = 'completed')`;
}

/** Imported daily totals: columns day, visitors, sessions, pageviews, bounces, duration_sum. */
export function importedDailySql(qc: QueryContext, scope: ImportScope): SqlFragment {
  return sql`SELECT day, SUM(visitors) AS visitors, SUM(visits) AS sessions, SUM(pageviews) AS pageviews,
      SUM(bounces) AS bounces, SUM(duration_sum) AS duration_sum
    FROM imported_daily WHERE ${scopeWhere(qc, scope, "")} GROUP BY day`;
}

/** Imported totals over the scope (one row, same columns as `importedDailySql` minus day). */
export function importedTotalsSql(qc: QueryContext, scope: ImportScope): SqlFragment {
  return sql`SELECT COALESCE(SUM(visitors), 0) AS visitors, COALESCE(SUM(visits), 0) AS sessions,
      COALESCE(SUM(pageviews), 0) AS pageviews, COALESCE(SUM(bounces), 0) AS bounces,
      COALESCE(SUM(duration_sum), 0) AS duration_sum
    FROM imported_daily WHERE ${scopeWhere(qc, scope, "")}`;
}

/**
 * Imported rows of one dimension shaped like a breakdown union term: `c0, visitors` or, for page
 * dimensions (no hostname in the export: the website domain is used), `c0, c1, visitors` with
 * optional extra zero/pageview columns.
 */
export function importedTermSql(
  qc: QueryContext,
  scope: ImportScope,
  dimension: string,
  shape: "value" | "page",
  extra = "",
): SqlFragment {
  const columns = shape === "page" ? sql`${qc.site.domain} AS c0, value AS c1` : raw("value AS c0");
  return sql`SELECT ${columns}, SUM(visitors) AS visitors${raw(extra)}
    FROM imported_daily WHERE ${scopeWhere(qc, scope, dimension)} GROUP BY value`;
}

/** Dimension of `imported_daily` per breakdown, or null when it cannot be merged (see above). */
export const IMPORTED_DIMENSION = {
  referrers: "referrer",
  channels: "channel",
  countries: "country",
  devices: "device",
  browsers: "browser",
  os: "os",
  entryPages: "entry_page",
  exitPages: "exit_page",
  regions: null,
  cities: null,
  hostnames: null,
  campaigns: null,
} as const;
