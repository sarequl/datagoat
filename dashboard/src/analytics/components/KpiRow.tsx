/**
 * KPI row: each tile shows the value, the change against the previous period and a trend
 * sparkline. Clicking a tile switches the main chart (Visitors → new vs returning, a rate → its
 * trend chart); clicking it again returns to the mixed visitors/revenue chart.
 */
import { Link } from "@tanstack/react-router";
import type { Overview, TimeseriesPoint } from "../../../../shared/api-types";
import { cx } from "../../components/ui";
import { formatMetric, METRICS, type MetricKind } from "../lib/chart";
import { delta, formatNumber, formatPercent } from "../lib/format";
import { Skeleton } from "./primitives";
import { Sparkline } from "./Sparkline";

interface Tile {
  key: string;
  label: string;
  kind: MetricKind;
  value: number | null;
  prev: number | null;
  inverse?: boolean;
  sub?: string;
  spark: Array<number | null>;
  color?: string;
}

function DeltaBadge({ value, inverse }: { value: number | null; inverse?: boolean }) {
  if (value === null) return <span className="text-xs text-muted">–</span>;
  const good = inverse ? value < 0 : value > 0;
  const flat = Math.abs(value) < 0.05;
  return (
    <span
      className={cx(
        "text-xs font-medium tabular-nums",
        flat ? "text-muted" : good ? "text-success-text" : "text-error-text",
      )}
    >
      <span aria-hidden="true">{flat ? "→" : value > 0 ? "↑" : "↓"}</span>
      <span className="sr-only">{value > 0 ? "up" : "down"}</span> {formatPercent(Math.abs(value))}
    </span>
  );
}

export function KpiRow({
  overview,
  prevOverview,
  points,
  currency,
  showRevenue,
  metric,
  onSelect,
  compare,
  kpiGoal,
  liveVisitors,
  realtimeLink,
  revenueColor,
}: {
  overview: Overview | undefined;
  prevOverview: Overview | undefined;
  points: TimeseriesPoint[];
  currency: string;
  showRevenue: boolean;
  metric: string | null;
  onSelect: (metric: string | null) => void;
  compare: boolean;
  kpiGoal?: {
    name: string;
    label: string;
    visitors: number;
    prevVisitors: number | null;
    rate: number;
  } | null;
  liveVisitors?: number | null;
  realtimeLink?: { siteId: string } | null;
  revenueColor: string;
}) {
  if (!overview) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" aria-busy="true">
        {Array.from({ length: 5 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholders
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
    );
  }
  const sp = (k: string) => points.map((p) => METRICS[k]?.value(p) ?? null);
  const o = overview;
  const p = prevOverview;
  const tiles: Tile[] = [
    {
      key: "visitors",
      label: "Visitors",
      kind: "number",
      value: o.visitors,
      prev: p?.visitors ?? null,
      sub: `${formatNumber(o.new_visitors)} new · ${formatNumber(o.returning_visitors)} returning`,
      spark: sp("visitors"),
      color: "var(--dg-secondary)",
    },
    ...(showRevenue
      ? [
          {
            key: "revenue",
            label: "Revenue",
            kind: "money" as const,
            value: o.revenue,
            prev: p?.revenue ?? null,
            spark: sp("revenue"),
            color: revenueColor,
          },
          {
            key: "payments",
            label: "Payments",
            kind: "number" as const,
            value: o.payments,
            prev: p?.payments ?? null,
            spark: sp("payments"),
          },
          {
            key: "revenue_per_visitor",
            label: "Revenue/visitor",
            kind: "money" as const,
            value: o.revenue_per_visitor,
            prev: p?.revenue_per_visitor ?? null,
            spark: sp("revenue_per_visitor"),
          },
          {
            key: "conversion_rate",
            label: "Conversion rate",
            kind: "percent" as const,
            value: o.conversion_rate,
            prev: p?.conversion_rate ?? null,
            spark: sp("conversion_rate"),
          },
        ]
      : []),
    {
      key: "sessions",
      label: "Sessions",
      kind: "number",
      value: o.sessions,
      prev: p?.sessions ?? null,
      spark: sp("sessions"),
    },
    {
      key: "pageviews",
      label: "Pageviews",
      kind: "number",
      value: o.pageviews,
      prev: p?.pageviews ?? null,
      spark: sp("pageviews"),
    },
    {
      key: "bounce_rate",
      label: "Bounce rate",
      kind: "percent",
      value: o.bounce_rate,
      prev: p?.bounce_rate ?? null,
      inverse: true,
      spark: sp("bounce_rate"),
    },
    {
      key: "avg_session_duration",
      label: "Session time",
      kind: "duration",
      value: o.avg_session_duration,
      prev: p?.avg_session_duration ?? null,
      spark: sp("avg_session_duration"),
    },
  ];
  const selected = metric ?? "revenue";
  return (
    <div>
      {kpiGoal ? (
        <div
          className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/40 bg-surface px-4 py-3"
          data-testid="kpi-goal"
        >
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-primary-text">
              #1 KPI
            </div>
            <div className="text-sm text-muted">{kpiGoal.label}</div>
          </div>
          <div className="flex items-baseline gap-4">
            <span className="text-2xl font-semibold tabular-nums">
              {formatNumber(kpiGoal.visitors)}
            </span>
            <span className="text-sm text-muted">
              visitors · {formatPercent(kpiGoal.rate, 2)} conversion
            </span>
            <DeltaBadge value={delta(kpiGoal.visitors, kpiGoal.prevVisitors)} />
          </div>
        </div>
      ) : null}
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5" aria-label="Key metrics">
        {tiles.map((t) => {
          const isSelected = t.key === "revenue" ? selected === "revenue" : selected === t.key;
          return (
            <li key={t.key}>
              <button
                type="button"
                aria-pressed={isSelected}
                onClick={() => onSelect(t.key === "revenue" || isSelected ? null : t.key)}
                className={cx(
                  "flex h-full w-full flex-col gap-1 rounded-lg border bg-surface p-3 text-left transition hover:bg-surface-2",
                  isSelected ? "border-primary" : "border-line",
                )}
                data-testid={`kpi-${t.key}`}
              >
                <span className="text-xs font-medium text-muted">{t.label}</span>
                <span className="flex items-end justify-between gap-2">
                  <span className="text-xl font-semibold tabular-nums">
                    {formatMetric(t.kind, t.value, currency)}
                  </span>
                  <span className={cx("shrink-0", !t.color && "text-muted")}>
                    <Sparkline
                      values={t.spark}
                      color={t.color ?? "currentColor"}
                      width={64}
                      height={24}
                    />
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-x-2">
                  <DeltaBadge
                    value={t.value === null ? null : delta(t.value, t.prev)}
                    inverse={t.inverse}
                  />
                  {compare && t.prev !== null ? (
                    <span className="text-xs text-muted">
                      was {formatMetric(t.kind, t.prev, currency)}
                    </span>
                  ) : null}
                </span>
                {t.sub ? <span className="text-xs text-muted">{t.sub}</span> : null}
              </button>
            </li>
          );
        })}
        {realtimeLink ? (
          <li>
            <Link
              to="/app/$siteId/realtime"
              params={{ siteId: realtimeLink.siteId }}
              className="flex h-full flex-col gap-1 rounded-lg border border-line bg-surface p-3 hover:bg-surface-2"
              data-testid="kpi-live"
            >
              <span className="flex items-center gap-1.5 text-xs font-medium text-muted">
                <span className="size-2 animate-pulse rounded-full bg-success" aria-hidden="true" />
                Visitors now
              </span>
              <span className="text-xl font-semibold tabular-nums">
                {liveVisitors === null || liveVisitors === undefined
                  ? "–"
                  : formatNumber(liveVisitors)}
              </span>
              <span className="text-xs text-muted">Open the live map (M)</span>
            </Link>
          </li>
        ) : null}
      </ul>
    </div>
  );
}
