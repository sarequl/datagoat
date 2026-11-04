/**
 * Visitor activity heatmap: weekday × hour of day in the website timezone, from hourly
 * time-series buckets. Rendered as a real table, so screen readers get every cell's value.
 */
import { useMemo, useState } from "react";
import type { TimeseriesPoint } from "../../../../shared/api-types";
import { cx } from "../../components/ui";
import { formatNumber } from "../lib/format";
import { zonedParts } from "../lib/tz";
import { Segmented } from "./primitives";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const HOURS = Array.from({ length: 24 }, (_, h) => h);

function hourLabel(h: number): string {
  if (h === 0) return "12am";
  if (h === 12) return "12pm";
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

export function buildHeatmap(
  points: readonly TimeseriesPoint[],
  tz: string,
  key: "visitors" | "pageviews",
): number[][] {
  const grid = DAYS.map(() => HOURS.map(() => 0));
  for (const p of points) {
    const v = p[key];
    if (typeof v !== "number") continue;
    const z = zonedParts(Date.parse(p.timestamp), tz);
    const row = grid[z.weekday] as number[];
    row[z.hour] = (row[z.hour] ?? 0) + v;
  }
  return grid;
}

export function ActivityHeatmap({
  points,
  timezone,
  loading,
  note,
}: {
  points: TimeseriesPoint[];
  timezone: string;
  loading?: boolean;
  note?: string;
}) {
  const [key, setKey] = useState<"visitors" | "pageviews">("visitors");
  const grid = useMemo(() => buildHeatmap(points, timezone, key), [points, timezone, key]);
  const max = Math.max(1, ...grid.flat());
  const busiest = useMemo(() => {
    let best = { d: 0, h: 0, v: -1 };
    grid.forEach((row, d) => {
      row.forEach((v, h) => {
        if (v > best.v) best = { d, h, v };
      });
    });
    return best;
  }, [grid]);
  return (
    <div className={cx(loading && "opacity-60")}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted">
          {busiest.v > 0
            ? `Busiest: ${DAYS[busiest.d]} around ${hourLabel(busiest.h)}`
            : "No activity in this period"}
          {note ? ` · ${note}` : ""}
        </p>
        <Segmented
          label="Heatmap metric"
          value={key}
          onChange={setKey}
          options={[
            { value: "visitors", label: "Visitors" },
            { value: "pageviews", label: "Pageviews" },
          ]}
        />
      </div>
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[26rem] border-separate" style={{ borderSpacing: 2 }}>
          <caption className="sr-only">
            {key === "visitors" ? "Visitors" : "Pageviews"} by weekday and hour ({timezone})
          </caption>
          <thead>
            <tr>
              <th scope="col" className="w-9">
                <span className="sr-only">Day</span>
              </th>
              {HOURS.map((h) => (
                <th key={h} scope="col" className="text-[10px] font-normal text-muted">
                  <span className={h % 3 === 0 ? "" : "sr-only"}>{hourLabel(h)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.map((row, d) => (
              <tr key={DAYS[d]}>
                <th scope="row" className="pr-1 text-left text-[11px] font-normal text-muted">
                  {DAYS[d]}
                </th>
                {row.map((v, h) => (
                  <td
                    // biome-ignore lint/suspicious/noArrayIndexKey: fixed 24-hour grid
                    key={h}
                    title={`${DAYS[d]} ${hourLabel(h)}: ${formatNumber(v)}`}
                    className="h-5 rounded-sm"
                    style={{
                      background:
                        v > 0
                          ? `color-mix(in srgb, var(--dg-secondary) ${Math.round(15 + (v / max) * 85)}%, transparent)`
                          : "var(--dg-surface-2)",
                    }}
                  >
                    <span className="sr-only">{formatNumber(v)}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
