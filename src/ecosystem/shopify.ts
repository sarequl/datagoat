/**
 * Shopify app (DataFast parity: "Add DataFast to your Shopify store"):
 *
 *   POST /api/apps/shopify/connect?websiteId=   {shop, clientId, clientSecret, grant?}
 *        grant "client_credentials" (default, DataFast's flow) connects at once;
 *        grant "authorization_code" stores the app credentials and returns an install URL.
 *   GET  /api/apps/shopify/install?websiteId=   302 to Shopify's OAuth consent screen
 *   GET  /api/apps/shopify/callback             OAuth redirect: verify HMAC + state, exchange the code
 *   POST /api/apps/shopify/webhooks             app/uninstalled and the GDPR compliance topics
 *   GET  /api/apps/shopify/pixel.js?websiteId=  custom-pixel code to paste into Shopify (optional)
 *
 * Connecting reads the shop, registers order webhooks to W3's /webhooks/shopify/:siteId, installs
 * the storefront loader (/apps/shopify.js, a static asset) as a ScriptTag, and stores an encrypted
 * provider_connections row (provider "shopify") that W3's adapter uses for orders and refunds.
 */
import { type Context, Hono } from "hono";
import { z } from "zod";
import { getAccess } from "../auth/context";
import { authenticate, requireSiteAccess, sameOriginGuard } from "../auth/middleware";
import { decryptString } from "../lib/crypto";
import { ApiError } from "../lib/errors";
import { log } from "../lib/log";
import { success } from "../lib/response";
import { siteCache } from "../lib/site-cache";
import type { Site } from "../lib/sites";
import { parseJsonBody } from "../lib/validate";
import type { AppEnv } from "../types";
import { connectionAad, loadConnection, upsertConnection } from "./connections";
import {
  authorizeUrl,
  clientCredentialsToken,
  exchangeCode,
  normalizeShop,
  ShopifyError,
  type ShopifyToken,
  setupShop,
  verifyOAuthHmac,
  verifyWebhookHmac,
} from "./shopify-api";
import { shopifyPixelCode } from "./shopify-pixel";
import { signState, verifyState } from "./signed-state";

export interface ShopifyCredentials {
  shop: string;
  clientId: string;
  clientSecret: string;
  grant: "client_credentials" | "authorization_code";
  accessToken: string | null;
  /** Epoch ms; null = offline token that does not expire. */
  accessTokenExpiresAt: number | null;
  scope: string;
}

const STATE_PURPOSE = "shopify-oauth";
const STATE_TTL_MS = 15 * 60_000;

export const shopifyRoutes = new Hono<AppEnv>();

function origin(c: Context<AppEnv>): string {
  return new URL(c.req.url).origin;
}

function integrationsUrl(siteId: string, outcome: "connected" | "error", message?: string) {
  const q = new URLSearchParams({ shopify: outcome, ...(message ? { message } : {}) });
  return `/app/${siteId}/integrations?${q.toString()}`;
}

/** Shop setup + connection row, shared by both grants. */
async function finishConnect(
  c: Context<AppEnv>,
  site: Site,
  creds: Omit<ShopifyCredentials, "accessToken" | "accessTokenExpiresAt" | "scope">,
  token: ShopifyToken,
) {
  const setup = await setupShop(fetch, {
    shop: creds.shop,
    token: token.accessToken,
    siteId: site.id,
    trackingId: site.publicId,
    origin: origin(c),
  });
  const credentials: ShopifyCredentials = {
    ...creds,
    accessToken: token.accessToken,
    accessTokenExpiresAt: token.expiresAt,
    scope: token.scope,
  };
  await upsertConnection(c.env, {
    siteId: site.id,
    provider: "shopify",
    credentials: credentials as unknown as Record<string, unknown>,
    // Shopify signs webhooks with the app's client secret.
    webhookSecret: creds.clientSecret,
    status: "active",
    accountId: creds.shop,
    accountName: setup.shop.name,
    currency: setup.shop.currency,
    settings: {
      grant: creds.grant,
      storefrontDomain: setup.shop.domain,
      scriptTagId: setup.scriptTagId,
      webhookIds: setup.webhookIds,
    },
    lastError: setup.errors.length ? setup.errors.join("; ").slice(0, 500) : null,
  });
  const warnings = [...setup.errors];
  const host = setup.shop.domain.replace(/^www\./, "");
  if (host !== site.domain && !host.endsWith(`.${site.domain}`)) {
    warnings.push(
      `The storefront domain ${setup.shop.domain} is not ${site.domain}: add it to the website's allowed hostnames.`,
    );
  }
  return { setup, warnings };
}

const ConnectBody = z
  .object({
    shop: z.string().min(1).max(255),
    clientId: z.string().trim().min(8).max(200),
    clientSecret: z.string().trim().min(8).max(200),
    grant: z.enum(["client_credentials", "authorization_code"]).optional(),
  })
  .strict();

shopifyRoutes.post(
  "/api/apps/shopify/connect",
  sameOriginGuard,
  authenticate,
  requireSiteAccess("settings:write"),
  async (c) => {
    const { site } = getAccess(c);
    const body = await parseJsonBody(c, ConnectBody, { maxBytes: 4096 });
    const shop = normalizeShop(body.shop);
    if (!shop) throw new ApiError(400, "shop: use your store's xxx.myshopify.com domain");
    const grant = body.grant ?? "client_credentials";
    const base = { shop, clientId: body.clientId, clientSecret: body.clientSecret, grant };
    if (grant === "authorization_code") {
      await upsertConnection(c.env, {
        siteId: site.id,
        provider: "shopify",
        credentials: { ...base, accessToken: null, accessTokenExpiresAt: null, scope: "" },
        webhookSecret: body.clientSecret,
        status: "pending",
        accountId: shop,
        accountName: null,
        currency: null,
        settings: { grant },
      });
      return success(c, [
        {
          status: "pending",
          shop,
          installUrl: `${origin(c)}/api/apps/shopify/install?websiteId=${site.id}`,
          redirectUrl: `${origin(c)}/api/apps/shopify/callback`,
        },
      ]);
    }
    let token: ShopifyToken;
    try {
      token = await clientCredentialsToken(fetch, shop, body.clientId, body.clientSecret);
    } catch (err) {
      if (err instanceof ShopifyError) throw new ApiError(400, err.message);
      throw new ApiError(502, `Could not reach ${shop}`);
    }
    try {
      const { setup, warnings } = await finishConnect(c, site, base, token);
      return success(c, [
        {
          status: "active",
          message: "Shopify connected",
          shop,
          shopName: setup.shop.name,
          currency: setup.shop.currency,
          scriptTagInstalled: setup.scriptTagId !== null,
          webhooks: Object.keys(setup.webhookIds),
          warnings,
        },
      ]);
    } catch (err) {
      if (err instanceof ShopifyError) throw new ApiError(400, err.message);
      throw err;
    }
  },
);

shopifyRoutes.get(
  "/api/apps/shopify/install",
  authenticate,
  requireSiteAccess("settings:write"),
  async (c) => {
    const { site, user } = getAccess(c);
    const conn = await loadConnection<ShopifyCredentials>(c.env, "shopify", site.id);
    if (!conn) {
      throw new ApiError(
        400,
        "Save the Shopify app's client id and secret first (POST /api/apps/shopify/connect)",
      );
    }
    const state = await signState(
      c.env.SESSION_SECRET,
      STATE_PURPOSE,
      { s: site.id, u: user.id, shop: conn.credentials.shop },
      STATE_TTL_MS,
    );
    return c.redirect(
      authorizeUrl(
        conn.credentials.shop,
        conn.credentials.clientId,
        `${origin(c)}/api/apps/shopify/callback`,
        state,
      ),
      302,
    );
  },
);

shopifyRoutes.get("/api/apps/shopify/callback", async (c) => {
  const query = new URL(c.req.url).searchParams;
  const state = await verifyState(c.env.SESSION_SECRET, STATE_PURPOSE, query.get("state") ?? "");
  if (!state || typeof state.s !== "string") {
    throw new ApiError(400, "Invalid or expired install link. Start the Shopify connection again.");
  }
  const siteId = state.s;
  const site = await siteCache.byId(c.env.DB, siteId);
  if (!site) throw new ApiError(404, "Website not found");
  const conn = await loadConnection<ShopifyCredentials>(c.env, "shopify", siteId);
  const shop = normalizeShop(query.get("shop") ?? "");
  if (!conn || !shop || shop !== state.shop || shop !== conn.credentials.shop) {
    return c.redirect(integrationsUrl(siteId, "error", "Shop does not match"), 302);
  }
  if (!(await verifyOAuthHmac(query, conn.credentials.clientSecret))) {
    throw new ApiError(401, "Invalid Shopify signature");
  }
  const code = query.get("code");
  if (!code) return c.redirect(integrationsUrl(siteId, "error", "Install was cancelled"), 302);
  try {
    const token = await exchangeCode(
      fetch,
      shop,
      conn.credentials.clientId,
      conn.credentials.clientSecret,
      code,
    );
    const { clientId, clientSecret } = conn.credentials;
    await finishConnect(
      c,
      site,
      { shop, clientId, clientSecret, grant: "authorization_code" },
      token,
    );
  } catch (err) {
    log.warn("shopify.callback_failed", { siteId, error: String((err as Error).message) });
    return c.redirect(integrationsUrl(siteId, "error", "Shopify did not accept the install"), 302);
  }
  return c.redirect(integrationsUrl(siteId, "connected"), 302);
});

// ---------------------------------------------------------------------------
// Webhooks: app lifecycle + mandatory compliance topics
// ---------------------------------------------------------------------------

interface CustomerRedact {
  customer?: { id?: number | string; email?: string };
  orders_to_redact?: Array<number | string>;
}

shopifyRoutes.post("/api/apps/shopify/webhooks", async (c) => {
  const raw = await c.req.text();
  if (raw.length > 256 * 1024) throw new ApiError(413, "Webhook body too large");
  const hmac = c.req.header("x-shopify-hmac-sha256") ?? "";
  const topic = c.req.header("x-shopify-topic") ?? "";
  const shop = normalizeShop(c.req.header("x-shopify-shop-domain") ?? "");
  if (!hmac || !shop) throw new ApiError(401, "Missing Shopify webhook headers");
  const rows = await c.env.DB.prepare(
    "SELECT site_id, webhook_secret_enc FROM provider_connections WHERE provider = 'shopify' AND account_id = ?",
  )
    .bind(shop)
    .all<{ site_id: string; webhook_secret_enc: string | null }>();
  const verified: string[] = [];
  for (const row of rows.results ?? []) {
    if (!row.webhook_secret_enc) continue;
    const secret = await decryptString(
      c.env.ENCRYPTION_KEY,
      row.webhook_secret_enc,
      connectionAad("shopify", row.site_id),
    ).catch(() => null);
    if (secret && (await verifyWebhookHmac(raw, hmac, secret))) verified.push(row.site_id);
  }
  if (verified.length === 0) throw new ApiError(401, "Invalid Shopify webhook signature");

  let payload: unknown = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new ApiError(400, "Invalid JSON body");
  }
  const db = c.env.DB;
  const now = Date.now();
  const sites = JSON.stringify(verified);
  const statements: D1PreparedStatement[] = [];
  switch (topic) {
    case "app/uninstalled":
      statements.push(
        db
          .prepare(
            `UPDATE provider_connections SET status = 'disconnected', last_error = ?, updated_at = ?
              WHERE provider = 'shopify' AND site_id IN (SELECT value FROM json_each(?))`,
          )
          .bind("The app was uninstalled from Shopify", now, sites),
      );
      break;
    case "shop/redact":
      // 48 hours after uninstall: forget the store's credentials and its customers' PII.
      statements.push(
        db
          .prepare(
            "DELETE FROM provider_connections WHERE provider = 'shopify' AND site_id IN (SELECT value FROM json_each(?))",
          )
          .bind(sites),
        db
          .prepare(
            `UPDATE payments SET customer_email = NULL, customer_name = NULL, email_hash = NULL, updated_at = ?
              WHERE provider = 'shopify' AND site_id IN (SELECT value FROM json_each(?))
                AND (customer_email IS NOT NULL OR customer_name IS NOT NULL OR email_hash IS NOT NULL)`,
          )
          .bind(now, sites),
      );
      break;
    case "customers/redact": {
      const body = payload as CustomerRedact;
      const orderIds = (body.orders_to_redact ?? []).flatMap((id) => [
        String(id),
        `gid://shopify/Order/${id}`,
      ]);
      const customerId = body.customer?.id === undefined ? null : String(body.customer.id);
      statements.push(
        db
          .prepare(
            `UPDATE payments SET customer_email = NULL, customer_name = NULL, email_hash = NULL, updated_at = ?4
              WHERE provider = 'shopify' AND site_id IN (SELECT value FROM json_each(?1))
                AND (provider_txn_id IN (SELECT value FROM json_each(?2))
                     OR (?3 IS NOT NULL AND provider_customer_id IN (?3, 'gid://shopify/Customer/' || ?3)))`,
          )
          .bind(sites, JSON.stringify(orderIds), customerId, now),
      );
      break;
    }
    case "customers/data_request":
      // DataGoat stores at most the customer's email and name on payment rows; the merchant can
      // export them from the dashboard. Nothing to send back to Shopify.
      log.info("shopify.data_request", { shop });
      break;
    default:
      log.info("shopify.webhook_ignored", { topic });
  }
  if (statements.length) await db.batch(statements);
  return success(c, { received: true });
});

// ---------------------------------------------------------------------------
// Custom pixel code (copy into Shopify admin → Settings → Customer events)
// ---------------------------------------------------------------------------

shopifyRoutes.get("/api/apps/shopify/pixel.js", async (c) => {
  const id = c.req.query("websiteId") ?? "";
  const site = id
    ? ((await siteCache.byPublicId(c.env.DB, id)) ?? (await siteCache.byId(c.env.DB, id)))
    : null;
  if (!site) throw new ApiError(404, "Website not found");
  return c.body(
    shopifyPixelCode({ origin: origin(c), trackingId: site.publicId, domain: site.domain }),
    200,
    {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  );
});
