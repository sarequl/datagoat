/**
 * Shopify Admin API calls used by the Shopify app (no SDK, plain fetch so tests mock it).
 *
 * Two ways to get an Admin API token, both documented by Shopify:
 * - **Client credentials grant** (DataFast's flow): a Dev Dashboard app installed on a store the
 *   merchant owns. POST /admin/oauth/access_token with grant_type=client_credentials returns a
 *   token that expires (about 24 h); W3's adapter mints a new one with the stored client id/secret.
 * - **Authorization code grant**: GET /admin/oauth/authorize → our callback → POST
 *   /admin/oauth/access_token with the code returns an offline token that does not expire.
 */
import { hmacSha256Hex, timingSafeEqual, verifyHmacSha256 } from "../lib/crypto";

export const SHOPIFY_API_VERSION = "2025-10";
export const SHOPIFY_SCOPES = [
  "read_orders",
  "read_products",
  "read_customers",
  "write_script_tags",
];
/** Order webhooks go to W3's revenue webhook; lifecycle webhooks come to the app endpoint. */
export const ORDER_WEBHOOK_TOPICS = ["orders/paid", "refunds/create"] as const;
export const APP_WEBHOOK_TOPICS = ["app/uninstalled"] as const;

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const SHOP_RE = /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/;

/** "mystore", "mystore.myshopify.com" or "https://mystore.myshopify.com/admin" → "mystore.myshopify.com". */
export function normalizeShop(input: string): string | null {
  let value = input.trim().toLowerCase();
  value = value.replace(/^https?:\/\//, "").split(/[/?#]/)[0] ?? "";
  if (value && !value.includes(".")) value = `${value}.myshopify.com`;
  return SHOP_RE.test(value) ? value : null;
}

export class ShopifyError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ShopifyError";
  }
}

export interface ShopifyToken {
  accessToken: string;
  scope: string;
  /** Epoch ms, or null for non-expiring offline tokens. */
  expiresAt: number | null;
}

async function tokenRequest(
  fetch: Fetch,
  shop: string,
  body: Record<string, string>,
  now: number,
): Promise<ShopifyToken> {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json().catch(() => null)) as {
    access_token?: string;
    scope?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  } | null;
  if (!res.ok || !json?.access_token) {
    const reason = json?.error_description ?? json?.error ?? `HTTP ${res.status}`;
    throw new ShopifyError(`Shopify rejected the credentials: ${reason}`, res.status);
  }
  return {
    accessToken: json.access_token,
    scope: json.scope ?? "",
    expiresAt: typeof json.expires_in === "number" ? now + json.expires_in * 1000 : null,
  };
}

export function clientCredentialsToken(
  fetch: Fetch,
  shop: string,
  clientId: string,
  clientSecret: string,
  now = Date.now(),
): Promise<ShopifyToken> {
  return tokenRequest(
    fetch,
    shop,
    { grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret },
    now,
  );
}

export function exchangeCode(
  fetch: Fetch,
  shop: string,
  clientId: string,
  clientSecret: string,
  code: string,
  now = Date.now(),
): Promise<ShopifyToken> {
  return tokenRequest(fetch, shop, { client_id: clientId, client_secret: clientSecret, code }, now);
}

export function authorizeUrl(
  shop: string,
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    scope: SHOPIFY_SCOPES.join(","),
    redirect_uri: redirectUri,
    state,
  });
  return `https://${shop}/admin/oauth/authorize?${params.toString()}`;
}

/**
 * OAuth redirect HMAC: every query parameter except `hmac` (and the legacy `signature`), sorted by
 * name, joined as `k=v&k=v`, HMAC-SHA256 hex with the app's client secret.
 */
export async function verifyOAuthHmac(
  query: URLSearchParams,
  clientSecret: string,
): Promise<boolean> {
  const given = query.get("hmac");
  if (!given) return false;
  const message = [...query.entries()]
    .filter(([k]) => k !== "hmac" && k !== "signature")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return timingSafeEqual(await hmacSha256Hex(clientSecret, message), given.toLowerCase());
}

/** Webhook HMAC: base64 HMAC-SHA256 of the raw body with the client secret. */
export function verifyWebhookHmac(rawBody: string, header: string, clientSecret: string) {
  return verifyHmacSha256(clientSecret, rawBody, header, "base64");
}

async function admin<T>(
  fetch: Fetch,
  shop: string,
  token: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/${path}`, {
    method,
    headers: {
      "x-shopify-access-token": token,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as T & { errors?: unknown };
  if (!res.ok) {
    const detail = json && "errors" in json ? JSON.stringify(json.errors) : `HTTP ${res.status}`;
    throw new ShopifyError(`Shopify ${method} ${path} failed: ${detail}`, res.status);
  }
  return json;
}

export interface ShopInfo {
  name: string;
  currency: string;
  /** Storefront primary domain, e.g. "shop.example.com". */
  domain: string;
  myshopifyDomain: string;
}

export async function getShop(fetch: Fetch, shop: string, token: string): Promise<ShopInfo> {
  const json = await admin<{
    shop: { name: string; currency: string; domain: string; myshopify_domain: string };
  }>(fetch, shop, token, "GET", "shop.json");
  return {
    name: json.shop.name,
    currency: json.shop.currency,
    domain: json.shop.domain,
    myshopifyDomain: json.shop.myshopify_domain,
  };
}

export interface SetupInput {
  shop: string;
  token: string;
  /** DataGoat site id (internal) and tracking id. */
  siteId: string;
  trackingId: string;
  /** Public origin of this DataGoat instance, e.g. https://analytics.example.com. */
  origin: string;
}

export interface SetupResult {
  shop: ShopInfo;
  webhookIds: Record<string, number>;
  scriptTagId: number | null;
  errors: string[];
}

export function loaderSrc(origin: string, trackingId: string): string {
  return `${origin}/apps/shopify.js?id=${encodeURIComponent(trackingId)}`;
}

/**
 * Read the shop, register webhooks (orders → W3's /webhooks/shopify/:siteId, lifecycle → the app
 * endpoint) and install the storefront loader as a ScriptTag. Webhook or ScriptTag failures are
 * collected, not thrown, so a store that already has them (HTTP 422) still connects.
 */
export async function setupShop(fetch: Fetch, input: SetupInput): Promise<SetupResult> {
  const { shop, token } = input;
  const info = await getShop(fetch, shop, token);
  const errors: string[] = [];
  const webhookIds: Record<string, number> = {};
  const existing = await admin<{ webhooks: Array<{ id: number; topic: string; address: string }> }>(
    fetch,
    shop,
    token,
    "GET",
    "webhooks.json?limit=250",
  ).catch((err: unknown) => {
    errors.push(String((err as Error).message));
    return { webhooks: [] };
  });
  const wanted: Array<[string, string]> = [
    ...ORDER_WEBHOOK_TOPICS.map(
      (t) => [t, `${input.origin}/webhooks/shopify/${input.siteId}`] as [string, string],
    ),
    ...APP_WEBHOOK_TOPICS.map(
      (t) => [t, `${input.origin}/api/apps/shopify/webhooks`] as [string, string],
    ),
  ];
  for (const [topic, address] of wanted) {
    const found = existing.webhooks.find((w) => w.topic === topic && w.address === address);
    if (found) {
      webhookIds[topic] = found.id;
      continue;
    }
    try {
      const created = await admin<{ webhook: { id: number } }>(
        fetch,
        shop,
        token,
        "POST",
        "webhooks.json",
        {
          webhook: { topic, address, format: "json" },
        },
      );
      webhookIds[topic] = created.webhook.id;
    } catch (err) {
      errors.push((err as Error).message);
    }
  }

  let scriptTagId: number | null = null;
  const src = loaderSrc(input.origin, input.trackingId);
  try {
    const tags = await admin<{ script_tags: Array<{ id: number; src: string }> }>(
      fetch,
      shop,
      token,
      "GET",
      "script_tags.json?limit=250",
    );
    const mine = tags.script_tags.find((t) => t.src.startsWith(`${input.origin}/apps/shopify.js`));
    if (mine && mine.src === src) {
      scriptTagId = mine.id;
    } else {
      const created = await admin<{ script_tag: { id: number } }>(
        fetch,
        shop,
        token,
        "POST",
        "script_tags.json",
        { script_tag: { event: "onload", src, display_scope: "online_store", cache: true } },
      );
      scriptTagId = created.script_tag.id;
    }
  } catch (err) {
    errors.push((err as Error).message);
  }
  return { shop: info, webhookIds, scriptTagId, errors };
}
