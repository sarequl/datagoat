import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { pickProperty } from "../../../src/growth/gsc/client";
import {
  BACKFILL_DAYS_PER_RUN,
  daysToFetch,
  syncSearchConsole,
} from "../../../src/growth/gsc/sync";
import { metaWindow, syncMeta } from "../../../src/growth/meta/sync";
import { encryptCredentials } from "../../../src/growth/shared/connections";
import { meterEnv, resetDb } from "../../helpers/db";
import {
  createPayment,
  createSession,
  createSite,
  createUser,
  sessionCookie,
} from "../../helpers/factories";
import { api } from "../../helpers/http";
import { jobCtx, mockFetch, useGlobalFetch } from "./helpers";

beforeEach(() => resetDb());

const NOW = Date.UTC(2026, 10, 4, 1, 17);

async function connect(
  siteId: string,
  kind: "gsc" | "meta_ads",
  settings: unknown,
  creds: unknown,
  cursor: unknown = null,
) {
  await env.DB.prepare(
    "INSERT INTO integration_connections (site_id, kind, credentials_enc, status, settings, cursor, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, 0, 0)",
  )
    .bind(
      siteId,
      kind,
      await encryptCredentials(env, kind, siteId, creds),
      JSON.stringify(settings),
      cursor ? JSON.stringify(cursor) : null,
    )
    .run();
}

describe("Search Console sync", () => {
  it("chooses the domain property first", () => {
    const props = [
      { siteUrl: "https://www.example.com/", permissionLevel: "siteOwner" },
      { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
    ];
    expect(pickProperty(props, "www.example.com")).toBe("sc-domain:example.com");
    expect(pickProperty(props.slice(0, 1), "example.com")).toBe("https://www.example.com/");
    expect(pickProperty([], "example.com")).toBeNull();
  });

  it("plans the daily refresh and a bounded backfill", () => {
    expect(daysToFetch({}, NOW)).toEqual({
      daily: ["2026-10-31", "2026-11-01", "2026-11-02"],
      backfill: ["2026-10-30", "2026-10-29"],
    });
    expect(
      daysToFetch({ lastDaily: "2026-11-04", backfillBefore: "2026-01-01" }, NOW).daily,
    ).toEqual([]);
    expect(daysToFetch({ lastDaily: "2026-11-04", backfillDone: true }, NOW).backfill).toEqual([]);
    expect(BACKFILL_DAYS_PER_RUN).toBe(2);
  });

  it("refreshes the token, stores totals and top query/page rows, and writes only changes", async () => {
    const owner = await createUser();
    const site = await createSite(owner.id);
    await connect(
      site.id,
      "gsc",
      { property: "sc-domain:example.com" },
      { accessToken: "old", refreshToken: "1//r", expiresAt: NOW - 1000, via: "oauth" },
    );
    const fetch = mockFetch()
      .on("https://oauth2.googleapis.com/token", (call) => {
        expect(new URLSearchParams(call.body).get("grant_type")).toBe("refresh_token");
        return { access_token: "fresh", expires_in: 3600 };
      })
      .on(/searchAnalytics\/query$/, (call) => {
        expect(call.url).toContain(encodeURIComponent("sc-domain:example.com"));
        expect(call.headers.get("authorization")).toBe("Bearer fresh");
        const body = JSON.parse(call.body);
        if (body.dimensions[0] === "date") {
          return {
            rows: ["2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"].map(
              (d) => ({
                keys: [d],
                clicks: 10,
                impressions: 200,
                position: 8.4,
              }),
            ),
          };
        }
        return {
          rows: [
            {
              keys: ["datagoat analytics", "https://example.com/"],
              clicks: 6,
              impressions: 50,
              position: 2.1,
            },
            {
              keys: ["web analytics revenue", "https://example.com/blog/revenue"],
              clicks: 3,
              impressions: 120,
              position: 9,
            },
          ],
        };
      });
    const e = { ...env, GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s" } as Cloudflare.Env;
    await syncSearchConsole(jobCtx({ now: NOW, fetch, env: e }));
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n, SUM(query = '') AS totals FROM gsc_daily",
    ).first<{ n: number; totals: number }>();
    expect(count).toEqual({ n: 15, totals: 5 });
    const conn = await env.DB.prepare(
      "SELECT cursor, credentials_enc FROM integration_connections",
    ).first<{ cursor: string; credentials_enc: string }>();
    expect(JSON.parse(conn?.cursor ?? "{}")).toEqual({
      lastDaily: "2026-11-04",
      backfillBefore: "2026-10-29",
    });

    // Next run: only two older backfill days are fetched; the refreshed token is reused.
    const m = meterEnv();
    await syncSearchConsole(
      jobCtx({ now: NOW + 1_800_000, fetch, env: { ...e, DB: m.db }, db: m.db }),
    );
    expect(fetch.calls.filter((c) => c.url.includes("oauth2")).length).toBe(1);
    // 2 new days x 2 rows + status row; the totals request returns days already stored (unchanged).
    expect(m.d1.rowsWritten).toBe(4 + 1);
  });
});

describe("Search Console API", () => {
  async function seed() {
    const owner = await createUser();
    const site = await createSite(owner.id);
    const cookie = await sessionCookie(owner.id);
    const insert = (
      day: string,
      query: string,
      page: string,
      clicks: number,
      impressions: number,
      position: number,
    ) =>
      env.DB.prepare(
        "INSERT INTO gsc_daily (site_id, day, query, page, clicks, impressions, position) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(site.id, day, query, page, clicks, impressions, position);
    await env.DB.batch([
      insert("2026-10-10", "", "", 40, 1000, 7),
      insert("2026-10-11", "", "", 20, 500, 9),
      insert("2026-10-10", "datagoat", "https://example.com/", 30, 300, 1.5),
      insert("2026-10-11", "datagoat", "https://example.com/", 10, 100, 2.5),
      insert("2026-10-10", "revenue analytics", "https://example.com/blog/revenue?x=1", 5, 400, 10),
    ]);
    // Organic sessions: 2 landing on "/", one of which paid $100; 1 on /blog/revenue with no payment.
    const t = Date.UTC(2026, 9, 10, 12);
    const a = await createSession({
      siteId: site.id,
      startedAt: t,
      channel: "Organic Search",
      entryPath: "/",
    });
    await createSession({
      siteId: site.id,
      startedAt: t + 1,
      channel: "Organic Search",
      entryPath: "/",
    });
    await createSession({
      siteId: site.id,
      startedAt: t + 2,
      channel: "Organic Search",
      entryPath: "/blog/revenue",
    });
    await createPayment({
      siteId: site.id,
      amountMinor: 10000,
      occurredAt: t + 10,
      visitorId: a.visitorId,
      firstSessionId: a.id,
    });
    return { site, cookie };
  }

  it("lists keywords with CTR, weighted position and estimated revenue", async () => {
    const { site, cookie } = await seed();
    const res = await api(
      `/api/v1/search-console?websiteId=${site.id}&startAt=2026-10-01&endAt=2026-10-31`,
      { cookie },
    );
    expect(res.body.data).toEqual([
      {
        query: "datagoat",
        clicks: 40,
        impressions: 400,
        ctr: 10,
        position: 1.8,
        estimatedRevenue: 2000,
      },
      {
        query: "revenue analytics",
        clicks: 5,
        impressions: 400,
        ctr: 1.25,
        position: 10,
        estimatedRevenue: 0,
      },
    ]);
    const pages = await api(
      `/api/v1/search-console?websiteId=${site.id}&startAt=2026-10-01&endAt=2026-10-31&groupBy=page`,
      { cookie },
    );
    expect(pages.body.data[0]).toMatchObject({ page: "https://example.com/", clicks: 40 });
    const blog = await api(
      `/api/v1/search-console?websiteId=${site.id}&startAt=2026-10-01&endAt=2026-10-31&filter_page=contains:/blog`,
      { cookie },
    );
    expect(blog.body.data.map((r: { query: string }) => r.query)).toEqual(["revenue analytics"]);
  });

  it("returns an overview with totals (incl. anonymised queries), series and the previous period", async () => {
    const { site, cookie } = await seed();
    const res = await api(
      `/api/v1/search-console/overview?websiteId=${site.id}&startAt=2026-10-10&endAt=2026-10-11`,
      { cookie },
    );
    expect(res.body.data).toMatchObject({
      currency: "USD",
      clicks: 60,
      impressions: 1500,
      ctr: 4,
      position: 7.7,
      estimatedRevenue: 2000,
      previous: { clicks: 0, impressions: 0 },
    });
    expect(res.body.data.timeseries).toEqual([
      { date: "2026-10-10", clicks: 40, impressions: 1000, ctr: 4, position: 7 },
      { date: "2026-10-11", clicks: 20, impressions: 500, ctr: 4, position: 9 },
    ]);
  });

  it("reports connection status with live properties", async () => {
    const { site, cookie } = await seed();
    await connect(
      site.id,
      "gsc",
      { property: "sc-domain:example.com" },
      { accessToken: "t", expiresAt: null },
    );
    useGlobalFetch(
      mockFetch().on("https://www.googleapis.com/webmasters/v3/sites", () => ({
        siteEntry: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }],
      })),
    );
    const res = await api(`/api/v1/search-console/status?websiteId=${site.id}`, { cookie });
    expect(res.body.data).toMatchObject({
      connected: true,
      oauthConfigured: false,
      property: "sc-domain:example.com",
      properties: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }],
      oldestDay: "2026-10-10",
      newestDay: "2026-10-11",
      backfillComplete: false,
    });
  });
});

describe("Meta Ads", () => {
  it("plans a 90-day backfill in 30-day windows, then refreshes 3 days", () => {
    expect(metaWindow({}, NOW)).toEqual({
      since: "2026-10-06",
      until: "2026-11-04",
      backfill: true,
    });
    expect(metaWindow({ backfilledTo: "2026-10-06" }, NOW)).toEqual({
      since: "2026-09-06",
      until: "2026-10-05",
      backfill: true,
    });
    expect(metaWindow({ backfilledTo: "2026-09-06" }, NOW).since).toBe("2026-08-07");
    expect(metaWindow({ backfilledTo: "2026-08-07" }, NOW)).toEqual({
      since: "2026-08-06",
      until: "2026-08-06",
      backfill: true,
    });
    expect(metaWindow({ backfillDone: true }, NOW)).toEqual({
      since: "2026-11-02",
      until: "2026-11-04",
      backfill: false,
    });
  });

  it("imports daily spend per selected campaign with appsecret_proof", async () => {
    const owner = await createUser();
    const site = await createSite(owner.id);
    await connect(
      site.id,
      "meta_ads",
      { adAccountIds: ["act_1"], campaignIds: ["111"] },
      { accessToken: "EAA-token", expiresAt: null },
    );
    const fetch = mockFetch().on("https://graph.facebook.com/v23.0/act_1/insights", (call) => {
      const url = new URL(call.url);
      expect(url.searchParams.get("level")).toBe("campaign");
      expect(url.searchParams.get("time_increment")).toBe("1");
      expect(JSON.parse(url.searchParams.get("filtering") ?? "[]")[0]).toEqual({
        field: "campaign.id",
        operator: "IN",
        value: ["111"],
      });
      expect(url.searchParams.get("appsecret_proof")).toMatch(/^[0-9a-f]{64}$/);
      return {
        data: [
          {
            campaign_id: "111",
            campaign_name: "Black Friday",
            date_start: "2026-11-01",
            spend: "120.50",
            impressions: "10000",
            clicks: "300",
            reach: "8000",
            account_currency: "USD",
            action_values: [
              { action_type: "purchase", value: "400" },
              { action_type: "omni_purchase", value: "400" },
            ],
          },
        ],
      };
    });
    const e = { ...env, META_APP_SECRET: "meta-secret" } as Cloudflare.Env;
    await syncMeta(jobCtx({ now: NOW, fetch, env: e }));
    const row = await env.DB.prepare("SELECT * FROM ad_spend_daily").first();
    expect(row).toMatchObject({
      account_id: "act_1",
      campaign_id: "111",
      campaign_name: "Black Friday",
      spend_minor: 12050,
      clicks: 300,
      purchase_value_minor: 40000,
    });
    const m = meterEnv();
    await syncMeta(jobCtx({ now: NOW + 3_600_000, fetch, env: { ...e, DB: m.db }, db: m.db }));
    expect(m.d1.rowsWritten).toBe(1); // unchanged spend: only the status row
  });

  it("joins spend with attributed revenue per campaign (ROAS)", async () => {
    const owner = await createUser();
    const site = await createSite(owner.id);
    const cookie = await sessionCookie(owner.id);
    await connect(
      site.id,
      "meta_ads",
      { adAccountIds: ["act_1"], campaignIds: ["111", "222"] },
      { accessToken: "x" },
    );
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO ad_spend_daily (site_id, platform, account_id, campaign_id, day, campaign_name, currency, spend_minor, impressions, clicks) VALUES (?, 'meta', 'act_1', '111', '2026-10-10', 'Black Friday', 'USD', 10000, 1000, 50)",
      ).bind(site.id),
      env.DB.prepare(
        "INSERT INTO ad_spend_daily (site_id, platform, account_id, campaign_id, day, campaign_name, currency, spend_minor, impressions, clicks) VALUES (?, 'meta', 'act_1', '222', '2026-09-01', 'Retargeting', 'USD', 5000, 100, 5)",
      ).bind(site.id),
    ]);
    const t = Date.UTC(2026, 9, 10, 12);
    const byId = await createSession({
      siteId: site.id,
      startedAt: t,
      utm: { utm_source: "facebook", utm_campaign: "111" },
    });
    const byName = await createSession({
      siteId: site.id,
      startedAt: t + 1,
      utm: { utm_source: "meta", utm_medium: "paid-social", utm_campaign: "black friday" },
    });
    const partial = await createSession({
      siteId: site.id,
      startedAt: t + 2,
      utm: { utm_source: "ig", utm_campaign: "2026-retargeting-us" },
    });
    await createSession({
      siteId: site.id,
      startedAt: t + 3,
      utm: { utm_source: "google", utm_campaign: "111" },
    });
    await createPayment({
      siteId: site.id,
      amountMinor: 20000,
      occurredAt: t + 100,
      visitorId: byId.visitorId,
      firstSessionId: byId.id,
    });
    await createPayment({
      siteId: site.id,
      amountMinor: 5000,
      occurredAt: t + 100,
      visitorId: byName.visitorId,
      firstSessionId: byName.id,
    });
    await createPayment({
      siteId: site.id,
      amountMinor: 1000,
      occurredAt: t + 100,
      visitorId: partial.visitorId,
      firstSessionId: partial.id,
    });

    const res = await api(
      `/api/v1/ads/campaigns?websiteId=${site.id}&startAt=2026-10-01&endAt=2026-10-31`,
      { cookie },
    );
    expect(res.body.data).toEqual([
      {
        platform: "meta",
        accountId: "act_1",
        campaignId: "111",
        campaignName: "Black Friday",
        spend: 100,
        impressions: 1000,
        clicks: 50,
        visitors: 2,
        revenue: 250,
        payments: 2,
        roas: 2.5,
        metaPurchaseValue: null,
      },
      {
        platform: "meta",
        accountId: "act_1",
        campaignId: "222",
        campaignName: "Retargeting",
        spend: 0,
        impressions: 0,
        clicks: 0,
        visitors: 1,
        revenue: 10,
        payments: 1,
        roas: null,
        metaPurchaseValue: null,
      },
    ]);
    const summary = await api(
      `/api/v1/ads/summary?websiteId=${site.id}&startAt=2026-10-01&endAt=2026-10-31`,
      { cookie },
    );
    expect(summary.body.data).toMatchObject({
      currency: "USD",
      spend: 100,
      revenue: 260,
      roas: 2.6,
      campaigns: 2,
      visitors: 3,
      payments: 3,
    });
  });

  it("lists ad accounts and campaigns from Meta", async () => {
    const owner = await createUser();
    const site = await createSite(owner.id);
    await connect(site.id, "meta_ads", {}, { accessToken: "x" });
    useGlobalFetch(
      mockFetch()
        .on("https://graph.facebook.com/v23.0/me/adaccounts", () => ({
          data: [{ id: "act_1", name: "Main", currency: "EUR", account_status: 1 }],
        }))
        .on("https://graph.facebook.com/v23.0/act_1/campaigns", () => ({
          data: [{ id: "111", name: "Black Friday", effective_status: "ACTIVE" }],
        })),
    );
    const res = await api(`/api/v1/ads/accounts?websiteId=${site.id}`, {
      cookie: await sessionCookie(owner.id),
    });
    expect(res.body.data).toEqual([
      {
        id: "act_1",
        name: "Main",
        currency: "EUR",
        accountStatus: 1,
        campaigns: [{ id: "111", name: "Black Friday", status: "ACTIVE" }],
      },
    ]);
  });
});
