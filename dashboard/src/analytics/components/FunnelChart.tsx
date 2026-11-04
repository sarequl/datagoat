/** Funnel results: one bar per step with conversion, drop-off and revenue, plus a table. */
import type { FunnelResult } from "../../../../shared/api-types";
import { formatMoney, formatNumber, formatPercent } from "../lib/format";

export function FunnelChart({
  result,
  currency,
  money,
}: {
  result: FunnelResult;
  currency: string;
  money: boolean;
}) {
  const first = Math.max(1, result.data[0]?.value ?? 0);
  return (
    <div className="space-y-4">
      <ol
        className="grid gap-3"
        style={{
          gridTemplateColumns: `repeat(${Math.max(1, result.data.length)}, minmax(0, 1fr))`,
        }}
        aria-hidden="true"
      >
        {result.data.map((s, i) => (
          <li key={s.id} className="flex min-w-0 flex-col">
            <div className="relative h-48 rounded-md bg-surface-2">
              <div
                className="absolute inset-x-0 bottom-0 rounded-md bg-visitors/80"
                style={{ height: `${Math.max(2, (s.value / first) * 100)}%` }}
              />
              {i > 0 ? (
                <div className="absolute inset-x-0 top-1 text-center text-[11px] text-error-text">
                  −{formatPercent(s.dropoffFromPrevious)}
                </div>
              ) : null}
            </div>
            <div className="mt-1 truncate text-xs font-medium" title={s.label}>
              {i + 1}. {s.label}
            </div>
            <div className="text-xs text-muted tabular-nums">
              {formatNumber(s.value)} · {formatPercent(s.conversionRate)}
            </div>
          </li>
        ))}
      </ol>
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[34rem] text-sm">
          <caption className="sr-only">Funnel steps</caption>
          <thead className="text-left text-xs text-muted">
            <tr>
              <th scope="col" className="py-2 font-medium">
                Step
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Visitors
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Conversion
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Drop-off
              </th>
              {money ? (
                <th scope="col" className="py-2 text-right font-medium">
                  Revenue
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {result.data.map((s, i) => (
              <tr key={s.id} className="border-t border-line">
                <th scope="row" className="py-2 text-left font-normal">
                  <span className="mr-1 text-muted">{i + 1}.</span>
                  {s.label}
                  <span className="ml-2 text-xs text-muted">
                    {s.stepType === "goal" ? "goal" : "page"}
                  </span>
                </th>
                <td className="py-2 text-right tabular-nums">{formatNumber(s.value)}</td>
                <td className="py-2 text-right tabular-nums">{formatPercent(s.conversionRate)}</td>
                <td className="py-2 text-right tabular-nums text-error-text">
                  {i === 0 ? "–" : formatPercent(s.dropoffFromPrevious)}
                </td>
                {money ? (
                  <td className="py-2 text-right tabular-nums text-primary-text">
                    {formatMoney(s.revenue, currency)}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
