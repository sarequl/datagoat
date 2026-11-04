/**
 * Read helpers for imported analytics (Plausible imports), for the analytics query layer (W2) to
 * merge into totals, time series and breakdowns, as DataFast does after an import.
 *
 * Contract (docs/architecture/data-model.md, `imported_daily`):
 * - Only completed imports count (`imports.status = 'completed'`); a cancelled import has no rows.
 * - Imported days are used only **before** the first natively tracked session (`importCutoff`),
 *   so a period covered by both sources is never counted twice.
 * - `dimension = ''` rows are daily totals (visitors, visits = sessions, pageviews, bounces,
 *   duration in ms). Dimension values use DataGoat's vocabulary: `referrer` holds the source
 *   display name ("Google", "Direct / None"), `country` ISO codes, `device` desktop/mobile/tablet,
 *   `page`/`entry_page`/`exit_page` paths, `utm_*`, `browser`, `os`, `region`, `city`.
 * - Visitors summed over several days are a sum of daily uniques (label them as such).
 */

export interface ImportedTotals {
  day: string;
  visitors: number;
  visits: number;
  pageviews: number;
  bounces: number;
  durationSum: number;
}

/** First local day with native data, or null when nothing has been tracked yet. */
export async function importCutoff(
  db: D1Database,
  siteId: string,
  timezone: string,
): Promise<string | null> {
  const row = await db
    .prepare("SELECT MIN(started_at) AS first FROM sessions WHERE site_id = ?")
    .bind(siteId)
    .first<{ first: number | null }>();
  if (!row?.first) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(row.first));
}

const COMPLETED = `import_id IN (SELECT id FROM imports WHERE site_id = ?1 AND status = 'completed')`;

/** Daily imported totals in [fromDay, toDay] (inclusive), before `cutoff` when given. */
export async function importedDailyTotals(
  db: D1Database,
  siteId: string,
  fromDay: string,
  toDay: string,
  cutoff: string | null,
): Promise<ImportedTotals[]> {
  const res = await db
    .prepare(
      `SELECT day, SUM(visitors) AS visitors, SUM(visits) AS visits, SUM(pageviews) AS pageviews,
         SUM(bounces) AS bounces, SUM(duration_sum) AS duration_sum
       FROM imported_daily WHERE site_id = ?1 AND dimension = '' AND day >= ?2 AND day <= ?3
         AND (?4 IS NULL OR day < ?4) AND ${COMPLETED}
       GROUP BY day ORDER BY day`,
    )
    .bind(siteId, fromDay, toDay, cutoff)
    .all<Record<string, number | string>>();
  return (res.results ?? []).map((r) => ({
    day: String(r.day),
    visitors: Number(r.visitors),
    visits: Number(r.visits),
    pageviews: Number(r.pageviews),
    bounces: Number(r.bounces),
    durationSum: Number(r.duration_sum),
  }));
}

/** Imported breakdown for one dimension over [fromDay, toDay], top `limit` values by visitors. */
export async function importedBreakdown(
  db: D1Database,
  siteId: string,
  dimension: string,
  fromDay: string,
  toDay: string,
  cutoff: string | null,
  limit = 100,
): Promise<Array<{ value: string; visitors: number; visits: number; pageviews: number }>> {
  const res = await db
    .prepare(
      `SELECT value, SUM(visitors) AS visitors, SUM(visits) AS visits, SUM(pageviews) AS pageviews
       FROM imported_daily WHERE site_id = ?1 AND dimension = ?5 AND day >= ?2 AND day <= ?3
         AND (?4 IS NULL OR day < ?4) AND ${COMPLETED}
       GROUP BY value ORDER BY visitors DESC, value LIMIT ?6`,
    )
    .bind(siteId, fromDay, toDay, cutoff, dimension, limit)
    .all<Record<string, number | string>>();
  return (res.results ?? []).map((r) => ({
    value: String(r.value),
    visitors: Number(r.visitors),
    visits: Number(r.visits),
    pageviews: Number(r.pageviews),
  }));
}
