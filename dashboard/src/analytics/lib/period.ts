/**
 * Dashboard periods (DataFast's period selector): presets, custom ranges, previous period for
 * comparisons, prev/next hopping and chart granularity. Day ranges are sent to the API as
 * `YYYY-MM-DD` in the website timezone; "Now" and "Last 24 hours" are exact instants.
 */
import type { Interval } from "../../../../shared/api-types";
import {
  addDays,
  addMonths,
  diffDays,
  endOfMonth,
  formatDay,
  isYmd,
  startOfMonth,
  startOfYear,
  ymdInTz,
} from "./tz";

export type PeriodKey =
  | "now"
  | "today"
  | "yesterday"
  | "24h"
  | "7d"
  | "30d"
  | "90d"
  | "6m"
  | "12m"
  | "mtd"
  | "lastmonth"
  | "ytd"
  | "all"
  | "custom";

/** Chart granularity; `minute` is the DataGoat extension used by the "Now" period. */
export type ChartInterval = Interval | "minute";

export interface Period {
  key: PeriodKey;
  /** Custom range, inclusive local days. */
  from?: string;
  to?: string;
}

export interface PeriodOption {
  key: Exclude<PeriodKey, "custom">;
  label: string;
  /** Single-key shortcut shown in the menu. */
  shortcut?: string;
  /** Shown by default (others live under "More periods" until pinned). */
  primary?: boolean;
}

export const PERIOD_OPTIONS: readonly PeriodOption[] = [
  { key: "now", label: "Now", shortcut: "n", primary: true },
  { key: "today", label: "Today", shortcut: "t", primary: true },
  { key: "yesterday", label: "Yesterday", shortcut: "y", primary: true },
  { key: "24h", label: "Last 24 hours", shortcut: "h", primary: true },
  { key: "7d", label: "Last 7 days", shortcut: "w", primary: true },
  { key: "30d", label: "Last 30 days", shortcut: "d", primary: true },
  { key: "90d", label: "Last 3 months", shortcut: "q" },
  { key: "6m", label: "Last 6 months" },
  { key: "12m", label: "Last 12 months", shortcut: "l" },
  { key: "mtd", label: "Month to date" },
  { key: "lastmonth", label: "Last month" },
  { key: "ytd", label: "Year to date" },
  { key: "all", label: "All time", shortcut: "a" },
];

export const DEFAULT_PERIOD: Period = { key: "30d" };

export interface ResolvedRange {
  kind: "days" | "instant" | "all";
  /** API params (absent for "all" without a known start). */
  startAt?: string;
  endAt?: string;
  startDay?: string;
  endDay?: string;
  /** Epoch ms bounds (instant ranges exact; day ranges approximate, UTC midnight). */
  startMs: number;
  endMs: number;
  /** Calendar days covered (fractional for instants). */
  days: number;
  label: string;
  /** Live periods refresh every minute. */
  live: boolean;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function dayRange(startDay: string, endDay: string, label: string, live: boolean): ResolvedRange {
  return {
    kind: "days",
    startAt: startDay,
    endAt: endDay,
    startDay,
    endDay,
    startMs: Date.parse(`${startDay}T00:00:00Z`),
    endMs: Date.parse(`${endDay}T23:59:59Z`),
    days: diffDays(startDay, endDay) + 1,
    label,
    live,
  };
}

function instantRange(start: number, end: number, label: string): ResolvedRange {
  return {
    kind: "instant",
    startAt: new Date(start).toISOString(),
    endAt: new Date(end).toISOString(),
    startMs: start,
    endMs: end,
    days: (end - start) / 86_400_000,
    label,
    live: true,
  };
}

export function customLabel(from: string, to: string): string {
  if (from === to) return formatDay(from, true);
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  return `${formatDay(from, !sameYear)} – ${formatDay(to, true)}`;
}

export function periodLabel(key: PeriodKey): string {
  return PERIOD_OPTIONS.find((o) => o.key === key)?.label ?? "Custom";
}

/**
 * Resolve a period to API params in the website timezone. `siteStart` (the website's creation
 * day) bounds "All time" so its chart has a start; without it the API's all-time default applies.
 */
export function resolvePeriod(
  period: Period,
  tz: string,
  now: number = Date.now(),
  siteStart?: string,
): ResolvedRange {
  const today = ymdInTz(now, tz);
  const label = periodLabel(period.key);
  switch (period.key) {
    case "now":
      return instantRange(now - 30 * MINUTE, now, label);
    case "24h":
      return instantRange(now - 24 * HOUR, now, label);
    case "today":
      return dayRange(today, today, label, true);
    case "yesterday": {
      const y = addDays(today, -1);
      return dayRange(y, y, label, false);
    }
    case "7d":
      return dayRange(addDays(today, -6), today, label, true);
    case "30d":
      return dayRange(addDays(today, -29), today, label, true);
    case "90d":
      return dayRange(addDays(today, -89), today, label, true);
    case "6m":
      return dayRange(addDays(addMonths(today, -6), 1), today, label, true);
    case "12m":
      return dayRange(addDays(addMonths(today, -12), 1), today, label, true);
    case "mtd":
      return dayRange(startOfMonth(today), today, label, true);
    case "lastmonth": {
      const start = startOfMonth(addMonths(today, -1));
      return dayRange(start, endOfMonth(start), label, false);
    }
    case "ytd":
      return dayRange(startOfYear(today), today, label, true);
    case "all":
      if (siteStart && isYmd(siteStart) && siteStart <= today) {
        return { ...dayRange(siteStart, today, label, true) };
      }
      return {
        kind: "all",
        startMs: now - 365 * 86_400_000,
        endMs: now,
        days: 365,
        label,
        live: true,
      };
    case "custom": {
      let from = isYmd(period.from) ? period.from : addDays(today, -29);
      let to = isYmd(period.to) ? period.to : today;
      if (from > to) [from, to] = [to, from];
      return dayRange(from, to, customLabel(from, to), to >= today);
    }
  }
}

/** The equally long range just before `range` (a calendar month for "Last month"). */
export function previousRange(range: ResolvedRange, period: Period): ResolvedRange | null {
  if (range.kind === "all") return null;
  if (range.kind === "instant") {
    const len = range.endMs - range.startMs;
    return instantRange(range.startMs - len, range.startMs, "Previous period");
  }
  const start = range.startDay as string;
  if (period.key === "lastmonth") {
    const prev = addMonths(start, -1);
    return dayRange(prev, endOfMonth(prev), "Previous period", false);
  }
  return dayRange(addDays(start, -range.days), addDays(start, -1), "Previous period", false);
}

/**
 * Prev/next arrows: shift a day range by its own length. Returns null when the move is not
 * possible (instant and all-time periods, or a next step past today).
 */
export function shiftPeriod(
  period: Period,
  range: ResolvedRange,
  dir: -1 | 1,
  tz: string,
  now: number = Date.now(),
): Period | null {
  if (range.kind !== "days" || period.key === "all") return null;
  const today = ymdInTz(now, tz);
  const start = range.startDay as string;
  const end = range.endDay as string;
  let from: string;
  let to: string;
  const wholeMonth = start === startOfMonth(start) && end === endOfMonth(start);
  if (wholeMonth) {
    from = addMonths(start, dir);
    to = endOfMonth(from);
  } else {
    from = addDays(start, dir * range.days);
    to = addDays(end, dir * range.days);
  }
  if (from > today) return null;
  if (to > today) to = today;
  if (from === today && to === today) return { key: "today" };
  if (from === addDays(today, -1) && to === from) return { key: "yesterday" };
  return { key: "custom", from, to };
}

export function allowedIntervals(range: ResolvedRange): ChartInterval[] {
  if (range.kind === "instant") return range.days <= 0.05 ? ["minute"] : ["hour"];
  const d = range.days;
  if (d <= 2) return ["hour", "day"];
  if (d <= 14) return ["hour", "day", "week"];
  if (d <= 92) return ["day", "week"];
  if (d <= 400) return ["day", "week", "month"];
  return ["week", "month"];
}

export function defaultInterval(range: ResolvedRange): ChartInterval {
  if (range.kind === "instant") return range.days <= 0.05 ? "minute" : "hour";
  if (range.kind === "all") return "month";
  const d = range.days;
  if (d <= 2) return "hour";
  if (d <= 92) return "day";
  if (d <= 400) return "week";
  return "month";
}

export const INTERVAL_LABELS: Record<ChartInterval, string> = {
  minute: "Minutely",
  hour: "Hourly",
  day: "Daily",
  week: "Weekly",
  month: "Monthly",
};
