/** Number, money, percentage, duration and time formatting for the analytics pages. */
import type { ChartInterval } from "./period";

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "–";
  return Math.round(n).toLocaleString("en-US");
}

export function formatCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "–";
  if (Math.abs(n) < 1000) return formatNumber(n);
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(
    n,
  );
}

const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "HUF", "TWD", "UGX"]);

export function formatMoney(
  n: number | null | undefined,
  currency = "USD",
  opts: { compact?: boolean; cents?: boolean } = {},
): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "–";
  const zero = ZERO_DECIMAL.has(currency.toUpperCase());
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      ...(opts.compact && Math.abs(n) >= 10_000
        ? { notation: "compact", maximumFractionDigits: 1 }
        : {
            minimumFractionDigits: opts.cents && !zero ? 2 : 0,
            maximumFractionDigits: zero ? 0 : opts.cents || Math.abs(n) < 10 ? 2 : 0,
          }),
    }).format(n);
  } catch {
    return `${n.toFixed(zero ? 0 : 2)} ${currency}`;
  }
}

export function formatPercent(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "–";
  return `${n.toFixed(digits)}%`;
}

/** Seconds → "1m 08s" / "42s" / "1h 03m". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return "–";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Milliseconds → "3 days", "2 hours", "5 min". */
export function formatSpan(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "less than a minute";
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"}`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "–";
  const ms = now - Date.parse(iso);
  if (Number.isNaN(ms)) return "–";
  if (ms < 45_000) return "just now";
  return `${formatSpan(ms)} ago`;
}

function fmt(iso: string | number, tz: string, opts: Intl.DateTimeFormatOptions): string {
  try {
    return new Date(iso).toLocaleString("en-US", { timeZone: tz, ...opts });
  } catch {
    return new Date(iso).toLocaleString("en-US", { timeZone: "UTC", ...opts });
  }
}

export function formatDateTime(iso: string | number, tz: string): string {
  return fmt(iso, tz, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatDate(iso: string | number, tz: string): string {
  return fmt(iso, tz, { month: "short", day: "numeric", year: "numeric" });
}

export function formatTime(iso: string | number, tz: string): string {
  return fmt(iso, tz, { hour: "numeric", minute: "2-digit" });
}

/** Axis/tooltip label for a time-series bucket. */
export function bucketLabel(
  iso: string,
  interval: ChartInterval,
  tz: string,
  long = false,
): string {
  switch (interval) {
    case "minute":
      return fmt(iso, tz, { hour: "numeric", minute: "2-digit" });
    case "hour":
      return long
        ? fmt(iso, tz, { weekday: "short", month: "short", day: "numeric", hour: "numeric" })
        : fmt(iso, tz, { hour: "numeric" });
    case "day":
      return long
        ? fmt(iso, tz, { weekday: "short", month: "short", day: "numeric", year: "numeric" })
        : fmt(iso, tz, { month: "short", day: "numeric" });
    case "week":
      return long
        ? `Week of ${fmt(iso, tz, { month: "short", day: "numeric", year: "numeric" })}`
        : fmt(iso, tz, { month: "short", day: "numeric" });
    case "month":
      return fmt(iso, tz, { month: long ? "long" : "short", year: "numeric" });
  }
}

/** Percentage change, or null when there is no baseline. */
export function delta(current: number, previous: number | null | undefined): number | null {
  if (previous === null || previous === undefined || !Number.isFinite(previous)) return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

export function flagEmoji(code: string | null | undefined): string {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return "🏳️";
  return String.fromCodePoint(
    ...code
      .toUpperCase()
      .split("")
      .map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  );
}

let regionNames: Intl.DisplayNames | null | undefined;

export function countryName(code: string | null | undefined): string {
  if (!code) return "Unknown";
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {
      regionNames = null;
    }
  }
  try {
    return regionNames?.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

export function capitalize(s: string): string {
  return s ? s[0]?.toUpperCase() + s.slice(1) : s;
}
