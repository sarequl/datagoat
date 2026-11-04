import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionAad, loadConnection } from "../../../src/ecosystem/connections";
import { signState } from "../../../src/ecosystem/signed-state";
import {
  finishWooSetup,
  normalizeStoreUrl,
  type WooCredentials,
} from "../../../src/ecosystem/woocommerce";
import { decryptString } from "../../../src/lib/crypto";
import { resetDb } from "../../helpers/db";
import { createSite, createUser, sessionCookie } from "../../helpers/factories";
import { api, ORIGIN } from "../../helpers/http";

beforeEach(() => resetDb());
afterEach(() => vi.restoreAllMocks());

const STORE = "https://shop.example.com";
const CK = `ck_${"a".repeat(40)}`;
const CS = `cs_${"b".repeat(40)}`;

async function getManual(path: string, cookie: string): Promise<Response> {
  const worker = (exports as unknown as { default: Fetcher }).default;
  return worker.fetch(new Request(`${ORIGIN}${path}`, { redirect: "manual", headers: { cookie } }));
}

function mockStore(options: { webhookStatus?: number } = {}) {
  const calls: Array<{ method: string; url: string; body: unknown; auth: string | null }> = [];
  let id = 10;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      auth: new Headers(init?.headers).get("authorization"),
    });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (url === `${STORE}/wp-json/wc/v3/settings/general/woocommerce_currency`) {
      return json({ id: "woocommerce_currency", value: "gbp" });
    }
    if (url === `${STORE}/wp-json/wc/v3/webhooks` && method === "POST") {
      if (options.webhookStatus) return json({ code: "nope" }, options.webhookStatus);
      return json({ id: id++ }, 201);
    }
    return json({}, 404);
  });
  return calls;
}

describe("normalizeStoreUrl", () => {
  it("normalises and refuses unsafe URLs", () => {
    expect(normalizeStoreUrl("shop.example.com/")).toBe(STORE);
    expect(normalizeStoreUrl("https://example.com/store/")).toBe("https://example.com/store");
    expect(normalizeStoreUrl("http://shop.example.com")).toBeNull();
    expect(normalizeStoreUrl("http://localhost:8080")).toBe("http://localhost:8080");
    expect(normalizeStoreUrl("https://user:pw@shop.example.com")).toBeNull();
    expect(normalizeStoreUrl("not a url")).toBeNull();
  });
});

describe("WooCommerce connect", () => {
  it("redirects to wc-auth with a signed state, then stores the posted keys", async () => {
    const user = await createUser();
    const site = await createSite(user.id);
    const cookie = await sessionCookie(user.id);
    const start = await getManual(
      `/api/apps/woocommerce/connect?websiteId=${site.id}&storeUrl=shop.example.com`,
      cookie,
    );
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(`${STORE}/wc-auth/v1/authorize`);
    expect(location.searchParams.get("app_name")).toBe("DataGoat");
    expect(location.searchParams.get("scope")).toBe("read_write");
    expect(location.searchParams.get("callback_url")).toBe(
      `${ORIGIN}/api/apps/woocommerce/connect`,
    );
    expect(location.searchParams.get("return_url")).toBe(
      `${ORIGIN}/app/${site.id}/integrations?woocommerce=connected`,
    );
    const state = location.searchParams.get("user_id") ?? "";

    const json = await api(
      `/api/apps/woocommerce/connect?websiteId=${site.id}&storeUrl=shop.example.com&format=json`,
      { cookie },
    );
    expect(json.body.data[0].authorizeUrl).toContain("/wc-auth/v1/authorize?");

    const calls = mockStore();
    const cb = await api("/api/apps/woocommerce/connect", {
      origin: null,
      body: {
        key_id: 3,
        user_id: state,
        consumer_key: CK,
        consumer_secret: CS,
        key_permissions: "read_write",
      },
    });
    expect(cb.status).toBe(200);
    const conn = await loadConnection<WooCredentials>(env, "woocommerce", site.id);
    expect(conn?.credentials).toEqual({
      storeUrl: STORE,
      consumerKey: CK,
      consumerSecret: CS,
      keyId: 3,
      permissions: "read_write",
    });
    expect(conn?.accountId).toBe("shop.example.com");

    // Background setup: currency + webhooks to W3's endpoint.
    await vi.waitFor(async () => {
      const row = await env.DB.prepare(
        "SELECT currency, webhook_secret_enc, settings FROM provider_connections WHERE site_id = ?",
      )
        .bind(site.id)
        .first<{ currency: string | null; webhook_secret_enc: string | null; settings: string }>();
      expect(row?.currency).toBe("GBP");
      expect(row?.webhook_secret_enc).toBeTruthy();
    });
    const hooks = calls.filter((c) => c.method === "POST");
    expect(hooks.map((h) => (h.body as { topic: string }).topic)).toEqual([
      "order.created",
      "order.updated",
    ]);
    const first = hooks[0]?.body as { delivery_url: string; secret: string };
    expect(first.delivery_url).toBe(`${ORIGIN}/webhooks/woocommerce/${site.id}`);
    expect(hooks[0]?.auth).toBe(`Basic ${btoa(`${CK}:${CS}`)}`);
    const row = await env.DB.prepare(
      "SELECT webhook_secret_enc FROM provider_connections WHERE site_id = ?",
    )
      .bind(site.id)
      .first<{ webhook_secret_enc: string }>();
    expect(
      await decryptString(
        env.ENCRYPTION_KEY,
        row?.webhook_secret_enc ?? "",
        connectionAad("woocommerce", site.id),
      ),
    ).toBe(first.secret);
  });

  it("keeps the connection with an error note when webhooks cannot be created", async () => {
    const user = await createUser();
    const site = await createSite(user.id);
    await env.DB.prepare(
      `INSERT INTO provider_connections (site_id, provider, credentials_enc, status, account_id, created_at, updated_at)
       VALUES (?, 'woocommerce', 'x', 'active', 'shop.example.com', 0, 0)`,
    )
      .bind(site.id)
      .run();
    // Re-store real credentials through the public flow helper.
    const state = await signState(
      env.SESSION_SECRET,
      "woocommerce-connect",
      { s: site.id, u: user.id, store: STORE },
      60_000,
    );
    mockStore({ webhookStatus: 401 });
    await api("/api/apps/woocommerce/connect", {
      origin: null,
      body: { user_id: state, consumer_key: CK, consumer_secret: CS },
    });
    await finishWooSetup(env, fetch, site.id, ORIGIN);
    const row = await env.DB.prepare(
      "SELECT status, last_error, webhook_secret_enc FROM provider_connections WHERE site_id = ?",
    )
      .bind(site.id)
      .first<{ status: string; last_error: string; webhook_secret_enc: string | null }>();
    expect(row?.status).toBe("active");
    expect(row?.last_error).toContain("HTTP 401");
    expect(row?.webhook_secret_enc).toBeNull();
  });

  it("rejects forged or expired state, bad keys and missing permissions", async () => {
    const user = await createUser();
    const site = await createSite(user.id);
    const forged = await api("/api/apps/woocommerce/connect", {
      origin: null,
      body: { user_id: "abc.def", consumer_key: CK, consumer_secret: CS },
    });
    expect(forged.status).toBe(401);
    const expired = await signState(
      env.SESSION_SECRET,
      "woocommerce-connect",
      { s: site.id, u: user.id, store: STORE },
      1000,
      Date.now() - 10_000,
    );
    expect(
      (
        await api("/api/apps/woocommerce/connect", {
          origin: null,
          body: { user_id: expired, consumer_key: CK, consumer_secret: CS },
        })
      ).status,
    ).toBe(401);
    // A Shopify state is not a WooCommerce state.
    const other = await signState(
      env.SESSION_SECRET,
      "shopify-oauth",
      { s: site.id, store: STORE },
      60_000,
    );
    expect(
      (
        await api("/api/apps/woocommerce/connect", {
          origin: null,
          body: { user_id: other, consumer_key: CK, consumer_secret: CS },
        })
      ).status,
    ).toBe(401);
    const valid = await signState(
      env.SESSION_SECRET,
      "woocommerce-connect",
      { s: site.id, u: user.id, store: STORE },
      60_000,
    );
    expect(
      (
        await api("/api/apps/woocommerce/connect", {
          origin: null,
          body: { user_id: valid, consumer_key: "nope", consumer_secret: CS },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api("/api/apps/woocommerce/connect", {
          origin: null,
          body: { user_id: valid, consumer_key: CK, consumer_secret: CS, key_permissions: "write" },
        })
      ).status,
    ).toBe(400);
  });

  it("requires settings:write to start", async () => {
    const user = await createUser();
    const site = await createSite(user.id);
    const viewer = await createUser();
    await env.DB.prepare(
      "INSERT INTO memberships (site_id, user_id, role, created_at) VALUES (?, ?, 'viewer', ?)",
    )
      .bind(site.id, viewer.id, Date.now())
      .run();
    const res = await api(`/api/apps/woocommerce/connect?websiteId=${site.id}&storeUrl=${STORE}`, {
      cookie: await sessionCookie(viewer.id),
    });
    expect(res.status).toBe(403);
    const bad = await api(
      `/api/apps/woocommerce/connect?websiteId=${site.id}&storeUrl=http://x.com`,
      {
        cookie: await sessionCookie(user.id),
      },
    );
    expect(bad.status).toBe(400);
  });
});
