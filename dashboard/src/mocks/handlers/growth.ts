/** W3 (revenue), W6 (growth) and W7 (OAuth connections) endpoints. */
import { http } from "msw";
import { paymentsFor } from "../fixtures/dashboard";
import * as g from "../fixtures/growth";
import { revenueFor } from "../fixtures/model";
import { consentDetails, MOCK_CONSENT_REQUEST, MOCK_REDIRECT } from "../fixtures/oauth";
import { state } from "../state";
import { w6Handlers } from "./growth-w6";
import { fail, list, ok } from "./util";

const W = "/api/v1/admin/websites/:websiteId";

export const growthHandlers = [
  // Growth (W6): alerts, bot traffic, mentions, integrations, Search Console, ads, imports.
  ...w6Handlers,

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
  http.get("/api/v1/analytics/revenue/sources", ({ request }) => {
    const url = new URL(request.url);
    return ok(
      g.revenueSources,
      {
        currency: "USD",
        groupBy: url.searchParams.get("groupBy") ?? "channel",
        model: url.searchParams.get("model") ?? "first_touch",
      },
      { limit: 100, offset: 0, total: g.revenueSources.length, hasMore: false },
    );
  }),
  http.get("/api/v1/analytics/revenue/path-to-purchase", () => ok(g.pathToPurchase)),
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

  // MCP OAuth connected apps (W7)
  http.get("/api/v1/admin/oauth/connections", () => ok(g.oauthConnections)),
  http.delete("/api/v1/admin/oauth/connections/:id", () => ok([{ message: "Access revoked" }])),
  http.get("/oauth/consent/details", ({ request }) =>
    new URL(request.url).searchParams.get("request") === MOCK_CONSENT_REQUEST
      ? ok(consentDetails(state.signedIn, state.websites))
      : fail(410, "This authorization request expired. Start again from your app."),
  ),
  http.post("/oauth/authorize", async ({ request }) => {
    if (!state.signedIn) return fail(401, "Sign in to approve this app");
    const body = (await request.json()) as { approve: boolean; scopes?: string[] };
    const url = new URL(MOCK_REDIRECT);
    if (body.approve) url.searchParams.set("code", "dgac_mock");
    else url.searchParams.set("error", "access_denied");
    url.searchParams.set("state", "mock-state");
    return ok({ redirectTo: url.toString() });
  }),
];
