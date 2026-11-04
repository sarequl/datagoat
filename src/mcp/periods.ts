/**
 * Dashboard date presets (`today`, `last7d`, …) resolved to the API's `startAt`/`endAt` values.
 * Shared by the MCP tools and the CLI (which bundles this file), so a preset means the same thing
 * everywhere. Pure: no Worker APIs, no imports.
 *
 * Day-based presets resolve to `YYYY-MM-DD` dates in the website timezone; the API reads those as
 * whole local days (end inclusive). `last24h` resolves to exact ISO instants.
 */

export const PERIODS = [
  "today",
  "yesterday",
  "last24h",
  "last7d",
  "last30d",
  "last90d",
  "last12m",
  "week",
  "month",
  "year",
  "all",
] as const;

export type Period = (typeof PERIODS)[number];

export function isPeriod(value: string): value is Period {
  return (PERIODS as readonly string[]).includes(value);
}

export interface ResolvedPeriod {
  startAt?: string;
  endAt?: string;
}

/** The calendar date (`YYYY-MM-DD`) of `nowMs` in `timeZone`. */
export function dateIn(nowMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function shiftDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function shiftMonths(date: string, months: number): string {
  const [y, m, day] = date.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

/** ISO weekday of a date: 1 = Monday … 7 = Sunday. */
function isoWeekday(date: string): number {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return dow === 0 ? 7 : dow;
}

/**
 * Resolve a preset in `timeZone` at `nowMs`. `all` returns no bounds (all time).
 * Throws on an unknown preset.
 */
export function resolvePeriod(
  period: string,
  timeZone: string,
  nowMs: number = Date.now(),
): ResolvedPeriod {
  if (!isPeriod(period)) {
    throw new Error(`Unknown period "${period}". Use one of: ${PERIODS.join(", ")}`);
  }
  const today = dateIn(nowMs, timeZone);
  switch (period) {
    case "today":
      return { startAt: today, endAt: today };
    case "yesterday": {
      const y = shiftDays(today, -1);
      return { startAt: y, endAt: y };
    }
    case "last24h":
      return {
        startAt: new Date(nowMs - 86_400_000).toISOString(),
        endAt: new Date(nowMs).toISOString(),
      };
    case "last7d":
      return { startAt: shiftDays(today, -6), endAt: today };
    case "last30d":
      return { startAt: shiftDays(today, -29), endAt: today };
    case "last90d":
      return { startAt: shiftDays(today, -89), endAt: today };
    case "last12m":
      return { startAt: shiftDays(shiftMonths(today, -12), 1), endAt: today };
    case "week":
      return { startAt: shiftDays(today, -(isoWeekday(today) - 1)), endAt: today };
    case "month":
      return { startAt: `${today.slice(0, 8)}01`, endAt: today };
    case "year":
      return { startAt: `${today.slice(0, 5)}01-01`, endAt: today };
    case "all":
      return {};
  }
}
