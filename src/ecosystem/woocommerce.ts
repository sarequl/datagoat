/**
 * WooCommerce connect (DataFast parity: "Connect WooCommerce" → approve in WordPress → done).
 * Uses WooCommerce's built-in REST API key authorization (`/wc-auth/v1/authorize`):
 *
 *   GET  /api/apps/woocommerce/connect?websiteId=&storeUrl=   302 to the store's approval screen
 *        (`&format=json` returns `[{authorizeUrl}]` instead, for the dashboard)
 *   POST /api/apps/woocommerce/connect                        WooCommerce posts the new keys here
 *        {key_id, user_id, consumer_key, consumer_secret, key_permissions}; `user_id` carries our
 *        signed state (website, user, store, expiry).
 *
 * The keys are stored encrypted in provider_connections (provider "woocommerce") for W3's adapter.
 * After answering WooCommerce, the Worker reads the store currency and registers order webhooks to
 * W3's /webhooks/woocommerce/:siteId, signed with a fresh secret kept in webhook_secret_enc.
 * The DataGoat WordPress plugin stores the visitor on each order as `_datagoat_visitor_id`.
 */
import { type Context, Hono } from "hono";
import { z } from "zod";
import { getAccess } from "../auth/context";
import { authenticate, requireSiteAccess } from "../auth/middleware";
import { ApiError } from "../lib/errors";
import { randomToken } from "../lib/ids";
import { log } from "../lib/log";
import { success } from "../lib/response";
import { siteCache } from "../lib/site-cache";
import { parseJsonBody } from "../lib/validate";
import type { AppEnv } from "../types";
import { loadConnection, upsertConnection } from "./connections";
import { signState, verifyState } from "./signed-state";

const STATE_PURPOSE = "woocommerce-connect";
const STATE_TTL_MS = 30 * 60_000;
export const WOO_WEBHOOK_TOPICS = ["order.created", "order.updated"] as const;

export interface WooCredentials {
  storeUrl: string;
  consumerKey: string;
  consumerSecret: string;
  keyId: number | null;
  permissions: string;
}

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** "shop.example.com" or "https://shop.example.com/" → "https://shop.example.com". Paths are kept (WordPress in a subfolder). */
export function normalizeStoreUrl(input: string): string | null {
  let value = input.trim();
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  const local = url.hostname === "localhost" || url.hostname.endsWith(".local");
  if (url.protocol !== "https:" && !local) return null;
  if (!url.hostname.includes(".") && !local) return null;
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

function origin(c: Context<AppEnv>): string {
  return new URL(c.req.url).origin;
}

export const woocommerceRoutes = new Hono<AppEnv>();

woocommerceRoutes.get(
  "/api/apps/woocommerce/connect",
  authenticate,
  requireSiteAccess("settings:write"),
  async (c) => {
    const { site, user } = getAccess(c);
    const storeUrl = normalizeStoreUrl(c.req.query("storeUrl") ?? "");
    if (!storeUrl) throw new ApiError(400, "storeUrl: use your store's https:// address");
    const state = await signState(
      c.env.SESSION_SECRET,
      STATE_PURPOSE,
      { s: site.id, u: user.id, store: storeUrl },
      STATE_TTL_MS,
    );
    const params = new URLSearchParams({
      app_name: "DataGoat",
      scope: "read_write",
      user_id: state,
      return_url: `${origin(c)}/app/${site.id}/integrations?woocommerce=connected`,
      callback_url: `${origin(c)}/api/apps/woocommerce/connect`,
    });
    const authorizeUrl = `${storeUrl}/wc-auth/v1/authorize?${params.toString()}`;
    if (c.req.query("format") === "json") return success(c, [{ authorizeUrl }]);
    return c.redirect(authorizeUrl, 302);
  },
);

const CallbackBody = z.object({
  key_id: z.union([z.number(), z.string()]).optional(),
  user_id: z.union([z.string(), z.number()]).transform(String),
  consumer_key: z.string().regex(/^ck_[A-Za-z0-9]{20,64}$/, "invalid consumer key"),
  consumer_secret: z.string().regex(/^cs_[A-Za-z0-9]{20,64}$/, "invalid consumer secret"),
  key_permissions: z.string().max(20).optional(),
});

/** Basic auth over HTTPS, as WooCommerce's REST API documents for consumer keys. */
function wooAuthHeader(creds: WooCredentials): string {
  return `Basic ${btoa(`${creds.consumerKey}:${creds.consumerSecret}`)}`;
}

export async function wooRequest<T>(
  fetch: Fetch,
  creds: WooCredentials,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${creds.storeUrl}/wp-json/wc/v3/${path}`, {
    method,
    headers: {
      authorization: wooAuthHeader(creds),
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`WooCommerce ${method} ${path} failed: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Read the store currency and register order webhooks. Runs after WooCommerce got its 200. */
export async function finishWooSetup(
  env: Cloudflare.Env,
  fetch: Fetch,
  siteId: string,
  workerOrigin: string,
): Promise<void> {
  const conn = await loadConnection<WooCredentials>(env, "woocommerce", siteId);
  if (!conn) return;
  const errors: string[] = [];
  let currency: string | null = null;
  try {
    const setting = await wooRequest<{ value?: string }>(
      fetch,
      conn.credentials,
      "GET",
      "settings/general/woocommerce_currency",
    );
    currency = typeof setting.value === "string" ? setting.value.toUpperCase() : null;
  } catch (err) {
    errors.push((err as Error).message);
  }
  const secret = randomToken(32);
  const deliveryUrl = `${workerOrigin}/webhooks/woocommerce/${siteId}`;
  const webhookIds: Record<string, number> = {};
  for (const topic of WOO_WEBHOOK_TOPICS) {
    try {
      const hook = await wooRequest<{ id: number }>(fetch, conn.credentials, "POST", "webhooks", {
        name: `DataGoat ${topic}`,
        topic,
        delivery_url: deliveryUrl,
        secret,
        status: "active",
      });
      webhookIds[topic] = hook.id;
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  await upsertConnection(env, {
    siteId,
    provider: "woocommerce",
    credentials: conn.credentials as unknown as Record<string, unknown>,
    webhookSecret: Object.keys(webhookIds).length ? secret : null,
    status: "active",
    accountId: conn.accountId ?? new URL(conn.credentials.storeUrl).host,
    accountName: new URL(conn.credentials.storeUrl).host,
    currency,
    settings: { ...conn.settings, webhookIds, visitorMetaKey: "_datagoat_visitor_id" },
    lastError: errors.length ? errors.join("; ").slice(0, 500) : null,
  });
  if (errors.length) log.warn("woocommerce.setup_incomplete", { siteId, errors: errors.length });
}

woocommerceRoutes.post("/api/apps/woocommerce/connect", async (c) => {
  const body = await parseJsonBody(c, CallbackBody, { maxBytes: 8192 });
  const state = await verifyState(c.env.SESSION_SECRET, STATE_PURPOSE, body.user_id);
  if (!state || typeof state.s !== "string" || typeof state.store !== "string") {
    throw new ApiError(401, "Invalid or expired connection request");
  }
  const site = await siteCache.byId(c.env.DB, state.s);
  if (!site) throw new ApiError(404, "Website not found");
  if (body.key_permissions && !body.key_permissions.includes("read")) {
    throw new ApiError(400, "The key needs read access");
  }
  const storeUrl = state.store;
  const credentials: WooCredentials = {
    storeUrl,
    consumerKey: body.consumer_key,
    consumerSecret: body.consumer_secret,
    keyId: body.key_id === undefined ? null : Number(body.key_id),
    permissions: body.key_permissions ?? "read_write",
  };
  await upsertConnection(c.env, {
    siteId: site.id,
    provider: "woocommerce",
    credentials: credentials as unknown as Record<string, unknown>,
    webhookSecret: null,
    status: "active",
    accountId: new URL(storeUrl).host,
    accountName: new URL(storeUrl).host,
    currency: null,
    settings: { connectedBy: state.u },
  });
  c.executionCtx.waitUntil(
    finishWooSetup(c.env, fetch, site.id, origin(c)).catch((err: unknown) =>
      log.warn("woocommerce.setup_failed", { siteId: site.id, error: String(err) }),
    ),
  );
  return success(c, { message: "WooCommerce connected" });
});
