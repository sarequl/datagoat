/**
 * Calendar helpers in an IANA timezone. Days are `YYYY-MM-DD` strings (the API reads them as whole
 * local days in `timezone`), so all arithmetic on days is done on UTC dates and never drifts with DST.
 */

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        weekday: "short",
        hourCycle: "h23",
      });
    } catch {
      f = formatter("UTC");
    }
    partsFormatters.set(tz, f);
  }
  return f;
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Monday … 6 = Sunday */
  weekday: number;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function zonedParts(date: Date | number, tz: string): ZonedParts {
  const parts = formatter(tz).formatToParts(typeof date === "number" ? new Date(date) : date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    weekday: Math.max(0, WEEKDAYS.indexOf(get("weekday"))),
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

export function ymd(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Today's (or `date`'s) calendar day in `tz`. */
export function ymdInTz(date: Date | number, tz: string): string {
  const p = zonedParts(date, tz);
  return ymd(p.year, p.month, p.day);
}

export function isYmd(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function toUtc(day: string): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUtc(date: Date): string {
  return ymd(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

export function addDays(day: string, n: number): string {
  const d = toUtc(day);
  d.setUTCDate(d.getUTCDate() + n);
  return fromUtc(d);
}

/** Whole days from `a` to `b` (b - a). */
export function diffDays(a: string, b: string): number {
  return Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86_400_000);
}

export function startOfMonth(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

export function addMonths(day: string, n: number): string {
  const d = toUtc(startOfMonth(day));
  d.setUTCMonth(d.getUTCMonth() + n);
  return fromUtc(d);
}

export function endOfMonth(day: string): string {
  return addDays(addMonths(day, 1), -1);
}

export function startOfYear(day: string): string {
  return `${day.slice(0, 4)}-01-01`;
}

/** 0 = Monday … 6 = Sunday for a calendar day. */
export function weekdayOf(day: string): number {
  return (toUtc(day).getUTCDay() + 6) % 7;
}

export function minDay(a: string, b: string): string {
  return a < b ? a : b;
}

export function maxDay(a: string, b: string): string {
  return a > b ? a : b;
}

/** "Oct 6" / "Oct 6, 2025" for a calendar day (no timezone shift: the day is already local). */
export function formatDay(day: string, withYear = false): string {
  return toUtc(day).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
    ...(withYear ? { year: "numeric" } : {}),
  });
}
