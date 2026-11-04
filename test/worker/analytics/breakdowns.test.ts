import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "../../helpers/db";
import { api } from "../../helpers/http";
import { limitedToken, RANGE, seedFixture } from "./fixture";

beforeEach(() => resetDb());

async function get(path: string, key: string) {
  const res = await api(path, { token: key });
  if (res.status !== 200) throw new Error(`${path}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

describe("session-dimension breakdowns", () => {
  it("referrers: source name, else domain, else Direct / None, with attributed revenue", async () => {
    const f = await seedFixture();
    const body = await get(`/api/v1/analytics/referrers?${RANGE}`, f.key);
    expect(body.data).toEqual([
      { referrer: "Direct / None", visitors: 2, revenue: 10, payments: 1 },
      { referrer: "Google", visitors: 1, revenue: 49.99, payments: 1 },
      { referrer: "X", visitors: 1, revenue: 0, payments: 0 },
    ]);
    expect(body.pagination).toEqual({ limit: 100, offset: 0, total: 3, hasMore: false });
  });

  it("paginates with limit and offset", async () => {
    const f = await seedFixture();
    const body = await get(`/api/v1/analytics/referrers?${RANGE}&limit=1&offset=1`, f.key);
    expect(body.data).toEqual([{ referrer: "Google", visitors: 1, revenue: 49.99, payments: 1 }]);
    expect(body.pagination).toEqual({ limit: 1, offset: 1, total: 3, hasMore: true });
    const beyond = await get(`/api/v1/analytics/referrers?${RANGE}&limit=10&offset=10`, f.key);
    expect(beyond.data).toEqual([]);
    expect(beyond.pagination.total).toBe(3);
  });

  it("channels, devices, browsers (Mobile Safari merged), operating systems, hostnames", async () => {
    const f = await seedFixture();
    const channels = await get(
      `/api/v1/analytics/channels?${RANGE}&fields=channel,visitors`,
      f.key,
    );
    expect(channels.data).toEqual([
      { channel: "Direct", visitors: 1 },
      { channel: "Email", visitors: 1 },
      { channel: "Organic Search", visitors: 1 },
      { channel: "Organic Social", visitors: 1 },
    ]);
    const devices = await get(`/api/v1/analytics/devices?${RANGE}`, f.key);
    expect(devices.data.map((r: { device: string }) => r.device)).toEqual([
      "desktop",
      "mobile",
      "tablet",
    ]);
    const browsers = await get(`/api/v1/analytics/browsers?${RANGE}`, f.key);
    expect(browsers.data).toContainEqual({
      browser: "Safari",
      visitors: 1,
      revenue: 0,
      payments: 0,
    });
    expect(browsers.data.some((r: { browser: string }) => r.browser === "Mobile Safari")).toBe(
      false,
    );
    const os = await get(`/api/v1/analytics/operating-systems?${RANGE}`, f.key);
    expect(os.data[0]).toHaveProperty("operating_system");
    const hosts = await get(`/api/v1/analytics/hostnames?${RANGE}`, f.key);
    expect(hosts.data).toEqual([
      { hostname: "example.com", visitors: 3, revenue: 59.99, payments: 2 },
    ]);
  });

  it("countries return English names, flag emoji and the ISO code", async () => {
    const f = await seedFixture();
    const body = await get(`/api/v1/analytics/countries?${RANGE}`, f.key);
    expect(body.data).toEqual([
      { country: "Germany", image: "🇩🇪", code: "DE", visitors: 1, revenue: 10, payments: 1 },
      { country: "France", image: "🇫🇷", code: "FR", visitors: 1, revenue: 0, payments: 0 },
      {
        country: "United States",
        image: "🇺🇸",
        code: "US",
        visitors: 1,
        revenue: 49.99,
        payments: 1,
      },
    ]);
    const regions = await get(`/api/v1/analytics/regions?${RANGE}`, f.key);
    expect(regions.data).toEqual([
      { region: "California", visitors: 1, revenue: 49.99, payments: 1 },
    ]);
    const cities = await get(`/api/v1/analytics/cities?${RANGE}&filter_device=desktop`, f.key);
    expect(cities.data).toEqual([
      { city: "San Francisco", visitors: 1, revenue: 49.99, payments: 1 },
    ]);
  });

  it("campaigns group UTM, ref, source and via with empty strings for absent values", async () => {
    const f = await seedFixture();
    const body = await get(`/api/v1/analytics/campaigns?${RANGE}`, f.key);
    expect(body.data).toEqual([
      {
        campaign: {
          utm_source: "newsletter",
          utm_medium: "",
          utm_campaign: "launch",
          utm_term: "",
          utm_content: "",
          ref: "hn",
          source: "",
          via: "",
        },
        visitors: 1,
        revenue: 10,
        payments: 1,
      },
    ]);
    const some = await get(
      `/api/v1/analytics/campaigns?${RANGE}&fields=utm_source,visitors`,
      f.key,
    );
    expect(some.data).toEqual([{ campaign: { utm_source: "newsletter" }, visitors: 1 }]);
  });

  it("entry and exit pages", async () => {
    const f = await seedFixture();
    const entry = await get(`/api/v1/analytics/entry-pages?${RANGE}`, f.key);
    expect(entry.data[0]).toEqual({
      hostname: "example.com",
      path: "/",
      visitors: 2,
      revenue: 59.99,
      payments: 2,
    });
    const exit = await get(`/api/v1/analytics/exit-pages?${RANGE}`, f.key);
    expect(exit.data).toHaveLength(3);
  });

  it("revenue follows the attribution model", async () => {
    const f = await seedFixture({ attributionModel: "last_touch" });
    const body = await get(`/api/v1/analytics/channels?${RANGE}`, f.key);
    // The factory sets last_session_id = first_session_id, so totals match first touch.
    expect(body.data.find((r: { channel: string }) => r.channel === "Email").revenue).toBe(10);
  });

  it("filters combine with breakdowns", async () => {
    const f = await seedFixture();
    const body = await get(
      `/api/v1/analytics/referrers?${RANGE}&filter_utm_campaign=launch`,
      f.key,
    );
    expect(body.data).toEqual([
      { referrer: "Direct / None", visitors: 1, revenue: 10, payments: 1 },
    ]);
    const direct = await get(
      `/api/v1/analytics/channels?${RANGE}&filter_referrer=Direct/None`,
      f.key,
    );
    expect(direct.data.map((r: { channel: string }) => r.channel)).toEqual(["Direct", "Email"]);
    const vc = await get(`/api/v1/analytics/countries?${RANGE}&filter_visit_count=gte:2`, f.key);
    expect(vc.data.map((r: { code: string }) => r.code)).toEqual(["FR"]);
  });

  it("rejects invalid fields", async () => {
    const f = await seedFixture();
    const res = await api(`/api/v1/analytics/countries?fields=nope`, { token: f.key });
    expect(res.status).toBe(400);
  });
});

describe("event breakdowns", () => {
  it("pages count visitors who viewed each page and their revenue", async () => {
    const f = await seedFixture();
    const body = await get(`/api/v1/analytics/pages?${RANGE}`, f.key);
    expect(body.data).toEqual([
      {
        hostname: "example.com",
        path: "/pricing",
        visitors: 3,
        revenue: 59.99,
        payments: 2,
        pageviews: 3,
      },
      {
        hostname: "example.com",
        path: "/",
        visitors: 2,
        revenue: 59.99,
        payments: 2,
        pageviews: 2,
      },
      {
        hostname: "example.com",
        path: "/blog/x",
        visitors: 1,
        revenue: 0,
        payments: 0,
        pageviews: 1,
      },
      {
        hostname: "example.com",
        path: "/signup",
        visitors: 1,
        revenue: 49.99,
        payments: 1,
        pageviews: 1,
      },
    ]);
    const mobile = await get(
      `/api/v1/analytics/pages?${RANGE}&filter_device=mobile&fields=path,visitors`,
      f.key,
    );
    expect(mobile.data).toEqual([
      { path: "/blog/x", visitors: 1 },
      { path: "/pricing", visitors: 1 },
    ]);
  });

  it("exit clicks", async () => {
    const f = await seedFixture();
    const body = await get(`/api/v1/analytics/exit-clicks?${RANGE}`, f.key);
    expect(body.data).toEqual([{ url: "https://github.com/x", visitors: 1, clicks: 1 }]);
    const none = await get(`/api/v1/analytics/exit-clicks?${RANGE}&filter_country=US`, f.key);
    expect(none.data).toEqual([]);
  });

  it("goals return completions and visitors; `name` maps to `goal`", async () => {
    const f = await seedFixture();
    const body = await get(`/api/v1/analytics/goals?${RANGE}`, f.key);
    expect(body.data).toEqual([
      {
        goal: "checkout_started",
        completions: 1,
        visitors: 1,
        revenue: 10,
        conversion_rate: 33.33,
      },
      { goal: "signup", completions: 1, visitors: 1, revenue: 49.99, conversion_rate: 33.33 },
    ]);
    const named = await get(`/api/v1/analytics/goals?${RANGE}&fields=name,completions`, f.key);
    expect(named.data).toEqual([
      { goal: "checkout_started", completions: 1 },
      { goal: "signup", completions: 1 },
    ]);
  });

  it("goal properties discover keys and break down values", async () => {
    const f = await seedFixture();
    const keys = await get(`/api/v1/analytics/goals/properties?eventName=signup&${RANGE}`, f.key);
    expect(keys.data).toEqual([{ property: "plan", completions: 1, visitors: 1 }]);
    expect(keys.pagination).toEqual({ limit: 100, offset: 0, total: 1, hasMore: false });
    expect(keys.meta).toEqual({
      eventName: "signup",
      propertyName: null,
      timezone: "UTC",
      startAt: "2026-03-10T00:00:00.000Z",
      endAt: "2026-03-11T23:59:59.999Z",
    });
    const values = await get(
      `/api/v1/analytics/goals/properties?eventName=signup&propertyName=plan&filter_page=/signup`,
      f.key,
    );
    expect(values.data).toEqual([{ value: "pro", completions: 1, visitors: 1 }]);
    const unknown = await get(`/api/v1/analytics/goals/properties?eventName=nothing`, f.key);
    expect(unknown.data).toEqual([]);
  });

  it.each([
    ["", "eventName is required"],
    ["eventName=Sign Up", "Invalid eventName"],
    ["eventName=signup&bogus=1", "Unsupported query parameter: bogus"],
    ["eventName=signup&eventName=x", "Duplicate query parameter"],
    ["eventName=signup&filter_entry_page=/", "not supported on this endpoint"],
    ["eventName=signup&filter_goal=x", "not supported on this endpoint"],
    ["eventName=signup&fields=value", "Invalid fields value"],
  ])("goal properties reject %s", async (query, message) => {
    const f = await seedFixture();
    const res = await api(`/api/v1/analytics/goals/properties?${query}`, { token: f.key });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain(message);
  });

  it("requires analytics:read on every breakdown", async () => {
    const f = await seedFixture();
    const token = await limitedToken(f.site, ["funnels:read"]);
    for (const path of ["pages", "referrers", "goals", "exit-clicks", "campaigns", "heatmap"]) {
      const res = await api(`/api/v1/analytics/${path}?websiteId=${f.site.id}`, { token });
      expect(res.status).toBe(403);
    }
  });
});

describe("heatmap", () => {
  it("counts pageviews by local weekday and hour", async () => {
    const f = await seedFixture();
    const body = await get(`/api/v1/analytics/heatmap?${RANGE}`, f.key);
    expect(body.data).toHaveLength(7 * 24);
    // 2026-03-10 is a Tuesday: A's three pageviews at 10:xx, B's at 11:00.
    const cell = (weekday: number, hour: number) =>
      body.data.find(
        (c: { weekday: number; hour: number }) => c.weekday === weekday && c.hour === hour,
      );
    expect(cell(2, 10)).toEqual({ weekday: 2, hour: 10, pageviews: 3, visitors: 1 });
    expect(cell(2, 11)).toMatchObject({ pageviews: 1 });
    expect(cell(3, 12)).toMatchObject({ pageviews: 2, visitors: 1 });
    const tokyo = await get(`/api/v1/analytics/heatmap?${RANGE}&timezone=Asia/Tokyo`, f.key);
    expect(tokyo.timezone).toBe("Asia/Tokyo");
  });
});
