/** KPI tiles for the overview screen, from the period's and the previous period's overview rows. */
import type { Overview } from "./api";
import {
  type Delta,
  delta,
  formatCount,
  formatDuration,
  formatMoney,
  formatPercent,
} from "./format";

export interface Kpi {
  key: string;
  label: string;
  value: string;
  delta: Delta | null;
}

export function buildKpis(current: Overview, previous: Overview | null): Kpi[] {
  const d = (cur: number, prev: number | undefined, higherIsBetter = true) =>
    previous && prev !== undefined ? delta(cur, prev, higherIsBetter) : null;
  const currency = current.currency || "USD";
  return [
    {
      key: "visitors",
      label: "Visitors",
      value: formatCount(current.visitors),
      delta: d(current.visitors, previous?.visitors),
    },
    {
      key: "revenue",
      label: "Revenue",
      value: formatMoney(current.revenue, currency, true),
      delta: d(current.revenue, previous?.revenue),
    },
    {
      key: "conversion_rate",
      label: "Conversion",
      value: formatPercent(current.conversion_rate),
      delta: d(current.conversion_rate, previous?.conversion_rate),
    },
    {
      key: "revenue_per_visitor",
      label: "Revenue/visitor",
      value: formatMoney(current.revenue_per_visitor, currency),
      delta: d(current.revenue_per_visitor, previous?.revenue_per_visitor),
    },
    {
      key: "bounce_rate",
      label: "Bounce rate",
      value: formatPercent(current.bounce_rate),
      delta: d(current.bounce_rate, previous?.bounce_rate, false),
    },
    {
      key: "avg_session_duration",
      label: "Session time",
      value: formatDuration(current.avg_session_duration),
      delta: d(current.avg_session_duration, previous?.avg_session_duration),
    },
  ];
}
