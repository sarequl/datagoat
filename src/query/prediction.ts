/**
 * Purchase-likelihood prediction (DataFast "Revenue prediction"): each visitor gets a 0-100 score,
 * a predicted conversion rate, an expected value and a confidence, from how visitors with the
 * same acquisition and system profile converted before.
 *
 * Activation (DataFast's documented requirement): at least 1,000 tracked visitors and 10
 * attributed payments. The `query.predictions` job (src/query/jobs/predictions.ts) trains the
 * model daily in SQL and stores it in `prediction_models`; scoring here is pure and cheap.
 *
 * Model: per dimension (channel, referrer, country, device, browser, os) and value, the visitors
 * seen, how many became paying customers and their revenue. Scoring combines the matched
 * dimensions as damped log-odds shifts from the baseline conversion rate (a naive-Bayes style
 * estimate with smoothing toward the baseline for small samples):
 *
 *   cr_d   = (conversions_d + 20 * baseline) / (visitors_d + 20)        (values with >= 30 visitors)
 *   logit p = logit(baseline) + 0.5 * Σ_d (logit(cr_d) - logit(baseline))
 *   score  = 100 * (1 - 2^(-p / baseline))       (50 = baseline, → 100 for hot visitors)
 *   value  = conversion-weighted average order value of matched values (else baseline)
 *   expectedValue = p * value;  confidence = coverage of matched dims × sample-size factor
 */

export const PREDICTION_MIN_VISITORS = 1000;
export const PREDICTION_MIN_PAYMENTS = 10;
export const PREDICTION_DIMENSIONS = [
  "channel",
  "referrer",
  "country",
  "device",
  "browser",
  "os",
] as const;
export type PredictionDimension = (typeof PREDICTION_DIMENSIONS)[number];

const MIN_SAMPLE = 30;
const SMOOTHING = 20;
const DAMPING = 0.5;

/** [visitors, conversions, revenue (major units)] */
export type DimStat = [number, number, number];

export interface PredictionModel {
  version: 1;
  baseline: { visitors: number; conversions: number; revenue: number };
  dims: Partial<Record<PredictionDimension, Record<string, DimStat>>>;
}

export interface StoredModel {
  model: PredictionModel;
  baselineConversionRate: number;
  baselineAverageValue: number;
  sampleVisitors: number;
  trainedAt: number;
}

export async function loadModel(db: D1Database, siteId: string): Promise<StoredModel | null> {
  const row = await db
    .prepare(
      "SELECT model, baseline_conversion_rate, baseline_average_value, sample_visitors, trained_at FROM prediction_models WHERE site_id = ?",
    )
    .bind(siteId)
    .first<Record<string, unknown>>();
  return row ? rowToModel(row) : null;
}

export function rowToModel(row: Record<string, unknown>): StoredModel | null {
  try {
    const model = JSON.parse(String(row.model)) as PredictionModel;
    if (model?.version !== 1) return null;
    return {
      model,
      baselineConversionRate: Number(row.baseline_conversion_rate),
      baselineAverageValue: Number(row.baseline_average_value),
      sampleVisitors: Number(row.sample_visitors),
      trainedAt: Number(row.trained_at),
    };
  } catch {
    return null;
  }
}

export interface Prediction {
  score: number;
  /** Predicted conversion rate, 0-1. */
  conversionRate: number;
  /** Website currency, major units. */
  averageValue: number;
  expectedValue: number;
  confidence: number;
  isBaseline: boolean;
  dimensionMatches: Array<{ dimension: string; value: string; conversionRate: number }>;
}

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

export function scoreVisitor(
  stored: StoredModel,
  profile: Partial<Record<PredictionDimension, string | null | undefined>>,
): Prediction {
  const { model } = stored;
  const b = clamp(
    model.baseline.visitors > 0 ? model.baseline.conversions / model.baseline.visitors : 0,
    1e-4,
    0.95,
  );
  const baseValue =
    model.baseline.conversions > 0 ? model.baseline.revenue / model.baseline.conversions : 0;
  let shift = 0;
  let valueWeight = 0;
  let valueSum = 0;
  const matches: Prediction["dimensionMatches"] = [];
  for (const dim of PREDICTION_DIMENSIONS) {
    const value = profile[dim];
    if (value === null || value === undefined || value === "") continue;
    const stat = model.dims[dim]?.[value];
    if (!stat || stat[0] < MIN_SAMPLE) continue;
    const [n, conv, revenue] = stat;
    const cr = clamp((conv + SMOOTHING * b) / (n + SMOOTHING), 1e-4, 0.95);
    shift += logit(cr) - logit(b);
    matches.push({ dimension: dim, value, conversionRate: round(cr, 4) });
    if (conv >= 3) {
      valueSum += revenue;
      valueWeight += conv;
    }
  }
  const p = clamp(sigmoid(logit(b) + DAMPING * shift), 1e-4, 0.95);
  const averageValue = valueWeight > 0 ? valueSum / valueWeight : baseValue;
  const sampleFactor = 1 - 1 / Math.sqrt(1 + stored.sampleVisitors / 100);
  const coverage = matches.length / PREDICTION_DIMENSIONS.length;
  return {
    score: Math.round(100 * (1 - 2 ** (-p / b))),
    conversionRate: round(p, 4),
    averageValue: round(averageValue, 2),
    expectedValue: round(p * averageValue, 2),
    confidence: round(clamp(coverage * sampleFactor, 0, 1), 3),
    isBaseline: matches.length === 0,
    dimensionMatches: matches,
  };
}

/** `conversionLikelihood` object of the realtime map. */
export function conversionLikelihood(stored: StoredModel, prediction: Prediction) {
  return {
    score: prediction.score,
    confidence: prediction.confidence,
    ...(prediction.isBaseline ? { isBaseline: true } : {}),
    dimensionMatches: prediction.dimensionMatches,
    raw: {
      conversionRate: prediction.conversionRate,
      averageValue: prediction.averageValue || stored.baselineAverageValue,
      expectedValue: prediction.expectedValue,
    },
  };
}

export const CUSTOMER_LIKELIHOOD = { score: 100, confidence: 1, isCustomer: true } as const;
