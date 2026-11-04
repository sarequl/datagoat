/**
 * `query.retention` (hourly at :23): deletes `events` older than each website's
 * `retention_days`. Sessions, visitors and payments are kept, so attribution and visitor counts
 * survive pruning, and the daily rollups keep long-range history: events are only pruned for
 * days the rollup job has already rolled up (in the website's current timezone).
 *
 * Deleting costs D1 writes like inserting (row + index entries), so one run deletes at most
 * RETENTION_ROWS_PER_RUN events (default 2000) across all websites.
 */
import type { JobContext, JobDefinition } from "../../jobs/registry";
import { addDays, DAY_MS, startOfDate } from "../../lib/time";

export const DEFAULT_RETENTION_ROWS_PER_RUN = 2000;

interface Row {
  id: string;
  retention_days: number;
  timezone: string;
  r_timezone: string | null;
  through_day: string | null;
}

/** Events strictly before this instant may be deleted for the website (0 = none). */
export function retentionCutoff(row: Row, now: number): number {
  const cutoff = now - row.retention_days * DAY_MS;
  if (!row.through_day || row.r_timezone !== row.timezone) return 0;
  const rolled = startOfDate(addDays(row.through_day, 1), row.timezone);
  return Math.min(cutoff, rolled);
}

export async function runRetention(ctx: JobContext): Promise<void> {
  const { db, now } = ctx;
  let budget =
    Number.parseInt(ctx.env.RETENTION_ROWS_PER_RUN ?? "", 10) || DEFAULT_RETENTION_ROWS_PER_RUN;
  const sites =
    (
      await db
        .prepare(
          `SELECT s.id, s.retention_days, s.timezone, r.timezone AS r_timezone, r.through_day
           FROM sites s LEFT JOIN rollup_state r ON r.site_id = s.id
           WHERE s.deleted_at IS NULL AND s.retention_days IS NOT NULL ORDER BY s.id`,
        )
        .all<Row>()
    ).results ?? [];
  for (const site of sites) {
    if (budget <= 0 || ctx.remainingQueries() < 2) return;
    const cutoff = retentionCutoff(site, now);
    if (cutoff <= 0) continue;
    const res = await db
      .prepare(
        "DELETE FROM events WHERE id IN (SELECT id FROM events WHERE site_id = ? AND ts < ? ORDER BY ts LIMIT ?)",
      )
      .bind(site.id, cutoff, budget)
      .run();
    budget -= res.meta.changes ?? 0;
  }
}

export const retentionJob: JobDefinition = {
  name: "query.retention",
  schedule: { every: "hour", minute: 23 },
  run: runRetention,
  description: "Prune events older than each website's retention window (bounded deletes)",
};
