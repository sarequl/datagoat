/**
 * Building blocks shared by the growth pages (W6): site id, date ranges, number formatting,
 * KPI tiles, a dependency-free SVG bar chart, tables, toggles and tabs. Everything uses the
 * design tokens from styles.css.
 */
import { useParams } from "@tanstack/react-router";
import { type ReactNode, useId } from "react";
import type { WebsiteSummary } from "../../../../shared/api-types";
import { useWebsites } from "../../api/hooks";
import { cx } from "../../components/ui";

export function useSiteId(): string {
  const params = useParams({ strict: false }) as { siteId?: string; websiteId?: string };
  return params.siteId ?? params.websiteId ?? "";
}

/** The current website's summary (tracking id, domain, currency) from the cached website list. */
export function useSite(): WebsiteSummary | undefined {
  const siteId = useSiteId();
  return useWebsites().data?.find((w) => w._id === siteId);
}

export type RangeKey = "7d" | "30d" | "90d" | "12mo";
export const RANGES: Array<{ key: RangeKey; label: string; days: number }> = [
  { key: "7d", label: "Last 7 days", days: 7 },
  { key: "30d", label: "Last 30 days", days: 30 },
  { key: "90d", label: "Last 90 days", days: 90 },
  { key: "12mo", label: "Last 12 months", days: 365 },
];

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** `startAt`/`endAt` (local calendar days, inclusive) for a preset. */
export function rangeParams(key: RangeKey, now = new Date()): { startAt: string; endAt: string } {
  const days = RANGES.find((r) => r.key === key)?.days ?? 30;
  const start = new Date(now);
  start.setDate(start.getDate() - (days - 1));
  return { startAt: isoDay(start), endAt: isoDay(now) };
}

export function RangeSelect({
  value,
  onChange,
}: {
  value: RangeKey;
  onChange: (v: RangeKey) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="sr-only">Date range</span>
      <select
        aria-label="Date range"
        className="rounded-md border border-line bg-surface px-2 py-1.5 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value as RangeKey)}
      >
        {RANGES.map((r) => (
          <option key={r.key} value={r.key}>
            {r.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const nf = new Intl.NumberFormat("en-US");
export const fmtNumber = (n: number | null | undefined) =>
  n === null || n === undefined ? "–" : nf.format(n);
export const fmtPercent = (n: number | null | undefined) =>
  n === null || n === undefined ? "–" : `${Math.round(n * 10) / 10}%`;
export function fmtMoney(n: number | null | undefined, currency = "USD") {
  if (n === null || n === undefined) return "–";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}
export function fmtDate(iso: string | null | undefined, withTime = false) {
  if (!iso) return "–";
  const d = new Date(iso);
  return withTime
    ? d.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "visitors" | "revenue" | "primary";
}) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div
        className={cx(
          "mt-1 text-2xl font-semibold tabular-nums",
          tone === "visitors" && "text-visitors",
          tone === "revenue" && "text-revenue",
          tone === "primary" && "text-primary-text",
        )}
      >
        {value}
      </div>
      {hint ? <div className="mt-0.5 text-xs text-muted">{hint}</div> : null}
    </div>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{children}</div>;
}

export interface BarDatum {
  label: string;
  value: number;
  secondary?: number;
}

/** Accessible SVG bar chart: one bar per bucket, optional overlaid secondary series. */
export function BarChart({
  data,
  label,
  height = 140,
  secondaryLabel,
}: {
  data: BarDatum[];
  label: string;
  height?: number;
  secondaryLabel?: string;
}) {
  const id = useId();
  const max = Math.max(1, ...data.map((d) => Math.max(d.value, d.secondary ?? 0)));
  const w = 100 / Math.max(1, data.length);
  return (
    <figure aria-labelledby={id} className="w-full">
      <svg
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        className="h-36 w-full"
        role="img"
        aria-labelledby={id}
      >
        <title>{label}</title>
        {data.map((d, i) => {
          const h = (d.value / max) * (height - 4);
          const s = d.secondary === undefined ? 0 : (d.secondary / max) * (height - 4);
          return (
            <g key={d.label}>
              <title>{`${d.label}: ${fmtNumber(d.value)}${d.secondary !== undefined ? ` (${secondaryLabel ?? "secondary"}: ${fmtNumber(d.secondary)})` : ""}`}</title>
              <rect
                x={i * w + w * 0.15}
                width={w * 0.7}
                y={height - h}
                height={h}
                rx={0.6}
                className="fill-chart-1"
              />
              {d.secondary !== undefined ? (
                <rect
                  x={i * w + w * 0.3}
                  width={w * 0.4}
                  y={height - s}
                  height={s}
                  rx={0.4}
                  className="fill-chart-2"
                />
              ) : null}
            </g>
          );
        })}
      </svg>
      <figcaption id={id} className="mt-1 flex justify-between text-xs text-muted">
        <span>{data[0]?.label ?? ""}</span>
        <span>{label}</span>
        <span>{data[data.length - 1]?.label ?? ""}</span>
      </figcaption>
    </figure>
  );
}

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  align?: "left" | "right";
}

export function Table<T>({
  columns,
  rows,
  rowKey,
  empty,
  caption,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, i: number) => string;
  empty: ReactNode;
  caption?: string;
}) {
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-muted">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={cx("px-2 py-2 font-medium", c.align === "right" && "text-right")}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={rowKey(row, i)}
              className="border-b border-line last:border-0 hover:bg-surface-2"
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={cx(
                    "px-2 py-2 align-top",
                    c.align === "right" && "text-right tabular-nums",
                  )}
                >
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Toggle({
  label,
  checked,
  onChange,
  disabled,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  hint?: ReactNode;
}) {
  return (
    <label className="flex items-start gap-3 text-sm">
      <input
        type="checkbox"
        className="mt-0.5 size-4 accent-[var(--dg-primary)]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span className="font-medium">{label}</span>
        {hint ? <span className="block text-xs text-muted">{hint}</span> : null}
      </span>
    </label>
  );
}

export function Tabs<K extends string>({
  value,
  onChange,
  items,
  label,
}: {
  value: K;
  onChange: (k: K) => void;
  items: Array<{ key: K; label: string }>;
  label: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex flex-wrap gap-1 rounded-md border border-line bg-surface p-1"
    >
      {items.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={value === t.key}
          onClick={() => onChange(t.key)}
          className={cx(
            "rounded px-3 py-1 text-sm",
            value === t.key ? "bg-primary text-primary-fg" : "text-muted hover:bg-surface-2",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium">{label}</span>
      <select
        className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-md bg-surface-2 p-3 text-xs">
      <code>{children}</code>
    </pre>
  );
}

/** Split a comma or newline separated list. */
export function splitList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((v) => v.trim())
    .filter(Boolean);
}
