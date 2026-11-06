/**
 * KPI row: six headline tiles in one row (value and change against the previous period), the
 * rest under "More metrics". Clicking a tile switches the main chart (Visitors → new vs
 * returning, a rate → its trend chart); clicking it again returns to the visitors/revenue chart.
 * The website's #1 KPI goal, when set, takes the conversion tile's place in the headline row.
 */
import type { ReactNode } from "react";
import type { Overview } from "../../../../shared/api-types";
import { cx } from "../../components/ui";
import { formatMetric, type MetricKind } from "../lib/chart";
import { delta, formatNumber, formatPercent } from "../lib/format";
import { Skeleton } from "./primitives";

interface Tile {
  key: string;
  label: string;
  kind: MetricKind;
  value: number | null;
  prev: number | null;
  inverse?: boolean;
  /** Extra detail: shown on hover and read by screen readers. */
  detail?: string;
  swatch?: string;
}

/** A read-only tile (MRR, ad spend and ROAS) shown next to the selectable KPIs. */
export interface ExtraTile {
  key: string;
  label: string;
  value: string;
  sub?: string;
  /** Put the tile right after Visitors (the website's headline revenue metric). */
  lead?: boolean;
}

export interface KpiGoal {
  name: string;
  label: string;
  visitors: number;
  prevVisitors: number | null;
  rate: number;
}

type Item =
  | { type: "tile"; tile: Tile }
  | { type: "extra"; extra: ExtraTile }
  | { type: "goal"; goal: KpiGoal };

/** Tiles in the headline row; the rest go under "More metrics". */
export const HEADLINE_TILES = 6;

/** Tiles sit in one card, split by hairlines (the right edge is clipped by the wrapper). */
const CELL = "border-b border-r border-line";
const VALUE = "mt-1 text-[22px] font-semibold leading-tight tracking-[-0.02em] tabular-nums";
const BOX = "relative flex h-full w-full flex-col px-4 py-3.5 text-left md:px-[18px]";

function Delta({
  value,
  inverse,
  was,
}: {
  value: number | null;
  inverse?: boolean;
  was?: string | null;
}) {
  if (value === null) return <span className="text-xs text-muted">–</span>;
  const good = inverse ? value < 0 : value > 0;
  const flat = Math.abs(value) < 0.05;
  return (
    <span className="text-xs tabular-nums">
      <span
        className={cx(
          "font-medium",
          flat ? "text-muted" : good ? "text-success-text" : "text-error-text",
        )}
      >
        <span aria-hidden="true">{flat ? "→" : value > 0 ? "↑" : "↓"}</span>
        <span className="sr-only">{value > 0 ? "up" : "down"}</span>{" "}
        {formatPercent(Math.abs(value))}
      </span>{" "}
      <span className="text-muted">{was ? `was ${was}` : "vs prev."}</span>
    </span>
  );
}

function Label({ children, swatch }: { children: ReactNode; swatch?: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted">
      {swatch ? (
        <span
          aria-hidden="true"
          className="size-2 shrink-0 rounded-[2px]"
          style={{ background: swatch }}
        />
      ) : null}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** How many tiles sit under "More metrics" (the toggle lives in the chart toolbar). */
export function moreMetricsCount(showRevenue: boolean, hasGoal: boolean, extras: number): number {
  const total = (showRevenue ? 10 : 5) + (hasGoal ? 1 : 0) + extras;
  return Math.max(0, total - HEADLINE_TILES);
}

export const MORE_METRICS_ID = "kpi-more-metrics";

export function KpiRow({
  overview,
  prevOverview,
  currency,
  showRevenue,
  metric,
  onSelect,
  compare,
  kpiGoal,
  revenueColor,
  extras = [],
  more = false,
}: {
  overview: Overview | undefined;
  prevOverview: Overview | undefined;
  currency: string;
  showRevenue: boolean;
  metric: string | null;
  onSelect: (metric: string | null) => void;
  compare: boolean;
  kpiGoal?: KpiGoal | null;
  revenueColor: string;
  extras?: ExtraTile[];
  /** Show the tiles beyond the headline row. */
  more?: boolean;
}) {
  if (!overview) {
    return (
      <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-6" aria-busy="true">
        {Array.from({ length: HEADLINE_TILES }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholders
          <Skeleton key={i} className="h-14" />
        ))}
      </div>
    );
  }
  const o = overview;
  const p = prevOverview;
  const t = (tile: Tile): Item => ({ type: "tile", tile });
  const visitors = t({
    key: "visitors",
    label: "Visitors",
    kind: "number",
    value: o.visitors,
    prev: p?.visitors ?? null,
    detail: `${formatNumber(o.new_visitors)} new · ${formatNumber(o.returning_visitors)} returning`,
    swatch: "var(--dg-secondary)",
  });
  const revenue = t({
    key: "revenue",
    label: "Revenue",
    kind: "money",
    value: o.revenue,
    prev: p?.revenue ?? null,
    swatch: revenueColor,
  });
  const payments = t({
    key: "payments",
    label: "Payments",
    kind: "number",
    value: o.payments,
    prev: p?.payments ?? null,
  });
  const rpv = t({
    key: "revenue_per_visitor",
    label: "Revenue / visitor",
    kind: "money",
    value: o.revenue_per_visitor,
    prev: p?.revenue_per_visitor ?? null,
  });
  const conversion = t({
    key: "conversion_rate",
    label: "Conversion",
    kind: "percent",
    value: o.conversion_rate,
    prev: p?.conversion_rate ?? null,
  });
  const sessions = t({
    key: "sessions",
    label: "Sessions",
    kind: "number",
    value: o.sessions,
    prev: p?.sessions ?? null,
  });
  const pageviews = t({
    key: "pageviews",
    label: "Pageviews",
    kind: "number",
    value: o.pageviews,
    prev: p?.pageviews ?? null,
  });
  const bounce = t({
    key: "bounce_rate",
    label: "Bounce rate",
    kind: "percent",
    value: o.bounce_rate,
    prev: p?.bounce_rate ?? null,
    inverse: true,
  });
  const duration = t({
    key: "avg_session_duration",
    label: "Session time",
    kind: "duration",
    value: o.avg_session_duration,
    prev: p?.avg_session_duration ?? null,
  });
  const goal: Item[] = kpiGoal ? [{ type: "goal", goal: kpiGoal }] : [];
  const lead: Item[] = extras.filter((e) => e.lead).map((extra) => ({ type: "extra", extra }));
  const rest: Item[] = extras.filter((e) => !e.lead).map((extra) => ({ type: "extra", extra }));
  // Headline order first, then everything else in its usual order.
  const ordered: Item[] = showRevenue
    ? [
        visitors,
        ...lead,
        revenue,
        ...(kpiGoal ? goal : [conversion]),
        rpv,
        bounce,
        duration,
        ...(kpiGoal ? [conversion] : []),
        payments,
        sessions,
        pageviews,
        ...rest,
      ]
    : [visitors, ...goal, pageviews, sessions, bounce, duration, ...lead, ...rest];
  const headline = ordered.slice(0, HEADLINE_TILES);
  const others = ordered.slice(HEADLINE_TILES);
  const selected = metric ?? "revenue";

  const render = (item: Item) => {
    if (item.type === "extra") {
      const e = item.extra;
      return (
        <li key={e.key} className={CELL}>
          <div className={BOX} data-testid={`kpi-${e.key}`}>
            <Label>{e.label}</Label>
            <span className={VALUE}>{e.value}</span>
            {e.sub ? <span className="mt-0.5 text-xs text-muted">{e.sub}</span> : null}
          </div>
        </li>
      );
    }
    if (item.type === "goal") {
      const g = item.goal;
      return (
        <li key="goal" className={CELL}>
          <div
            className={BOX}
            data-testid="kpi-goal"
            title={`${formatPercent(g.rate, 2)} of visitors converted`}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <Label swatch="var(--dg-primary)">{g.label}</Label>
              <span className="shrink-0 rounded bg-surface-2 px-1 text-[10px] font-semibold text-primary-text">
                #1 KPI
              </span>
            </span>
            <span className={VALUE}>{formatNumber(g.visitors)}</span>
            <span className="mt-0.5">
              <Delta value={delta(g.visitors, g.prevVisitors)} />
            </span>
            <span className="sr-only">visitors, {formatPercent(g.rate, 2)} conversion</span>
          </div>
        </li>
      );
    }
    const tile = item.tile;
    const isSelected = tile.key === "revenue" ? selected === "revenue" : selected === tile.key;
    return (
      <li key={tile.key} className={CELL}>
        <button
          type="button"
          aria-pressed={isSelected}
          title={tile.detail}
          onClick={() => onSelect(tile.key === "revenue" || isSelected ? null : tile.key)}
          className={cx(BOX, "transition hover:bg-surface-2")}
          data-testid={`kpi-${tile.key}`}
        >
          {isSelected ? (
            <span
              aria-hidden="true"
              className="absolute inset-x-4 bottom-0 h-0.5 rounded-full bg-text md:inset-x-[18px]"
            />
          ) : null}
          <Label swatch={tile.swatch}>{tile.label}</Label>
          <span className={VALUE}>{formatMetric(tile.kind, tile.value, currency)}</span>
          <span className="mt-0.5">
            <Delta
              value={tile.value === null ? null : delta(tile.value, tile.prev)}
              inverse={tile.inverse}
              was={
                compare && tile.prev !== null ? formatMetric(tile.kind, tile.prev, currency) : null
              }
            />
          </span>
          {tile.detail ? <span className="sr-only">{tile.detail}</span> : null}
        </button>
      </li>
    );
  };

  return (
    <div className="overflow-hidden">
      <ul
        className="-mr-px grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6"
        aria-label="Key metrics"
      >
        {headline.map(render)}
      </ul>
      {others.length && more ? (
        <ul
          id={MORE_METRICS_ID}
          className="-mr-px grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6"
          aria-label="More metrics"
        >
          {others.map(render)}
        </ul>
      ) : null}
    </div>
  );
}
