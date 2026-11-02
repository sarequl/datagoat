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
