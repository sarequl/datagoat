/**
 * Time and timezone helpers. All instants are epoch milliseconds (UTC). Calendar dates are
 * `YYYY-MM-DD` strings in a named IANA timezone. Everything is DST-safe: offsets are computed
 * per instant with Intl, never assumed constant.
 *
 * Key functions:
 * - `parseRange()`  DataFast `startAt`/`endAt`/`timezone` query semantics → [startMs, endMs)
 * - `zonedToUtc()`  local wall-clock time in a zone → UTC instant
 * - `localDate()`, `startOfLocalDay()`, `bucketStart()`, `enumerateBuckets()`
 * - `localShiftSql()`/`bucketKeySql()`  SQL expressions that group a ms column into local
 *   hour/day/week/month buckets inside D1, correct across DST transitions
 */
import { ApiError } from "./errors";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export type Interval = "hour" | "day" | "week" | "month";
export const INTERVALS: readonly Interval[] = ["hour", "day", "week", "month"];

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

const validZones = new Map<string, boolean>();

export function isValidTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== "string" || timeZone.length === 0 || timeZone.length > 64) return false;
  const cached = validZones.get(timeZone);
  if (cached !== undefined) return cached;
  let ok: boolean;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    ok = true;
  } catch {
    ok = false;
  }
  validZones.set(timeZone, ok);
  return ok;
}

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** ISO weekday: 1 = Monday ... 7 = Sunday */
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function localParts(utcMs: number, timeZone: string): LocalParts {
  const parts = formatter(timeZone).formatToParts(new Date(utcMs));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: WEEKDAYS[get("weekday")] ?? 1,
  };
}

/** Offset of `timeZone` from UTC at `utcMs`, in ms (positive east of UTC). */
export function tzOffsetMs(utcMs: number, timeZone: string): number {
  if (timeZone === "UTC" || timeZone === "Etc/UTC") return 0;
  const p = localParts(utcMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const truncated = Math.floor(utcMs / 1000) * 1000;
  return asUtc - truncated;
}

export interface WallTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
  ms?: number;
}

/**
 * Convert a local wall-clock time in `timeZone` to a UTC instant.
 * Nonexistent local times (spring-forward gap) resolve forward by the gap length;
 * ambiguous times (fall-back overlap) resolve to the earlier instant.
 */
export function zonedToUtc(t: WallTime, timeZone: string): number {
  const naive = Date.UTC(
    t.year,
    t.month - 1,
    t.day,
    t.hour ?? 0,
    t.minute ?? 0,
    t.second ?? 0,
    t.ms ?? 0,
  );
  if (timeZone === "UTC" || timeZone === "Etc/UTC") return naive;
  const before = tzOffsetMs(naive - DAY_MS, timeZone);
  const candidates = new Set([
    tzOffsetMs(naive, timeZone),
    before,
    tzOffsetMs(naive + DAY_MS, timeZone),
  ]);
  let best: number | undefined;
  for (const offset of candidates) {
    const utc = naive - offset;
    if (utc + tzOffsetMs(utc, timeZone) === naive && (best === undefined || utc < best)) best = utc;
  }
  // No valid mapping: the wall time falls in a spring-forward gap. Shift forward by the gap.
  return best ?? naive - before;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDateString(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function parseDate(value: string): { year: number; month: number; day: number } {
  const m = DATE_RE.exec(value);
  if (!m || !isDateString(value)) throw new ApiError(400, `Invalid date: ${value}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/** `YYYY-MM-DD` of the local calendar day containing `utcMs` in `timeZone`. */
export function localDate(utcMs: number, timeZone: string): string {
  const p = localParts(utcMs, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** UTC instant of local midnight at the start of `date` (`YYYY-MM-DD`) in `timeZone`. */
export function startOfDate(date: string, timeZone: string): number {
  return zonedToUtc(parseDate(date), timeZone);
}

/** Pure calendar arithmetic on `YYYY-MM-DD`. */
export function addDays(date: string, days: number): string {
  const { year, month, day } = parseDate(date);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function startOfLocalDay(utcMs: number, timeZone: string): number {
  return startOfDate(localDate(utcMs, timeZone), timeZone);
}

/** Start (UTC ms) of the local bucket containing `utcMs`. Weeks start on Monday (ISO). */
export function bucketStart(utcMs: number, interval: Interval, timeZone: string): number {
  const p = localParts(utcMs, timeZone);
  switch (interval) {
    case "hour": {
      // Local hour boundaries are the instants where wall-clock minutes are zero. Offsets are whole
      // minutes, so this is exact; it also gives both 01:00 hours on a fall-back day.
      const wall = utcMs + tzOffsetMs(utcMs, timeZone);
      return utcMs - (((wall % HOUR_MS) + HOUR_MS) % HOUR_MS);
    }
    case "day":
      return zonedToUtc({ year: p.year, month: p.month, day: p.day }, timeZone);
    case "week":
      return zonedToUtc({ year: p.year, month: p.month, day: p.day - (p.weekday - 1) }, timeZone);
    case "month":
      return zonedToUtc({ year: p.year, month: p.month, day: 1 }, timeZone);
  }
}

/** Start of the bucket after the one starting at `start`. */
export function nextBucket(start: number, interval: Interval, timeZone: string): number {
  if (interval === "hour") return bucketStart(start + HOUR_MS, "hour", timeZone);
  const p = localParts(start, timeZone);
  if (interval === "day")
    return zonedToUtc({ year: p.year, month: p.month, day: p.day + 1 }, timeZone);
  if (interval === "week")
    return zonedToUtc({ year: p.year, month: p.month, day: p.day + 7 }, timeZone);
  return zonedToUtc({ year: p.year, month: p.month + 1, day: 1 }, timeZone);
}

/** Bucket start instants covering [fromMs, toMs). Throws 400 above `max` buckets. */
export function enumerateBuckets(
  fromMs: number,
  toMs: number,
  interval: Interval,
  timeZone: string,
  max = 5000,
): number[] {
  const out: number[] = [];
  let cur = bucketStart(fromMs, interval, timeZone);
  while (cur < toMs) {
    out.push(cur);
    if (out.length > max)
      throw new ApiError(400, `Too many ${interval} buckets for this date range`);
    cur = nextBucket(cur, interval, timeZone);
  }
  return out;
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

export function toIsoOrNull(ms: number | null | undefined): string | null {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// DataFast date-range semantics
// ---------------------------------------------------------------------------

export interface DateRange {
  /** Inclusive start, UTC ms. */
  startMs: number;
  /** Exclusive end, UTC ms. */
  endMs: number;
  timezone: string;
}

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/;
const ISO_LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

function parseBound(value: string, timeZone: string, edge: "start" | "end"): number {
  if (isDateString(value)) {
    const start = startOfDate(value, timeZone);
    return edge === "start" ? start : startOfDate(addDays(value, 1), timeZone);
  }
  if (ISO_WITH_ZONE.test(value)) {
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) throw new ApiError(400, `Invalid timestamp: ${value}`);
    return edge === "start" ? ms : ms + 1;
  }
  const local = ISO_LOCAL.exec(value);
  if (local) {
    const ms = zonedToUtc(
      {
        year: Number(local[1]),
        month: Number(local[2]),
        day: Number(local[3]),
        hour: Number(local[4]),
        minute: Number(local[5]),
        second: Number(local[6] ?? 0),
        ms: Number((local[7] ?? "0").padEnd(3, "0")),
      },
      timeZone,
    );
    return edge === "start" ? ms : ms + 1;
  }
  throw new ApiError(400, `Invalid date: ${value}. Use YYYY-MM-DD or an ISO 8601 timestamp.`);
}

export interface RangeInput {
  startAt?: string | null | undefined;
  endAt?: string | null | undefined;
  timezone?: string | null | undefined;
}

/**
 * Resolve DataFast's `startAt`/`endAt`/`timezone` parameters.
 *
 * - Both or neither must be given (400 otherwise).
 * - `YYYY-MM-DD` covers whole local days: start at local midnight of `startAt`, end at local
 *   midnight after `endAt` (exclusive).
 * - ISO timestamps with `Z` or an offset keep their exact instants (the end is inclusive,
 *   so endMs = endAt + 1 ms). ISO timestamps without a zone are read in `timezone`.
 * - `timezone` defaults to the site timezone.
 * - Returns `null` for "all time" when neither bound is given and no default is supplied.
 */
export function parseRange(
  input: RangeInput,
  siteTimezone: string,
  defaultRange?: (timezone: string, nowMs: number) => DateRange,
  nowMs: number = Date.now(),
): DateRange | null {
  const timezone = input.timezone || siteTimezone;
  if (!isValidTimeZone(timezone)) throw new ApiError(400, `Invalid timezone: ${timezone}`);
  const hasStart = Boolean(input.startAt);
  const hasEnd = Boolean(input.endAt);
  if (hasStart !== hasEnd) throw new ApiError(400, "startAt and endAt must be provided together");
  if (!hasStart) return defaultRange ? defaultRange(timezone, nowMs) : null;
  const startMs = parseBound(input.startAt as string, timezone, "start");
  const endMs = parseBound(input.endAt as string, timezone, "end");
  if (endMs <= startMs) throw new ApiError(400, "endAt must be after startAt");
  return { startMs, endMs, timezone };
}

/** The last `days` calendar days including today, in `timezone`. */
export function lastNDays(days: number, timezone: string, nowMs: number = Date.now()): DateRange {
  const today = localDate(nowMs, timezone);
  return {
    startMs: startOfDate(addDays(today, -(days - 1)), timezone),
    endMs: startOfDate(addDays(today, 1), timezone),
    timezone,
  };
}

/** The previous period of equal length, for KPI comparisons. */
export function previousPeriod(range: DateRange): DateRange {
  const length = range.endMs - range.startMs;
  return { startMs: range.startMs - length, endMs: range.startMs, timezone: range.timezone };
}

// ---------------------------------------------------------------------------
// SQL bucketing (DST-safe, evaluated inside D1)
// ---------------------------------------------------------------------------

/** Offset changes of `timeZone` within [fromMs, toMs): `[{at, offset}]`, first entry at fromMs. */
export function offsetSegments(
  fromMs: number,
  toMs: number,
  timeZone: string,
): Array<{ at: number; offset: number }> {
  const segments = [{ at: fromMs, offset: tzOffsetMs(fromMs, timeZone) }];
  if (timeZone === "UTC" || timeZone === "Etc/UTC") return segments;
  const step = 6 * HOUR_MS;
  let prevT = fromMs;
  let prevO = segments[0]?.offset ?? 0;
  for (let t = fromMs + step; t < toMs + step; t += step) {
    const probe = Math.min(t, toMs);
    const o = tzOffsetMs(probe, timeZone);
    if (o !== prevO) {
      // Binary search the transition instant to the millisecond.
      let lo = prevT;
      let hi = probe;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (tzOffsetMs(mid, timeZone) === prevO) lo = mid;
        else hi = mid;
      }
      segments.push({ at: hi, offset: o });
      prevO = o;
    }
    prevT = probe;
    if (probe >= toMs) break;
  }
  return segments;
}

/**
 * SQL expression for "local wall-clock ms" of an epoch-ms column: `column + offset(column)`.
 * Offsets are inlined integer literals (no bound parameters), one CASE arm per DST transition.
 * `column` must be a trusted SQL identifier such as `s.started_at`.
 */
export function localShiftSql(
  column: string,
  timeZone: string,
  fromMs: number,
  toMs: number,
): string {
  if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i.test(column)) {
    throw new Error(`Unsafe SQL column: ${column}`);
  }
  const segs = offsetSegments(fromMs, toMs, timeZone);
  if (segs.length === 1) return `(${column} + ${segs[0]?.offset ?? 0})`;
  const arms = segs
    .slice(1)
    .map((s, i) => `WHEN ${column} < ${s.at} THEN ${segs[i]?.offset ?? 0}`)
    .join(" ");
  return `(${column} + CASE ${arms} ELSE ${segs[segs.length - 1]?.offset ?? 0} END)`;
}

/**
 * SQL expression returning an integer/text bucket key for `column`, plus a function mapping a key
 * back to the bucket's UTC start instant. Use with `GROUP BY 1`.
 *
 *   hour:  local hours since epoch     day: local days since epoch
 *   week:  ISO weeks (Monday start)    month: 'YYYY-MM'
 */
export function bucketKeySql(
  column: string,
  interval: Interval,
  timeZone: string,
  fromMs: number,
  toMs: number,
): { sql: string; keyToStart: (key: number | string) => number } {
  const shifted = localShiftSql(column, timeZone, fromMs, toMs);
  switch (interval) {
    case "hour":
      return {
        sql: `(${shifted} / ${HOUR_MS})`,
        keyToStart: (key) => {
          const wall = new Date(Number(key) * HOUR_MS);
          return zonedToUtc(
            {
              year: wall.getUTCFullYear(),
              month: wall.getUTCMonth() + 1,
              day: wall.getUTCDate(),
              hour: wall.getUTCHours(),
            },
            timeZone,
          );
        },
      };
    case "day":
      return {
        sql: `(${shifted} / ${DAY_MS})`,
        keyToStart: (key) =>
          startOfDate(new Date(Number(key) * DAY_MS).toISOString().slice(0, 10), timeZone),
      };
    case "week":
      // 1970-01-01 was a Thursday; +3 days aligns week boundaries to Mondays.
      return {
        sql: `((${shifted} / ${DAY_MS} + 3) / 7)`,
        keyToStart: (key) =>
          startOfDate(
            new Date((Number(key) * 7 - 3) * DAY_MS).toISOString().slice(0, 10),
            timeZone,
          ),
      };
    case "month":
      return {
        sql: `strftime('%Y-%m', ${shifted} / 1000, 'unixepoch')`,
        keyToStart: (key) => startOfDate(`${String(key)}-01`, timeZone),
      };
  }
}
