/** W3 (revenue), W6 (growth) and W7 (OAuth connections) endpoints. */
import { http } from "msw";
import { websites } from "../fixtures/core";
import { commitsFor, paymentsFor } from "../fixtures/dashboard";
import * as g from "../fixtures/growth";
import { revenueFor } from "../fixtures/model";
import { list, ok } from "./util";

const W = "/api/v1/admin/websites/:websiteId";
const domainOf = (id: unknown) => websites.find((w) => w._id === id)?.domain ?? "example.com";

export const growthHandlers = [
  // Growth integrations (W6) — before the payment provider handlers so they win.
  ...(["github", "google-search-console", "meta-ads", "x"] as const).flatMap((k) => {
    const kind = k === "google-search-console" ? "gsc" : k === "meta-ads" ? "meta_ads" : k;
    return [
      http.get(`${W}/integrations/${k}`, () => ok(g.growthIntegration(kind))),
      http.put(`${W}/integrations/${k}`, () =>
        ok({ ...g.growthIntegration(kind), connected: true, status: "active" }),
      ),
      http.delete(`${W}/integrations/${k}`, () =>
        ok({ ...g.growthIntegration(kind), connected: false, status: "disconnected" }),
      ),
    ];
  }),

  // Revenue (W3)
  http.get("/api/v1/payments", ({ request }) => {
    const url = new URL(request.url);
    return list(paymentsFor(url), url);
  }),
  http.post("/api/v1/payments", async ({ request }) => {
    const body = (await request.json()) as { transaction_id: string };
    return new Response(
      JSON.stringify({
        message: "Payment recorded and attributed successfully",
        transaction_id: body.transaction_id,
      }),
      {
        headers: { "content-type": "application/json" },
      },
    );
  }),
  http.delete("/api/v1/payments", () => ok([{ message: "Payment deleted successfully" }])),
  http.get("/api/v1/analytics/revenue", ({ request }) => ok(revenueFor(new URL(request.url)))),
  http.get(`${W}/integrations`, () => ok([g.integrations])),
  http.post(`${W}/integrations/:provider`, ({ params }) =>
    ok([{ message: `${String(params.provider)} connected successfully`, currency: "USD" }]),
  ),
  http.patch(`${W}/integrations/:provider`, ({ params }) =>
    ok([{ message: `${String(params.provider)} payment re-sync queued` }]),
  ),
  http.delete(`${W}/integrations/:provider`, ({ params }) =>
    ok([{ message: `${String(params.provider)} disconnected successfully` }]),
  ),

  // Alerts (W6)
  http.get(`${W}/alerts`, ({ params }) => ok(g.alerts(String(params.websiteId)))),
  http.post(`${W}/alerts`, async ({ params, request }) =>
    ok([
      {
        ...g.alerts(String(params.websiteId))[0],
        ...((await request.json()) as object),
        id: `alert_${Date.now()}`,
      },
    ]),
  ),
  http.get(`${W}/alerts/history`, () =>
    ok(g.alertHistory, { counts: { sent: 1, failed: 0, total: 1 } }),
  ),
  http.put(`${W}/alerts/:alertId`, async ({ params, request }) =>
    ok([{ ...g.alerts(String(params.websiteId))[0], ...((await request.json()) as object) }]),
  ),
  http.delete(`${W}/alerts/:alertId`, () => ok([{ message: "Alert deleted successfully" }])),
  http.post(`${W}/alerts/:alertId/test`, () => ok([{ message: "Test alert sent" }])),

  // Bot traffic (W6)
  http.get("/api/v1/analytics/bot-traffic", ({ request }) => {
    const id = new URL(request.url).searchParams.get("websiteId") ?? websites[0]?._id;
    return ok([g.botSummary(String(id), domainOf(id))]);
  }),
  http.get("/api/v1/analytics/bot-traffic/pages", ({ request }) =>
    ok(
      g.botPages,
      {
        context: {
          websiteId: new URL(request.url).searchParams.get("websiteId"),
          domain: "example.com",
        },
      },
      { limit: 50, offset: 0, total: 1, hasMore: false, nextOffset: null },
    ),
  ),
  http.get("/api/v1/admin/bot-traffic/usage", () =>
    ok([
      {
        usage: {
          usage: 12840,
          dropped: 0,
          allowance: null,
          remaining: null,
          percentUsed: 0,
          periodStartAt: null,
          resetAt: null,
          isCounting: false,
        },
        websiteStats: [],
      },
    ]),
  ),
  http.get(`${W}/bot-traffic/settings`, ({ params }) =>
    ok([
      {
        websiteId: params.websiteId,
        domain: domainOf(params.websiteId),
        settings: g.botSettings,
        crawlerCatalog: [],
      },
    ]),
  ),
  http.patch(`${W}/bot-traffic/settings`, async ({ params, request }) =>
    ok([
      {
        websiteId: params.websiteId,
        domain: domainOf(params.websiteId),
        settings: { ...g.botSettings, ...((await request.json()) as object) },
        crawlerCatalog: [],
      },
    ]),
  ),
  http.get(`${W}/bot-traffic/token`, ({ params }) =>
    ok([g.botToken(String(params.websiteId), domainOf(params.websiteId))]),
  ),
  http.post(`${W}/bot-traffic/token`, ({ params }) =>
    ok([
      {
        ...g.botToken(String(params.websiteId), domainOf(params.websiteId)),
        hasToken: true,
        displayToken: "dfbot_abcd...wxyz",
        requestAuthToken: "dfbot_mockShownOnce",
      },
    ]),
  ),
  http.put(`${W}/bot-traffic/token`, ({ params }) =>
    ok([
      {
        ...g.botToken(String(params.websiteId), domainOf(params.websiteId)),
        hasToken: true,
        displayToken: "dfbot_efgh...wxyz",
        requestAuthToken: "dfbot_mockRotated",
      },
    ]),
  ),
  http.delete(`${W}/bot-traffic/token`, ({ params }) =>
    ok([g.botToken(String(params.websiteId), domainOf(params.websiteId))]),
  ),

  // Mentions, X links, GitHub, Search Console, ads (W6)
  http.get("/api/v1/mentions", ({ request }) => {
    const url = new URL(request.url);
    const rows = g.mentions(url.searchParams.get("websiteId") ?? String(websites[0]?._id));
    return ok(
      rows,
      {
        meta: {
          totalMentions: rows.length,
          sampled: false,
          mentionLimit: null,
          timezone: "UTC",
          startAt: null,
          endAt: null,
        },
      },
      { limit: 100, offset: 0, total: rows.length, hasMore: false },
    );
  }),
  http.get("/api/v1/x/links", ({ request }) => list(g.xLinks, new URL(request.url))),
  http.get("/api/v1/github/commits", ({ request }) => list(commitsFor(), new URL(request.url))),
  http.get("/api/v1/search-console", ({ request }) => list(g.searchConsole, new URL(request.url))),
  http.get("/api/v1/ads/campaigns", ({ request }) => list(g.adCampaigns, new URL(request.url))),
  http.get("/api/v1/ads/summary", () =>
    ok({ currency: "USD", spend: 500, revenue: 1400, roas: 2.8, campaigns: 1 }),
  ),

  // Imports (W6)
  http.get(`${W}/imports`, ({ params }) => ok(g.imports(String(params.websiteId)))),
  http.post(`${W}/imports`, ({ params }) =>
    ok([
      {
        ...g.imports(String(params.websiteId))[0],
        id: `imp_${Date.now()}`,
        status: "pending",
        rowsImported: 0,
      },
    ]),
  ),
  http.get(`${W}/imports/:importId`, ({ params }) =>
    ok([{ ...g.imports(String(params.websiteId))[0], id: params.importId }]),
  ),
  http.delete(`${W}/imports/:importId`, ({ params }) =>
    ok([{ ...g.imports(String(params.websiteId))[0], id: params.importId, status: "cancelled" }]),
  ),
  http.post(`${W}/imports/:importId/rows`, () => ok([{ accepted: 1000 }])),
  http.post(`${W}/imports/:importId/complete`, ({ params }) =>
    ok([{ ...g.imports(String(params.websiteId))[0], id: params.importId }]),
  ),

  // MCP OAuth connected apps (W7)
  http.get("/api/v1/admin/oauth/connections", () => ok(g.oauthConnections)),
  http.delete("/api/v1/admin/oauth/connections/:id", () => ok([{ message: "Access revoked" }])),
];
