/**
 * Stateful mocks for the settings pages (W5): payment-provider and growth integrations, share
 * link, MCP connections, install verification and the /cdn-cgi/trace IP lookup. Listed before the
 * other handler groups so the settings pages see their own writes; other areas' fixtures remain.
 */
import { http } from "msw";
import type {
  GrowthIntegrationStatus,
  IntegrationsStatus,
  PaymentProvider,
} from "../../../../shared/api-types";
import * as f from "../fixtures/analytics";
import { integrationsOf, isNewSite, state } from "../state";
import { fail, ok } from "./util";

const W = "/api/v1/admin/websites/:websiteId";

/** Growth integration slugs: served by handlers/growth-w6.ts, so the generic routes skip them. */
const GROWTH_KINDS: Record<string, GrowthIntegrationStatus["kind"]> = {
  github: "github",
  "google-search-console": "gsc",
  "meta-ads": "meta_ads",
  x: "x",
};

const PROVIDERS: readonly PaymentProvider[] = [
  "stripe",
  "polar",
  "lemonsqueezy",
  "paddle",
  "dodo",
  "creem",
  "shopify",
  "woocommerce",
];

const NAMES: Record<PaymentProvider, string> = {
  stripe: "Stripe",
  polar: "Polar",
  lemonsqueezy: "Lemon Squeezy",
  paddle: "Paddle",
  dodo: "Dodo Payments",
  creem: "Creem",
  shopify: "Shopify",
  woocommerce: "WooCommerce",
};

/** The credential checks the real providers fail on, so error states can be exercised. */
function credentialError(provider: PaymentProvider, body: Record<string, string>): string | null {
  if (provider === "stripe" && !body.stripeRak?.startsWith("rk_"))
    return "Use a Stripe restricted key (rk_...)";
  if (provider === "stripe" && body.stripeRak?.includes("invalid"))
    return "Stripe rejected the key: Invalid API Key provided";
  if (provider === "paddle" && !body.paddleApiKey?.startsWith("pdl_live_"))
    return "Paddle API keys start with pdl_live_";
  return null;
}

function setConnected(status: IntegrationsStatus, provider: PaymentProvider, connected: boolean) {
  const entries = status as unknown as Record<string, { connected: boolean } | undefined>;
  entries[provider] = { ...entries[provider], connected };
}

const share = (siteId: string) => {
  const w = state.websites.find((x) => x._id === siteId);
  const link = f.shareLink(w?.shareToken ?? null);
  return { ...link, isPublicDataEnabled: w?.isPublicDataEnabled ?? false };
};

export const settingsHandlers = [
  // Growth integrations (GitHub, Search Console, Meta Ads, X) are served by the growth
  // mocks (handlers/growth-w6.ts), which own that state, so both pages agree.

  // Payment providers (W3 endpoints)
  http.get(`${W}/integrations`, ({ params }) => ok([integrationsOf(String(params.websiteId))])),
  http.post(`${W}/integrations/:provider`, async ({ params, request }) => {
    if (String(params.provider) in GROWTH_KINDS) return; // falls through to the growth mocks
    const provider = String(params.provider) as PaymentProvider;
    if (!PROVIDERS.includes(provider)) return fail(404, `Unknown provider ${provider}`);
    const body = (await request.json()) as Record<string, string>;
    const problem = credentialError(provider, body);
    if (problem) return fail(400, problem);
    const status = integrationsOf(String(params.websiteId));
    setConnected(status, provider, true);
    status.details = [
      ...(status.details ?? []).filter((d) => d.provider !== provider),
      {
        provider,
        status: "active",
        accountName: `${NAMES[provider]} account`,
        lastSyncedAt: null,
        lastError: null,
        backfillComplete: false,
      },
    ];
    return ok([{ message: `${NAMES[provider]} connected successfully`, currency: "EUR" }]);
  }),
  http.patch(`${W}/integrations/:provider`, ({ params }) => {
    if (String(params.provider) in GROWTH_KINDS) return; // falls through to the growth mocks
    const provider = String(params.provider) as PaymentProvider;
    const status = integrationsOf(String(params.websiteId));
    const detail = status.details?.find((d) => d.provider === provider);
    if (!status[provider]?.connected) return fail(404, `${NAMES[provider]} is not connected`);
    if (detail) detail.lastSyncedAt = new Date().toISOString();
    return ok([{ message: `${NAMES[provider]} payment re-sync queued` }]);
  }),
  http.delete(`${W}/integrations/:provider`, ({ params }) => {
    if (String(params.provider) in GROWTH_KINDS) return; // falls through to the growth mocks
    const provider = String(params.provider) as PaymentProvider;
    const status = integrationsOf(String(params.websiteId));
    if (!status[provider]?.connected) return fail(404, `${NAMES[provider]} is not connected`);
    setConnected(status, provider, false);
    status.details = (status.details ?? []).filter((d) => d.provider !== provider);
    return ok([{ message: `${NAMES[provider]} disconnected successfully` }]);
  }),

  // Share link (W2 endpoints) backed by the website's share token.
  http.get(`${W}/share`, ({ params }) => ok(share(String(params.websiteId)))),
  http.post(`${W}/share`, ({ params }) => {
    const w = state.websites.find((x) => x._id === params.websiteId);
    if (!w) return fail(404, "Website not found");
    w.shareToken = `share_${Math.random().toString(36).slice(2, 12)}`;
    w.isPublicDashboardEnabled = true;
    return ok(share(w._id));
  }),
  http.delete(`${W}/share`, ({ params }) => {
    const w = state.websites.find((x) => x._id === params.websiteId);
    if (!w) return fail(404, "Website not found");
    w.shareToken = null;
    w.isPublicDashboardEnabled = false;
    return ok(share(w._id));
  }),

  // MCP connected apps (W7 endpoints)
  http.get("/api/v1/admin/oauth/connections", () => ok(state.oauthConnections)),
  http.delete("/api/v1/admin/oauth/connections/:id", ({ params }) => {
    state.oauthConnections = state.oauthConnections.filter((c) => c.id !== params.id);
    return ok([{ message: "Access revoked" }]);
  }),

  // Install verification for websites added in this session: no data until the third poll.
  http.get("/api/v1/analytics/realtime", ({ request }) => {
    const id = new URL(request.url).searchParams.get("websiteId") ?? "";
    if (!isNewSite(id)) return undefined;
    state.installPolls[id] = (state.installPolls[id] ?? 0) + 1;
    return ok([{ visitors: state.installPolls[id] >= 3 ? 1 : 0 }]);
  }),
  http.get("/api/v1/analytics/overview", ({ request }) => {
    const id = new URL(request.url).searchParams.get("websiteId") ?? "";
    if (!isNewSite(id)) return undefined;
    return ok([{ ...f.overview, visitors: 0, pageviews: 0, sessions: 0, revenue: 0 }]);
  }),

  // Cloudflare's trace endpoint (the "Add my current IP" button).
  http.get("/cdn-cgi/trace", () => new Response("fl=1\nh=localhost\nip=203.0.113.9\nts=0\n")),
];
