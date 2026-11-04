/**
 * Period presets → API ranges in the website's timezone. The API reads `YYYY-MM-DD` as whole local
 * days in `timezone`, end inclusive, so the app only needs calendar dates.
 */
import type { Range } from "./api";

export type PeriodKey = "today" | "yesterday" | "7d" | "30d" | "12m";
export type Interval = "hour" | "day" | "week" | "month";

export const PERIODS: Array<{ key: PeriodKey; label: string }> = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "12m", label: "12 months" },
];

export interface Period {
  key: PeriodKey;
  range: Range;
  previous: Range;
  interval: Interval;
}

/** Calendar date (YYYY-MM-DD) of `now` in `timeZone`. */
export function localDate(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Shift a calendar date by whole days (UTC arithmetic on the date only, so DST cannot interfere). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** First day of the month `months` months before `date`'s month. */
export function addMonthsStart(date: string, months: number): string {
  const [y, m] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1 + months, 1));
  return t.toISOString().slice(0, 10);
}

export function periodFor(key: PeriodKey, timeZone: string, now = new Date()): Period {
  const today = localDate(now, timeZone);
  const r = (startAt: string, endAt: string): Range => ({ startAt, endAt, timezone: timeZone });
  switch (key) {
    case "today":
      return {
        key,
        range: r(today, today),
        previous: r(addDays(today, -1), addDays(today, -1)),
        interval: "hour",
      };
    case "yesterday": {
      const y = addDays(today, -1);
      return { key, range: r(y, y), previous: r(addDays(y, -1), addDays(y, -1)), interval: "hour" };
    }
    case "7d":
      return {
        key,
        range: r(addDays(today, -6), today),
        previous: r(addDays(today, -13), addDays(today, -7)),
        interval: "day",
      };
    case "30d":
      return {
        key,
        range: r(addDays(today, -29), today),
        previous: r(addDays(today, -59), addDays(today, -30)),
        interval: "day",
      };
    case "12m": {
      const start = addMonthsStart(today, -11);
      return {
        key,
        range: r(start, today),
        previous: r(addMonthsStart(today, -23), addDays(start, -1)),
        interval: "month",
      };
    }
  }
}
