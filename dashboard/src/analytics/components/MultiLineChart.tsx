/** Several series over time as lines (goals over time), with a hidden data table. */
import { useState } from "react";
import { niceTicks } from "../lib/chart";
import { bucketLabel, formatCompact, formatNumber } from "../lib/format";
import type { ChartInterval } from "../lib/period";
import { useWidth } from "./Sparkline";

export interface LineSeries {
  key: string;
  label: string;
  color: string;
  values: number[];
}

const H = 220;

export function MultiLineChart({
  timestamps,
  series,
  interval,
  timezone,
  caption,
}: {
  timestamps: string[];
  series: LineSeries[];
  interval: ChartInterval;
  timezone: string;
  caption: string;
}) {
  const { ref, width } = useWidth<HTMLDivElement>(720);
  const [active, setActive] = useState<number | null>(null);
  const padL = 40;
  const padR = 12;
  const padT = 10;
  const padB = 24;
  const n = timestamps.length;
  const innerW = Math.max(40, width - padL - padR);
  const innerH = H - padT - padB;
  const band = innerW / Math.max(1, n);
  const x = (i: number) => padL + band * (i + 0.5);
  const ticks = niceTicks(Math.max(0, ...series.flatMap((s) => s.values)));
  const top = ticks.at(-1) || 1;
  const y = (v: number) => padT + innerH - (v / top) * innerH;
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(innerW / 80))));
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover tooltip only; the data table carries the values
    <div ref={ref} className="relative" onMouseLeave={() => setActive(null)}>
      <svg width={width} height={H} role="img" aria-label={caption} className="block">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} stroke="var(--dg-line)" />
            <text x={padL - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--dg-muted)">
              {formatCompact(t)}
            </text>
          </g>
        ))}
        {series.map((s) => (
          <path
            key={s.key}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            strokeLinejoin="round"
            d={s.values
              .map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
              .join("")}
          />
        ))}
        {timestamps.map((t, i) =>
          i % every === 0 ? (
            <text
              key={t}
              x={x(i)}
              y={H - 6}
              textAnchor="middle"
              fontSize="11"
              fill="var(--dg-muted)"
            >
              {bucketLabel(t, interval, timezone)}
            </text>
          ) : null,
        )}
        {active !== null ? (
          <line
            x1={x(active)}
            x2={x(active)}
            y1={padT}
            y2={padT + innerH}
            stroke="var(--dg-line-strong)"
          />
        ) : null}
        {timestamps.map((t, i) => (
          // biome-ignore lint/a11y/noStaticElementInteractions: pointer helper; data table below
          <rect
            key={`h${t}`}
            x={padL + band * i}
            y={padT}
            width={band}
            height={innerH}
            fill="transparent"
            onMouseEnter={() => setActive(i)}
          />
        ))}
      </svg>
      {active !== null && timestamps[active] ? (
        <div
          className="pointer-events-none absolute top-1 z-10 w-48 rounded-md border border-line bg-surface p-2 text-xs shadow-lg"
          style={{ left: Math.min(Math.max(x(active) - 90, 0), width - 200) }}
        >
          <div className="mb-1 font-medium">
            {bucketLabel(timestamps[active] as string, interval, timezone, true)}
          </div>
          {series.map((s) => (
            <div key={s.key} className="flex justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1 truncate">
                <span className="size-2 shrink-0 rounded-full" style={{ background: s.color }} />
                {s.label}
              </span>
              <span className="tabular-nums">{formatNumber(s.values[active])}</span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="sr-only">
        <table>
          <caption>{caption}</caption>
          <thead>
            <tr>
              <th scope="col">Period</th>
              {series.map((s) => (
                <th key={s.key} scope="col">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {timestamps.map((t, i) => (
              <tr key={t}>
                <th scope="row">{bucketLabel(t, interval, timezone, true)}</th>
                {series.map((s) => (
                  <td key={s.key}>{formatNumber(s.values[i])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
