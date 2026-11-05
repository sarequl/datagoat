/**
 * The main dashboard chart, drawn in SVG: visitors line + revenue bars (DataFast's mixed chart),
 * new vs returning visitors, or a single metric trend; previous period as a dashed line / faded
 * bars; note, GitHub-commit and X-mention markers under the axis. Keyboard: focus the chart, use
 * Left/Right to move between buckets, Enter for actions (drill down, add a note), Escape to close.
 */
import { type KeyboardEvent, type ReactNode, useId, useMemo, useState } from "react";
import type { TimeseriesPoint } from "../../../../shared/api-types";
import { Button, cx } from "../../components/ui";
import { bucketIndex, formatMetric, METRICS, type MetricDef, niceTicks } from "../lib/chart";
import { bucketLabel, formatMoney, formatNumber } from "../lib/format";
import type { ChartInterval } from "../lib/period";
import { Dialog } from "./primitives";
import { useWidth } from "./Sparkline";

export type ChartMode = "default" | "visitors" | string;

export interface ChartMarker {
  id: string;
  kind: "note" | "commit" | "mention";
  ts: number;
  title: string;
  detail?: string;
  url?: string | null;
}

const MARKER_ICON: Record<ChartMarker["kind"], string> = {
  note: "📝",
  commit: "⌥",
  mention: "𝕏",
};

const MARKER_NAME: Record<ChartMarker["kind"], [string, string]> = {
  note: ["note", "notes"],
  commit: ["commit", "commits"],
  mention: ["mention", "mentions"],
};

interface Series {
  main?: Array<number | null>;
  prevMain?: Array<number | null> | null;
  newV?: number[];
  retV?: number[];
  revenue?: number[];
  refunds?: number[];
  prevRevenue?: number[] | null;
}

const H = 260;
const PAD_T = 12;
const PAD_B = 26;

function linePath(
  values: Array<number | null>,
  x: (i: number) => number,
  y: (v: number) => number,
) {
  let d = "";
  let pen = false;
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

export function MainChart({
  points,
  prevPoints,
  mode,
  interval,
  timezone,
  currency,
  showRevenue,
  revenueColor,
  compare,
  markers = [],
  onAddNote,
  onDrill,
  renderMarkers,
  loading,
}: {
  points: TimeseriesPoint[];
  prevPoints?: TimeseriesPoint[];
  mode: ChartMode;
  interval: ChartInterval;
  timezone: string;
  currency: string;
  showRevenue: boolean;
  revenueColor: string;
  compare: boolean;
  markers?: ChartMarker[];
  onAddNote?: (timestamp: string, text: string) => Promise<unknown>;
  onDrill?: (point: TimeseriesPoint) => void;
  renderMarkers?: (items: ChartMarker[], close: () => void) => ReactNode;
  loading?: boolean;
}) {
  const { ref, width } = useWidth<HTMLDivElement>(720);
  const gradId = useId().replace(/:/g, "");
  const [active, setActive] = useState<number | null>(null);
  const [menu, setMenu] = useState<number | null>(null);
  const [noteText, setNoteText] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [markerGroup, setMarkerGroup] = useState<ChartMarker[] | null>(null);

  const metric: MetricDef | undefined =
    mode !== "default" && mode !== "visitors" ? METRICS[mode] : undefined;
  const revenueOn = showRevenue && mode === "default";
  const padL = 44;
  const padR = revenueOn ? 56 : 14;
  const innerW = Math.max(40, width - padL - padR);
  const innerH = H - PAD_T - PAD_B;
  const n = points.length;
  const band = innerW / Math.max(1, n);
  const cx_ = (i: number) => padL + band * (i + 0.5);
  const prev = compare || metric ? prevPoints : undefined;

  const series = useMemo((): Series => {
    const val = (p: TimeseriesPoint | undefined, k: keyof TimeseriesPoint) => {
      const v = p?.[k];
      return typeof v === "number" ? v : null;
    };
    if (metric) {
      return {
        main: points.map(metric.value),
        prevMain: prev ? points.map((_, i) => (prev[i] ? metric.value(prev[i]) : null)) : null,
      };
    }
    if (mode === "visitors") {
      return {
        newV: points.map((p) => val(p, "new_visitors") ?? 0),
        retV: points.map((p) => val(p, "returning_visitors") ?? 0),
        prevMain: prev ? points.map((_, i) => val(prev[i], "visitors")) : null,
      };
    }
    return {
      main: points.map((p) => val(p, "visitors")),
      prevMain: prev ? points.map((_, i) => val(prev[i], "visitors")) : null,
      revenue: points.map((p) => Math.max(0, val(p, "revenue") ?? 0)),
      // Refunded amounts are drawn greyed out on top of the net revenue bar (DataFast).
      refunds: points.map((p) => Math.max(0, val(p, "refunds") ?? 0)),
      prevRevenue: prev ? points.map((_, i) => Math.max(0, val(prev[i], "revenue") ?? 0)) : null,
    };
  }, [points, prev, metric, mode]);

  const leftValues: number[] = [
    ...((series.main ?? []).filter((v) => v !== null) as number[]),
    ...((series.prevMain ?? []).filter((v) => v !== null) as number[]),
    ...(series.newV ? series.newV.map((v, i) => v + (series.retV?.[i] ?? 0)) : []),
  ];
  const ticks = niceTicks(Math.max(0, ...leftValues));
  const top = ticks[ticks.length - 1] || 1;
  const y = (v: number) => PAD_T + innerH - (v / top) * innerH;
  const revTicks = revenueOn
    ? niceTicks(
        Math.max(
          0,
          ...(series.revenue ?? []).map((v, i) => v + (series.refunds?.[i] ?? 0)),
          ...(series.prevRevenue ?? []),
        ),
      )
    : [];
  const revTop = revTicks[revTicks.length - 1] || 1;
  const yr = (v: number) => PAD_T + innerH - (v / revTop) * innerH;
  const leftKind = metric?.kind ?? "number";
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(innerW / 80))));
  const barW = Math.max(1, Math.min(28, band * 0.62));

  const groups = useMemo(() => {
    const map = new Map<number, ChartMarker[]>();
    for (const m of markers) {
      const i = bucketIndex(points, m.ts);
      if (i < 0) continue;
      map.set(i, [...(map.get(i) ?? []), m]);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [markers, points]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!n) return;
    const cur = active ?? (e.key === "ArrowLeft" ? n : -1);
    let next: number | null = null;
    if (e.key === "ArrowRight") next = Math.min(n - 1, cur + 1);
    else if (e.key === "ArrowLeft") next = Math.max(0, cur - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    else if ((e.key === "Enter" || e.key === " ") && active !== null) {
      e.preventDefault();
      setMenu(active);
      return;
    } else if (e.key === "Escape") {
      setMenu(null);
      setNoteOpen(false);
      return;
    }
    if (next !== null) {
      e.preventDefault();
      setActive(next);
    }
  };

  const activePoint = active !== null ? points[active] : undefined;
  const menuPoint = menu !== null ? points[menu] : undefined;
  const tooltipLeft = active !== null ? Math.min(Math.max(cx_(active) - 90, 0), width - 200) : 0;

  const tooltipRows = (i: number): Array<[string, string, string?]> => {
    const p = points[i] as TimeseriesPoint;
    const pp = prev?.[i];
    if (metric) {
      const rows: Array<[string, string, string?]> = [
        [metric.label, formatMetric(metric.kind, metric.value(p), currency)],
      ];
      if (pp)
        rows.push(["Previous", formatMetric(metric.kind, metric.value(pp), currency), "muted"]);
      return rows;
    }
    if (mode === "visitors") {
      return [
        ["New visitors", formatNumber(p.new_visitors)],
        ["Returning visitors", formatNumber(p.returning_visitors)],
        ...(pp
          ? [["Previous visitors", formatNumber(pp.visitors), "muted"] as [string, string, string]]
          : []),
      ];
    }
    const rows: Array<[string, string, string?]> = [["Visitors", formatNumber(p.visitors)]];
    if (revenueOn) {
      rows.push(["Revenue", formatMoney(p.revenue ?? 0, currency)]);
      rows.push(["Payments", formatNumber(p.payments ?? 0)]);
      if ((p.refunds ?? 0) > 0)
        rows.push(["Refunds", formatMoney(p.refunds ?? 0, currency), "muted"]);
    }
    if (pp) {
      rows.push(["Previous visitors", formatNumber(pp.visitors), "muted"]);
      if (revenueOn)
        rows.push(["Previous revenue", formatMoney(pp.revenue ?? 0, currency), "muted"]);
    }
    return rows;
  };

  const valueText = (i: number) => {
    const p = points[i];
    if (!p) return "No data";
    return `${bucketLabel(p.timestamp, interval, timezone, true)}: ${tooltipRows(i)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}`;
  };

  const caption = metric
    ? `${metric.label} over time`
    : mode === "visitors"
      ? "New and returning visitors over time"
      : revenueOn
        ? "Visitors and revenue over time"
        : "Visitors over time";

  return (
    <div className="relative">
      <div
        className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted"
        aria-hidden="true"
      >
        {metric ? (
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-4 bg-visitors" /> {metric.label}
          </span>
        ) : mode === "visitors" ? (
          <>
            <span className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm bg-visitors" /> New
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm bg-accent" /> Returning
            </span>
          </>
        ) : (
          <>
            <span className="flex items-center gap-1.5">
              <span className="h-0.5 w-4 bg-visitors" /> Visitors
            </span>
            {revenueOn ? (
              <span className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-sm" style={{ background: revenueColor }} />{" "}
                Revenue
              </span>
            ) : null}
            {revenueOn && series.refunds?.some((v) => v > 0) ? (
              <span className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-sm bg-muted/45" /> Refunds
              </span>
            ) : null}
          </>
        )}
        {prev ? (
          <span className="flex items-center gap-1.5">
            <span className="w-4 border-t border-dashed border-muted" /> Previous period
          </span>
        ) : null}
      </div>
      <div
        ref={ref}
        role="slider"
        aria-roledescription="chart"
        tabIndex={0}
        aria-label={`${caption}. Use the arrow keys to move between points and Enter for actions.`}
        aria-valuemin={0}
        aria-valuemax={Math.max(0, n - 1)}
        aria-valuenow={active ?? Math.max(0, n - 1)}
        aria-valuetext={valueText(active ?? n - 1)}
        aria-busy={loading || undefined}
        onKeyDown={onKey}
        onMouseLeave={() => setActive(null)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setActive(null);
        }}
        className={cx("relative rounded-md", loading && "opacity-60")}
        data-testid="main-chart"
      >
        <svg
          width={width}
          height={H}
          role="img"
          aria-label={caption}
          className="block overflow-visible"
        >
          <defs>
            <linearGradient id={`g${gradId}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--dg-secondary)" stopOpacity="0.28" />
              <stop offset="100%" stopColor="var(--dg-secondary)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} stroke="var(--dg-line)" />
              <text x={padL - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--dg-muted)">
                {formatMetric(leftKind, t, currency, true)}
              </text>
            </g>
          ))}
          {revenueOn
            ? revTicks.map((t) => (
                <text
                  key={t}
                  x={width - padR + 6}
                  y={yr(t) + 4}
                  fontSize="11"
                  fill="var(--dg-muted)"
                >
                  {formatMoney(t, currency, { compact: true })}
                </text>
              ))
            : null}
          {series.prevRevenue
            ? series.prevRevenue.map((v, i) =>
                v > 0 ? (
                  <rect
                    // biome-ignore lint/suspicious/noArrayIndexKey: buckets are positional
                    key={`pr${i}`}
                    x={cx_(i) - barW / 2 - 2}
                    width={barW + 4}
                    y={yr(v)}
                    height={PAD_T + innerH - yr(v)}
                    fill={revenueColor}
                    opacity={0.22}
                    rx={2}
                  />
                ) : null,
              )
            : null}
          {series.revenue
            ? series.revenue.map((v, i) =>
                v > 0 ? (
                  <rect
                    // biome-ignore lint/suspicious/noArrayIndexKey: buckets are positional
                    key={`r${i}`}
                    x={cx_(i) - barW / 2}
                    width={barW}
                    y={yr(v)}
                    height={PAD_T + innerH - yr(v)}
                    fill={revenueColor}
                    opacity={active === null || active === i ? 0.9 : 0.55}
                    rx={2}
                  />
                ) : null,
              )
            : null}
          {series.refunds && series.revenue
            ? series.refunds.map((v, i) => {
                if (v <= 0) return null;
                const base = series.revenue?.[i] ?? 0;
                return (
                  <rect
                    // biome-ignore lint/suspicious/noArrayIndexKey: buckets are positional
                    key={`rf${i}`}
                    x={cx_(i) - barW / 2}
                    width={barW}
                    y={yr(base + v)}
                    height={yr(base) - yr(base + v)}
                    fill="var(--dg-muted)"
                    opacity={0.45}
                    rx={2}
                    data-testid="refund-bar"
                  />
                );
              })
            : null}
          {series.newV
            ? series.newV.map((v, i) => {
                const r = series.retV?.[i] ?? 0;
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: buckets are positional
                  <g key={`nv${i}`} opacity={active === null || active === i ? 1 : 0.6}>
                    <rect
                      x={cx_(i) - barW / 2}
                      width={barW}
                      y={y(v)}
                      height={PAD_T + innerH - y(v)}
                      fill="var(--dg-secondary)"
                      rx={1}
                    />
                    <rect
                      x={cx_(i) - barW / 2}
                      width={barW}
                      y={y(v + r)}
                      height={y(v) - y(v + r)}
                      fill="var(--dg-accent)"
                      rx={1}
                    />
                  </g>
                );
              })
            : null}
          {series.main && !metric ? (
            <path
              d={`${linePath(series.main, cx_, y)}L${cx_(n - 1).toFixed(1)},${PAD_T + innerH}L${cx_(0).toFixed(1)},${PAD_T + innerH}Z`}
              fill={`url(#g${gradId})`}
            />
          ) : null}
          {series.prevMain ? (
            <path
              d={linePath(series.prevMain, cx_, y)}
              fill="none"
              stroke="var(--dg-muted)"
              strokeWidth={1.5}
              strokeDasharray="4 4"
              data-testid="previous-line"
            />
          ) : null}
          {series.main ? (
            <path
              d={linePath(series.main, cx_, y)}
              fill="none"
              stroke="var(--dg-secondary)"
              strokeWidth={2.25}
              strokeLinejoin="round"
            />
          ) : null}
          {active !== null ? (
            <line
              x1={cx_(active)}
              x2={cx_(active)}
              y1={PAD_T}
              y2={PAD_T + innerH}
              stroke="var(--dg-line-strong)"
            />
          ) : null}
          {active !== null && series.main?.[active] !== null && series.main ? (
            <circle
              cx={cx_(active)}
              cy={y(series.main[active] as number)}
              r={4}
              fill="var(--dg-secondary)"
            />
          ) : null}
          {points.map((p, i) =>
            i % labelEvery === 0 ? (
              <text
                key={p.timestamp}
                x={cx_(i)}
                y={H - 8}
                textAnchor="middle"
                fontSize="11"
                fill="var(--dg-muted)"
              >
                {bucketLabel(p.timestamp, interval, timezone)}
              </text>
            ) : null,
          )}
          {points.map((p, i) => (
            // biome-ignore lint/a11y/noStaticElementInteractions: pointer helper; the chart group handles keys
            <rect
              key={`h${p.timestamp}`}
              x={padL + band * i}
              y={PAD_T}
              width={band}
              height={innerH}
              fill="transparent"
              onMouseEnter={() => setActive(i)}
              onClick={() => {
                setActive(i);
                setMenu(i);
              }}
              style={{ cursor: "pointer" }}
            />
          ))}
        </svg>
      </div>
      {activePoint && active !== null && menu === null ? (
        <div
          role="status"
          className="pointer-events-none absolute top-8 z-10 w-48 rounded-md border border-line bg-surface p-2 text-xs shadow-lg"
          style={{ left: tooltipLeft }}
          data-testid="chart-tooltip"
        >
          <div className="mb-1 font-medium">
            {bucketLabel(activePoint.timestamp, interval, timezone, true)}
          </div>
          {tooltipRows(active).map(([k, v, tone]) => (
            <div
              key={k}
              className={cx("flex justify-between gap-2", tone === "muted" && "text-muted")}
            >
              <span>{k}</span>
              <span className="font-medium tabular-nums">{v}</span>
            </div>
          ))}
          {(groups.find(([gi]) => gi === active)?.[1] ?? []).slice(0, 3).map((m) => (
            <div key={m.id} className="mt-1 truncate text-muted">
              {MARKER_ICON[m.kind]} {m.title}
            </div>
          ))}
        </div>
      ) : null}
      {menuPoint && menu !== null ? (
        <div
          role="dialog"
          aria-label="Chart point actions"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setMenu(null);
              setNoteOpen(false);
              ref.current?.focus();
            }
          }}
          className="absolute top-8 z-20 w-64 rounded-md border border-line bg-surface p-3 text-sm shadow-xl"
          style={{ left: Math.min(Math.max(cx_(menu) - 120, 0), width - 260) }}
        >
          <div className="mb-2 font-medium">
            {bucketLabel(menuPoint.timestamp, interval, timezone, true)}
          </div>
          {/* The clicked point's numbers stay visible (DataFast's sticky tooltip, for screenshots). */}
          <dl className="mb-2 space-y-0.5 text-xs" data-testid="chart-pinned-tooltip">
            {tooltipRows(menu).map(([k, v, tone]) => (
              <div
                key={k}
                className={cx("flex justify-between gap-2", tone === "muted" && "text-muted")}
              >
                <dt>{k}</dt>
                <dd className="font-medium tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
          {noteOpen ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!noteText.trim() || !onAddNote) return;
                setSaving(true);
                try {
                  await onAddNote(menuPoint.timestamp, noteText.trim().slice(0, 500));
                  setNoteText("");
                  setNoteOpen(false);
                  setMenu(null);
                } finally {
                  setSaving(false);
                }
              }}
              className="space-y-2"
            >
              <label className="block text-xs text-muted">
                Note
                <textarea
                  // biome-ignore lint/a11y/noAutofocus: the form opens on request
                  autoFocus
                  value={noteText}
                  maxLength={500}
                  rows={3}
                  onChange={(e) => setNoteText(e.target.value)}
                  placeholder="Shipped the new onboarding"
                  className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-1 text-sm text-text"
                />
              </label>
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => setNoteOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={saving || !noteText.trim()}>
                  Save note
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-col gap-1">
              {onDrill && interval !== "minute" && interval !== "hour" ? (
                <Button
                  variant="secondary"
                  autoFocus
                  onClick={() => {
                    onDrill(menuPoint);
                    setMenu(null);
                  }}
                >
                  View this {interval}
                </Button>
              ) : null}
              {onAddNote ? (
                <Button variant="secondary" onClick={() => setNoteOpen(true)}>
                  Add note here
                </Button>
              ) : null}
              <Button variant="ghost" onClick={() => setMenu(null)}>
                Close
              </Button>
            </div>
          )}
        </div>
      ) : null}
      {groups.length ? (
        <div className="relative h-7">
          {groups.map(([i, items]) => {
            const kinds = [...new Set(items.map((m) => m.kind))];
            const label = kinds
              .map((k) => {
                const c = items.filter((m) => m.kind === k).length;
                return `${c} ${MARKER_NAME[k][c === 1 ? 0 : 1]}`;
              })
              .join(", ");
            const p = points[i] as TimeseriesPoint;
            return (
              <button
                key={i}
                type="button"
                onClick={() => setMarkerGroup(items)}
                aria-label={`${label} on ${bucketLabel(p.timestamp, interval, timezone, true)}`}
                title={items.map((m) => m.title).join("\n")}
                className="absolute top-0.5 flex h-6 min-w-6 items-center justify-center rounded-full border border-line bg-surface px-1 text-[11px] leading-none hover:bg-surface-2"
                style={{ left: cx_(i) - 12 }}
                data-testid={`marker-${kinds.join("-")}`}
              >
                {kinds.map((k) => MARKER_ICON[k]).join("")}
                {items.length > 1 ? (
                  <span className="ml-0.5 text-muted">{items.length}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
      <Dialog open={markerGroup !== null} onClose={() => setMarkerGroup(null)} title="Chart notes">
        {markerGroup && renderMarkers
          ? renderMarkers(markerGroup, () => setMarkerGroup(null))
          : null}
      </Dialog>
      <div className="sr-only">
        <table>
          <caption>{caption}</caption>
          <thead>
            <tr>
              <th scope="col">Period</th>
              <th scope="col">
                {metric?.label ?? (mode === "visitors" ? "New / returning" : "Visitors")}
              </th>
              {revenueOn ? <th scope="col">Revenue</th> : null}
            </tr>
          </thead>
          <tbody>
            {points.map((p, i) => (
              <tr key={p.timestamp}>
                <th scope="row">{bucketLabel(p.timestamp, interval, timezone, true)}</th>
                <td>
                  {metric
                    ? formatMetric(metric.kind, metric.value(p), currency)
                    : mode === "visitors"
                      ? `${formatNumber(p.new_visitors)} / ${formatNumber(p.returning_visitors)}`
                      : formatNumber(p.visitors)}
                </td>
                {revenueOn ? <td>{formatMoney(series.revenue?.[i] ?? 0, currency)}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
