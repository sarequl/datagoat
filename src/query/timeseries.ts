/**
 * Time-bucketed metrics (DataFast `GET /analytics/timeseries`). Buckets are local hours, days,
 * ISO weeks (Monday) or months in the request timezone, computed inside D1 with DST-safe offsets
 * (`bucketKeySql`). One pass over the sessions yields every bucket and the range totals.
 */
import { ApiError } from "../lib/errors";
import {
  percentage,
  TIMESERIES_FIELDS,
  type TimeseriesField,
  visitorBreakdown,
} from "../lib/metrics";
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
  startOfDate,
  zonedToUtc,
} from "../lib/time";
import { type QueryContext, rangeOn, sessionScope, sessionsFrom } from "./context";
import { paymentAggregates, paymentScope, revenueBreakdown, revenueFromRow } from "./revenue";
import { chooseSource, rawRemainder } from "./strategy";

export { TIMESERIES_FIELDS };

export function defaultTimeseriesRange(interval: Interval) {
  return (timezone: string, nowMs: number): DateRange => {
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

/** DataFast upgrades same-day ranges to hourly buckets. */
export function effectiveInterval(interval: Interval, range: DateRange): Interval {
  if (interval === "hour") return interval;
  return localDate(range.startMs, range.timezone) === localDate(range.endMs - 1, range.timezone)
    ? "hour"
    : interval;
}

interface Bucket {
  start: number;
  visitors: number;
  newVisitors: number;
  returningVisitors: number;
  sessions: number;
  pageviews: number;
  revenueMinor: number;
  payments: number;
  payingVisitors: number;
}

const emptyBucket = (start: number): Bucket => ({
  start,
  visitors: 0,
  newVisitors: 0,
  returningVisitors: 0,
  sessions: 0,
  pageviews: 0,
  revenueMinor: 0,
  payments: 0,
  payingVisitors: 0,
});

export interface TimeseriesResult {
  interval: Interval;
  buckets: Bucket[];
  totals: Bucket;
  revenue: ReturnType<typeof revenueFromRow>;
  approximate: boolean;
}

const labelFormats: Record<Interval, Intl.DateTimeFormatOptions> = {
  hour: { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
  day: { month: "short", day: "numeric", year: "numeric" },
  week: { month: "short", day: "numeric", year: "numeric" },
  month: { month: "long", year: "numeric" },
};

export function bucketLabel(start: number, interval: Interval, timeZone: string): string {
  const text = new Intl.DateTimeFormat("en-US", { ...labelFormats[interval], timeZone }).format(
    new Date(start),
  );
  return interval === "week" ? `Week of ${text}` : text;
}

/** Compute every bucket of `range` (required) at `interval`. */
export async function computeTimeseries(
  qc: QueryContext & { range: DateRange },
  interval: Interval,
): Promise<TimeseriesResult> {
  const tz = qc.timezone;
  const { startMs, endMs } = qc.range;
  const starts = enumerateBuckets(startMs, endMs, interval, tz, 5000);
  const byStart = new Map<number, Bucket>(starts.map((s) => [s, emptyBucket(s)]));
  const bucketOf = (ms: number): Bucket | undefined => {
    const b = byStart.get(bucketStart(ms, interval, tz));
    return b;
  };

  const pay = paymentScope(qc);
  const payKey = bucketKeySql("p.occurred_at", interval, tz, startMs, endMs);
  const revenueByBucket = prepare(
    qc.db,
    sql`SELECT ${raw(payKey.sql)} AS k, ${raw(paymentAggregates(qc))} FROM ${pay.from} WHERE ${pay.where} GROUP BY 1`,
  );
  const revenueTotal = prepare(
    qc.db,
    sql`SELECT ${raw(paymentAggregates(qc))} FROM ${pay.from} WHERE ${pay.where}`,
  );

  const source =
    interval === "hour" ? { mode: "raw" as const } : await chooseSource(qc, "breakdown");
  let totals = emptyBucket(startMs);
  let approximate = false;
  let revenueRows: Array<Record<string, unknown>>;
  let revenueTotalRow: Record<string, unknown> | undefined;

  if (source.mode === "raw") {
    const key = bucketKeySql("s.started_at", interval, tz, startMs, endMs);
    const traffic = prepare(
      qc.db,
      sql`WITH sv AS MATERIALIZED (
          SELECT ${raw(key.sql)} AS k, s.visitor_id AS v, COUNT(*) AS n, SUM(s.pageviews) AS pv,
            MIN(s.session_number) AS fn
          FROM ${sessionsFrom(qc.range)} WHERE ${sessionScope(qc)} GROUP BY 1, 2)
        SELECT 0 AS t, k, COUNT(*) AS visitors, SUM(n) AS sessions, SUM(pv) AS pageviews,
          SUM(CASE WHEN fn < 2 THEN 1 ELSE 0 END) AS new_visitors,
          SUM(CASE WHEN fn >= 2 THEN 1 ELSE 0 END) AS returning_visitors
        FROM sv GROUP BY k
        UNION ALL
        SELECT 1, NULL, COUNT(*), COALESCE(SUM(n), 0), COALESCE(SUM(pv), 0),
          COALESCE(SUM(CASE WHEN fn < 2 THEN 1 ELSE 0 END), 0),
          COALESCE(SUM(CASE WHEN fn >= 2 THEN 1 ELSE 0 END), 0)
        FROM (SELECT v, SUM(n) AS n, SUM(pv) AS pv, MIN(fn) AS fn FROM sv GROUP BY v)`,
    );
    const [t, r, rt] = await qc.db.batch([traffic, revenueByBucket, revenueTotal]);
    for (const row of (t?.results ?? []) as Array<Record<string, unknown>>) {
      const target =
        Number(row.t) === 1 ? totals : byStart.get(key.keyToStart(row.k as number | string));
      if (!target) continue;
      target.visitors = Number(row.visitors ?? 0);
      target.sessions = Number(row.sessions ?? 0);
      target.pageviews = Number(row.pageviews ?? 0);
      target.newVisitors = Number(row.new_visitors ?? 0);
      target.returningVisitors = Number(row.returning_visitors ?? 0);
    }
    revenueRows = (r?.results ?? []) as Array<Record<string, unknown>>;
    revenueTotalRow = rt?.results?.[0] as Record<string, unknown> | undefined;
    for (const row of revenueRows)
      applyRevenue(byStart.get(payKey.keyToStart(row.k as number)), row);
  } else {
    approximate = true;
    const stmts = [
      revenueByBucket,
      revenueTotal,
      prepare(
        qc.db,
        sql`SELECT day, visitors, new_visitors, returning_visitors, sessions, pageviews FROM daily_stats
          WHERE site_id = ${qc.site.id} AND day >= ${source.fromDay ?? "0000-00-00"} AND day <= ${source.toDay}`,
      ),
    ];
    const remainder = rawRemainder(source, qc);
    let dayKey: ReturnType<typeof bucketKeySql> | null = null;
    if (remainder) {
      dayKey = bucketKeySql("s.started_at", "day", tz, remainder.startMs, remainder.endMs);
      stmts.push(
        prepare(
          qc.db,
          sql`SELECT k, COUNT(*) AS visitors, SUM(n) AS sessions, SUM(pv) AS pageviews,
              SUM(CASE WHEN fn < 2 THEN 1 ELSE 0 END) AS new_visitors,
              SUM(CASE WHEN fn >= 2 THEN 1 ELSE 0 END) AS returning_visitors
            FROM (SELECT ${raw(dayKey.sql)} AS k, s.visitor_id, COUNT(*) AS n, SUM(s.pageviews) AS pv,
                MIN(s.session_number) AS fn
              FROM sessions s INDEXED BY sessions_time WHERE s.site_id = ${qc.site.id} AND ${rangeOn("s.started_at", remainder)}
              GROUP BY 1, 2)
            GROUP BY k`,
        ),
      );
    }
    const [r, rt, rolled, rawDays] = await qc.db.batch(stmts);
    const add = (target: Bucket | undefined, row: Record<string, unknown>) => {
      if (!target) return;
      target.visitors += Number(row.visitors ?? 0);
      target.newVisitors += Number(row.new_visitors ?? 0);
      target.returningVisitors += Number(row.returning_visitors ?? 0);
      target.sessions += Number(row.sessions ?? 0);
      target.pageviews += Number(row.pageviews ?? 0);
    };
    for (const row of (rolled?.results ?? []) as Array<Record<string, unknown>>) {
      const start = startOfDate(String(row.day), tz);
      add(bucketOf(start), row);
      add(totals, row);
    }
    for (const row of (rawDays?.results ?? []) as Array<Record<string, unknown>>) {
      if (!dayKey) break;
      const start = dayKey.keyToStart(row.k as number);
      add(bucketOf(start), row);
      add(totals, row);
    }
    revenueRows = (r?.results ?? []) as Array<Record<string, unknown>>;
    revenueTotalRow = rt?.results?.[0] as Record<string, unknown> | undefined;
    for (const row of revenueRows)
      applyRevenue(byStart.get(payKey.keyToStart(row.k as number)), row);
  }
  const revenue = revenueFromRow(revenueTotalRow);
  totals = {
    ...totals,
    revenueMinor: revenue.revenueMinor,
    payments: revenue.payments,
    payingVisitors: revenue.payingVisitors,
  };
  return { interval, buckets: [...byStart.values()], totals, revenue, approximate };
}

function applyRevenue(target: Bucket | undefined, row: Record<string, unknown>): void {
  if (!target) return;
  target.revenueMinor = Number(row.revenue_minor ?? 0);
  target.payments = Number(row.payments ?? 0);
  target.payingVisitors = Number(row.paying_visitors ?? 0);
}

/** Render buckets in DataFast's shape for the requested fields. */
export function renderPoint(
  b: Bucket,
  fields: readonly TimeseriesField[],
  interval: Interval,
  qc: QueryContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = { timestamp: new Date(b.start).toISOString() };
  for (const f of fields) Object.assign(out, metricField(b, f, qc, interval));
  return out;
}

function metricField(
  b: Bucket,
  f: TimeseriesField,
  qc: QueryContext,
  interval: Interval,
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
  }
}

/** Requested fields as DataFast echoes them: `revenue` adds `payments`. */
export function normaliseFields(fields: TimeseriesField[]): TimeseriesField[] {
  const out = [...fields];
  if (out.includes("revenue") && !out.includes("payments")) {
    out.splice(out.indexOf("revenue") + 1, 0, "payments");
  }
  return out;
}

export function renderTotals(
  result: TimeseriesResult,
  fields: readonly TimeseriesField[],
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

export function parseInterval(value: string | undefined): Interval {
  if (!value) throw new ApiError(400, "interval is required: hour, day, week or month");
  if (value === "hour" || value === "day" || value === "week" || value === "month") return value;
  throw new ApiError(400, `Invalid interval: ${value}. Use hour, day, week or month`);
}
