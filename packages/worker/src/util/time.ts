/** Formats a unix-seconds timestamp as YYYY-MM-DD in an IANA timezone. */
export function dayBucket(ts: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(ts * 1000));
  } catch {
    return new Date(ts * 1000).toISOString().slice(0, 10);
  }
}

/** Hour of day (0-23) in an IANA timezone, used for peak-hour aggregates. */
export function hourBucket(ts: number, timeZone: string): string {
  try {
    return String(
      Number(
        new Intl.DateTimeFormat('en-US', {
          timeZone,
          hour: '2-digit',
          hour12: false,
        }).format(new Date(ts * 1000)),
      ),
    );
  } catch {
    return String(new Date(ts * 1000).getUTCHours());
  }
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock parts of a unix-seconds timestamp in an IANA timezone. */
export function localParts(ts: number, timeZone: string): LocalParts {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(new Date(ts * 1000));
    const get = (type: string): number => {
      const part = parts.find((candidate) => candidate.type === type);
      return part ? Number(part.value) : 0;
    };
    return {
      year: get('year'),
      month: get('month'),
      day: get('day'),
      hour: get('hour') % 24,
      minute: get('minute'),
      second: get('second'),
    };
  } catch {
    const date = new Date(ts * 1000);
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
      second: date.getUTCSeconds(),
    };
  }
}

/**
 * Converts a wall-clock date in `timeZone` at local midnight to a unix-seconds
 * UTC timestamp. Two offset passes keep DST transition days correct.
 */
export function zonedLocalMidnightToUtc(
  year: number,
  month: number,
  day: number,
  timeZone: string,
): number {
  // Work in milliseconds internally; localParts() and callers use seconds.
  const guessMs = Date.UTC(year, month - 1, day, 0, 0, 0);
  const first = localParts(guessMs / 1000, timeZone);
  const firstOffset =
    Date.UTC(first.year, first.month - 1, first.day, first.hour, first.minute, first.second) -
    guessMs;
  const resultMs = guessMs - firstOffset;
  const second = localParts(resultMs / 1000, timeZone);
  const secondOffset =
    Date.UTC(second.year, second.month - 1, second.day, second.hour, second.minute, second.second) -
    resultMs;
  return Math.floor((guessMs - secondOffset) / 1000);
}

/** True when `timeZone` is an IANA zone the runtime can format. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/**
 * Parses a date bound. `YYYY-MM-DD` is interpreted in `timeZone` (the end bound
 * covers the whole local day); ISO timestamps are parsed as-is. Returns unix
 * seconds, or null when the value is invalid.
 */
export function parseDateBound(value: string, timeZone: string, end: boolean): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    if (end) {
      return zonedLocalMidnightToUtc(year, month, day + 1, timeZone) - 1;
    }
    return zonedLocalMidnightToUtc(year, month, day, timeZone);
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return Math.floor(parsed.getTime() / 1000);
}
