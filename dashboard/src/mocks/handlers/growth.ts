/** W3 (revenue), W6 (growth) and W7 (OAuth connections) endpoints. */
import { http } from "msw";
import * as g from "../fixtures/growth";
import { w6Handlers } from "./growth-w6";
import { list, ok } from "./util";

const W = "/api/v1/admin/websites/:websiteId";

export const growthHandlers = [
  // Growth (W6): alerts, bot traffic, mentions, integrations, Search Console, ads, imports.
  ...w6Handlers,

  // Revenue (W3)
  http.get("/api/v1/payments", ({ request }) => list(g.payments, new URL(request.url))),
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
  http.get("/api/v1/analytics/revenue", () => ok(g.revenueSummary)),
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
];
