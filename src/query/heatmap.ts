/**
 * Pageviews heatmap (DataGoat endpoint for DataFast's "pageviews heatmap": the days and hours
 * people browse the most). One pass over the range's pageviews, grouped by local ISO weekday
 * (1 = Monday … 7 = Sunday) and hour (0-23), DST-safe.
 */
import { prepare, raw, sql } from "../lib/sql";
import { localShiftSql } from "../lib/time";
import { eventScope, filterSql, hasFilters, type QueryContext } from "./context";

export async function pageviewHeatmap(
  qc: QueryContext & { range: { startMs: number; endMs: number } },
) {
  const shifted = localShiftSql("e.ts", qc.timezone, qc.range.startMs, qc.range.endMs);
  const join = hasFilters(qc)
    ? raw("JOIN sessions s ON s.site_id = e.site_id AND s.id = e.session_id")
    : raw("");
  const where = hasFilters(qc) ? filterSql(qc, "s") : raw("1=1");
  const res = await prepare(
    qc.db,
    sql`SELECT ((${raw(shifted)} / 86400000 + 3) % 7) + 1 AS weekday, (${raw(shifted)} / 3600000) % 24 AS hour,
        COUNT(*) AS pageviews, COUNT(DISTINCT e.visitor_id) AS visitors
      FROM events e ${join}
      WHERE ${eventScope(qc)} AND e.type = 'pageview' AND ${where}
      GROUP BY 1, 2 ORDER BY 1, 2`,
  ).all<{ weekday: number; hour: number; pageviews: number; visitors: number }>();
  const cells = new Map((res.results ?? []).map((r) => [`${r.weekday}:${r.hour}`, r]));
  const out: Array<{ weekday: number; hour: number; pageviews: number; visitors: number }> = [];
  for (let weekday = 1; weekday <= 7; weekday++) {
    for (let hour = 0; hour < 24; hour++) {
      const c = cells.get(`${weekday}:${hour}`);
      out.push({
        weekday,
        hour,
        pageviews: Number(c?.pageviews ?? 0),
        visitors: Number(c?.visitors ?? 0),
      });
    }
  }
  return out;
}
