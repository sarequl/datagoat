import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "../../helpers/db";
import { createApiKey, createPayment } from "../../helpers/factories";
import { api } from "../../helpers/http";
import { DAY, ownerWithSite, visitorWithSessions } from "./helpers";

beforeEach(() => resetDb());

const D = (day: number) => Date.UTC(2026, 9, day, 12);
const RANGE = "startAt=2026-10-01&endAt=2026-10-31";

async function seed() {
  const ctx = await ownerWithSite({ currency: "USD" });
  const s = ctx.site.id;
  // Visitor A: found via Google, came back direct, bought twice (one renewal) and got a refund.
  const a = await visitorWithSessions(s, [
    { at: D(1), channel: "Organic Search", source: "Google", country: "US" },
    { at: D(5), channel: "Direct", country: "US" },
  ]);
  // Visitor B: one visit from Hacker News, bought the same day.
  const b = await visitorWithSessions(s, [
    { at: D(10), channel: "Referral", source: "Hacker News", country: "DE" },
  ]);
  const [a1, a2] = a.sessions;
  const [b1] = b.sessions;
  const pay = (input: Parameters<typeof createPayment>[0]) => createPayment(input);
  await pay({
    siteId: s,
    amountMinor: 10000,
    occurredAt: D(5) + 1000,
    visitorId: a.visitorId,
    firstSessionId: a1?.id,
    lastSessionId: a2?.id,
    lastNonDirectSessionId: a1?.id,
    attributedVia: "metadata",
  });
  await pay({
    siteId: s,
    amountMinor: 10000,
    kind: "renewal",
    occurredAt: D(20),
    visitorId: a.visitorId,
    firstSessionId: a1?.id,
    lastSessionId: a2?.id,
    lastNonDirectSessionId: a1?.id,
    attributedVia: "customer",
  });
  await pay({
    siteId: s,
    amountMinor: -2000,
    kind: "refund",
    occurredAt: D(21),
    visitorId: a.visitorId,
    firstSessionId: a1?.id,
    lastSessionId: a2?.id,
    lastNonDirectSessionId: a1?.id,
    attributedVia: "metadata",
  });
  await pay({
    siteId: s,
    amountMinor: 5000,
    occurredAt: D(10) + 5000,
    visitorId: b.visitorId,
    firstSessionId: b1?.id,
    attributedVia: "link",
  });
  await pay({ siteId: s, amountMinor: 3000, occurredAt: D(15), attributedVia: "none" });
  await pay({
    siteId: s,
    amountMinor: 0,
    kind: "free_trial",
    occurredAt: D(16),
    attributedVia: "none",
  });
  // Outside the range.
  await pay({ siteId: s, amountMinor: 99900, occurredAt: D(1) - 40 * DAY, attributedVia: "none" });
  return { ...ctx, a, b };
}

describe("GET /api/v1/analytics/revenue", () => {
  it("summarises revenue, attribution coverage and LTV by first channel", async () => {
    const { site, cookie } = await seed();
    const res = await api(`/api/v1/analytics/revenue?websiteId=${site.id}&${RANGE}`, { cookie });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      currency: "USD",
      revenue: 260,
      newRevenue: 180,
      renewalRevenue: 100,
      refunds: -20,
      payments: 4,
      customers: 3,
      attribution: {
        attributedRevenue: 230,
        unattributedRevenue: 30,
        coveragePercentage: 88.46,
        byMethod: { metadata: 80, link: 50, customer: 100, email: 0, api: 0, none: 30 },
      },
      lifetimeValueByChannel: [
        { channel: "Organic Search", customers: 1, revenue: 180, averageValue: 180 },
        { channel: "Referral", customers: 1, revenue: 50, averageValue: 50 },
      ],
    });
  });

  it("excludes renewals when the website does, and applies filters to the attributed session", async () => {
    const { site, cookie } = await seed();
    const { env } = await import("cloudflare:test");
    await env.DB.prepare("UPDATE sites SET include_renewal_revenue = 0 WHERE id = ?")
      .bind(site.id)
      .run();
    const { siteCache } = await import("../../../src/lib/site-cache");
    siteCache.clear();
    const res = await api(
      `/api/v1/analytics/revenue?websiteId=${site.id}&${RANGE}&filter_country=DE`,
      { cookie },
    );
    expect(res.body.data).toMatchObject({
      revenue: 50,
      payments: 1,
      customers: 1,
      renewalRevenue: 0,
    });
    expect(res.body.data.attribution.unattributedRevenue).toBe(0);
  });

  it("requires analytics:read", async () => {
    const { user, site } = await seed();
    const token = await createApiKey({ userId: user.id, permissions: ["payments:write"] });
    const res = await api(`/api/v1/analytics/revenue?websiteId=${site.id}`, {
      token: token.secret,
    });
    expect(res.status).toBe(403);
  });
});

describe("GET /api/v1/analytics/revenue/sources", () => {
  it("groups revenue by source under each attribution model, with an Unattributed bucket", async () => {
    const { site, cookie } = await seed();
    const first = await api(`/api/v1/analytics/revenue/sources?websiteId=${site.id}&${RANGE}`, {
      cookie,
    });
    expect(first.body).toMatchObject({ currency: "USD", groupBy: "channel", model: "first_touch" });
    expect(first.body.data).toEqual([
      {
        value: "Organic Search",
        revenue: 180,
        newRevenue: 100,
        renewalRevenue: 100,
        refunds: -20,
        payments: 2,
        customers: 1,
        share: 69.23,
      },
      {
        value: "Referral",
        revenue: 50,
        newRevenue: 50,
        renewalRevenue: 0,
        refunds: 0,
        payments: 1,
        customers: 1,
        share: 19.23,
      },
      {
        value: "Unattributed",
        revenue: 30,
        newRevenue: 30,
        renewalRevenue: 0,
        refunds: 0,
        payments: 1,
        customers: 0,
        share: 11.54,
      },
    ]);
    const last = await api(
      `/api/v1/analytics/revenue/sources?websiteId=${site.id}&${RANGE}&model=last_touch`,
      { cookie },
    );
    expect(last.body.data[0]).toMatchObject({ value: "Direct", revenue: 180 });
    const ref = await api(
      `/api/v1/analytics/revenue/sources?websiteId=${site.id}&${RANGE}&groupBy=referrer&model=last_non_direct`,
      { cookie },
    );
    expect(ref.body.data.map((r: { value: string }) => r.value)).toEqual([
      "Google",
      "Hacker News",
      "Unattributed",
    ]);
    const bad = await api(`/api/v1/analytics/revenue/sources?websiteId=${site.id}&groupBy=nope`, {
      cookie,
    });
    expect(bad.status).toBe(400);
    const badModel = await api(
      `/api/v1/analytics/revenue/sources?websiteId=${site.id}&model=nope`,
      { cookie },
    );
    expect(badModel.status).toBe(400);
  });
});

describe("GET /api/v1/analytics/revenue/path-to-purchase", () => {
  it("measures days and sessions from first visit to first purchase, and channel paths", async () => {
    const { site, cookie } = await seed();
    const res = await api(
      `/api/v1/analytics/revenue/path-to-purchase?websiteId=${site.id}&${RANGE}`,
      { cookie },
    );
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d).toMatchObject({
      currency: "USD",
      model: "first_touch",
      customers: 2,
      averageSessionsToPurchase: 1.5,
      medianSessionsToPurchase: 1.5,
      averagePageviewsToPurchase: 1.5,
    });
    expect(d.averageDaysToPurchase).toBeCloseTo(2, 1);
    expect(d.timeToPurchase).toEqual([
      { bucket: "same_day", customers: 1, percentage: 50 },
      { bucket: "1_7_days", customers: 1, percentage: 50 },
      { bucket: "8_30_days", customers: 0, percentage: 0 },
      { bucket: "31_90_days", customers: 0, percentage: 0 },
      { bucket: "over_90_days", customers: 0, percentage: 0 },
    ]);
    expect(d.sessionsToPurchase.slice(0, 2)).toEqual([
      { sessions: "1", customers: 1, percentage: 50 },
      { sessions: "2", customers: 1, percentage: 50 },
    ]);
    expect(d.paths).toEqual([
      { firstChannel: "Organic Search", lastChannel: "Direct", customers: 1, revenue: 100 },
      { firstChannel: "Referral", lastChannel: "Referral", customers: 1, revenue: 50 },
    ]);
    const filtered = await api(
      `/api/v1/analytics/revenue/path-to-purchase?websiteId=${site.id}&${RANGE}&filter_country=US`,
      { cookie },
    );
    expect(filtered.body.data.customers).toBe(1);
  });
});
