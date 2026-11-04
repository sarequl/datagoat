/**
 * Time-bucketed metrics (DataFast `GET /analytics/timeseries`). Buckets are local hours, days,
 * ISO weeks (Monday) or months in the request timezone, computed inside D1 with DST-safe offsets
 * (`bucketKeySql`), plus DataGoat's one-minute buckets for ranges up to 6 hours (the dashboard's
 * "Now" period). One pass over the sessions yields every bucket and the range totals.
 *
 * DataGoat fields on top of DataFast's: `bounce_rate` and `avg_session_duration` per bucket (same
 * definitions as the overview) and `goals` (completions per goal name per bucket).
 */
import { ApiError } from "../lib/errors";
import { percentage, TIMESERIES_FIELDS, visitorBreakdown } from "../lib/metrics";
import { toMajor } from "../lib/money";
import { prepare, raw, sql } from "../lib/sql";
import {
  bucketKeySql,
  bucketStart,
  type DateRange,
  enumerateBuckets,
  HOUR_MS,
  type Interval,
  lastNDays,
  localDate,
  localParts,
  MINUTE_MS,
  startOfDate,
  zonedToUtc,
} from "../lib/time";
import {
  ACTIVITY,
  eventScope,
  filterSql,
  hasFilters,
  type QueryContext,
  rangeOn,
  sessionScope,
  sessionsFrom,
} from "./context";
import { importedDailySql, resolveImportScope } from "./imports";
import { paymentAggregates, paymentScope, revenueBreakdown, revenueFromRow } from "./revenue";
import { chooseSource, rawRemainder } from "./strategy";

export type SeriesInterval = Interval | "minute";

export const SERIES_FIELDS = [
  ...TIMESERIES_FIELDS,
  "bounce_rate",
  "avg_session_duration",
  "goals",
] as const;
export type SeriesField = (typeof SERIES_FIELDS)[number];

/** Longest range served with one-minute buckets. */
export const MAX_MINUTE_RANGE_MS = 6 * HOUR_MS;

export function defaultTimeseriesRange(interval: SeriesInterval) {
  return (timezone: string, nowMs: number): DateRange => {
    if (interval === "minute") {
      const end = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
      return { startMs: end - 30 * MINUTE_MS, endMs: end, timezone };
    }
    if (interval === "hour") {
      const end = bucketStart(nowMs, "hour", timezone) + HOUR_MS;
      return { startMs: end - 24 * HOUR_MS, endMs: end, timezone };
    }
    if (interval === "month") {
      const p = localParts(nowMs, timezone);
      return {
        startMs: zonedToUtc({ year: p.year, month: p.month - 11, day: 1 }, timezone),
        endMs: zonedToUtc({ year: p.year, month: p.month + 1, day: 1 }, timezone),
        timezone,
      };
    }
    return lastNDays(30, timezone, nowMs);
  };
}

/** DataFast upgrades same-day ranges to hourly buckets. Minute ranges are capped at 6 hours. */
export function effectiveInterval(interval: SeriesInterval, range: DateRange): SeriesInterval {
  if (interval === "minute") {
    if (range.endMs - range.startMs > MAX_MINUTE_RANGE_MS) {
      throw new ApiError(400, "interval=minute supports ranges up to 6 hours");
    }
    return interval;
  }
  if (interval === "hour") return interval;
  return localDate(range.startMs, range.timezone) === localDate(range.endMs - 1, range.timezone)
    ? "hour"
    : interval;
}

// Minute buckets are timezone-independent (UTC offsets are whole minutes).
function keySql(col: string, interval: SeriesInterval, tz: string, from: number, to: number) {
  if (interval === "minute") {
    return {
      sql: `(${col} / ${MINUTE_MS})`,
      keyToStart: (k: number | string) => Number(k) * MINUTE_MS,
    };
  }
  return bucketKeySql(col, interval, tz, from, to);
}
function startOf(ms: number, interval: SeriesInterval, tz: string): number {
  return interval === "minute"
    ? Math.floor(ms / MINUTE_MS) * MINUTE_MS
    : bucketStart(ms, interval, tz);
}
function enumerate(from: number, to: number, interval: SeriesInterval, tz: string): number[] {
  if (interval !== "minute") return enumerateBuckets(from, to, interval, tz, 5000);
  const out: number[] = [];
  for (let t = startOf(from, "minute", tz); t < to; t += MINUTE_MS) out.push(t);
  return out;
}

interface Bucket {
  start: number;
  visitors: number;
  newVisitors: number;
  returningVisitors: number;
  sessions: number;
  pageviews: number;
  bounces: number;
  durationSum: number;
  revenueMinor: number;
  payments: number;
  payingVisitors: number;
  goals: Record<string, number>;
}

const emptyBucket = (start: number): Bucket => ({
  start,
  visitors: 0,
  newVisitors: 0,
  returningVisitors: 0,
  sessions: 0,
  pageviews: 0,
  bounces: 0,
  durationSum: 0,
  revenueMinor: 0,
  payments: 0,
  payingVisitors: 0,
  goals: {},
});

export interface TimeseriesResult {
  interval: SeriesInterval;
  buckets: Bucket[];
  totals: Bucket;
  revenue: ReturnType<typeof revenueFromRow>;
  approximate: boolean;
}

const labelFormats: Record<SeriesInterval, Intl.DateTimeFormatOptions> = {
  minute: { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
  hour: { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
  day: { month: "short", day: "numeric", year: "numeric" },
  week: { month: "short", day: "numeric", year: "numeric" },
  month: { month: "long", year: "numeric" },
};

export function bucketLabel(start: number, interval: SeriesInterval, timeZone: string): string {
  const text = new Intl.DateTimeFormat("en-US", { ...labelFormats[interval], timeZone }).format(
    new Date(start),
  );
  return interval === "week" ? `Week of ${text}` : text;
}

function addTraffic(target: Bucket | undefined, row: Record<string, unknown>, assign = false) {
  if (!target) return;
  const v = (k: string) => Number(row[k] ?? 0);
  if (assign) {
    target.visitors = v("visitors");
    target.newVisitors = v("new_visitors");
    target.returningVisitors = v("returning_visitors");
    target.sessions = v("sessions");
    target.pageviews = v("pageviews");
    target.bounces = v("bounces");
    target.durationSum = v("duration_sum");
    return;
  }
  target.visitors += v("visitors");
  target.newVisitors += v("new_visitors");
  target.returningVisitors += v("returning_visitors");
  target.sessions += v("sessions");
  target.pageviews += v("pageviews");
  target.bounces += v("bounces");
  target.durationSum += v("duration_sum");
}

function addGoal(target: Bucket | undefined, name: unknown, n: unknown) {
  if (!target || name === null || name === undefined) return;
  const key = String(name);
  target.goals[key] = (target.goals[key] ?? 0) + Number(n ?? 0);
}

/** Compute every bucket of `range` (required) at `interval`. */
export async function computeTimeseries(
  qc: QueryContext & { range: DateRange },
  interval: SeriesInterval,
  options: { goals?: boolean } = {},
): Promise<TimeseriesResult> {
  // Imported history (whole days, no hourly detail) joins day, week and month buckets.
  const daily = interval !== "hour" && interval !== "minute";
  const [result, scope] = await Promise.all([
    nativeTimeseries(qc, interval, options),
    daily ? resolveImportScope(qc) : Promise.resolve(null),
  ]);
  if (!scope) return result;
  const rows =
    (await prepare(qc.db, importedDailySql(qc, scope)).all<Record<string, unknown>>()).results ??
    [];
  if (!rows.length) return result;
  const byStart = new Map(result.buckets.map((b) => [b.start, b]));
  for (const row of rows) {
    const start = startOf(startOfDate(String(row.day), qc.timezone), interval, qc.timezone);
    addTraffic(byStart.get(start), row);
    addTraffic(result.totals, row);
  }
  return { ...result, approximate: true };
}

async function nativeTimeseries(
  qc: QueryContext & { range: DateRange },
  interval: SeriesInterval,
  options: { goals?: boolean } = {},
): Promise<TimeseriesResult> {
  const tz = qc.timezone;
  const { startMs, endMs } = qc.range;
  const starts = enumerate(startMs, endMs, interval, tz);
  const byStart = new Map<number, Bucket>(starts.map((s) => [s, emptyBucket(s)]));
  const bucketOf = (ms: number): Bucket | undefined => byStart.get(startOf(ms, interval, tz));

  const pay = paymentScope(qc);
  const payKey = keySql("p.occurred_at", interval, tz, startMs, endMs);
  const revenueByBucket = prepare(
    qc.db,
    sql`SELECT ${raw(payKey.sql)} AS k, ${raw(paymentAggregates(qc))} FROM ${pay.from} WHERE ${pay.where} GROUP BY 1`,
  );
  const revenueTotal = prepare(
    qc.db,
    sql`SELECT ${raw(paymentAggregates(qc))} FROM ${pay.from} WHERE ${pay.where}`,
  );

  const source =
    interval === "hour" || interval === "minute"
      ? { mode: "raw" as const }
      : await chooseSource(qc, "breakdown");
  const totals = emptyBucket(startMs);
  let approximate = false;
  let goalsKey: { keyToStart: (k: number | string) => number } | null = null;
  const stmts: D1PreparedStatement[] = [revenueByBucket, revenueTotal];
  let goalsIndex = -1;

  if (source.mode === "raw") {
    const key = keySql("s.started_at", interval, tz, startMs, endMs);
    stmts.push(
      prepare(
        qc.db,
        sql`WITH sv AS MATERIALIZED (
            SELECT ${raw(key.sql)} AS k, s.visitor_id AS v, COUNT(*) AS n, SUM(s.pageviews) AS pv,
              SUM(CASE WHEN s.pageviews + s.interactions <= 1 THEN 1 ELSE 0 END) AS b,
              SUM(s.last_seen_at - s.started_at) AS d, MIN(s.session_number) AS fn
            FROM ${sessionsFrom(qc.range)} WHERE ${sessionScope(qc)} GROUP BY 1, 2)
          SELECT 0 AS t, k, COUNT(*) AS visitors, SUM(n) AS sessions, SUM(pv) AS pageviews,
            SUM(b) AS bounces, SUM(d) AS duration_sum,
            SUM(CASE WHEN fn < 2 THEN 1 ELSE 0 END) AS new_visitors,
            SUM(CASE WHEN fn >= 2 THEN 1 ELSE 0 END) AS returning_visitors
          FROM sv GROUP BY k
          UNION ALL
          SELECT 1, NULL, COUNT(*), COALESCE(SUM(n), 0), COALESCE(SUM(pv), 0), COALESCE(SUM(b), 0),
            COALESCE(SUM(d), 0), COALESCE(SUM(CASE WHEN fn < 2 THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN fn >= 2 THEN 1 ELSE 0 END), 0)
          FROM (SELECT v, SUM(n) AS n, SUM(pv) AS pv, SUM(b) AS b, SUM(d) AS d, MIN(fn) AS fn
            FROM sv GROUP BY v)`,
      ),
    );
    if (options.goals) {
      const gk = keySql("e.ts", interval, tz, startMs, endMs);
      goalsKey = gk;
      const join = hasFilters(qc)
        ? raw("JOIN sessions s ON s.site_id = e.site_id AND s.id = e.session_id")
        : raw("");
      const where = hasFilters(qc) ? filterSql(qc, "s") : raw("1=1");
      goalsIndex = stmts.length;
      stmts.push(
        prepare(
          qc.db,
          sql`SELECT ${raw(gk.sql)} AS k, e.name AS g, COUNT(*) AS n FROM events e ${join}
            WHERE ${eventScope(qc)} AND e.${raw(ACTIVITY)} AND e.type = 'custom' AND e.name IS NOT NULL
              AND ${where}
            GROUP BY 1, 2`,
        ),
      );
    }
    const results = await qc.db.batch(stmts);
    for (const row of (results[2]?.results ?? []) as Array<Record<string, unknown>>) {
      addTraffic(
        Number(row.t) === 1 ? totals : byStart.get(key.keyToStart(row.k as number)),
        row,
        true,
      );
    }
    if (goalsIndex >= 0 && goalsKey) {
      for (const row of (results[goalsIndex]?.results ?? []) as Array<Record<string, unknown>>) {
        addGoal(byStart.get(goalsKey.keyToStart(row.k as number)), row.g, row.n);
        addGoal(totals, row.g, row.n);
      }
    }
    return finish(qc, interval, byStart, totals, results, payKey, approximate);
  }

  approximate = true;
  const from = source.fromDay ?? "0000-00-00";
  stmts.push(
    prepare(
      qc.db,
      sql`SELECT day, visitors, new_visitors, returning_visitors, sessions, pageviews, bounces, duration_sum
        FROM daily_stats WHERE site_id = ${qc.site.id} AND day >= ${from} AND day <= ${source.toDay}`,
    ),
  );
  const remainder = rawRemainder(source, qc);
  let dayIndex = -1;
  let dayKey: ReturnType<typeof bucketKeySql> | null = null;
  if (remainder) {
    dayKey = bucketKeySql("s.started_at", "day", tz, remainder.startMs, remainder.endMs);
    dayIndex = stmts.length;
    stmts.push(
      prepare(
        qc.db,
        sql`SELECT k, COUNT(*) AS visitors, SUM(n) AS sessions, SUM(pv) AS pageviews, SUM(b) AS bounces,
            SUM(d) AS duration_sum, SUM(CASE WHEN fn < 2 THEN 1 ELSE 0 END) AS new_visitors,
            SUM(CASE WHEN fn >= 2 THEN 1 ELSE 0 END) AS returning_visitors
          FROM (SELECT ${raw(dayKey.sql)} AS k, s.visitor_id, COUNT(*) AS n, SUM(s.pageviews) AS pv,
              SUM(CASE WHEN s.pageviews + s.interactions <= 1 THEN 1 ELSE 0 END) AS b,
              SUM(s.last_seen_at - s.started_at) AS d, MIN(s.session_number) AS fn
            FROM sessions s INDEXED BY sessions_time
            WHERE s.site_id = ${qc.site.id} AND ${rangeOn("s.started_at", remainder)}
            GROUP BY 1, 2)
          GROUP BY k`,
      ),
    );
  }
  let goalsRolled = -1;
  let goalsRaw = -1;
  let goalsDayKey: ReturnType<typeof bucketKeySql> | null = null;
  if (options.goals) {
    goalsRolled = stmts.length;
    stmts.push(
      prepare(
        qc.db,
        sql`SELECT day, name, completions FROM daily_goals
          WHERE site_id = ${qc.site.id} AND day >= ${from} AND day <= ${source.toDay}`,
      ),
    );
    if (remainder) {
      goalsDayKey = bucketKeySql("e.ts", "day", tz, remainder.startMs, remainder.endMs);
      goalsRaw = stmts.length;
      stmts.push(
        prepare(
          qc.db,
          sql`SELECT ${raw(goalsDayKey.sql)} AS k, e.name AS g, COUNT(*) AS n FROM events e
            WHERE e.site_id = ${qc.site.id} AND ${rangeOn("e.ts", remainder)} AND e.${raw(ACTIVITY)}
              AND e.type = 'custom' AND e.name IS NOT NULL
            GROUP BY 1, 2`,
        ),
      );
    }
  }
  const results = await qc.db.batch(stmts);
  for (const row of (results[2]?.results ?? []) as Array<Record<string, unknown>>) {
    addTraffic(bucketOf(startOfDate(String(row.day), tz)), row);
    addTraffic(totals, row);
  }
  if (dayIndex >= 0 && dayKey) {
    for (const row of (results[dayIndex]?.results ?? []) as Array<Record<string, unknown>>) {
      addTraffic(bucketOf(dayKey.keyToStart(row.k as number)), row);
      addTraffic(totals, row);
    }
  }
  if (goalsRolled >= 0) {
    for (const row of (results[goalsRolled]?.results ?? []) as Array<Record<string, unknown>>) {
      addGoal(bucketOf(startOfDate(String(row.day), tz)), row.name, row.completions);
      addGoal(totals, row.name, row.completions);
    }
  }
  if (goalsRaw >= 0 && goalsDayKey) {
    for (const row of (results[goalsRaw]?.results ?? []) as Array<Record<string, unknown>>) {
      addGoal(bucketOf(goalsDayKey.keyToStart(row.k as number)), row.g, row.n);
      addGoal(totals, row.g, row.n);
    }
  }
  return finish(qc, interval, byStart, totals, results, payKey, approximate);
}

function finish(
  _qc: QueryContext,
  interval: SeriesInterval,
  byStart: Map<number, Bucket>,
  totals: Bucket,
  results: D1Result[],
  payKey: { keyToStart: (k: number | string) => number },
  approximate: boolean,
): TimeseriesResult {
  for (const row of (results[0]?.results ?? []) as Array<Record<string, unknown>>) {
    const target = byStart.get(payKey.keyToStart(row.k as number));
    if (!target) continue;
    target.revenueMinor = Number(row.revenue_minor ?? 0);
    target.payments = Number(row.payments ?? 0);
    target.payingVisitors = Number(row.paying_visitors ?? 0);
  }
  const revenue = revenueFromRow(results[1]?.results?.[0] as Record<string, unknown> | undefined);
  totals.revenueMinor = revenue.revenueMinor;
  totals.payments = revenue.payments;
  totals.payingVisitors = revenue.payingVisitors;
  return { interval, buckets: [...byStart.values()], totals, revenue, approximate };
}

/** Render buckets in DataFast's shape for the requested fields. */
export function renderPoint(
  b: Bucket,
  fields: readonly SeriesField[],
  interval: SeriesInterval,
  qc: QueryContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = { timestamp: new Date(b.start).toISOString() };
  for (const f of fields) Object.assign(out, metricField(b, f, qc, interval));
  return out;
}

function metricField(
  b: Bucket,
  f: SeriesField,
  qc: QueryContext,
  interval: SeriesInterval,
): Record<string, unknown> {
  switch (f) {
    case "name":
      return { name: bucketLabel(b.start, interval, qc.timezone) };
    case "visitors":
      return { visitors: b.visitors };
    case "new_visitors":
      return { new_visitors: b.newVisitors };
    case "returning_visitors":
      return { returning_visitors: b.returningVisitors };
    case "visitor_breakdown":
      return { visitorBreakdown: visitorBreakdown(b.newVisitors, b.returningVisitors) };
    case "pageviews":
      return { pageviews: b.pageviews };
    case "sessions":
      return { sessions: b.sessions };
    case "revenue":
      return { revenue: toMajor(b.revenueMinor, qc.site.currency) };
    case "payments":
      return { payments: b.payments };
    case "conversion_rate":
      return { conversion_rate: percentage(Math.min(b.payingVisitors, b.visitors), b.visitors) };
    case "bounce_rate":
      return { bounce_rate: percentage(b.bounces, b.sessions) };
    case "avg_session_duration":
      return {
        avg_session_duration: b.sessions > 0 ? Math.round(b.durationSum / b.sessions / 1000) : 0,
      };
    case "goals":
      return { goals: { ...b.goals } };
  }
}

/** Requested fields as DataFast echoes them: `revenue` adds `payments`. */
export function normaliseFields(fields: SeriesField[]): SeriesField[] {
  const out = [...fields];
  if (out.includes("revenue") && !out.includes("payments")) {
    out.splice(out.indexOf("revenue") + 1, 0, "payments");
  }
  return out;
}

export function renderTotals(
  result: TimeseriesResult,
  fields: readonly SeriesField[],
  qc: QueryContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f === "name") continue;
    Object.assign(out, metricField(result.totals, f, qc, result.interval));
  }
  if (fields.includes("visitors") && !out.visitorBreakdown) {
    out.visitorBreakdown = visitorBreakdown(
      result.totals.newVisitors,
      result.totals.returningVisitors,
    );
  }
  if (fields.includes("revenue"))
    out.revenueBreakdown = revenueBreakdown(result.revenue, qc.site.currency);
  return out;
}

const INTERVALS: readonly SeriesInterval[] = ["minute", "hour", "day", "week", "month"];

export function parseInterval(value: string | undefined): SeriesInterval {
  if (!value) throw new ApiError(400, "interval is required: hour, day, week or month");
  if ((INTERVALS as readonly string[]).includes(value)) return value as SeriesInterval;
  throw new ApiError(400, `Invalid interval: ${value}. Use hour, day, week or month (or minute)`);
}
