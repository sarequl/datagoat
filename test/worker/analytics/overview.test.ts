import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "../../helpers/db";
import { createSession, createSite, createUser, sessionCookie } from "../../helpers/factories";
import { api } from "../../helpers/http";
import { limitedToken, RANGE, seedFixture } from "./fixture";

beforeEach(() => resetDb());

describe("GET /api/v1/analytics/overview", () => {
  it("computes DataFast's overview metrics for a range", async () => {
    const f = await seedFixture();
    const res = await api(`/api/v1/analytics/overview?${RANGE}`, { token: f.key });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "success",
      data: [
        {
          visitors: 3,
          new_visitors: 3,
          returning_visitors: 0,
          visitorBreakdown: { new: 3, returning: 0, newPercentage: 100, returningPercentage: 0 },
          pageviews: 7,
          sessions: 4,
          bounce_rate: 25,
          avg_session_duration: 255,
          currency: "USD",
          revenue: 59.99,
          payments: 2,
          revenue_per_visitor: 20,
          conversion_rate: 66.67,
        },
      ],
    });
  });

  it("classifies returning visitors by their lowest session number in the range", async () => {
    const f = await seedFixture();
    const res = await api(`/api/v1/analytics/overview?startAt=2026-03-11&endAt=2026-03-11`, {
      token: f.key,
    });
    expect(res.body.data[0]).toMatchObject({
      visitors: 2,
      new_visitors: 1,
      returning_visitors: 1,
      sessions: 2,
      revenue: 10,
      payments: 1,
    });
  });

  it("returns all time when the range is omitted and honours fields", async () => {
    const f = await seedFixture();
    const res = await api("/api/v1/analytics/overview?fields=visitors,revenue", { token: f.key });
    expect(res.body.data).toEqual([{ visitors: 3, revenue: 59.99 }]);
  });

  it("applies session filters to traffic and to attributed revenue", async () => {
    const f = await seedFixture();
    const res = await api(`/api/v1/analytics/overview?${RANGE}&filter_country=United States`, {
      token: f.key,
    });
    expect(res.body.data[0]).toMatchObject({
      visitors: 1,
      sessions: 1,
      revenue: 49.99,
      payments: 1,
    });
    const not = await api(`/api/v1/analytics/overview?${RANGE}&filter_country=is_not:US`, {
      token: f.key,
    });
    expect(not.body.data[0]).toMatchObject({ visitors: 2, sessions: 3, revenue: 10, payments: 1 });
  });

  it("applies visitor-level page and goal filters", async () => {
    const f = await seedFixture();
    const page = await api(`/api/v1/analytics/overview?${RANGE}&filter_page=/pricing`, {
      token: f.key,
    });
    expect(page.body.data[0]).toMatchObject({ visitors: 3 });
    const blog = await api(`/api/v1/analytics/overview?${RANGE}&filter_page=contains:/blog`, {
      token: f.key,
    });
    expect(blog.body.data[0]).toMatchObject({ visitors: 1, sessions: 2 });
    const goal = await api(`/api/v1/analytics/overview?${RANGE}&filter_goal=signup`, {
      token: f.key,
    });
    expect(goal.body.data[0]).toMatchObject({ visitors: 1, revenue: 49.99 });
    const noGoal = await api(`/api/v1/analytics/overview?${RANGE}&filter_goal=is_not:signup`, {
      token: f.key,
    });
    expect(noGoal.body.data[0]).toMatchObject({ visitors: 2 });
  });

  it("compares with the previous period", async () => {
    const f = await seedFixture();
    const res = await api(
      `/api/v1/analytics/overview?startAt=2026-03-11&endAt=2026-03-11&compare=previous`,
      {
        token: f.key,
      },
    );
    expect(res.body.data[0].visitors).toBe(2);
    expect(res.body.previous).toMatchObject({ visitors: 2, sessions: 2, revenue: 49.99 });
    expect(res.body.previousRange).toEqual({
      startAt: "2026-03-10T00:00:00.000Z",
      endAt: "2026-03-10T23:59:59.999Z",
    });
    const bad = await api("/api/v1/analytics/overview?compare=previous", { token: f.key });
    expect(bad.status).toBe(400);
  });

  it("excludes renewals when the website does not count renewal revenue", async () => {
    const f = await seedFixture({ includeRenewalRevenue: false });
    const res = await api(`/api/v1/analytics/overview?${RANGE}`, { token: f.key });
    expect(res.body.data[0]).toMatchObject({ revenue: 49.99, payments: 1, conversion_rate: 33.33 });
  });

  it("reads days in the requested timezone", async () => {
    const f = await seedFixture();
    // 2026-03-10 in Tokyo (UTC+9) ends at 15:00 UTC on 03-10: sessions A and B.
    const res = await api(
      "/api/v1/analytics/overview?startAt=2026-03-10&endAt=2026-03-10&timezone=Asia/Tokyo",
      {
        token: f.key,
      },
    );
    expect(res.body.data[0]).toMatchObject({ visitors: 2, sessions: 2 });
  });

  it.each([
    ["fields=nope", "Invalid fields value"],
    ["startAt=2026-03-10", "startAt and endAt must be provided together"],
    ["filter_country=Atlantis", "unknown country"],
    ["filter_bogus=1", "Unknown filter"],
    ["filter_visit_count=gte:x", "non-negative integers"],
    ["timezone=Mars/Base", "Invalid timezone"],
  ])("rejects %s with 400", async (query, message) => {
    const f = await seedFixture();
    const res = await api(`/api/v1/analytics/overview?${query}`, { token: f.key });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain(message);
  });

  it("enforces authentication and permissions", async () => {
    const f = await seedFixture();
    expect((await api("/api/v1/analytics/overview")).status).toBe(401);
    const noPerm = await limitedToken(f.site, ["goals:write"]);
    const denied = await api(`/api/v1/analytics/overview?websiteId=${f.site.id}`, {
      token: noPerm,
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error.message).toBe("Missing permission: analytics:read");
    const ok = await limitedToken(f.site, ["analytics:read"]);
    expect(
      (await api(`/api/v1/analytics/overview?websiteId=${f.site.id}`, { token: ok })).status,
    ).toBe(200);
    expect((await api("/api/v1/analytics/overview", { token: ok })).status).toBe(400);
    const other = await createSite((await createUser()).id);
    const cross = await api(`/api/v1/analytics/overview?websiteId=${other.id}`, { token: f.key });
    expect(cross.status).toBe(403);
  });

  it("serves the dashboard session by websiteId or tracking id", async () => {
    const f = await seedFixture();
    const cookie = await sessionCookie(f.owner.id);
    const res = await api(`/api/v1/analytics/overview?websiteId=${f.site.publicId}&${RANGE}`, {
      cookie,
    });
    expect(res.status).toBe(200);
    expect(res.body.data[0].visitors).toBe(3);
  });

  it("returns zeros for an empty website", async () => {
    const owner = await createUser();
    const site = await createSite(owner.id);
    const cookie = await sessionCookie(owner.id);
    const res = await api(`/api/v1/analytics/overview?websiteId=${site.id}`, { cookie });
    expect(res.body.data[0]).toMatchObject({
      visitors: 0,
      bounce_rate: 0,
      conversion_rate: 0,
      revenue: 0,
    });
    await createSession({ siteId: site.id, startedAt: Date.now() - 1000 });
    const again = await api(`/api/v1/analytics/overview?websiteId=${site.id}`, {
      cookie,
      headers: { "cache-control": "no-cache" },
    });
    expect(again.body.data[0].visitors).toBe(1);
  });
});
