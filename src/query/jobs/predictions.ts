/**
 * `query.predictions` (daily at 04:43): trains the purchase-likelihood model of each website
 * that meets DataFast's activation threshold (1,000 visitors and 10 attributed payments) from the
 * last 90 days of sessions, in SQL (one batch per website). The model is written only when it
 * changed; websites below the threshold have their model removed. A cursor spreads large
 * installs over several runs.
 */
import type { JobContext, JobDefinition } from "../../jobs/registry";
import { toMajor } from "../../lib/money";
import { DAY_MS } from "../../lib/time";
import { BROWSER_EXPR, REFERRER_EXPR } from "../breakdowns";
import {
  type DimStat,
  PREDICTION_DIMENSIONS,
  PREDICTION_MIN_PAYMENTS,
  PREDICTION_MIN_VISITORS,
  type PredictionModel,
} from "../prediction";

export const TRAINING_WINDOW_DAYS = 90;
const MIN_SAMPLE = 30;
const MAX_VALUES_PER_DIMENSION = 200;

const DIMENSION_SQL: Record<(typeof PREDICTION_DIMENSIONS)[number], string> = {
  channel: "s.channel",
  referrer: REFERRER_EXPR,
  country: "s.country",
  device: "s.device",
  browser: BROWSER_EXPR,
  os: "s.os",
};

interface SiteRow {
  id: string;
  currency: string;
  include_renewal_revenue: number;
}

export function trainingStatements(db: D1Database, site: SiteRow, now: number) {
  const paying = site.include_renewal_revenue ? "('payment', 'renewal')" : "('payment')";
  const counts = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM visitors WHERE site_id = ?1) AS visitors,
         (SELECT COUNT(*) FROM payments WHERE site_id = ?1 AND visitor_id IS NOT NULL AND kind IN ${paying}) AS payments`,
    )
    .bind(site.id);
  const cols = PREDICTION_DIMENSIONS.map((d) => `${DIMENSION_SQL[d]} AS ${d}`).join(", ");
  const branches = PREDICTION_DIMENSIONS.map(
    (d) =>
      `SELECT * FROM (SELECT '${d}' AS dim, ${d} AS value, COUNT(*) AS n, SUM(conv) AS c, COALESCE(SUM(rev), 0) AS r
        FROM j WHERE ${d} IS NOT NULL GROUP BY ${d} HAVING COUNT(*) >= ${MIN_SAMPLE}
        ORDER BY n DESC LIMIT ${MAX_VALUES_PER_DIMENSION})`,
  );
  const training = db
    .prepare(
      `WITH v AS MATERIALIZED (
         SELECT s.visitor_id AS vid, ${cols}, MIN(s.started_at) AS t
         FROM sessions s WHERE s.site_id = ?1 AND s.started_at >= ?2 GROUP BY s.visitor_id),
       pv AS MATERIALIZED (
         SELECT visitor_id AS vid, SUM(reporting_minor) AS rev FROM payments
         WHERE site_id = ?1 AND visitor_id IS NOT NULL AND kind IN ${paying} GROUP BY visitor_id),
       j AS MATERIALIZED (
         SELECT v.*, pv.rev AS rev, CASE WHEN pv.vid IS NULL THEN 0 ELSE 1 END AS conv
         FROM v LEFT JOIN pv ON pv.vid = v.vid)
       SELECT '' AS dim, '' AS value, COUNT(*) AS n, COALESCE(SUM(conv), 0) AS c, COALESCE(SUM(rev), 0) AS r FROM j
       UNION ALL ${branches.join(" UNION ALL ")}`,
    )
    .bind(site.id, now - TRAINING_WINDOW_DAYS * DAY_MS);
  return { counts, training };
}

/** Build the model JSON (stable key order, so an unchanged model serialises identically). */
export function buildModel(
  rows: Array<{ dim: string; value: string; n: number; c: number; r: number }>,
  currency: string,
): PredictionModel | null {
  const base = rows.find((r) => r.dim === "");
  if (!base || Number(base.n) === 0) return null;
  const dims: PredictionModel["dims"] = {};
  for (const d of PREDICTION_DIMENSIONS) {
    const entries = rows
      .filter((r) => r.dim === d)
      .sort((a, b) => String(a.value).localeCompare(String(b.value)))
      .map(
        (r) =>
          [String(r.value), [Number(r.n), Number(r.c), toMajor(Number(r.r), currency)]] as const,
      );
    if (entries.length) dims[d] = Object.fromEntries(entries) as Record<string, DimStat>;
  }
  return {
    version: 1,
    baseline: {
      visitors: Number(base.n),
      conversions: Number(base.c),
      revenue: toMajor(Number(base.r), currency),
    },
    dims,
  };
}

export async function runPredictions(ctx: JobContext): Promise<void> {
  const { db, now } = ctx;
  const after = (ctx.state as { after?: string } | null)?.after ?? "";
  const sites =
    (
      await db
        .prepare(
          "SELECT id, currency, include_renewal_revenue FROM sites WHERE deleted_at IS NULL AND id > ? ORDER BY id LIMIT 50",
        )
        .bind(after)
        .all<SiteRow>()
    ).results ?? [];
  let last = after;
  for (const site of sites) {
    if (ctx.remainingQueries() < 3) {
      ctx.setState({ after: last });
      return;
    }
    const { counts, training } = trainingStatements(db, site, now);
    const [countRes, trainRes] = await db.batch([counts, training]);
    const c = (countRes?.results?.[0] ?? {}) as { visitors?: number; payments?: number };
    const active =
      Number(c.visitors ?? 0) >= PREDICTION_MIN_VISITORS &&
      Number(c.payments ?? 0) >= PREDICTION_MIN_PAYMENTS;
    const model = active
      ? buildModel(
          (trainRes?.results ?? []) as Array<{
            dim: string;
            value: string;
            n: number;
            c: number;
            r: number;
          }>,
          site.currency,
        )
      : null;
    if (!model || model.baseline.conversions === 0) {
      await db.prepare("DELETE FROM prediction_models WHERE site_id = ?").bind(site.id).run();
    } else {
      const json = JSON.stringify(model);
      const rate = Math.round((model.baseline.conversions / model.baseline.visitors) * 1e6) / 1e6;
      const avg = Math.round((model.baseline.revenue / model.baseline.conversions) * 100) / 100;
      await db
        .prepare(
          `INSERT INTO prediction_models (site_id, model, baseline_conversion_rate, baseline_average_value,
             sample_visitors, trained_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (site_id) DO UPDATE SET model = excluded.model,
             baseline_conversion_rate = excluded.baseline_conversion_rate,
             baseline_average_value = excluded.baseline_average_value,
             sample_visitors = excluded.sample_visitors, trained_at = excluded.trained_at
           WHERE prediction_models.model IS NOT excluded.model`,
        )
        .bind(site.id, json, rate, avg, model.baseline.visitors, now)
        .run();
    }
    last = site.id;
  }
  // Finished the list: start over next run.
  ctx.setState(sites.length === 50 ? { after: last } : null);
}

export const predictionJob: JobDefinition = {
  name: "query.predictions",
  schedule: { every: "day", at: "04:43" },
  run: runPredictions,
  minQueries: 3,
  description: "Train purchase-likelihood models (activation: 1,000 visitors, 10 payments)",
};
