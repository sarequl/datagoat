/**
 * Site totals: DataFast's overview metrics (visitors, new/returning, pageviews, sessions, bounce
 * rate, average session duration, revenue, payments, revenue per visitor, conversion rate).
 *
 * Cost: one D1 query (a batch of two statements). Traffic is a single pass over the sessions in
 * the range through `sessions_time`, grouped by visitor so distinct visitors and new/returning
 * come out of the same scan; revenue reads `payments` through `payments_time`.
 */
import { type DerivedMetrics, deriveMetrics, type RawTotals } from "../lib/metrics";
import { prepare, raw, type SqlFragment, sql } from "../lib/sql";
import { type QueryContext, rangeOn, sessionScope, sessionsFrom } from "./context";
import { importedTotalsSql, resolveImportScope } from "./imports";
import { paymentAggregates, paymentScope, type RevenueTotals, revenueFromRow } from "./revenue";
import { chooseSource, rawRemainder } from "./strategy";

export type TrafficTotals = Omit<RawTotals, "revenueMinor" | "payments" | "payingVisitors"> & {
  newVisitors: number;
  returningVisitors: number;
};

/** Per-visitor grouping of filtered sessions; columns v, n, pv, b, d, fn. */
export function visitorGroupSql(
  scope: SqlFragment,
  from: SqlFragment = raw("sessions s"),
): SqlFragment {
  return sql`SELECT s.visitor_id AS v, COUNT(*) AS n, SUM(s.pageviews) AS pv,
      SUM(CASE WHEN s.pageviews + s.interactions <= 1 THEN 1 ELSE 0 END) AS b,
      SUM(s.last_seen_at - s.started_at) AS d, MIN(s.session_number) AS fn
    FROM ${from} WHERE ${scope} GROUP BY s.visitor_id`;
}

/** Aggregates over a visitor grouping (see visitorGroupSql). */
export const VISITOR_TOTALS_SELECT = `COUNT(*) AS visitors, COALESCE(SUM(n), 0) AS sessions,
  COALESCE(SUM(pv), 0) AS pageviews, COALESCE(SUM(b), 0) AS bounces, COALESCE(SUM(d), 0) AS duration_sum,
  COALESCE(SUM(CASE WHEN fn < 2 THEN 1 ELSE 0 END), 0) AS new_visitors,
  COALESCE(SUM(CASE WHEN fn >= 2 THEN 1 ELSE 0 END), 0) AS returning_visitors`;

export function trafficFromRow(row: Record<string, unknown> | null | undefined): TrafficTotals {
  return {
    visitors: Number(row?.visitors ?? 0),
    sessions: Number(row?.sessions ?? 0),
    pageviews: Number(row?.pageviews ?? 0),
    bounces: Number(row?.bounces ?? 0),
    durationSum: Number(row?.duration_sum ?? 0),
    newVisitors: Number(row?.new_visitors ?? 0),
    returningVisitors: Number(row?.returning_visitors ?? 0),
  };
}

export function addTraffic(a: TrafficTotals, b: TrafficTotals): TrafficTotals {
  return {
    visitors: a.visitors + b.visitors,
    sessions: a.sessions + b.sessions,
    pageviews: a.pageviews + b.pageviews,
    bounces: a.bounces + b.bounces,
    durationSum: a.durationSum + b.durationSum,
    newVisitors: a.newVisitors + b.newVisitors,
    returningVisitors: a.returningVisitors + b.returningVisitors,
  };
}

export interface Totals {
  traffic: TrafficTotals;
  revenue: RevenueTotals;
  metrics: DerivedMetrics;
  /** Visitor counts are sums of daily uniques (rollups were read). */
  approximate: boolean;
}

export function combineTotals(
  qc: QueryContext,
  traffic: TrafficTotals,
  revenue: RevenueTotals,
  approximate: boolean,
): Totals {
  const metrics = deriveMetrics(
    {
      ...traffic,
      revenueMinor: revenue.revenueMinor,
      payments: revenue.payments,
      // A paying visitor whose attributed session started before the range still converted.
      payingVisitors: Math.min(revenue.payingVisitors, traffic.visitors),
    },
    qc.site.currency,
  );
  return { traffic, revenue, metrics, approximate };
}

/**
 * Site totals, including imported history (src/query/imports.ts) for days before the first native
 * session. Imported visitors are daily uniques, so a merged result is `approximate`; imports have
 * no new/returning split and no revenue.
 */
export async function computeTotals(qc: QueryContext): Promise<Totals> {
  const [native, imported] = await Promise.all([nativeTotals(qc), importedTraffic(qc)]);
  if (!imported) return native;
  return combineTotals(qc, addTraffic(native.traffic, imported), native.revenue, true);
}

async function importedTraffic(qc: QueryContext): Promise<TrafficTotals | null> {
  const scope = await resolveImportScope(qc);
  if (!scope) return null;
  const row = await prepare(qc.db, importedTotalsSql(qc, scope)).first<Record<string, unknown>>();
  const t = trafficFromRow(row);
  return t.visitors > 0 || t.sessions > 0 || t.pageviews > 0 ? t : null;
}

async function nativeTotals(qc: QueryContext): Promise<Totals> {
  const source = await chooseSource(qc, "overview");
  const pay = paymentScope(qc);
  const revenueStmt = prepare(
    qc.db,
    sql`SELECT ${raw(paymentAggregates(qc))} FROM ${pay.from} WHERE ${pay.where}`,
  );
  if (source.mode === "raw") {
    const [traffic, revenue] = await qc.db.batch([
      prepare(
        qc.db,
        sql`SELECT ${raw(VISITOR_TOTALS_SELECT)} FROM (${visitorGroupSql(sessionScope(qc), sessionsFrom(qc.range))})`,
      ),
      revenueStmt,
    ]);
    return combineTotals(
      qc,
      trafficFromRow(traffic?.results?.[0] as Record<string, unknown>),
      revenueFromRow(revenue?.results?.[0] as Record<string, unknown>),
      false,
    );
  }
  const remainder = rawRemainder(source, qc);
  const stmts = [
    revenueStmt,
    prepare(
      qc.db,
      sql`SELECT COALESCE(SUM(visitors), 0) AS visitors, COALESCE(SUM(sessions), 0) AS sessions,
        COALESCE(SUM(pageviews), 0) AS pageviews, COALESCE(SUM(bounces), 0) AS bounces,
        COALESCE(SUM(duration_sum), 0) AS duration_sum, COALESCE(SUM(new_visitors), 0) AS new_visitors,
        COALESCE(SUM(returning_visitors), 0) AS returning_visitors
      FROM daily_stats WHERE site_id = ${qc.site.id} AND day >= ${source.fromDay ?? "0000-00-00"} AND day <= ${source.toDay}`,
    ),
  ];
  if (remainder) {
    const scope = sql`s.site_id = ${qc.site.id} AND ${rangeOn("s.started_at", remainder)}`;
    stmts.push(
      prepare(
        qc.db,
        sql`SELECT ${raw(VISITOR_TOTALS_SELECT)} FROM (${visitorGroupSql(scope, raw("sessions s INDEXED BY sessions_time"))})`,
      ),
    );
  }
  const [revenue, rolled, rawPart] = await qc.db.batch(stmts);
  let traffic = trafficFromRow(rolled?.results?.[0] as Record<string, unknown>);
  if (rawPart)
    traffic = addTraffic(traffic, trafficFromRow(rawPart.results?.[0] as Record<string, unknown>));
  return combineTotals(
    qc,
    traffic,
    revenueFromRow(revenue?.results?.[0] as Record<string, unknown>),
    true,
  );
}
