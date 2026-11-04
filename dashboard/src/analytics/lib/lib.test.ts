import { describe, expect, it } from "vitest";
import { buildHeatmap } from "../components/ActivityHeatmap";
import { bucketIndex, METRICS, niceTicks } from "./chart";
import { likelihoodColor } from "./colors";
import {
  filtersFromSearch,
  filtersToParams,
  parseFilterValue,
  upsertFilter,
  visitorListParams,
} from "./filters";
import { delta, flagEmoji, formatDuration, formatMoney } from "./format";
import { NUMERIC_TO_ALPHA2 } from "./geo";
import { randomVisitorName, visitorName } from "./names";
import {
  allowedIntervals,
  defaultInterval,
  previousRange,
  resolvePeriod,
  shiftPeriod,
} from "./period";
import { addDays, addMonths, diffDays, endOfMonth, weekdayOf, ymdInTz } from "./tz";

// 2026-11-04 12:00 UTC = 07:00 in New York
const NOW = Date.UTC(2026, 10, 4, 12, 0);
const NY = "America/New_York";

describe("tz helpers", () => {
  it("does calendar arithmetic on local days", () => {
    expect(ymdInTz(Date.UTC(2026, 10, 4, 3, 0), NY)).toBe("2026-11-03");
    expect(ymdInTz(Date.UTC(2026, 10, 4, 3, 0), "Europe/Paris")).toBe("2026-11-04");
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09"); // DST day in New York
    expect(diffDays("2026-10-06", "2026-11-04")).toBe(29);
    expect(endOfMonth("2024-02-10")).toBe("2024-02-29");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-01");
    expect(weekdayOf("2026-11-02")).toBe(0); // Monday
  });
});

describe("periods", () => {
  it("resolves presets to local days or instants", () => {
    expect(resolvePeriod({ key: "today" }, NY, NOW)).toMatchObject({
      startAt: "2026-11-04",
      endAt: "2026-11-04",
      days: 1,
    });
    expect(resolvePeriod({ key: "30d" }, NY, NOW)).toMatchObject({
      startAt: "2026-10-06",
      endAt: "2026-11-04",
      days: 30,
    });
    expect(resolvePeriod({ key: "lastmonth" }, NY, NOW)).toMatchObject({
      startAt: "2026-10-01",
      endAt: "2026-10-31",
    });
    expect(resolvePeriod({ key: "mtd" }, NY, NOW).startAt).toBe("2026-11-01");
    expect(resolvePeriod({ key: "ytd" }, NY, NOW).startAt).toBe("2026-01-01");
    const now = resolvePeriod({ key: "now" }, NY, NOW);
    expect(now.kind).toBe("instant");
    expect(now.endMs - now.startMs).toBe(30 * 60_000);
    expect(resolvePeriod({ key: "all" }, NY, NOW, "2026-01-01").startAt).toBe("2026-01-01");
    expect(resolvePeriod({ key: "all" }, NY, NOW).startAt).toBeUndefined();
    expect(
      resolvePeriod({ key: "custom", from: "2026-10-20", to: "2026-10-10" }, NY, NOW),
    ).toMatchObject({ startAt: "2026-10-10", endAt: "2026-10-20", label: "Oct 10 – Oct 20, 2026" });
  });

  it("computes the previous period", () => {
    const r = resolvePeriod({ key: "7d" }, NY, NOW);
    expect(previousRange(r, { key: "7d" })).toMatchObject({
      startAt: "2026-10-22",
      endAt: "2026-10-28",
    });
    const lm = resolvePeriod({ key: "lastmonth" }, NY, NOW);
    expect(previousRange(lm, { key: "lastmonth" })).toMatchObject({
      startAt: "2026-09-01",
      endAt: "2026-09-30",
    });
    const h = resolvePeriod({ key: "24h" }, NY, NOW);
    expect(previousRange(h, { key: "24h" })?.endMs).toBe(h.startMs);
    expect(previousRange(resolvePeriod({ key: "all" }, NY, NOW), { key: "all" })).toBeNull();
  });

  it("hops back and forward by the period length, never past today", () => {
    const r = resolvePeriod({ key: "7d" }, NY, NOW);
    expect(shiftPeriod({ key: "7d" }, r, -1, NY, NOW)).toEqual({
      key: "custom",
      from: "2026-10-22",
      to: "2026-10-28",
    });
    expect(shiftPeriod({ key: "7d" }, r, 1, NY, NOW)).toBeNull();
    const today = resolvePeriod({ key: "today" }, NY, NOW);
    expect(shiftPeriod({ key: "today" }, today, -1, NY, NOW)).toEqual({ key: "yesterday" });
    const lm = resolvePeriod({ key: "lastmonth" }, NY, NOW);
    expect(shiftPeriod({ key: "lastmonth" }, lm, 1, NY, NOW)).toEqual({
      key: "custom",
      from: "2026-11-01",
      to: "2026-11-04",
    });
    expect(
      shiftPeriod({ key: "now" }, resolvePeriod({ key: "now" }, NY, NOW), -1, NY, NOW),
    ).toBeNull();
  });

  it("picks a granularity that fits the range", () => {
    expect(defaultInterval(resolvePeriod({ key: "now" }, NY, NOW))).toBe("minute");
    expect(defaultInterval(resolvePeriod({ key: "today" }, NY, NOW))).toBe("hour");
    expect(defaultInterval(resolvePeriod({ key: "30d" }, NY, NOW))).toBe("day");
    expect(defaultInterval(resolvePeriod({ key: "12m" }, NY, NOW))).toBe("week");
    expect(allowedIntervals(resolvePeriod({ key: "7d" }, NY, NOW))).toEqual([
      "hour",
      "day",
      "week",
    ]);
    expect(allowedIntervals(resolvePeriod({ key: "90d" }, NY, NOW))).toEqual(["day", "week"]);
  });
});

describe("filters", () => {
  it("parses and serialises the API value syntax", () => {
    expect(parseFilterValue("is_not:US,DE")).toEqual({ op: "is_not", values: ["US", "DE"] });
    expect(parseFilterValue("Google")).toEqual({ op: "is", values: ["Google"] });
    expect(parseFilterValue("gte:2")).toEqual({ op: "gte", values: ["2"] });
    expect(parseFilterValue("contains:/pricing")).toEqual({ op: "contains", values: ["/pricing"] });
    const f = filtersFromSearch({
      filter_country: "is:US",
      filter_visit_count: "gte:2",
      other: 1,
      filter_bogus: "x",
    });
    expect(f).toEqual([
      { key: "country", op: "is", values: ["US"] },
      { key: "visit_count", op: "gte", values: ["2"] },
    ]);
    expect(filtersToParams(f)).toEqual({ filter_country: "is:US", filter_visit_count: "gte:2" });
  });

  it("keeps one filter per dimension", () => {
    const next = upsertFilter([{ key: "country", op: "is", values: ["US"] }], {
      key: "country",
      op: "is_not",
      values: ["FR"],
    });
    expect(next).toEqual([{ key: "country", op: "is_not", values: ["FR"] }]);
  });

  it("maps exact filters onto visitor-list parameters", () => {
    const { params, unsupported } = visitorListParams([
      { key: "country", op: "is", values: ["US"] },
      { key: "page", op: "contains", values: ["/docs"] },
      { key: "goal", op: "is", values: ["signup"] },
      { key: "referrer", op: "is_not", values: ["Google"] },
    ]);
    expect(params).toEqual({
      country: "US",
      visitedPageContains: "/docs",
      completedGoal: "signup",
    });
    expect(unsupported).toHaveLength(1);
  });
});

describe("formatting and charts", () => {
  it("formats values", () => {
    expect(formatDuration(68)).toBe("1m 08s");
    expect(formatDuration(42)).toBe("42s");
    expect(formatMoney(28450, "USD")).toBe("$28,450");
    expect(formatMoney(2.29, "USD")).toBe("$2.29");
    expect(formatMoney(1000, "JPY")).toBe("¥1,000");
    expect(delta(110, 100)).toBeCloseTo(10);
    expect(delta(5, 0)).toBeNull();
    expect(delta(0, 0)).toBe(0);
    expect(flagEmoji("US")).toBe("🇺🇸");
  });

  it("makes nice ticks and finds buckets", () => {
    expect(niceTicks(870)).toEqual([0, 250, 500, 750, 1000]);
    expect(niceTicks(0)).toEqual([0, 1]);
    const pts = [{ timestamp: "2026-10-01T00:00:00Z" }, { timestamp: "2026-10-02T00:00:00Z" }];
    expect(bucketIndex(pts, Date.parse("2026-10-01T15:00:00Z"))).toBe(0);
    expect(bucketIndex(pts, Date.parse("2026-10-03T15:00:00Z"))).toBe(1);
    expect(bucketIndex(pts, Date.parse("2026-09-30T15:00:00Z"))).toBe(-1);
    expect(METRICS.revenue_per_visitor?.value({ timestamp: "", revenue: 50, visitors: 20 })).toBe(
      2.5,
    );
  });

  it("buckets hourly points into a weekday × hour grid", () => {
    const grid = buildHeatmap(
      [
        { timestamp: "2026-11-02T14:00:00Z", visitors: 5 }, // Mon 9am New York
        { timestamp: "2026-11-09T14:00:00Z", visitors: 3 },
      ],
      NY,
      "visitors",
    );
    expect(grid[0]?.[9]).toBe(8);
  });

  it("keeps avatar initials (#171717) at AA contrast on every likelihood colour", () => {
    const lum = (rgb: number[]) =>
      rgb
        .map((c) => c / 255)
        .map((s) => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4))
        .reduce((a, v, i) => a + v * ([0.2126, 0.7152, 0.0722][i] ?? 0), 0);
    const text = lum([23, 23, 23]);
    for (let s = 0; s <= 100; s += 5) {
      const bg = likelihoodColor(s).match(/\d+/g)?.map(Number) ?? [];
      expect((lum(bg) + 0.05) / (text + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("names visitors and colours likelihood", () => {
    expect(randomVisitorName("abc")).toBe(randomVisitorName("abc"));
    expect(visitorName("abc", "Maya", "u1")).toBe("Maya");
    expect(visitorName("abc", null, "u1")).toBe("u1");
    expect(likelihoodColor(0)).toBe("rgb(141, 205, 255)");
    expect(likelihoodColor(100)).toBe("rgb(255, 88, 97)");
    expect(NUMERIC_TO_ALPHA2["840"]).toBe("US");
    expect(NUMERIC_TO_ALPHA2["276"]).toBe("DE");
  });
});
