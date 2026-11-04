import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../../src/lib/errors";
import {
  addDays,
  bucketKeySql,
  bucketStart,
  enumerateBuckets,
  isValidTimeZone,
  lastNDays,
  localDate,
  nextBucket,
  offsetSegments,
  parseRange,
  previousPeriod,
  startOfDate,
  tzOffsetMs,
  zonedToUtc,
} from "../../../src/lib/time";

const NY = "America/New_York";
const iso = (ms: number) => new Date(ms).toISOString();

describe("timezones", () => {
  it("validates IANA zones", () => {
    expect(isValidTimeZone("Europe/Paris")).toBe(true);
    expect(isValidTimeZone("Mars/Base")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });

  it("computes offsets across DST", () => {
    expect(tzOffsetMs(Date.UTC(2026, 0, 15), NY)).toBe(-5 * 3600_000);
    expect(tzOffsetMs(Date.UTC(2026, 6, 15), NY)).toBe(-4 * 3600_000);
    expect(tzOffsetMs(Date.UTC(2026, 6, 15), "Asia/Kolkata")).toBe(5.5 * 3600_000);
  });

  it("converts wall time to UTC, including gaps and overlaps", () => {
    expect(iso(zonedToUtc({ year: 2026, month: 1, day: 15, hour: 9 }, NY))).toBe(
      "2026-01-15T14:00:00.000Z",
    );
    // 2026-03-08 02:30 does not exist in New York: shifted forward to 03:30 EDT.
    expect(iso(zonedToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, NY))).toBe(
      "2026-03-08T07:30:00.000Z",
    );
    // 2026-11-01 01:30 happens twice: the earlier (EDT) instant wins.
    expect(iso(zonedToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, NY))).toBe(
      "2026-11-01T05:30:00.000Z",
    );
    // Day overflow is normalised.
    expect(iso(zonedToUtc({ year: 2026, month: 1, day: 32 }, "UTC"))).toBe(
      "2026-02-01T00:00:00.000Z",
    );
  });

  it("finds local dates and day starts", () => {
    expect(localDate(Date.UTC(2026, 0, 1, 3), NY)).toBe("2025-12-31");
    expect(iso(startOfDate("2026-03-08", NY))).toBe("2026-03-08T05:00:00.000Z");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });

  it("has 23- and 25-hour days at DST transitions", () => {
    const spring = enumerateBuckets(
      startOfDate("2026-03-08", NY),
      startOfDate("2026-03-09", NY),
      "hour",
      NY,
    );
    const fall = enumerateBuckets(
      startOfDate("2026-11-01", NY),
      startOfDate("2026-11-02", NY),
      "hour",
      NY,
    );
    expect(spring).toHaveLength(23);
    expect(fall).toHaveLength(25);
  });

  it("starts weeks on Monday and months on the 1st, in local time", () => {
    const wed = Date.UTC(2026, 10, 4, 12);
    expect(iso(bucketStart(wed, "week", "UTC"))).toBe("2026-11-02T00:00:00.000Z");
    expect(iso(bucketStart(wed, "month", "Europe/Paris"))).toBe("2026-10-31T23:00:00.000Z");
    expect(iso(nextBucket(bucketStart(wed, "month", "UTC"), "month", "UTC"))).toBe(
      "2026-12-01T00:00:00.000Z",
    );
    expect(iso(bucketStart(Date.UTC(2026, 6, 1, 10, 45), "hour", "Asia/Kolkata"))).toBe(
      "2026-07-01T10:30:00.000Z",
    );
  });

  it("caps bucket enumeration", () => {
    expect(() => enumerateBuckets(0, 10 * 86_400_000, "hour", "UTC", 100)).toThrow(ApiError);
  });
});

describe("parseRange (DataFast startAt/endAt semantics)", () => {
  it("treats dates as whole local days, end inclusive", () => {
    const r = parseRange({ startAt: "2026-05-01", endAt: "2026-05-01" }, NY);
    expect(r && iso(r.startMs)).toBe("2026-05-01T04:00:00.000Z");
    expect(r && iso(r.endMs)).toBe("2026-05-02T04:00:00.000Z");
  });

  it("keeps exact ISO instants and makes the end inclusive", () => {
    const r = parseRange(
      { startAt: "2026-05-01T10:00:00Z", endAt: "2026-05-01T11:00:00+01:00" },
      "UTC",
    );
    expect(r?.startMs).toBe(Date.UTC(2026, 4, 1, 10));
    expect(r?.endMs).toBe(Date.UTC(2026, 4, 1, 10) + 1);
  });

  it("reads zone-less timestamps in the requested timezone", () => {
    const r = parseRange(
      { startAt: "2026-05-01T09:00", endAt: "2026-05-01T10:00", timezone: "Europe/Paris" },
      "UTC",
    );
    expect(r && iso(r.startMs)).toBe("2026-05-01T07:00:00.000Z");
    expect(r?.timezone).toBe("Europe/Paris");
  });

  it("returns null for all time, or the default range", () => {
    expect(parseRange({}, "UTC")).toBeNull();
    const now = Date.UTC(2026, 10, 4, 12);
    const r = parseRange({}, "UTC", (tz, n) => lastNDays(30, tz, n), now);
    expect(r && iso(r.startMs)).toBe("2026-10-06T00:00:00.000Z");
    expect(r && iso(r.endMs)).toBe("2026-11-05T00:00:00.000Z");
  });

  it("rejects partial, invalid and inverted ranges", () => {
    expect(() => parseRange({ startAt: "2026-05-01" }, "UTC")).toThrow("together");
    expect(() => parseRange({ startAt: "2026-02-30", endAt: "2026-03-01" }, "UTC")).toThrow(
      "Invalid date",
    );
    expect(() => parseRange({ startAt: "yesterday", endAt: "today" }, "UTC")).toThrow();
    expect(() => parseRange({ startAt: "2026-05-02", endAt: "2026-05-01" }, "UTC")).toThrow(
      "after",
    );
    expect(() =>
      parseRange({ startAt: "2026-05-01", endAt: "2026-05-02", timezone: "Nope/Zone" }, "UTC"),
    ).toThrow("timezone");
  });

  it("computes the previous period", () => {
    const r = { startMs: 100, endMs: 200, timezone: "UTC" };
    expect(previousPeriod(r)).toEqual({ startMs: 0, endMs: 100, timezone: "UTC" });
  });
});

describe("SQL bucketing inside D1", () => {
  it("finds DST transitions", () => {
    const segs = offsetSegments(Date.UTC(2026, 0, 1), Date.UTC(2027, 0, 1), NY);
    expect(segs.map((s) => iso(s.at))).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-03-08T07:00:00.000Z",
      "2026-11-01T06:00:00.000Z",
    ]);
  });

  it("groups timestamps into the same local days as the JS reference", async () => {
    const from = startOfDate("2026-03-06", NY);
    const to = startOfDate("2026-03-11", NY);
    const stamps: number[] = [];
    for (let t = from; t < to; t += 47 * 60_000) stamps.push(t);
    for (const interval of ["hour", "day", "week", "month"] as const) {
      const { sql, keyToStart } = bucketKeySql("t.ts", interval, NY, from, to);
      const values = stamps.map((s) => `(${s})`).join(",");
      const res = await env.DB.prepare(
        `WITH t(ts) AS (VALUES ${values}) SELECT ${sql} AS k, MIN(ts) AS first, COUNT(*) AS n FROM t GROUP BY 1 ORDER BY 1`,
      ).all<{ k: number | string; first: number; n: number }>();
      for (const row of res.results ?? []) {
        expect(keyToStart(row.k), `${interval} ${row.k}`).toBe(
          bucketStart(row.first, interval, NY),
        );
      }
      const expected = new Set(stamps.map((s) => bucketStart(s, interval, NY))).size;
      expect(res.results).toHaveLength(expected);
    }
  });

  it("rejects unsafe column expressions", () => {
    expect(() => bucketKeySql("ts; DROP TABLE x", "day", "UTC", 0, 1)).toThrow();
  });
});
