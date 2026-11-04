/** Display formatting for numbers, money, percentages, durations and period-over-period changes. */

export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (abs >= 10_000) return `${trim(n / 1000)}k`;
  return Math.round(n).toLocaleString("en-US");
}

function trim(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

export function formatMoney(amount: number, currency: string, compact = false): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      ...(compact && Math.abs(amount) >= 10_000
        ? { notation: "compact", maximumFractionDigits: 1 }
        : {}),
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function formatPercent(value: number): string {
  return `${(Math.round(value * 10) / 10).toString()}%`;
}

/** Seconds → "45s", "3m 12s", "1h 05m". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

export interface Delta {
  /** Rounded percentage change, or null when there is no previous value to compare with. */
  percent: number | null;
  direction: "up" | "down" | "flat";
  /** Whether the change is good news (bounce rate going down is good). */
  good: boolean | null;
  label: string;
}

export function delta(current: number, previous: number, higherIsBetter = true): Delta {
  if (!Number.isFinite(previous) || previous === 0) {
    if (current === 0) return { percent: 0, direction: "flat", good: null, label: "0%" };
    return { percent: null, direction: "up", good: higherIsBetter, label: "new" };
  }
  const pct = Math.round(((current - previous) / Math.abs(previous)) * 100);
  const direction = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  const good = direction === "flat" ? null : (direction === "up") === higherIsBetter;
  const sign = pct > 0 ? "+" : "";
  return { percent: pct, direction, good, label: `${sign}${pct}%` };
}
