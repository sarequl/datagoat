/**
 * Long-range strategy (plan §9). Raw tables give exact numbers and are cheap for small ranges.
 * For large ranges the daily rollups (written by the `query.rollups` job for closed days) are
 * read instead, plus raw tables for the days after the rollup watermark (today, yesterday).
 *
 * Rollups are used only when the answer can come from them: no filters, the request timezone is
 * the website timezone the rollups were computed in, and the range is whole local days (or all
 * time). Then:
 * - breakdowns, pages, goals and timeseries use them when the covered days hold at least
 *   ROLLUP_MIN_SESSIONS sessions (default 20000), or when part of the range is older than the
 *   website's retention window (raw events there are pruned; rollups survive pruning);
 * - the overview uses them only for pruned ranges, since its distinct-visitor count needs the
 *   sessions scan anyway.
 * Visitor counts from rollups are sums of daily unique visitors; responses say so with
 * `approximate: true`.
 */
import { addDays, DAY_MS, localDate, startOfDate } from "../lib/time";
import type { QueryContext } from "./context";

export interface RollupState {
  timezone: string;
  firstDay: string | null;
  throughDay: string | null;
}

export async function loadRollupState(db: D1Database, siteId: string): Promise<RollupState | null> {
  const row = await db
    .prepare("SELECT timezone, first_day, through_day FROM rollup_state WHERE site_id = ?")
    .bind(siteId)
    .first<{ timezone: string; first_day: string | null; through_day: string | null }>();
  return row
    ? { timezone: row.timezone, firstDay: row.first_day, throughDay: row.through_day }
    : null;
}

export type Source =
  | { mode: "raw" }
  | {
      mode: "rollup";
      /** First rolled-up day to read (inclusive); null = from the beginning. */
      fromDay: string | null;
      /** Last rolled-up day to read (inclusive). */
      toDay: string;
      /** Raw tables cover [rawStartMs, rawEndMs); rawEndMs null = open-ended (all time). */
      rawStartMs: number;
      rawEndMs: number | null;
    };

export const DEFAULT_ROLLUP_MIN_SESSIONS = 20_000;

export function rollupThreshold(env: Cloudflare.Env): number {
  const v = Number.parseInt(env.ROLLUP_MIN_SESSIONS ?? "", 10);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_ROLLUP_MIN_SESSIONS;
}

/** True when part of the range is older than the website's event retention window. */
export function touchesPrunedDays(qc: QueryContext): boolean {
  if (!qc.site.retentionDays) return false;
  const cutoff = qc.now - qc.site.retentionDays * DAY_MS;
  return qc.range === null || qc.range.startMs < cutoff;
}

function isDayAligned(ms: number, tz: string): boolean {
  return startOfDate(localDate(ms, tz), tz) === ms;
}

export type SourceKind = "overview" | "breakdown";

/** Decide where a query reads from. Costs at most two small D1 reads. */
export async function chooseSource(qc: QueryContext, kind: SourceKind): Promise<Source> {
  if (qc.filters.length > 0) return { mode: "raw" };
  const tz = qc.site.timezone;
  if (qc.timezone !== tz) return { mode: "raw" };
  if (qc.range && !(isDayAligned(qc.range.startMs, tz) && isDayAligned(qc.range.endMs, tz))) {
    return { mode: "raw" };
  }
  const pruned = touchesPrunedDays(qc);
  if (kind === "overview" && !pruned) return { mode: "raw" };
  const state = await loadRollupState(qc.db, qc.site.id);
  if (!state || state.timezone !== tz || !state.throughDay) return { mode: "raw" };
  const fromDay = qc.range ? localDate(qc.range.startMs, tz) : null;
  const endDay = qc.range ? localDate(qc.range.endMs - 1, tz) : null;
  if (fromDay !== null && fromDay > state.throughDay) return { mode: "raw" };
  const toDay = endDay !== null && endDay < state.throughDay ? endDay : state.throughDay;
  if (!pruned) {
    const est = await qc.db
      .prepare(
        "SELECT COALESCE(SUM(sessions), 0) AS n FROM daily_stats WHERE site_id = ? AND day >= ? AND day <= ?",
      )
      .bind(qc.site.id, fromDay ?? "0000-00-00", toDay)
      .first<number>("n");
    if ((est ?? 0) < rollupThreshold(qc.env)) return { mode: "raw" };
  }
  return {
    mode: "rollup",
    fromDay,
    toDay,
    rawStartMs: startOfDate(addDays(toDay, 1), tz),
    rawEndMs: qc.range ? qc.range.endMs : null,
  };
}

/** The raw remainder of a rollup source as a range (null when there is none). */
export function rawRemainder(
  source: Extract<Source, { mode: "rollup" }>,
  qc: QueryContext,
): { startMs: number; endMs: number; timezone: string } | null {
  const end = source.rawEndMs ?? qc.now + DAY_MS;
  if (source.rawStartMs >= end) return null;
  return { startMs: source.rawStartMs, endMs: end, timezone: qc.timezone };
}
