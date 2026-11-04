import { describe, expect, it } from "vitest";
import type { Overview } from "./api";
import { bucketLabel, buildChart } from "./chart";
import { delta, formatCount, formatDuration, formatMoney, formatPercent } from "./format";
import { buildKpis } from "./kpis";
import {
  DEFAULT_PREFERENCES,
  preferencesOf,
  registrationBody,
  routeForNotification,
  toggleMuted,
} from "./notifications";
import { addDays, localDate, periodFor } from "./periods";
import { buildWidgetSnapshot } from "./widget";

const overview = (o: Partial<Overview>): Overview => ({
  visitors: 0,
  sessions: 0,
  pageviews: 0,
  bounce_rate: 0,
  avg_session_duration: 0,
  currency: "USD",
  revenue: 0,
  payments: 0,
  revenue_per_visitor: 0,
  conversion_rate: 0,
  ...o,
});

describe("periods", () => {
  // 2026-11-04 23:30 UTC is already 2026-11-05 in Tokyo and still 2026-11-04 in New York.
  const now = new Date("2026-11-04T23:30:00Z");

  it("uses the site's calendar date", () => {
    expect(localDate(now, "Asia/Tokyo")).toBe("2026-11-05");
    expect(localDate(now, "America/New_York")).toBe("2026-11-04");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("builds ranges, previous periods and intervals", () => {
    expect(periodFor("today", "Asia/Tokyo", now)).toEqual({
      key: "today",
      range: { startAt: "2026-11-05", endAt: "2026-11-05", timezone: "Asia/Tokyo" },
      previous: { startAt: "2026-11-04", endAt: "2026-11-04", timezone: "Asia/Tokyo" },
      interval: "hour",
    });
    expect(periodFor("yesterday", "UTC", now).range.startAt).toBe("2026-11-03");
    const week = periodFor("7d", "UTC", now);
    expect(week.range).toMatchObject({ startAt: "2026-10-29", endAt: "2026-11-04" });
    expect(week.previous).toMatchObject({ startAt: "2026-10-22", endAt: "2026-10-28" });
    expect(week.interval).toBe("day");
    const month = periodFor("30d", "UTC", now);
    expect(month.range.startAt).toBe("2026-10-06");
    expect(month.previous).toMatchObject({ startAt: "2026-09-06", endAt: "2026-10-05" });
    const year = periodFor("12m", "UTC", now);
    expect(year.range).toMatchObject({ startAt: "2025-12-01", endAt: "2026-11-04" });
    expect(year.previous).toMatchObject({ startAt: "2024-12-01", endAt: "2025-11-30" });
    expect(year.interval).toBe("month");
  });
});

describe("format", () => {
  it("formats counts, money, percentages and durations", () => {
    expect(formatCount(950)).toBe("950");
    expect(formatCount(9999)).toBe("9,999");
    expect(formatCount(12_345)).toBe("12.3k");
    expect(formatCount(2_500_000)).toBe("2.5M");
    expect(formatMoney(49, "USD")).toBe("$49.00");
    expect(formatMoney(12_345, "EUR", true)).toBe("€12.3K");
    expect(formatMoney(5, "XXX_BAD")).toBe("5.00 XXX_BAD");
    expect(formatPercent(42.456)).toBe("42.5%");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(192)).toBe("3m 12s");
    expect(formatDuration(3900)).toBe("1h 05m");
  });

  it("computes deltas, including when lower is better", () => {
    expect(delta(120, 100)).toEqual({ percent: 20, direction: "up", good: true, label: "+20%" });
    expect(delta(80, 100, false)).toEqual({
      percent: -20,
      direction: "down",
      good: true,
      label: "-20%",
    });
    expect(delta(5, 0)).toEqual({ percent: null, direction: "up", good: true, label: "new" });
    expect(delta(0, 0).direction).toBe("flat");
  });
});

describe("kpis", () => {
  it("builds the six tiles with comparisons", () => {
    const tiles = buildKpis(
      overview({
        visitors: 200,
        revenue: 300,
        conversion_rate: 2,
        revenue_per_visitor: 1.5,
        bounce_rate: 40,
        avg_session_duration: 75,
        currency: "EUR",
      }),
      overview({
        visitors: 100,
        revenue: 300,
        conversion_rate: 1,
        revenue_per_visitor: 3,
        bounce_rate: 50,
        avg_session_duration: 60,
      }),
    );
    expect(tiles.map((t) => [t.label, t.value, t.delta?.label])).toEqual([
      ["Visitors", "200", "+100%"],
      ["Revenue", "€300.00", "0%"],
      ["Conversion", "2%", "+100%"],
      ["Revenue/visitor", "€1.50", "-50%"],
      ["Bounce rate", "40%", "-20%"],
      ["Session time", "1m 15s", "+25%"],
    ]);
    expect(tiles[4]?.delta?.good).toBe(true);
    expect(buildKpis(overview({}), null)[0]?.delta).toBeNull();
  });
});

describe("chart", () => {
  it("scales the visitors line and revenue bars into the box", () => {
    const g = buildChart(
      [
        { timestamp: "a", name: "2026-11-04 00:00", visitors: 0, revenue: 0 },
        { timestamp: "b", name: "2026-11-04 01:00", visitors: 5, revenue: 10 },
        { timestamp: "c", name: "2026-11-04 02:00", visitors: 10, revenue: 20 },
      ],
      "hour",
      200,
      100,
      3,
    );
    expect(g.maxVisitors).toBe(10);
    expect(g.linePath).toBe("M0 100 L100 50 L200 0");
    expect(g.areaPath).toBe("M0 100 L100 50 L200 0 L200 100 L0 100 Z");
    expect(g.bars.map((b) => b.height)).toEqual([0, 25, 50]);
    expect(g.labels.map((l) => l.text)).toEqual(["00:00", "01:00", "02:00"]);
    const empty = buildChart([], "day", 200, 100);
    expect(empty.linePath).toBe("");
    expect(empty.bars).toEqual([]);
  });

  it("labels days and months", () => {
    expect(bucketLabel({ timestamp: "x", name: "2026-11-04" }, "day")).toBe("4 Nov");
    expect(bucketLabel({ timestamp: "x", name: "2026-11" }, "month")).toBe("Nov");
  });
});

describe("notifications", () => {
  it("routes sale and alert pushes to the site and ignores anything else", () => {
    expect(routeForNotification({ type: "sale", websiteId: "64f0c0ffee" })).toBe(
      "/site/64f0c0ffee",
    );
    expect(routeForNotification({ type: "alert", websiteId: "abc" })).toBe("/site/abc");
    expect(routeForNotification({ type: "other", websiteId: "abc" })).toBeNull();
    expect(routeForNotification({ type: "sale", websiteId: "../../x" })).toBeNull();
    expect(routeForNotification(null)).toBeNull();
  });

  it("toggles muted sites and builds the registration body", () => {
    const muted = toggleMuted(DEFAULT_PREFERENCES, "s1");
    expect(muted.mutedSiteIds).toEqual(["s1"]);
    expect(toggleMuted(muted, "s1").mutedSiteIds).toEqual([]);
    expect(preferencesOf(null)).toEqual(DEFAULT_PREFERENCES);
    expect(registrationBody("ExponentPushToken[a]", "ios", "iPhone", muted)).toEqual({
      pushToken: "ExponentPushToken[a]",
      platform: "ios",
      name: "iPhone",
      notifySales: true,
      notifyAlerts: true,
      mutedSiteIds: ["s1"],
    });
  });
});

describe("widget snapshot", () => {
  it("keeps at most six sites with display strings, under 2 KB", () => {
    const sites = Array.from({ length: 12 }, (_, i) => ({
      id: `s${i}`,
      name: `Site ${i}`,
      visitorsToday: 12_400,
      revenueToday: 99,
      currency: "USD",
      live: 3,
    }));
    const snap = buildWidgetSnapshot(sites, new Date("2026-11-04T10:00:00Z"));
    expect(snap.version).toBe(1);
    expect(snap.updatedAt).toBe("2026-11-04T10:00:00.000Z");
    expect(snap.sites).toHaveLength(6);
    expect(JSON.stringify(snap).length).toBeLessThan(2048);
    expect(snap.sites[0]?.display).toEqual({ visitors: "12.4k", revenue: "$99.00", live: "3" });
  });
});
