import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "../../helpers/db";
import { createApiKey, createSession, createSite, createUser } from "../../helpers/factories";
import { api } from "../../helpers/http";
import { RANGE, seedFixture, V1, V2, V3 } from "./fixture";

beforeEach(() => resetDb());

const ids = (body: { data: Array<{ visitorId: string }> }) => body.data.map((r) => r.visitorId);

describe("GET /api/v1/visitors", () => {
  it("lists visitors with sessions in the range, latest activity first", async () => {
    const f = await seedFixture();
    const res = await api(`/api/v1/visitors?${RANGE}`, { token: f.key });
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual([V3, V2, V1]);
    expect(res.body.pagination).toEqual({ limit: 100, offset: 0, total: 3, hasMore: false });
    expect(res.body.data[1]).toMatchObject({
      visitorId: V2,
      lastSeenAt: "2026-03-11T09:02:00.000Z",
      visitorSessionNumber: 2,
      visitorType: "returning",
      currentUrl: "example.com/pricing",
      identity: {
        country: "FR",
        region: null,
        city: null,
        browser: "Mobile Safari",
        os: "iOS",
        device: "mobile",
      },
      acquisition: { referrer: "X", utm_source: null, ref: null },
      revenue: 0,
    });
    expect(res.body.data[0].acquisition).toMatchObject({
      referrer: null,
      utm_source: "newsletter",
      ref: "hn",
    });
    expect(res.body.data[2].revenue).toBe(49.99);
  });

  it.each([
    ["visitedPage=/blog/x", [V2]],
    ["page=/blog/x,/signup", [V2, V1]],
    ["visitedPageContains=/pri", [V3, V2, V1]],
    ["pageContains=sign", [V1]],
    ["country=Germany", [V3]],
    ["country=is_not:DE", [V2, V1]],
    ["device=mobile&browser=Safari", [V2]],
    ["visitCount=2", [V2]],
    ["visit_count=1", [V3, V2, V1]],
    ["referrer=Google", [V1]],
    ["utm_campaign=launch", [V3]],
    ["ref=hn", [V3]],
    ["isCustomer=true", [V3, V1]],
    ["hasRevenue=false", [V3, V2, V1]],
    ["filter_os=iOS", [V2]],
  ])("filters with %s", async (query, expected) => {
    const f = await seedFixture();
    const res = await api(`/api/v1/visitors?${RANGE}&${query}`, { token: f.key });
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual(expected);
  });

  it("completedGoal reports the goal completion time as lastSeenAt", async () => {
    const f = await seedFixture();
    const res = await api(`/api/v1/visitors?completedGoal=signup`, { token: f.key });
    expect(ids(res.body)).toEqual([V1]);
    expect(res.body.data[0].lastSeenAt).toBe("2026-03-10T10:05:00.000Z");
  });

  it("paginates (max 250) and searches identified users with q", async () => {
    const f = await seedFixture();
    const page = await api(`/api/v1/visitors?limit=1&offset=1`, { token: f.key });
    expect(ids(page.body)).toEqual([V2]);
    expect(page.body.pagination).toEqual({ limit: 1, offset: 1, total: 3, hasMore: true });
    const beyond = await api(`/api/v1/visitors?limit=5&offset=10`, { token: f.key });
    expect(beyond.body.pagination.total).toBe(3);
    await env.DB.prepare(
      "UPDATE visitors SET user_id = 'user_9', name = 'Grace Hopper' WHERE site_id = ? AND id = ?",
    )
      .bind(f.site.id, V3)
      .run();
    expect(ids((await api("/api/v1/visitors?q=user_9", { token: f.key })).body)).toEqual([V3]);
    expect(ids((await api("/api/v1/visitors?q=hopper", { token: f.key })).body)).toEqual([V3]);
    expect(ids((await api(`/api/v1/visitors?q=${V2}`, { token: f.key })).body)).toEqual([V2]);
    const row = (await api("/api/v1/visitors?q=user_9", { token: f.key })).body.data[0];
    expect(row.userId).toBe("user_9");
    expect(row.displayName).toBeNull(); // df_ key without includePii
  });

  it.each([
    ["limit=251", "at most 250"],
    ["bogus=1", "Unsupported query parameter: bogus"],
    ["completedGoal=signup&isCustomer=true", "cannot be combined"],
    ["didNotCompleteGoal=signup", "not supported"],
    ["goalNot=signup", "not supported"],
    ["isCustomer=yes", "true or false"],
    ["visitedPage=/a&page=/b", "only one of"],
    ["visitCount=abc", "integers"],
  ])("rejects %s", async (query, message) => {
    const f = await seedFixture();
    const res = await api(`/api/v1/visitors?${query}`, { token: f.key });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain(message);
  });
});

describe("GET /api/v1/visitors/:visitorId", () => {
  it("returns identity, activity, journey, goals and payments", async () => {
    const f = await seedFixture();
    const res = await api(`/api/v1/visitors/${V1}`, { token: f.key });
    expect(res.status).toBe(200);
    const p = res.body.data;
    expect(p.visitorId).toBe(V1);
    expect(p.identity).toMatchObject({
      country: "US",
      countryCode: "US",
      region: "California",
      city: "San Francisco",
      browser: { name: "Chrome", version: null },
      os: { name: "Mac OS", version: null },
      device: { type: "desktop", vendor: null, model: null },
      adClickIds: {},
    });
    expect(p.activity).toMatchObject({
      visitCount: 1,
      visitorSessionNumber: 1,
      visitorType: "new",
      pageViewCount: 3,
      firstVisitAt: "2026-03-10T10:00:00.000Z",
      lastVisitAt: "2026-03-10T10:00:00.000Z",
      currentUrl: "example.com/",
      completedGoals: [
        { name: "signup", origin: "manual", type: "custom", timestamp: "2026-03-10T10:05:00.000Z" },
      ],
    });
    expect(p.activity.visitedPages.map((v: { url: string }) => v.url)).toEqual([
      "example.com/signup",
      "example.com/pricing",
      "example.com/",
    ]);
    expect(p.payments).toEqual([
      {
        id: expect.any(String),
        amount: 49.99,
        currency: "USD",
        kind: "payment",
        provider: "api",
        timestamp: "2026-03-10T10:06:00.000Z",
      },
    ]);
    expect(p.sessions).toHaveLength(1);
    expect(p.activityGrid).toEqual([{ date: "2026-03-10", events: 4, goals: 1 }]);
    expect(p).not.toHaveProperty("profile");
    expect(p).not.toHaveProperty("prediction");
  });

  it("returning visitors and the prediction (omitted for customers)", async () => {
    const f = await seedFixture();
    const model = {
      version: 1,
      baseline: { visitors: 2000, conversions: 20, revenue: 1000 },
      dims: { country: { FR: [400, 12, 600] }, device: { mobile: [900, 15, 750] } },
    };
    await env.DB.prepare(
      "INSERT INTO prediction_models (site_id, model, baseline_conversion_rate, baseline_average_value, sample_visitors, trained_at) VALUES (?, ?, 0.01, 50, 2000, 0)",
    )
      .bind(f.site.id, JSON.stringify(model))
      .run();
    const v2 = (await api(`/api/v1/visitors/${V2}`, { token: f.key })).body.data;
    expect(v2.activity).toMatchObject({
      visitCount: 2,
      visitorSessionNumber: 2,
      visitorType: "returning",
    });
    expect(v2.prediction.score).toBeGreaterThan(50);
    expect(v2.prediction.conversionRate).toBeGreaterThan(0.01);
    expect(v2.prediction.expectedValue).toBeGreaterThan(0);
    expect(v2.prediction.confidence).toBeGreaterThan(0);
    expect(v2.prediction.confidence).toBeLessThanOrEqual(1);
    const v1 = (await api(`/api/v1/visitors/${V1}`, { token: f.key })).body.data;
    expect(v1).not.toHaveProperty("prediction");
  });

  it("validates the id and 404s visitors without pageviews", async () => {
    const f = await seedFixture();
    expect((await api("/api/v1/visitors/not-a-uuid", { token: f.key })).status).toBe(400);
    expect(
      (await api("/api/v1/visitors/abcdef0123456789abcdef0123456789", { token: f.key })).status,
    ).toBe(400);
    const missing = await api("/api/v1/visitors/44444444-4444-4444-8444-444444444444", {
      token: f.key,
    });
    expect(missing.status).toBe(404);
    // Cookieless hashes are accepted on cookieless websites.
    const owner = await createUser();
    const site = await createSite(owner.id, { privacyMode: "cookieless" });
    const key = (await createApiKey({ userId: owner.id, siteId: site.id })).secret;
    expect(
      (await api("/api/v1/visitors/abcdef0123456789abcdef0123456789", { token: key })).status,
    ).toBe(404);
  });
});

describe("Google keyword probability in journeys", () => {
  it("guesses the search queries of Google sessions from Search Console clicks", async () => {
    const owner = await createUser();
    const site = await createSite(owner.id, { domain: "example.com", timezone: "UTC" });
    const key = (await createApiKey({ userId: owner.id, siteId: site.id })).secret;
    const visitorId = "55555555-5555-4555-8555-555555555555";
    const at = Date.UTC(2026, 9, 14, 10);
    await createSession({
      siteId: site.id,
      visitorId,
      startedAt: at,
      channel: "Organic Search",
      source: "Google",
      entryPath: "/pricing?ref=x",
    });
    await createSession({ siteId: site.id, visitorId, startedAt: at + 86_400_000 });
    const gsc = env.DB.prepare(
      "INSERT INTO gsc_daily (site_id, day, query, page, clicks, impressions) VALUES (?, ?, ?, ?, ?, 100)",
    );
    await env.DB.batch([
      gsc.bind(site.id, "2026-10-13", "datagoat pricing", "https://example.com/pricing", 4),
      gsc.bind(site.id, "2026-10-15", "datagoat pricing", "https://example.com/pricing/", 2),
      gsc.bind(site.id, "2026-10-14", "analytics tool", "https://example.com/pricing", 2),
      gsc.bind(site.id, "2026-10-14", "elsewhere", "https://example.com/blog", 50),
      gsc.bind(site.id, "2026-09-01", "too early", "https://example.com/pricing", 50),
      gsc.bind(site.id, "2026-10-14", "", "", 500),
    ]);
    const res = await api(`/api/v1/visitors/${visitorId}`, { token: key });
    expect(res.status).toBe(200);
    const sessions = res.body.data.sessions as Array<Record<string, unknown>>;
    const google = sessions.find((s) => s.channel === "Organic Search");
    expect(google?.searchKeywords).toEqual([
      { query: "datagoat pricing", probability: 75 },
      { query: "analytics tool", probability: 25 },
    ]);
    expect(sessions.find((s) => s.channel === "Direct")).not.toHaveProperty("searchKeywords");
  });
});
