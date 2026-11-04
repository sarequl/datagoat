/** Small helpers for the hand-drawn SVG charts (scales, ticks, metric accessors). */
import type { TimeseriesPoint } from "../../../../shared/api-types";
import { formatCompact, formatDuration, formatMoney, formatNumber, formatPercent } from "./format";

/** Upper bound and 4–5 "nice" ticks (1, 2, 2.5, 5 × 10^k) covering `max`. */
export function niceTicks(max: number, count = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

export type MetricKind = "number" | "money" | "percent" | "duration";

export interface MetricDef {
  key: string;
  label: string;
  kind: MetricKind;
  /** Lower is better (bounce rate): deltas are coloured inversely. */
  inverse?: boolean;
  value: (p: TimeseriesPoint) => number | null;
}

const num = (v: number | undefined | null) => (typeof v === "number" ? v : null);

export const METRICS: Record<string, MetricDef> = {
  visitors: { key: "visitors", label: "Visitors", kind: "number", value: (p) => num(p.visitors) },
  sessions: { key: "sessions", label: "Sessions", kind: "number", value: (p) => num(p.sessions) },
  pageviews: {
    key: "pageviews",
    label: "Pageviews",
    kind: "number",
    value: (p) => num(p.pageviews),
  },
  bounce_rate: {
    key: "bounce_rate",
    label: "Bounce rate",
    kind: "percent",
    inverse: true,
    value: (p) => num(p.bounce_rate),
  },
  avg_session_duration: {
    key: "avg_session_duration",
    label: "Session time",
    kind: "duration",
    value: (p) => num(p.avg_session_duration),
  },
  revenue: { key: "revenue", label: "Revenue", kind: "money", value: (p) => num(p.revenue) },
  payments: { key: "payments", label: "Payments", kind: "number", value: (p) => num(p.payments) },
  revenue_per_visitor: {
    key: "revenue_per_visitor",
    label: "Revenue/visitor",
    kind: "money",
    value: (p) =>
      typeof p.revenue === "number" && typeof p.visitors === "number"
        ? p.visitors > 0
          ? p.revenue / p.visitors
          : 0
        : null,
  },
  conversion_rate: {
    key: "conversion_rate",
    label: "Conversion rate",
    kind: "percent",
    value: (p) => num(p.conversion_rate),
  },
};

export function formatMetric(
  kind: MetricKind,
  v: number | null | undefined,
  currency: string,
  compact = false,
): string {
  switch (kind) {
    case "money":
      return formatMoney(v, currency, { compact, cents: !compact && (v ?? 0) < 100 });
    case "percent":
      return formatPercent(v);
    case "duration":
      return formatDuration(v);
    default:
      return compact ? formatCompact(v) : formatNumber(v);
  }
}

/** Index of the bucket that contains `ts` (the last bucket starting at or before it). */
export function bucketIndex(points: readonly { timestamp: string }[], ts: number): number {
  let idx = -1;
  for (let i = 0; i < points.length; i++) {
    const start = Date.parse((points[i] as { timestamp: string }).timestamp);
    if (start <= ts) idx = i;
    else break;
  }
  return idx;
}
