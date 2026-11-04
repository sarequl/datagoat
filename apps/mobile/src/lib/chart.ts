/** Timeseries → geometry for the overview chart (a visitors line over revenue bars). */
import type { TimeseriesPoint } from "./api";
import type { Interval } from "./periods";

export interface ChartGeometry {
  width: number;
  height: number;
  /** SVG path for the visitors line ("" when there are no points). */
  linePath: string;
  /** SVG path closing the line to the baseline, for the area fill. */
  areaPath: string;
  bars: Array<{ x: number; y: number; width: number; height: number }>;
  maxVisitors: number;
  maxRevenue: number;
  /** A few evenly spaced x-axis labels. */
  labels: Array<{ x: number; text: string }>;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Axis label for a bucket. `name` from the API is already local ("2026-11-04 13:00" / "2026-11-04"). */
export function bucketLabel(point: TimeseriesPoint, interval: Interval): string {
  const name = point.name ?? point.timestamp;
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?(?:[ T](\d{2}):(\d{2}))?/.exec(name);
  if (!m) return name;
  const month = MONTHS[Number(m[2]) - 1] ?? m[2];
  if (interval === "hour") return `${m[4] ?? "00"}:00`;
  if (interval === "month") return `${month}`;
  return `${Number(m[3] ?? 1)} ${month}`;
}

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(value));
  const f = value / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * exp;
}

export function buildChart(
  points: TimeseriesPoint[],
  interval: Interval,
  width: number,
  height: number,
  labelCount = 4,
): ChartGeometry {
  const n = points.length;
  const visitors = points.map((p) => p.visitors ?? 0);
  const revenue = points.map((p) => Math.max(0, p.revenue ?? 0));
  const maxVisitors = niceMax(Math.max(0, ...visitors));
  const maxRevenue = Math.max(0, ...revenue);
  const step = n > 1 ? width / (n - 1) : 0;
  const xAt = (i: number) => (n > 1 ? i * step : width / 2);
  const yAt = (v: number) => height - (v / maxVisitors) * height;
  const coords = visitors.map((v, i) => [round(xAt(i)), round(yAt(v))] as const);
  const linePath = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x} ${y}`).join(" ");
  const areaPath = n
    ? `${linePath} L${coords[n - 1]?.[0]} ${height} L${coords[0]?.[0]} ${height} Z`
    : "";
  const barWidth = n ? Math.max(1, (width / n) * 0.6) : 0;
  const bars =
    maxRevenue > 0
      ? revenue.map((r, i) => {
          const h = round((r / maxRevenue) * height * 0.5);
          return {
            x: round(xAt(i) - barWidth / 2),
            y: round(height - h),
            width: round(barWidth),
            height: h,
          };
        })
      : [];
  const labels: ChartGeometry["labels"] = [];
  if (n) {
    const every = Math.max(1, Math.ceil(n / labelCount));
    for (let i = 0; i < n; i += every) {
      const p = points[i];
      if (p) labels.push({ x: round(xAt(i)), text: bucketLabel(p, interval) });
    }
  }
  return { width, height, linePath, areaPath, bars, maxVisitors, maxRevenue, labels };
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}
