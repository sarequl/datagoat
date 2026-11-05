/**
 * Embeddable widget at /share/:token/widget (DataFast's widgets): one number or a small chart from
 * the public share API, styled by the iframe URL (type, period, theme, colour). It needs the share
 * link to be on; revenue appears only when the owner shares revenue.
 */
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useEffect } from "react";
import type { Overview, SharedWebsite, TimeseriesPoint } from "../../../../shared/api-types";
import { Sparkline } from "../../analytics/components/Sparkline";
import { formatMoney, formatNumber } from "../../analytics/lib/format";
import { apiGet } from "../../api/client";
import {
  PERIOD_LABELS,
  parseWidgetOptions,
  WIDGET_LABELS,
  type WidgetOptions,
  widgetRange,
} from "./widget-options";

const share = (token: string, path = "") => `/api/share/${encodeURIComponent(token)}${path}`;

function Bars({ values, color }: { values: number[]; color: string }) {
  const max = Math.max(1, ...values);
  const w = 100 / Math.max(1, values.length);
  return (
    <svg
      viewBox="0 0 100 40"
      preserveAspectRatio="none"
      className="h-full w-full"
      aria-hidden="true"
    >
      {values.map((v, i) => {
        const h = (v / max) * 38;
        return (
          <rect
            // biome-ignore lint/suspicious/noArrayIndexKey: buckets are positional
            key={i}
            x={i * w + w * 0.15}
            y={40 - h}
            width={w * 0.7}
            height={h}
            rx={0.6}
            fill={color}
          />
        );
      })}
    </svg>
  );
}

export function WidgetBody({
  token,
  options,
  now = Date.now(),
}: {
  token: string;
  options: WidgetOptions;
  now?: number;
}) {
  const color = `#${options.color}`;
  const range = widgetRange(options.period, now);
  const site = useQuery({
    queryKey: ["widget", token, "site"],
    queryFn: () => apiGet<SharedWebsite>(share(token)),
    retry: false,
  });
  const wantsRevenue = options.type === "revenue";
  const overview = useQuery({
    queryKey: ["widget", token, "overview", options.period],
    queryFn: () =>
      apiGet<Overview[]>(share(token, "/analytics/overview"), {
        startAt: range.startAt,
        endAt: range.endAt,
      }),
    enabled: options.type !== "live" && options.type !== "chart",
    refetchInterval: 5 * 60_000,
  });
  const series = useQuery({
    queryKey: ["widget", token, "series", options.period, wantsRevenue],
    queryFn: () =>
      apiGet<TimeseriesPoint[]>(share(token, "/analytics/timeseries"), {
        startAt: range.startAt,
        endAt: range.endAt,
        interval: range.interval,
        fields: wantsRevenue ? "visitors,revenue" : "visitors",
      }),
    enabled: options.type !== "live",
    refetchInterval: 5 * 60_000,
  });
  const live = useQuery({
    queryKey: ["widget", token, "live"],
    queryFn: () => apiGet<Array<{ visitors: number }>>(share(token, "/analytics/realtime")),
    enabled: options.type === "live",
    refetchInterval: 60_000,
  });

  if (site.error) {
    return <p className="p-3 text-xs text-muted">This widget is not available.</p>;
  }
  const w = site.data;
  const name = w ? (w.name ?? w.domain) : "";
  const points = series.data ?? [];
  const o = overview.data?.[0];
  const revenueHidden = wantsRevenue && w && !w.showRevenue;
  let value = "…";
  if (options.type === "live" && live.data) value = formatNumber(live.data[0]?.visitors ?? 0);
  if (options.type === "visitors" && o) value = formatNumber(o.visitors);
  if (options.type === "revenue" && o && w)
    value = revenueHidden ? "–" : formatMoney(o.revenue ?? 0, o.currency ?? w.currency);
  if (options.type === "chart")
    value = formatNumber(points.reduce((s, p) => s + (p.visitors ?? 0), 0));
  const label =
    options.type === "live"
      ? WIDGET_LABELS.live
      : `${options.type === "revenue" ? "Revenue" : "Visitors"} · ${PERIOD_LABELS[options.period]}`;

  return (
    <a
      href={`/share/${encodeURIComponent(token)}`}
      target="_blank"
      rel="noopener noreferrer"
      className="flex h-screen w-full flex-col gap-1 overflow-hidden bg-surface p-3 text-text no-underline"
      data-testid="widget"
    >
      <span className="flex items-center justify-between gap-2 text-xs text-muted">
        <span className="truncate font-medium">{name}</span>
        {options.type === "live" ? (
          <span
            className="size-2 shrink-0 animate-pulse rounded-full"
            style={{ background: color }}
          />
        ) : null}
      </span>
      <span
        className="text-2xl font-semibold tabular-nums"
        style={{ color }}
        data-testid="widget-value"
      >
        {value}
      </span>
      <span className="text-xs text-muted">
        {revenueHidden ? "Revenue is not shared publicly" : label}
      </span>
      {options.type === "chart" ? (
        <span className="min-h-0 flex-1 pt-1">
          <Bars values={points.map((p) => p.visitors ?? 0)} color={color} />
        </span>
      ) : options.type !== "live" ? (
        <span className="mt-auto">
          <Sparkline
            values={points.map((p) => (wantsRevenue ? (p.revenue ?? 0) : (p.visitors ?? 0)))}
            color={color}
            width={280}
            height={28}
          />
        </span>
      ) : null}
      <span className="mt-auto text-right text-[10px] text-muted">DataGoat</span>
    </a>
  );
}

export default function WidgetPage() {
  const { token } = useParams({ strict: false }) as { token: string };
  const options = parseWidgetOptions(window.location.search);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", options.theme);
  }, [options.theme]);
  return <WidgetBody token={token} options={options} />;
}
