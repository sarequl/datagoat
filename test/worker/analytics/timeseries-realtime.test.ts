import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "../../helpers/db";
import { createEvent, createPayment, createSession, sessionCookie } from "../../helpers/factories";
import { api } from "../../helpers/http";
import { RANGE, seedFixture, V1 } from "./fixture";

beforeEach(() => resetDb());

describe("GET /api/v1/analytics/timeseries", () => {
  it("buckets by day with DataFast's top-level fields and totals", async () => {
    const f = await seedFixture();
    const res = await api(`/api/v1/analytics/timeseries?interval=day&${RANGE}`, { token: f.key });
    expect(res.status).toBe(200);
    const b = res.body;
    expect(b.fields).toEqual([...b.fields]);
    expect(b.interval).toBe("day");
    expect(b.timezone).toBe("UTC");
    expect(b.currency).toBe("USD");
    expect(b.data).toHaveLength(2);
    expect(b.data[0]).toMatchObject({
      timestamp: "2026-03-10T00:00:00.000Z",
      name: "Mar 10, 2026",
      visitors: 2,
      new_visitors: 2,
      returning_visitors: 0,
      sessions: 2,
      pageviews: 4,
      revenue: 49.99,
      payments: 1,
      conversion_rate: 50,
    });
    expect(b.data[1]).toMatchObject({
      visitors: 2,
      new_visitors: 1,
      returning_visitors: 1,
      visitorBreakdown: { new: 1, returning: 1, newPercentage: 50, returningPercentage: 50 },
      revenue: 10,
    });
    expect(b.totals).toMatchObject({
      visitors: 3,
      new_visitors: 3,
      returning_visitors: 0,
      pageviews: 7,
      sessions: 4,
      revenue: 59.99,
      payments: 2,
      revenueBreakdown: { new: 49.99, renewal: 10, refunds: 0 },
    });
    expect(b.pagination).toEqual({ limit: 100, offset: 0, total: 2, hasMore: false });
  });

  it("requesting revenue adds payments; same-day ranges become hourly", async () => {
    const f = await seedFixture();
    const res = await api(
      "/api/v1/analytics/timeseries?interval=day&fields=revenue&startAt=2026-03-10&endAt=2026-03-10",
      { token: f.key },
    );
    expect(res.body.fields).toEqual(["revenue", "payments"]);
    expect(res.body.interval).toBe("hour");
    expect(res.body.data).toHaveLength(24);
    expect(res.body.data[10]).toEqual({
      timestamp: "2026-03-10T10:00:00.000Z",
      revenue: 49.99,
      payments: 1,
    });
  });

  it("reports refunds per bucket with the DataGoat refunds field (revenue only)", async () => {
    const f = await seedFixture();
    await createPayment({
      siteId: f.site.id,
      amountMinor: -1500,
      kind: "refund",
      occurredAt: Date.UTC(2026, 2, 11, 9),
    });
    const res = await api(
      `/api/v1/analytics/timeseries?interval=day&fields=visitors,revenue,refunds&${RANGE}`,
      { token: f.key },
    );
    expect(res.status).toBe(200);
    expect(res.body.fields).toEqual(["visitors", "revenue", "payments", "refunds"]);
    expect(res.body.data[0]).toMatchObject({ refunds: 0, revenue: 49.99 });
    // Refunds are positive amounts; revenue stays net of them.
    expect(res.body.data[1]).toMatchObject({ refunds: 15, revenue: -5 });
    expect(res.body.totals).toMatchObject({ refunds: 15 });
    // Public views without shared revenue never see it.
    const share = await api(`/api/v1/admin/websites/${f.site.id}/share`, {
      token: f.key,
      body: {},
    });
    const pub = await api(
      `/api/share/${share.body.data.token}/analytics/timeseries?interval=day&fields=visitors,refunds&${RANGE}`,
    );
    expect(pub.body.fields).toEqual(["visitors"]);
    expect(pub.body.data[1]).not.toHaveProperty("refunds");
  });

  it("weeks start on Monday and months on the 1st in the requested timezone", async () => {
    const f = await seedFixture();
    const week = await api(`/api/v1/analytics/timeseries?interval=week&fields=visitors&${RANGE}`, {
      token: f.key,
    });
    expect(week.body.data).toEqual([{ timestamp: "2026-03-09T00:00:00.000Z", visitors: 3 }]);
    const month = await api(
      "/api/v1/analytics/timeseries?interval=month&fields=sessions&startAt=2026-02-01&endAt=2026-03-31&timezone=America/New_York",
      { token: f.key },
    );
    expect(month.body.data).toEqual([
      { timestamp: "2026-02-01T05:00:00.000Z", sessions: 0 },
      { timestamp: "2026-03-01T05:00:00.000Z", sessions: 4 },
    ]);
  });

  it("applies the default window when the range is omitted", async () => {
    const f = await seedFixture();
    const hour = await api("/api/v1/analytics/timeseries?interval=hour&fields=visitors", {
      token: f.key,
    });
    expect(hour.body.data).toHaveLength(24);
    const day = await api("/api/v1/analytics/timeseries?interval=day&fields=visitors", {
      token: f.key,
    });
    expect(day.body.data).toHaveLength(30);
    const month = await api("/api/v1/analytics/timeseries?interval=month&fields=visitors", {
      token: f.key,
    });
    expect(month.body.data).toHaveLength(12);
  });

  it("compares with the previous period", async () => {
    const f = await seedFixture();
    const res = await api(
      "/api/v1/analytics/timeseries?interval=day&fields=visitors&startAt=2026-03-11&endAt=2026-03-11&compare=previous",
      { token: f.key },
    );
    expect(res.body.interval).toBe("hour");
    expect(res.body.previous.totals.visitors).toBe(2);
    expect(res.body.previous.data).toHaveLength(24);
  });

  it("filters and paginates buckets", async () => {
    const f = await seedFixture();
    const res = await api(
      `/api/v1/analytics/timeseries?interval=day&fields=visitors&${RANGE}&filter_country=DE&limit=1&offset=1`,
      { token: f.key },
    );
    expect(res.body.data).toEqual([{ timestamp: "2026-03-11T00:00:00.000Z", visitors: 1 }]);
    expect(res.body.pagination).toEqual({ limit: 1, offset: 1, total: 2, hasMore: false });
    expect(res.body.totals.visitors).toBe(1);
  });

  it.each([
    ["", "interval is required"],
    ["interval=second", "Invalid interval"],
    ["interval=day&fields=revenue_per_visitor", "Invalid fields value"],
    ["interval=hour&startAt=2020-01-01&endAt=2026-01-01", "Too many hour buckets"],
  ])("rejects %s", async (query, message) => {
    const f = await seedFixture();
    const res = await api(`/api/v1/analytics/timeseries?${query}`, { token: f.key });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain(message);
  });
});

describe("metadata", () => {
  it("returns website settings and honours fields", async () => {
    const f = await seedFixture();
    const res = await api("/api/v1/analytics/metadata", { token: f.key });
    expect(res.body.data).toEqual([
      {
        domain: "example.com",
        timezone: "UTC",
        name: f.site.name,
        logo: null,
        kpiColorScheme: "orange",
        kpi: null,
        currency: "USD",
      },
    ]);
    const some = await api("/api/v1/analytics/metadata?fields=domain,currency", { token: f.key });
    expect(some.body.data).toEqual([{ domain: "example.com", currency: "USD" }]);
    expect((await api("/api/v1/analytics/metadata?fields=x", { token: f.key })).status).toBe(400);
  });
});

describe("realtime", () => {
  it("counts visitors with pageviews in the last 10 minutes", async () => {
    const f = await seedFixture();
    const now = Date.now();
    const live = await createSession({ siteId: f.site.id, startedAt: now - 60_000, country: "NL" });
    await createEvent({ siteId: f.site.id, session: live, ts: now - 30_000, path: "/live" });
    const stale = await createSession({ siteId: f.site.id, startedAt: now - 3_600_000 });
    await createEvent({ siteId: f.site.id, session: stale, ts: now - 11 * 60_000 });
    const res = await api("/api/v1/analytics/realtime", { token: f.key });
    expect(res.body).toEqual({ status: "success", data: [{ visitors: 1 }] });
    expect(
      (await api("/api/v1/analytics/realtime?fields=pageviews", { token: f.key })).status,
    ).toBe(400);
  });

  it("realtime map lists active visitors, recent goals and payments; PII needs includePii", async () => {
    const f = await seedFixture();
    const now = Date.now();
    const live = await createSession({
      siteId: f.site.id,
      visitorId: V1,
      startedAt: now - 120_000,
      country: "US",
      city: "Austin",
      region: "Texas",
      device: "desktop",
      browser: "Chrome",
      os: "Mac OS",
      sessionNumber: 2,
      utm: { utm_source: "google" },
    });
    await createEvent({ siteId: f.site.id, session: live, ts: now - 60_000, path: "/pricing" });
    await createEvent({
      siteId: f.site.id,
      session: live,
      ts: now - 50_000,
      type: "custom",
      name: "signup",
      path: "/pricing",
      props: { plan: "pro" },
    });
    const payId = await createPayment({
      siteId: f.site.id,
      amountMinor: 2900,
      occurredAt: now - 40_000,
      visitorId: V1,
      firstSessionId: live.id,
    });
    await env.DB.prepare(
      "UPDATE payments SET customer_name = 'Ada', customer_email = 'ada@example.com' WHERE id = ?",
    )
      .bind(payId)
      .run();
    const cookie = await sessionCookie(f.owner.id);
    const res = await api(`/api/v1/analytics/realtime/map?websiteId=${f.site.id}`, { cookie });
    expect(res.status).toBe(200);
    const map = res.body.data;
    expect(map.count).toBe(1);
    expect(map.hasConversionPredictions).toBe(false);
    expect(map.visitors[0]).toMatchObject({
      visitorId: V1,
      location: { city: "Austin", region: "Texas", countryCode: "US" },
      system: { browser: { name: "Chrome" }, os: { name: "Mac OS" }, device: { type: "desktop" } },
      currentUrl: "/pricing",
      visitCount: 2,
      isCustomer: true,
      customerName: "Ada",
      customerEmail: "ada@example.com",
      profileData: { displayName: "Ada", userId: null, hasProfile: false, isRandomName: false },
    });
    // First-session parameters (session A had none).
    expect(map.visitors[0].params.utm_source).toBeNull();
    expect(map.recentEvents[0]).toMatchObject({
      type: "signup",
      visitorId: V1,
      extraData: { plan: "pro" },
    });
    expect(map.recentPayments[0]).toMatchObject({
      _id: payId,
      type: "payment_received",
      amount: 29,
      currency: "USD",
      renewal: false,
      name: "Ada",
      email: "ada@example.com",
      displayName: null,
      isNew: false,
      visible: true,
    });
    const keyRes = await api("/api/v1/analytics/realtime/map", { token: f.key });
    expect(keyRes.body.data.visitors[0].customerEmail).toBeNull();
    expect(keyRes.body.data.recentPayments[0].email).toBeNull();
  });
});
