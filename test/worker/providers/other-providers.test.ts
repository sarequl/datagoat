/**
 * Polar, Lemon Squeezy, Paddle, Dodo Payments, Creem, Shopify and WooCommerce: connect,
 * signed webhooks, polling/backfill and hint resolution against mocked provider APIs.
 */
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toBase64 } from "../../../src/lib/encoding";
import { providerJobs } from "../../../src/providers";
import { CREEM_API } from "../../../src/providers/adapters/creem";
import { DODO_API } from "../../../src/providers/adapters/dodo";
import { LS_API } from "../../../src/providers/adapters/lemonsqueezy";
import { PADDLE_API } from "../../../src/providers/adapters/paddle";
import { POLAR_API } from "../../../src/providers/adapters/polar";
import { sign } from "../../../src/providers/signatures";
import type { ProviderId } from "../../../src/providers/types";
import { resetDb } from "../../helpers/db";
import { api } from "../../helpers/http";
import {
  connect,
  DAY,
  goalEvents,
  json,
  MIN,
  mockProviders,
  ownerWithSite,
  paymentRows,
  runJobs,
  T0,
  visitorWithSessions,
} from "./helpers";

let mock: ReturnType<typeof mockProviders> | null = null;
beforeEach(() => resetDb());
afterEach(() => {
  mock?.restore();
  mock = null;
});

const sync = providerJobs.filter((j) => j.name === "providers.sync");
const hints = providerJobs.filter((j) => j.name === "providers.resolve-hints");
const sec = (ms: number) => Math.floor(ms / 1000);
const iso = (ms: number) => new Date(ms).toISOString();

function post(provider: ProviderId, siteId: string, body: string, headers: Record<string, string>) {
  return api(`/webhooks/${provider}/${siteId}`, { method: "POST", body, origin: null, headers });
}

async function standardHeaders(secret: string, id: string, body: string) {
  const ts = sec(Date.now());
  return {
    "webhook-id": id,
    "webhook-timestamp": String(ts),
    "webhook-signature": await sign.standard(secret, id, ts, body),
  };
}

async function addHint(
  siteId: string,
  provider: ProviderId,
  ref: string,
  visitorId: string,
  sessionId: string,
) {
  await env.DB.prepare(
    "INSERT INTO payment_hints (site_id, provider, ref, visitor_id, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(siteId, provider, ref, visitorId, sessionId, T0)
    .run();
}

describe("Polar", () => {
  const SECRET = `whsec_${toBase64(new TextEncoder().encode("polar-signing-secret-bytes"))}`;

  it("connects with DataFast's field names (message only, as DataFast)", async () => {
    const { site, cookie } = await ownerWithSite();
    mock = mockProviders({
      [`GET ${POLAR_API}/organizations/org_1`]: () => json({ id: "org_1", name: "Acme" }),
      [`GET ${POLAR_API}/orders/`]: () => json({ items: [], pagination: { max_page: 1 } }),
    });
    const res = await api(`/api/v1/admin/websites/${site.id}/integrations/polar`, {
      cookie,
      body: { polarAccessToken: "polar_oat_abc", polarOrgId: "org_1", webhookSecret: SECRET },
    });
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toEqual({
      message: "Polar connected successfully",
      webhookUrl: `https://datagoat.test/webhooks/polar/${site.id}`,
      webhookConfigured: true,
    });
    const missing = await api(`/api/v1/admin/websites/${site.id}/integrations/polar`, {
      cookie,
      body: { polarAccessToken: "polar_oat_abc" },
    });
    expect(missing.status).toBe(400);
  });

  it("connects a token without organizations:read (only orders:read is required)", async () => {
    const { site, cookie } = await ownerWithSite();
    mock = mockProviders({
      [`GET ${POLAR_API}/organizations/`]: () =>
        json({ error: "insufficient_scope", error_description: "Missing organizations:read" }, 403),
      [`GET ${POLAR_API}/orders/`]: () => json({ items: [] }),
    });
    const res = await api(`/api/v1/admin/websites/${site.id}/integrations/polar`, {
      cookie,
      body: { polarAccessToken: "polar_oat_abc", polarOrgId: "org_1", webhookSecret: SECRET },
    });
    expect(res.status).toBe(200);
    expect(res.body.data[0].message).toBe("Polar connected successfully");
    // Orders are checked with the poller's query, and requests identify themselves.
    const [orders] = mock.to(`${POLAR_API}/orders/`);
    expect(orders?.url).toContain("organization_id=org_1");
    expect(orders?.headers.get("authorization")).toBe("Bearer polar_oat_abc");
    expect(orders?.headers.get("user-agent")).toMatch(/^DataGoat/);
  });

  it("says what Polar objected to when connecting fails", async () => {
    const { site, cookie } = await ownerWithSite();
    const attempt = async (routes: Parameters<typeof mockProviders>[0]) => {
      mock?.restore();
      mock = mockProviders(routes);
      const res = await api(`/api/v1/admin/websites/${site.id}/integrations/polar`, {
        cookie,
        body: { polarAccessToken: "polar_oat_abc", polarOrgId: "org_1" },
      });
      expect(res.status).toBe(400);
      return res.body.error.message as string;
    };
    const invalid = () =>
      json(
        {
          error: "invalid_token",
          error_description:
            "The access token provided is expired, revoked, malformed, or invalid.",
        },
        401,
      );

    // Unknown everywhere: rejected, with Polar's own words.
    let msg = await attempt({
      [`GET ${POLAR_API}/orders/`]: invalid,
      [`GET https://sandbox-api.polar.sh/v1/orders/`]: invalid,
    });
    expect(msg).toMatch(/^Polar rejected the access token\. Polar said: "The access token/);
    expect(msg).toContain("polar_oat_");

    // Unknown live but valid on the sandbox: a sandbox token.
    msg = await attempt({
      [`GET ${POLAR_API}/orders/`]: invalid,
      [`GET https://sandbox-api.polar.sh/v1/orders/`]: () => json({ items: [] }),
    });
    expect(msg).toMatch(/sandbox token/);

    // Valid token without orders:read.
    msg = await attempt({
      [`GET ${POLAR_API}/orders/`]: () =>
        json({ error: "insufficient_scope", error_description: "Missing orders:read" }, 403),
    });
    expect(msg).toMatch(/not allowed to read orders/);
    expect(msg).toContain("orders:read");

    // Orders fine, but the organization ID does not exist for this token.
    msg = await attempt({
      [`GET ${POLAR_API}/orders/`]: () => json({ items: [] }),
      [`GET ${POLAR_API}/organizations/`]: () => json({ detail: "Not found" }, 404),
    });
    expect(msg).toMatch(/no organization with the ID "org_1"/);

    // A malformed organization ID.
    msg = await attempt({
      [`GET ${POLAR_API}/orders/`]: () =>
        json({ detail: [{ msg: "Input should be a UUID" }] }, 422),
    });
    expect(msg).toMatch(/did not accept the organization ID "org_1"/);
  });

  it("ingests Standard Webhooks orders and lifecycle (both secret generations)", async () => {
    const { site } = await ownerWithSite();
    const v = await visitorWithSessions(site.id, [
      { at: Date.now() - DAY, channel: "Organic Search" },
    ]);
    await connect(site.id, "polar", {
      credentials: { accessToken: "t" },
      webhookSecret: SECRET,
      settings: { organizationId: "org_1" },
    });
    const sub = {
      id: "sub_p",
      status: "active",
      customer_id: "cust_p",
      amount: 1500,
      currency: "usd",
      recurring_interval: "month",
      cancel_at_period_end: false,
      metadata: { datafast_visitor_id: v.visitorId },
      modified_at: iso(Date.now()),
    };
    const order = {
      id: "ord_p1",
      status: "paid",
      paid: true,
      total_amount: 1500,
      currency: "usd",
      billing_reason: "subscription_create",
      customer_id: "cust_p",
      customer: { id: "cust_p", email: "p@x.io" },
      subscription_id: "sub_p",
      checkout_id: "chk_1",
      metadata: { datafast_visitor_id: v.visitorId },
      created_at: iso(Date.now()),
    };
    for (const [i, payload] of [
      { type: "subscription.created", data: sub },
      { type: "order.paid", data: order },
      { type: "subscription.canceled", data: { ...sub, cancel_at_period_end: true } },
      {
        type: "order.paid",
        data: { ...order, id: "ord_p2", billing_reason: "subscription_cycle", metadata: {} },
      },
      {
        type: "order.refunded",
        data: {
          ...order,
          id: "ord_p2",
          billing_reason: "subscription_cycle",
          status: "refunded",
          refunded_amount: 1500,
          metadata: {},
        },
      },
      { type: "subscription.revoked", data: sub },
    ].entries()) {
      const body = JSON.stringify({ ...payload, timestamp: iso(Date.now()) });
      const res = await post(
        "polar",
        site.id,
        body,
        await standardHeaders(SECRET, `msg_${i}`, body),
      );
      expect(res.status).toBe(200);
    }
    const rows = await paymentRows(site.id);
    expect(
      rows.map((r) => [r.provider_txn_id, r.kind, r.amount_minor, r.attributed_via]).sort(),
    ).toEqual([
      ["ord_p1", "payment", 1500, "metadata"],
      ["ord_p2", "renewal", 1500, "customer"],
      ["ord_p2:refund", "refund", -1500, "customer"],
    ]);
    expect((await goalEvents(site.id)).map((g) => g.name).sort()).toEqual(
      [
        "payment",
        "subscription_cancel_scheduled",
        "subscription_ended",
        "subscription_renewed",
        "subscription_started",
      ].sort(),
    );
    // Legacy secret (raw bytes) still verifies.
    await connect(site.id, "polar", {
      credentials: { accessToken: "t" },
      webhookSecret: "polar_legacy_secret",
    });
    const body = JSON.stringify({ type: "order.paid", data: { ...order, id: "ord_p3" } });
    const ts = sec(Date.now());
    const raw = await sign.standard("polar_legacy_secret", "msg_legacy", ts, body);
    const ok = await post("polar", site.id, body, {
      "webhook-id": "msg_legacy",
      "webhook-timestamp": String(ts),
      "webhook-signature": raw,
    });
    expect(ok.status).toBe(200);
    const bad = await post("polar", site.id, body, {
      "webhook-id": "msg_x",
      "webhook-timestamp": String(ts),
      "webhook-signature": raw,
    });
    expect(bad.status).toBe(401);
  });

  it("polls new orders every 5 minutes and resolves Checkout Link hints", async () => {
    const { site } = await ownerWithSite();
    const v = await visitorWithSessions(site.id, [{ at: T0 - 10 * MIN }]);
    await connect(site.id, "polar", {
      credentials: { accessToken: "t" },
      settings: { organizationId: "org_1" },
      now: T0 - DAY,
    });
    await addHint(site.id, "polar", "chk_9", v.visitorId, v.sessions[0]?.id ?? "");
    const order = {
      id: "ord_9",
      status: "paid",
      paid: true,
      total_amount: 900,
      currency: "usd",
      billing_reason: "purchase",
      customer_id: "c9",
      checkout_id: "chk_9",
      created_at: iso(T0),
      modified_at: iso(T0),
    };
    mock = mockProviders({
      [`GET ${POLAR_API}/orders/`]: () => json({ items: [order] }),
      [`GET ${POLAR_API}/subscriptions/`]: () => json({ items: [] }),
      [`GET ${POLAR_API}/checkouts/chk_9`]: () => json({ id: "chk_9", status: "succeeded" }),
    });
    // Find a minute the 5-minute poll is due for this site.
    let at = T0 + MIN;
    for (let i = 0; i < 5 && mock.to(`${POLAR_API}/orders/`).length === 0; i++) {
      await runJobs(sync, at);
      at += MIN;
    }
    expect(mock.to(`${POLAR_API}/orders/`)).toHaveLength(1);
    const [row] = await paymentRows(site.id);
    expect(row).toMatchObject({
      provider_txn_id: "ord_9",
      attributed_via: "link",
      visitor_id: v.visitorId,
    });
    const h = await env.DB.prepare("SELECT resolved_at FROM payment_hints").first<number>(
      "resolved_at",
    );
    expect(h).not.toBeNull();
  });
});

describe("Lemon Squeezy", () => {
  const SECRET = "ls_webhook_secret";

  it("connects, returns the store currency and creates the webhook with our secret", async () => {
    const { site, cookie } = await ownerWithSite({ currency: "USD" });
    mock = mockProviders({
      [`GET ${LS_API}/stores/123`]: () =>
        json({
          data: { type: "stores", id: "123", attributes: { name: "Store", currency: "EUR" } },
        }),
      [`POST ${LS_API}/webhooks`]: () =>
        json({ data: { type: "webhooks", id: "77", attributes: {} } }, 201),
    });
    const res = await api(`/api/v1/admin/websites/${site.id}/integrations/lemonsqueezy`, {
      cookie,
      body: { lemonsqueezyApiKey: "eyJ0eXAi", lemonsqueezyStoreId: "123" },
    });
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({
      message: "Lemon Squeezy connected successfully",
      currency: "USD",
      webhookConfigured: true,
    });
    const created = JSON.parse(mock.to(`${LS_API}/webhooks`)[0]?.body ?? "{}");
    expect(created.data.attributes.url).toBe(
      `https://datagoat.test/webhooks/lemonsqueezy/${site.id}`,
    );
    expect(created.data.attributes.secret).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(created.data.relationships.store.data.id).toBe("123");
    const status = await api(`/api/v1/admin/websites/${site.id}/integrations`, { cookie });
    expect(status.body.data[0].details[0]).toMatchObject({
      webhookConfigured: true,
      webhookAutoCreated: true,
    });
    const row = await env.DB.prepare(
      "SELECT account_name, currency FROM provider_connections",
    ).first();
    expect(row).toEqual({ account_name: "Store", currency: "EUR" });
    expect(
      (
        await api(`/api/v1/admin/websites/${site.id}/integrations/lemonsqueezy`, {
          cookie,
          body: { lemonsqueezyApiKey: "k", lemonsqueezyStoreId: "abc" },
        })
      ).status,
    ).toBe(400);
  });

  it("verifies X-Signature and reads custom_data, renewals and plan changes", async () => {
    const { site } = await ownerWithSite();
    const v = await visitorWithSessions(site.id, [{ at: Date.now() - DAY }]);
    await connect(site.id, "lemonsqueezy", {
      credentials: { apiKey: "k" },
      webhookSecret: SECRET,
      settings: { storeId: "123" },
    });
    const deliver = async (payload: unknown) => {
      const body = JSON.stringify(payload);
      return post("lemonsqueezy", site.id, body, {
        "x-signature": await sign.hex(SECRET, body),
        "x-event-name": "x",
      });
    };
    const now = iso(Date.now());
    const ok = await deliver({
      meta: { event_name: "order_created", custom_data: { datafast_visitor_id: v.visitorId } },
      data: {
        type: "orders",
        id: "1001",
        attributes: {
          status: "paid",
          total: 4900,
          currency: "USD",
          customer_id: 55,
          user_email: "l@x.io",
          created_at: now,
          updated_at: now,
        },
      },
    });
    expect(ok.status).toBe(200);
    for (const [id, total] of [
      ["9001", 1000],
      ["9002", 2000],
    ] as const) {
      await deliver({
        meta: { event_name: "subscription_payment_success" },
        data: {
          type: "subscription-invoices",
          id,
          attributes: {
            billing_reason: "renewal",
            status: "paid",
            total,
            currency: "USD",
            customer_id: 55,
            subscription_id: 7,
            created_at: now,
            updated_at: `${now}${id}`,
          },
        },
      });
    }
    await deliver({
      meta: { event_name: "subscription_payment_success" },
      data: {
        type: "subscription-invoices",
        id: "9000",
        attributes: {
          billing_reason: "initial",
          status: "paid",
          total: 4900,
          currency: "USD",
          customer_id: 55,
          subscription_id: 7,
          created_at: now,
          updated_at: now,
        },
      },
    });
    const rows = await paymentRows(site.id);
    expect(rows.map((r) => [r.provider_txn_id, r.kind, r.attributed_via]).sort()).toEqual([
      ["1001", "payment", "metadata"],
      ["inv_9001", "renewal", "customer"],
      ["inv_9002", "renewal", "customer"],
    ]);
    expect((await goalEvents(site.id)).map((g) => g.name)).toContain("subscription_upgraded");
    const bad = await post("lemonsqueezy", site.id, "{}", { "x-signature": "00" });
    expect(bad.status).toBe(401);
  });

  it("resolves ?order_id= hints", async () => {
    const { site } = await ownerWithSite();
    const v = await visitorWithSessions(site.id, [{ at: T0 - MIN }]);
    await connect(site.id, "lemonsqueezy", {
      credentials: { apiKey: "k" },
      settings: { storeId: "123" },
    });
    await addHint(site.id, "lemonsqueezy", "555", v.visitorId, v.sessions[0]?.id ?? "");
    mock = mockProviders({
      [`GET ${LS_API}/orders/555`]: () =>
        json({
          data: {
            type: "orders",
            id: "555",
            attributes: {
              store_id: 123,
              status: "paid",
              total: 700,
              currency: "USD",
              created_at: iso(T0),
            },
          },
        }),
    });
    await runJobs(hints, T0 + MIN);
    expect((await paymentRows(site.id))[0]).toMatchObject({
      provider_txn_id: "555",
      attributed_via: "link",
    });
  });
});

describe("Paddle Billing", () => {
  const SECRET = "pdl_ntfset_secret";

  it("accepts only pdl_live_ keys in production and returns the website currency", async () => {
    const { site, cookie } = await ownerWithSite({ currency: "GBP" });
    const url = `/api/v1/admin/websites/${site.id}/integrations/paddle`;
    expect((await api(url, { cookie, body: { paddleApiKey: "abc" } })).status).toBe(400);
    const sandbox = await api(url, { cookie, body: { paddleApiKey: "pdl_sdbx_apikey_1" } });
    expect(sandbox.body.error.message).toBe("Paddle sandbox keys only work in development");
    mock = mockProviders({
      [`GET ${PADDLE_API}/transactions`]: () => json({ data: [] }),
      [`GET ${PADDLE_API}/events`]: () => json({ data: [{ event_id: "evt_01newest" }] }),
    });
    const res = await api(url, { cookie, body: { paddleApiKey: "pdl_live_apikey_1" } });
    expect(res.body.data[0]).toMatchObject({
      message: "Paddle connected successfully",
      currency: "GBP",
    });
    const cursor = await env.DB.prepare(
      "SELECT cursor FROM provider_sync_state WHERE stream = 'sync'",
    ).first("cursor");
    expect(cursor).toBe("evt_01newest");
    const patch = await api(url, { cookie, method: "PATCH" });
    expect(patch.body).toEqual({
      status: "success",
      data: [{ message: "Paddle payment re-sync queued" }],
    });
    const status = await api(`/api/v1/admin/websites/${site.id}/integrations`, { cookie });
    expect(status.body.data[0].paddle).toEqual({ connected: true, keyExpiresAt: null });
    const del = await api(url, { cookie, method: "DELETE" });
    expect(del.body.data[0].message).toBe("Paddle disconnected successfully");
    expect((await api(url, { cookie, method: "PATCH" })).body.error.message).toBe(
      "Paddle is not connected to this website",
    );
  });

  it("polls the events API (ascending, from the cursor) with custom_data attribution", async () => {
    const { site } = await ownerWithSite();
    const v = await visitorWithSessions(site.id, [{ at: T0 - DAY }]);
    await connect(site.id, "paddle", {
      credentials: { apiKey: "pdl_live_k" },
      syncCursor: "evt_00",
    });
    const txn = {
      id: "txn_1",
      status: "completed",
      origin: "web",
      customer_id: "ctm_1",
      subscription_id: "sub_1",
      currency_code: "EUR",
      custom_data: { datafast_visitor_id: v.visitorId },
      details: { totals: { grand_total: "2400" } },
      billed_at: iso(T0),
    };
    mock = mockProviders({
      [`GET ${PADDLE_API}/events`]: (c) =>
        new URL(c.url).searchParams.get("after") === "evt_00"
          ? json({
              data: [
                {
                  event_id: "evt_01",
                  event_type: "subscription.created",
                  occurred_at: iso(T0),
                  data: {
                    id: "sub_1",
                    status: "active",
                    customer_id: "ctm_1",
                    currency_code: "EUR",
                    items: [
                      {
                        quantity: 1,
                        price: {
                          unit_price: { amount: "2400", currency_code: "EUR" },
                          billing_cycle: { interval: "month", frequency: 1 },
                        },
                      },
                    ],
                    custom_data: { datafast_visitor_id: v.visitorId },
                    scheduled_change: null,
                    updated_at: iso(T0),
                  },
                },
                {
                  event_id: "evt_02",
                  event_type: "transaction.completed",
                  occurred_at: iso(T0),
                  data: txn,
                },
                {
                  event_id: "evt_03",
                  event_type: "adjustment.updated",
                  occurred_at: iso(T0 + DAY),
                  data: {
                    id: "adj_1",
                    action: "refund",
                    status: "approved",
                    transaction_id: "txn_1",
                    currency_code: "EUR",
                    totals: { total: "600" },
                    updated_at: iso(T0 + DAY),
                  },
                },
              ],
              meta: { pagination: { has_more: false } },
            })
          : json({ data: [], meta: { pagination: { has_more: false } } }),
    });
    await runJobs(sync, T0 + 2 * DAY);
    const rows = await paymentRows(site.id);
    expect(
      rows.map((r) => [r.provider_txn_id, r.kind, r.amount_minor, r.currency, r.visitor_id]),
    ).toEqual([
      ["txn_1", "payment", 2400, "EUR", v.visitorId],
      ["adj_1", "refund", -600, "EUR", v.visitorId],
    ]);
    expect(
      await env.DB.prepare("SELECT cursor FROM provider_sync_state WHERE stream = 'sync'").first(
        "cursor",
      ),
    ).toBe("evt_03");
    expect(new URL(mock.calls[0]?.url ?? "").searchParams.get("order_by")).toBe("id[ASC]");
  });

  it("backfills by following Paddle's pagination URLs, one page per run", async () => {
    const { site } = await ownerWithSite();
    await connect(site.id, "paddle", { credentials: { apiKey: "pdl_live_k" }, backfill: true });
    const txn = (id: string) => ({
      id,
      status: "completed",
      origin: "web",
      currency_code: "USD",
      details: { totals: { grand_total: "1000" } },
      billed_at: iso(T0 - DAY),
    });
    const next = `${PADDLE_API}/transactions?after=txn_a&per_page=50`;
    mock = mockProviders({
      [`GET ${PADDLE_API}/transactions`]: (c) =>
        c.url === next
          ? json({ data: [txn("txn_b")], meta: { pagination: { has_more: false } } })
          : json({ data: [txn("txn_a")], meta: { pagination: { has_more: true, next } } }),
      [`GET ${PADDLE_API}/subscriptions`]: () => json({ data: [], meta: { pagination: {} } }),
      [`GET ${PADDLE_API}/adjustments`]: () => json({ data: [], meta: { pagination: {} } }),
      [`GET ${PADDLE_API}/events`]: () => json({ data: [], meta: { pagination: {} } }),
    });
    for (let i = 0; i < 5; i++) await runJobs(sync, T0 + i * MIN);
    const pages = mock.calls.filter((c) => !c.url.includes("/events"));
    expect(pages.map((c) => new URL(c.url).pathname)).toEqual([
      "/transactions",
      "/transactions",
      "/subscriptions",
      "/adjustments",
    ]);
    expect(pages[1]?.url).toBe(next);
    expect((await paymentRows(site.id)).map((r) => r.provider_txn_id)).toEqual(["txn_a", "txn_b"]);
  });

  it("verifies Paddle-Signature webhooks", async () => {
    const { site } = await ownerWithSite();
    await connect(site.id, "paddle", {
      credentials: { apiKey: "pdl_live_k" },
      webhookSecret: SECRET,
    });
    const body = JSON.stringify({
      event_id: "evt_w1",
      event_type: "transaction.completed",
      occurred_at: iso(Date.now()),
      data: {
        id: "txn_w",
        status: "completed",
        origin: "subscription_recurring",
        currency_code: "USD",
        details: { totals: { grand_total: "1000" } },
      },
    });
    const ok = await post("paddle", site.id, body, {
      "paddle-signature": await sign.paddle(SECRET, body, sec(Date.now())),
    });
    expect(ok.status).toBe(200);
    expect((await paymentRows(site.id))[0]).toMatchObject({
      provider_txn_id: "txn_w",
      kind: "renewal",
    });
    const bad = await post("paddle", site.id, body, {
      "paddle-signature": `ts=${sec(Date.now())};h1=00`,
    });
    expect(bad.status).toBe(401);
  });
});

describe("Dodo Payments", () => {
  const SECRET = `whsec_${toBase64(new TextEncoder().encode("dodo-secret"))}`;

  it("connects, ingests Standard Webhooks and treats later subscription charges as renewals", async () => {
    const { site, cookie } = await ownerWithSite();
    mock = mockProviders({ [`GET ${DODO_API}/payments`]: () => json({ items: [] }) });
    const res = await api(`/api/v1/admin/websites/${site.id}/integrations/dodo`, {
      cookie,
      body: { apiKey: "dodo_key", webhookSecret: SECRET },
    });
    expect(res.body.data[0]).toMatchObject({
      message: "Dodo Payments connected successfully",
      webhookConfigured: true,
    });
    const v = await visitorWithSessions(site.id, [{ at: Date.now() - DAY }]);
    const pay = (id: string) => ({
      payment_id: id,
      status: "succeeded",
      total_amount: 1999,
      currency: "USD",
      customer: { customer_id: "cus_d", email: "d@x.io" },
      subscription_id: "sub_d",
      metadata: { datafast_visitor_id: v.visitorId },
      created_at: iso(Date.now()),
    });
    for (const [i, payload] of [
      { type: "payment.succeeded", data: pay("pay_1") },
      { type: "payment.succeeded", data: { ...pay("pay_2"), metadata: {} } },
      {
        type: "refund.succeeded",
        data: {
          refund_id: "ref_1",
          payment_id: "pay_2",
          amount: 1999,
          currency: "USD",
          status: "succeeded",
          created_at: iso(Date.now()),
        },
      },
    ].entries()) {
      const body = JSON.stringify({ ...payload, timestamp: iso(Date.now()) });
      expect(
        (await post("dodo", site.id, body, await standardHeaders(SECRET, `d_${i}`, body))).status,
      ).toBe(200);
    }
    const rows = await paymentRows(site.id);
    expect(rows.map((r) => [r.provider_txn_id, r.kind, r.attributed_via]).sort()).toEqual([
      ["pay_1", "payment", "metadata"],
      ["pay_2", "renewal", "customer"],
      ["ref_1", "refund", "customer"],
    ]);
  });
});

describe("Creem", () => {
  const SECRET = "creem_whsec";

  it("verifies creem-signature and maps checkout.completed metadata", async () => {
    const { site } = await ownerWithSite();
    const v = await visitorWithSessions(site.id, [{ at: Date.now() - DAY }]);
    await connect(site.id, "creem", { credentials: { apiKey: "creem_k" }, webhookSecret: SECRET });
    const body = JSON.stringify({
      id: "evt_c1",
      eventType: "checkout.completed",
      created_at: Date.now(),
      object: {
        id: "ch_1",
        status: "completed",
        metadata: { datagoat_visitor_id: v.visitorId },
        customer: { id: "cust_c", email: "c@x.io" },
        order: {
          id: "ord_c",
          transaction: "tran_c",
          amount: 3000,
          currency: "EUR",
          created_at: iso(Date.now()),
        },
      },
    });
    const ok = await post("creem", site.id, body, {
      "creem-signature": await sign.hex(SECRET, body),
    });
    expect(ok.status).toBe(200);
    expect((await paymentRows(site.id))[0]).toMatchObject({
      provider_txn_id: "tran_c",
      amount_minor: 3000,
      currency: "EUR",
      attributed_via: "metadata",
    });
    expect((await post("creem", site.id, body, { "creem-signature": "bad" })).status).toBe(401);
  });

  it("rejects test keys unless enabled", async () => {
    const { site, cookie } = await ownerWithSite();
    const res = await api(`/api/v1/admin/websites/${site.id}/integrations/creem`, {
      cookie,
      body: { apiKey: "creem_test_123" },
    });
    expect(res.status).toBe(400);
  });

  it("polls transactions", async () => {
    const { site } = await ownerWithSite();
    await connect(site.id, "creem", { credentials: { apiKey: "creem_k" }, now: T0 - DAY });
    mock = mockProviders({
      [`GET ${CREEM_API}/v1/transactions/search`]: () =>
        json({
          items: [{ id: "tran_p", status: "paid", amount: 500, currency: "USD", created_at: T0 }],
        }),
    });
    for (let i = 1; i <= 5; i++) await runJobs(sync, T0 + i * MIN);
    expect(mock.calls).toHaveLength(1);
    expect((await paymentRows(site.id))[0]).toMatchObject({
      provider_txn_id: "tran_p",
      source: "poll",
    });
  });
});

describe("Shopify", () => {
  const SECRET = "shpss_client_secret";

  it("verifies the HMAC, reads the visitor from cart attributes and records refunds", async () => {
    const { site, cookie } = await ownerWithSite({ currency: "USD" });
    const res = await api(`/api/v1/admin/websites/${site.id}/integrations/shopify`, {
      cookie,
      body: { shopDomain: "https://Acme.myshopify.com/admin", webhookSecret: SECRET },
    });
    expect(res.body.data[0]).toMatchObject({
      message: "Shopify connected successfully",
      webhookConfigured: true,
    });
    const v = await visitorWithSessions(site.id, [
      { at: Date.now() - DAY, channel: "Organic Social" },
    ]);
    const order = {
      id: 820982911946154500,
      name: "#1001",
      email: "s@x.io",
      currency: "USD",
      total_price: "59.50",
      financial_status: "paid",
      customer: { id: 115310627314723950 },
      note_attributes: [{ name: "datagoat_visitor_id", value: v.visitorId }],
      processed_at: iso(Date.now()),
    };
    const deliver = async (topic: string, payload: unknown, shop = "acme.myshopify.com") => {
      const body = JSON.stringify(payload);
      return post("shopify", site.id, body, {
        "x-shopify-hmac-sha256": await sign.base64(SECRET, body),
        "x-shopify-topic": topic,
        "x-shopify-shop-domain": shop,
        "x-shopify-event-id": `${topic}:${body.length}`,
      });
    };
    expect((await deliver("orders/paid", order)).status).toBe(200);
    await deliver("refunds/create", {
      id: 999,
      order_id: order.id,
      transactions: [{ kind: "refund", status: "success", amount: "10.00", currency: "USD" }],
    });
    await deliver("orders/paid", { ...order, id: 1 }, "evil.myshopify.com");
    const rows = await paymentRows(site.id);
    expect(
      rows.map((r) => [r.provider_txn_id, r.kind, r.amount_minor, r.visitor_id]).sort(),
    ).toEqual(
      [
        ["820982911946154500", "payment", 5950, v.visitorId],
        ["refund:999", "refund", -1000, v.visitorId],
      ].sort(),
    );
    const bad = await post("shopify", site.id, "{}", { "x-shopify-hmac-sha256": "nope" });
    expect(bad.status).toBe(401);
  });

  it("rejects non-myshopify domains", async () => {
    const { site, cookie } = await ownerWithSite();
    const res = await api(`/api/v1/admin/websites/${site.id}/integrations/shopify`, {
      cookie,
      body: { shopDomain: "acme.com", webhookSecret: "s" },
    });
    expect(res.status).toBe(400);
  });
});

describe("WooCommerce", () => {
  const SECRET = "wc_webhook_secret";

  it("acknowledges the ping, verifies signatures and reads _datagoat_visitor_id", async () => {
    const { site } = await ownerWithSite({ currency: "EUR" });
    await connect(site.id, "woocommerce", {
      credentials: {},
      webhookSecret: SECRET,
      settings: { storeUrl: "https://shop.example" },
    });
    const ping = await post("woocommerce", site.id, "webhook_id=12", {
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(ping.status).toBe(200);
    const v = await visitorWithSessions(site.id, [{ at: Date.now() - DAY }]);
    const order = {
      id: 727,
      status: "processing",
      currency: "EUR",
      total: "29.00",
      customer_id: 3,
      date_paid_gmt: "2026-11-03T10:00:00",
      billing: { email: "w@x.io", first_name: "W", last_name: "C" },
      meta_data: [{ id: 1, key: "_datagoat_visitor_id", value: v.visitorId }],
      refunds: [],
    };
    const deliver = async (payload: unknown, id: string) => {
      const body = JSON.stringify(payload);
      return post("woocommerce", site.id, body, {
        "x-wc-webhook-signature": await sign.base64(SECRET, body),
        "x-wc-webhook-topic": "order.updated",
        "x-wc-webhook-delivery-id": id,
      });
    };
    expect((await deliver(order, "1")).status).toBe(200);
    await deliver({ ...order, refunds: [{ id: 81, total: "-9.00" }] }, "2");
    await deliver({ ...order, id: 728, status: "pending", date_paid_gmt: null }, "3");
    const rows = await paymentRows(site.id);
    expect(
      rows
        .map((r) => [r.provider_txn_id, r.kind, r.amount_minor, r.attributed_via, r.occurred_at])
        .sort(),
    ).toEqual(
      [
        ["727", "payment", 2900, "metadata", Date.UTC(2026, 10, 3, 10)],
        ["refund:81", "refund", -900, "metadata", expect.any(Number)],
      ].sort(),
    );
    expect(
      (await post("woocommerce", site.id, JSON.stringify(order), { "x-wc-webhook-signature": "x" }))
        .status,
    ).toBe(401);
  });
});
