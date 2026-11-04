import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionAad, loadConnection } from "../../../src/ecosystem/connections";
import type { ShopifyCredentials } from "../../../src/ecosystem/shopify";
import { normalizeShop, verifyOAuthHmac } from "../../../src/ecosystem/shopify-api";
import { decryptString, hmacSha256Base64, hmacSha256Hex } from "../../../src/lib/crypto";
import { resetDb } from "../../helpers/db";
import { createSite, createUser, sessionCookie } from "../../helpers/factories";
import { api, ORIGIN } from "../../helpers/http";

beforeEach(() => resetDb());

/** GET without following redirects (the api() helper follows them). */
async function getManual(path: string, cookie?: string): Promise<Response> {
  const worker = (exports as unknown as { default: Fetcher }).default;
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      redirect: "manual",
      headers: cookie ? { cookie } : {},
    }),
  );
}
afterEach(() => vi.restoreAllMocks());

const SHOP = "goat-store.myshopify.com";
const CLIENT_ID = "client-id-123456";
const SECRET = "shpss_client-secret-abcdef";

interface Call {
  method: string;
  url: string;
  body: string | null;
  headers: Headers;
}

function mockShopify(options: { tokenStatus?: number; existingScript?: string } = {}) {
  const calls: Call[] = [];
  let nextId = 100;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url,
      body: typeof init?.body === "string" ? init.body : null,
      headers: new Headers(init?.headers),
    });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url === `https://${SHOP}/admin/oauth/access_token`) {
      if (options.tokenStatus && options.tokenStatus !== 200) {
        return json(
          { error: "invalid_client", error_description: "Client authentication failed" },
          options.tokenStatus,
        );
      }
      return json({
        access_token: "shpat_token",
        scope: "read_orders,write_script_tags",
        expires_in: 86399,
      });
    }
    const base = `https://${SHOP}/admin/api/2025-10/`;
    if (url === `${base}shop.json`) {
      return json({
        shop: {
          name: "Goat Store",
          currency: "EUR",
          domain: "goat.example.com",
          myshopify_domain: SHOP,
        },
      });
    }
    if (url.startsWith(`${base}webhooks.json`) && method === "GET") return json({ webhooks: [] });
    if (url === `${base}webhooks.json` && method === "POST")
      return json({ webhook: { id: nextId++ } }, 201);
    if (url.startsWith(`${base}script_tags.json`) && method === "GET") {
      return json({
        script_tags: options.existingScript ? [{ id: 5, src: options.existingScript }] : [],
      });
    }
    if (url === `${base}script_tags.json` && method === "POST") {
      return json({ script_tag: { id: 77 } }, 201);
    }
    return json({ errors: "not mocked" }, 404);
  });
  return calls;
}

async function owner() {
  const user = await createUser();
  const site = await createSite(user.id, { domain: "goat.example.com" });
  return { user, site, cookie: await sessionCookie(user.id) };
}

describe("normalizeShop", () => {
  it("accepts handles, domains and admin URLs", () => {
    expect(normalizeShop("goat-store")).toBe(SHOP);
    expect(normalizeShop("https://Goat-Store.myshopify.com/admin")).toBe(SHOP);
    expect(normalizeShop("goat.example.com")).toBeNull();
    expect(normalizeShop("evil.com/x.myshopify.com")).toBeNull();
  });
});

describe("POST /api/apps/shopify/connect (client credentials)", () => {
  it("connects: token, shop info, webhooks, ScriptTag, encrypted connection row", async () => {
    const { site, cookie } = await owner();
    const calls = mockShopify();
    const res = await api(`/api/apps/shopify/connect?websiteId=${site.id}`, {
      cookie,
      body: { shop: "goat-store", clientId: CLIENT_ID, clientSecret: SECRET },
    });
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({
      status: "active",
      shopName: "Goat Store",
      currency: "EUR",
      scriptTagInstalled: true,
      webhooks: ["orders/paid", "refunds/create", "app/uninstalled"],
      warnings: [],
    });
    const tokenCall = calls[0];
    expect(tokenCall?.body).toContain("grant_type=client_credentials");
    const hooks = calls.filter((c) => c.method === "POST" && c.url.endsWith("webhooks.json"));
    expect(hooks.map((h) => JSON.parse(h.body ?? "{}").webhook)).toEqual([
      { topic: "orders/paid", address: `${ORIGIN}/webhooks/shopify/${site.id}`, format: "json" },
      { topic: "refunds/create", address: `${ORIGIN}/webhooks/shopify/${site.id}`, format: "json" },
      { topic: "app/uninstalled", address: `${ORIGIN}/api/apps/shopify/webhooks`, format: "json" },
    ]);
    expect(hooks[0]?.headers.get("x-shopify-access-token")).toBe("shpat_token");
    const tag = calls.find((c) => c.method === "POST" && c.url.endsWith("script_tags.json"));
    expect(JSON.parse(tag?.body ?? "{}").script_tag.src).toBe(
      `${ORIGIN}/apps/shopify.js?id=${encodeURIComponent(site.publicId)}`,
    );

    const conn = await loadConnection<ShopifyCredentials>(env, "shopify", site.id);
    expect(conn?.status).toBe("active");
    expect(conn?.accountId).toBe(SHOP);
    expect(conn?.credentials).toMatchObject({
      shop: SHOP,
      clientId: CLIENT_ID,
      clientSecret: SECRET,
      grant: "client_credentials",
      accessToken: "shpat_token",
    });
    expect(conn?.credentials.accessTokenExpiresAt).toBeGreaterThan(Date.now());
    expect(conn?.settings).toMatchObject({ scriptTagId: 77, storefrontDomain: "goat.example.com" });
    const row = await env.DB.prepare(
      "SELECT credentials_enc, webhook_secret_enc, currency, account_name FROM provider_connections WHERE site_id = ?",
    )
      .bind(site.id)
      .first<Record<string, string>>();
    expect(row?.credentials_enc).not.toContain(SECRET);
    expect(row?.currency).toBe("EUR");
    expect(row?.account_name).toBe("Goat Store");
    expect(
      await decryptString(
        env.ENCRYPTION_KEY,
        row?.webhook_secret_enc ?? "",
        connectionAad("shopify", site.id),
      ),
    ).toBe(SECRET);
  });

  it("is idempotent for an existing ScriptTag and warns about a foreign storefront domain", async () => {
    const user = await createUser();
    const site = await createSite(user.id, { domain: "other.example.org" });
    const cookie = await sessionCookie(user.id);
    const calls = mockShopify({
      existingScript: `${ORIGIN}/apps/shopify.js?id=${encodeURIComponent(site.publicId)}`,
    });
    const res = await api(`/api/apps/shopify/connect?websiteId=${site.id}`, {
      cookie,
      body: { shop: SHOP, clientId: CLIENT_ID, clientSecret: SECRET },
    });
    expect(res.status).toBe(200);
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("script_tags.json"))).toBe(
      false,
    );
    expect(res.body.data[0].warnings[0]).toContain("allowed hostnames");
  });

  it("answers 400 when Shopify rejects the credentials and stores nothing", async () => {
    const { site, cookie } = await owner();
    mockShopify({ tokenStatus: 401 });
    const res = await api(`/api/apps/shopify/connect?websiteId=${site.id}`, {
      cookie,
      body: { shop: SHOP, clientId: CLIENT_ID, clientSecret: SECRET },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("Client authentication failed");
    expect(await loadConnection(env, "shopify", site.id)).toBeNull();
  });

  it("validates input and permissions", async () => {
    const { site, cookie } = await owner();
    const bad = await api(`/api/apps/shopify/connect?websiteId=${site.id}`, {
      cookie,
      body: { shop: "example.com", clientId: CLIENT_ID, clientSecret: SECRET },
    });
    expect(bad.status).toBe(400);
    const anon = await api(`/api/apps/shopify/connect?websiteId=${site.id}`, {
      body: { shop: SHOP, clientId: CLIENT_ID, clientSecret: SECRET },
    });
    expect(anon.status).toBe(401);
    const viewer = await createUser();
    await env.DB.prepare(
      "INSERT INTO memberships (site_id, user_id, role, created_at) VALUES (?, ?, 'viewer', ?)",
    )
      .bind(site.id, viewer.id, Date.now())
      .run();
    const asViewer = await api(`/api/apps/shopify/connect?websiteId=${site.id}`, {
      cookie: await sessionCookie(viewer.id),
      body: { shop: SHOP, clientId: CLIENT_ID, clientSecret: SECRET },
    });
    expect(asViewer.status).toBe(403);
    const crossOrigin = await api(`/api/apps/shopify/connect?websiteId=${site.id}`, {
      cookie,
      origin: "https://evil.example",
      body: { shop: SHOP, clientId: CLIENT_ID, clientSecret: SECRET },
    });
    expect(crossOrigin.status).toBe(403);
  });
});

describe("Shopify OAuth install", () => {
  async function callbackQuery(state: string, secret = SECRET, extra: Record<string, string> = {}) {
    const params = new URLSearchParams({
      code: "auth-code-1",
      shop: SHOP,
      state,
      timestamp: String(Math.floor(Date.now() / 1000)),
      ...extra,
    });
    const message = [...params.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    params.set("hmac", await hmacSha256Hex(secret, message));
    return params;
  }

  it("stores pending credentials, redirects to Shopify, and completes on a signed callback", async () => {
    const { site, cookie } = await owner();
    const pending = await api(`/api/apps/shopify/connect?websiteId=${site.id}`, {
      cookie,
      body: { shop: SHOP, clientId: CLIENT_ID, clientSecret: SECRET, grant: "authorization_code" },
    });
    expect(pending.body.data[0]).toMatchObject({
      status: "pending",
      installUrl: `${ORIGIN}/api/apps/shopify/install?websiteId=${site.id}`,
      redirectUrl: `${ORIGIN}/api/apps/shopify/callback`,
    });
    const install = await getManual(`/api/apps/shopify/install?websiteId=${site.id}`, cookie);
    expect(install.status).toBe(302);
    const location = new URL(install.headers.get("location") ?? "");
    expect(location.origin).toBe(`https://${SHOP}`);
    expect(location.pathname).toBe("/admin/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(location.searchParams.get("scope")).toBe(
      "read_orders,read_products,read_customers,write_script_tags",
    );
    const state = location.searchParams.get("state") ?? "";

    const calls = mockShopify();
    const query = await callbackQuery(state);
    const cb = await getManual(`/api/apps/shopify/callback?${query.toString()}`);
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe(`/app/${site.id}/integrations?shopify=connected`);
    expect(calls[0]?.body).toContain("code=auth-code-1");
    const conn = await loadConnection<ShopifyCredentials>(env, "shopify", site.id);
    expect(conn?.status).toBe("active");
    expect(conn?.credentials.grant).toBe("authorization_code");
  });

  it("rejects forged signatures, tampered state and a missing pending connection", async () => {
    const { site, cookie } = await owner();
    const noConn = await api(`/api/apps/shopify/install?websiteId=${site.id}`, { cookie });
    expect(noConn.status).toBe(400);
    await api(`/api/apps/shopify/connect?websiteId=${site.id}`, {
      cookie,
      body: { shop: SHOP, clientId: CLIENT_ID, clientSecret: SECRET, grant: "authorization_code" },
    });
    const install = await getManual(`/api/apps/shopify/install?websiteId=${site.id}`, cookie);
    const state = new URL(install.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const forged = await api(
      `/api/apps/shopify/callback?${(await callbackQuery(state, "wrong-secret")).toString()}`,
    );
    expect(forged.status).toBe(401);
    const tampered = await api(
      `/api/apps/shopify/callback?${(await callbackQuery(`${state.slice(0, -2)}xx`)).toString()}`,
    );
    expect(tampered.status).toBe(400);
  });

  it("verifies Shopify's documented HMAC example shape", async () => {
    const params = new URLSearchParams(
      "code=0907a61c0c8d55e99db179b68161bc00&shop=some-shop.myshopify.com&state=0.6784241404160823&timestamp=1337178173",
    );
    const message =
      "code=0907a61c0c8d55e99db179b68161bc00&shop=some-shop.myshopify.com&state=0.6784241404160823&timestamp=1337178173";
    params.set("hmac", await hmacSha256Hex("hush", message));
    expect(await verifyOAuthHmac(params, "hush")).toBe(true);
    params.set("timestamp", "1");
    expect(await verifyOAuthHmac(params, "hush")).toBe(false);
  });
});

describe("POST /api/apps/shopify/webhooks", () => {
  async function connected() {
    const ctx = await owner();
    mockShopify();
    await api(`/api/apps/shopify/connect?websiteId=${ctx.site.id}`, {
      cookie: ctx.cookie,
      body: { shop: SHOP, clientId: CLIENT_ID, clientSecret: SECRET },
    });
    vi.restoreAllMocks();
    return ctx;
  }

  async function deliver(topic: string, payload: unknown, secret = SECRET) {
    const body = JSON.stringify(payload);
    return api("/api/apps/shopify/webhooks", {
      body,
      origin: null,
      headers: {
        "x-shopify-topic": topic,
        "x-shopify-shop-domain": SHOP,
        "x-shopify-hmac-sha256": await hmacSha256Base64(secret, body),
      },
    });
  }

  it("marks the connection disconnected on app/uninstalled", async () => {
    const { site } = await connected();
    const res = await deliver("app/uninstalled", { id: 1, domain: SHOP });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare(
      "SELECT status, last_error FROM provider_connections WHERE site_id = ?",
    )
      .bind(site.id)
      .first<{ status: string; last_error: string }>();
    expect(row).toEqual({
      status: "disconnected",
      last_error: "The app was uninstalled from Shopify",
    });
  });

  it("rejects bad signatures and unknown shops", async () => {
    await connected();
    expect((await deliver("app/uninstalled", {}, "wrong")).status).toBe(401);
    const unknown = await api("/api/apps/shopify/webhooks", {
      body: "{}",
      origin: null,
      headers: {
        "x-shopify-topic": "app/uninstalled",
        "x-shopify-shop-domain": "other.myshopify.com",
        "x-shopify-hmac-sha256": await hmacSha256Base64(SECRET, "{}"),
      },
    });
    expect(unknown.status).toBe(401);
  });

  it("redacts customer PII on customers/redact and forgets the shop on shop/redact", async () => {
    const { site } = await connected();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO payments (site_id, id, provider, provider_txn_id, provider_customer_id, kind, amount_minor,
         currency, reporting_minor, reporting_currency, attributed_via, customer_email, customer_name,
         email_hash, source, occurred_at, created_at, updated_at)
       VALUES (?, 'p1', 'shopify', '1001', '77', 'payment', 100, 'EUR', 100, 'EUR', 'none',
               'a@example.com', 'A', 'h', 'webhook', ?, ?, ?),
              (?, 'p2', 'shopify', '2002', '88', 'payment', 100, 'EUR', 100, 'EUR', 'none',
               'b@example.com', 'B', 'h2', 'webhook', ?, ?, ?)`,
    )
      .bind(site.id, now, now, now, site.id, now, now, now)
      .run();
    const res = await deliver("customers/redact", {
      shop_domain: SHOP,
      customer: { id: 77, email: "a@example.com" },
      orders_to_redact: [1001],
    });
    expect(res.status).toBe(200);
    const rows = await env.DB.prepare("SELECT id, customer_email FROM payments ORDER BY id").all();
    expect(rows.results).toEqual([
      { id: "p1", customer_email: null },
      { id: "p2", customer_email: "b@example.com" },
    ]);
    await deliver("customers/data_request", { customer: { id: 88 } });
    expect((await deliver("shop/redact", { shop_domain: SHOP })).status).toBe(200);
    expect(await loadConnection(env, "shopify", site.id)).toBeNull();
    const after = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM payments WHERE customer_email IS NOT NULL",
    ).first<{ n: number }>();
    expect(after?.n).toBe(0);
  });
});

describe("GET /api/apps/shopify/pixel.js", () => {
  it("serves custom pixel code for the website", async () => {
    const { site } = await owner();
    const res = await api(`/api/apps/shopify/pixel.js?websiteId=${site.publicId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const code = String(res.body);
    expect(code).toContain(`"websiteId":"${site.publicId}"`);
    expect(code).toContain(`"api":"${ORIGIN}/api/events"`);
    expect(code).toContain('analytics.subscribe("checkout_started"');
    expect((await api("/api/apps/shopify/pixel.js?websiteId=nope")).status).toBe(404);
  });
});
