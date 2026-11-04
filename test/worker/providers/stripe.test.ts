import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { providerJobs } from "../../../src/providers";
import {
  EVENTS_PER_PAGE,
  MAX_EVENT_PAGES,
  STRIPE_API,
} from "../../../src/providers/adapters/stripe";
import { sign } from "../../../src/providers/signatures";
import { meterEnv, resetDb } from "../../helpers/db";
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

const KEY = "rk_live_51Habcdefghijklmnop";
const sync = providerJobs.filter((j) => j.name === "providers.sync");
const hints = providerJobs.filter((j) => j.name === "providers.resolve-hints");
const sec = (ms: number) => Math.floor(ms / 1000);

let n = 0;
function event(
  type: string,
  object: Record<string, unknown>,
  at: number,
  previous?: Record<string, unknown>,
) {
  n += 1;
  return {
    id: `evt_${String(n).padStart(4, "0")}`,
    object: "event",
    type,
    created: sec(at),
    data: { object, ...(previous ? { previous_attributes: previous } : {}) },
  };
}

function list(data: unknown[], hasMore = false) {
  return json({ object: "list", data, has_more: hasMore });
}

/** Serve `events` (oldest first) through Stripe's newest-first `ending_before` pagination. */
function eventsApi(all: Array<{ id: string }>) {
  return (call: { url: string }) => {
    const url = new URL(call.url);
    const before = url.searchParams.get("ending_before");
    const limit = Number(url.searchParams.get("limit") ?? 10);
    const idx = before ? all.findIndex((e) => e.id === before) : -1;
    const newer = before ? all.slice(idx + 1) : all;
    const page = before ? newer.slice(0, limit) : newer.slice(-limit);
    return list([...page].reverse(), before ? newer.length > limit : all.length > limit);
  };
}

describe("connect", () => {
  it("rejects publishable, secret and malformed keys", async () => {
    const { site, cookie } = await ownerWithSite();
    const url = `/api/v1/admin/websites/${site.id}/integrations/stripe`;
    for (const [key, msg] of [
      ["pk_live_abc", /Publishable/],
      ["sk_live_abc", /Secret keys/],
      ["hello", /rk_/],
      ["", /required/],
    ] as const) {
      const res = await api(url, { cookie, body: { stripeRak: key } });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(msg);
    }
    const test = await api(url, { cookie, body: { stripeRak: "rk_test_abcdefghijklmnop" } });
    expect(test.status).toBe(400);
    expect(test.body.error.message).toMatch(/Test keys/);
  });

  it("validates read permissions, stores the key encrypted and starts at the newest event", async () => {
    const { site, cookie } = await ownerWithSite({ currency: "EUR" });
    mock = mockProviders({
      [`GET ${STRIPE_API}/events`]: () => list([{ id: "evt_newest" }]),
      [`GET ${STRIPE_API}/checkout/sessions`]: () => list([]),
      [`GET ${STRIPE_API}/charges`]: () => list([]),
      [`GET ${STRIPE_API}/invoices`]: () => list([]),
      [`GET ${STRIPE_API}/subscriptions`]: () => list([]),
      [`GET ${STRIPE_API}/account`]: () => json({ error: { message: "no" } }, 403),
    });
    const res = await api(`/api/v1/admin/websites/${site.id}/integrations/stripe`, {
      cookie,
      body: { stripeRak: KEY },
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      {
        message: "Stripe connected successfully",
        currency: "EUR",
        webhookUrl: `https://datagoat.test/webhooks/stripe/${site.id}`,
        webhookConfigured: false,
      },
    ]);
    for (const call of mock.calls) {
      expect(call.headers.get("authorization")).toBe(`Bearer ${KEY}`);
      expect(call.method).toBe("GET");
    }
    const row = await env.DB.prepare("SELECT * FROM provider_connections WHERE site_id = ?")
      .bind(site.id)
      .first<Record<string, string>>();
    expect(row?.credentials_enc).toMatch(/^v1\./);
    expect(row?.credentials_enc).not.toContain("rk_live");
    const states = await env.DB.prepare(
      "SELECT stream, cursor, done FROM provider_sync_state WHERE site_id = ? ORDER BY stream",
    )
      .bind(site.id)
      .all();
    expect(states.results).toEqual([
      { stream: "backfill", cursor: null, done: 0 },
      { stream: "sync", cursor: JSON.stringify({ id: "evt_newest" }), done: 0 },
    ]);
    const status = await api(`/api/v1/admin/websites/${site.id}/integrations`, { cookie });
    expect(status.body.data[0]).toMatchObject({
      stripe: { connected: true },
      polar: { connected: false },
      currency: "EUR",
      details: [
        { provider: "stripe", status: "active", backfillComplete: false, webhookConfigured: false },
      ],
    });
    expect(JSON.stringify(status.body)).not.toContain(KEY);
  });

  it("names the read permissions the restricted key lacks", async () => {
    const { site, cookie } = await ownerWithSite();
    const denied = () =>
      json({ error: { message: "does not have the required permissions" } }, 403);
    mock = mockProviders({
      [`GET ${STRIPE_API}/events`]: () => list([]),
      [`GET ${STRIPE_API}/checkout/sessions`]: denied,
      [`GET ${STRIPE_API}/charges`]: () => list([]),
      [`GET ${STRIPE_API}/invoices`]: denied,
      [`GET ${STRIPE_API}/subscriptions`]: () => list([]),
    });
    const res = await api(`/api/v1/admin/websites/${site.id}/integrations/stripe`, {
      cookie,
      body: { stripeRak: KEY },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe(
      "The restricted key is missing read access to: Checkout Sessions, Invoices",
    );
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM provider_connections").first("n")).toBe(
      0,
    );
  });

  it("rejects an invalid key without storing it", async () => {
    const { site, cookie } = await ownerWithSite();
    mock = mockProviders({
      [`GET ${STRIPE_API}/`]: () => json({ error: { message: "Invalid API Key" } }, 401),
    });
    const res = await api(`/api/v1/admin/websites/${site.id}/integrations/stripe`, {
      cookie,
      body: { stripeRak: KEY },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/rejected the key/);
  });
});

describe("Events API polling", () => {
  it("polls from the cursor, attributes by metadata and advances the cursor", async () => {
    const { site } = await ownerWithSite();
    const v = await visitorWithSessions(site.id, [
      { at: T0 - 2 * DAY, channel: "Organic Search" },
      { at: T0 - 10 * MIN, channel: "Direct" },
    ]);
    await connect(site.id, "stripe", {
      credentials: { apiKey: KEY },
      syncCursor: JSON.stringify({ id: "evt_0000" }),
    });
    const events = [
      { id: "evt_0000" },
      event(
        "checkout.session.completed",
        {
          id: "cs_live_a1",
          object: "checkout.session",
          mode: "payment",
          status: "complete",
          payment_status: "paid",
          amount_total: 4900,
          currency: "usd",
          customer: "cus_A",
          customer_details: { email: "a@example.com", name: "Ann" },
          payment_intent: "pi_A",
          metadata: { datafast_visitor_id: v.visitorId, datafast_session_id: v.sessions[1]?.id },
          created: sec(T0),
        },
        T0,
      ),
      // The PaymentIntent of the same checkout: deduplicated by its id.
      event(
        "payment_intent.succeeded",
        {
          id: "pi_A",
          status: "succeeded",
          amount_received: 4900,
          currency: "usd",
          invoice: null,
          metadata: {},
        },
        T0,
      ),
    ];
    mock = mockProviders({ [`GET ${STRIPE_API}/events`]: eventsApi(events) });
    await runJobs(sync, T0 + MIN);
    const [row, ...rest] = await paymentRows(site.id);
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({
      provider: "stripe",
      provider_txn_id: "pi_A",
      provider_customer_id: "cus_A",
      kind: "payment",
      amount_minor: 4900,
      visitor_id: v.visitorId,
      attributed_via: "metadata",
      first_session_id: v.sessions[0]?.id,
      last_session_id: v.sessions[1]?.id,
      source: "poll",
    });
    const url = new URL(mock.calls[0]?.url ?? "");
    expect(url.searchParams.get("ending_before")).toBe("evt_0000");
    expect(url.searchParams.getAll("types[]")).toContain("invoice.paid");
    const state = await env.DB.prepare(
      "SELECT cursor FROM provider_sync_state WHERE site_id = ? AND stream = 'sync'",
    )
      .bind(site.id)
      .first<string>("cursor");
    expect(JSON.parse(state ?? "{}")).toEqual({ id: events[2]?.id });
    expect((await goalEvents(site.id)).map((g) => g.name)).toEqual(["payment"]);
  });

  it("pages through bursts, bounded per run", async () => {
    const { site } = await ownerWithSite();
    await connect(site.id, "stripe", {
      credentials: { apiKey: KEY },
      syncCursor: JSON.stringify({ id: "evt_start" }),
    });
    const events: Array<{ id: string }> = [{ id: "evt_start" }];
    for (let i = 0; i < 350; i++) {
      events.push(
        event(
          "payment_intent.succeeded",
          {
            id: `pi_${i}`,
            status: "succeeded",
            amount_received: 100,
            currency: "usd",
            metadata: { datagoat_visitor_id: "00000000-0000-4000-8000-000000000000" },
          },
          T0 + i * 1000,
        ),
      );
    }
    mock = mockProviders({ [`GET ${STRIPE_API}/events`]: eventsApi(events) });
    await runJobs(sync, T0 + MIN);
    expect(mock.calls).toHaveLength(MAX_EVENT_PAGES);
    expect(await paymentRows(site.id)).toHaveLength(MAX_EVENT_PAGES * EVENTS_PER_PAGE);
    for (let i = 2; i <= 4; i++) await runJobs(sync, T0 + i * MIN);
    expect(await paymentRows(site.id)).toHaveLength(350);
    expect(mock.calls.length).toBeLessThanOrEqual(4 * MAX_EVENT_PAGES);
  });

  it("recovers from a cursor that aged out of Stripe's 30-day window", async () => {
    const { site } = await ownerWithSite();
    await connect(site.id, "stripe", {
      credentials: { apiKey: KEY },
      syncCursor: JSON.stringify({ id: "evt_gone" }),
    });
    mock = mockProviders({
      [`GET ${STRIPE_API}/events`]: (c) =>
        new URL(c.url).searchParams.get("ending_before")
          ? json({ error: { message: "No such event: 'evt_gone'" } }, 400)
          : list([{ id: "evt_head" }]),
    });
    await runJobs(sync, T0 + MIN);
    const states = await env.DB.prepare(
      "SELECT stream, cursor, done FROM provider_sync_state WHERE site_id = ? ORDER BY stream",
    )
      .bind(site.id)
      .all();
    expect(states.results).toEqual([
      { stream: "backfill", cursor: null, done: 0 },
      { stream: "sync", cursor: JSON.stringify({ id: "evt_head" }), done: 0 },
    ]);
  });

  it("an idle poll (and idle hint/FX/email jobs) writes nothing", async () => {
    const { site } = await ownerWithSite();
    await connect(site.id, "stripe", {
      credentials: { apiKey: KEY },
      syncCursor: JSON.stringify({ id: "evt_x" }),
    });
    mock = mockProviders({
      [`GET ${STRIPE_API}/events`]: () => list([]),
      "GET https://www.ecb.europa.eu/": () => new Response("<gesmes/>"),
    });
    await runJobs(providerJobs, T0);
    const m = meterEnv();
    const before = mock.calls.length;
    const res = await runJobs(providerJobs, T0 + MIN, m.env);
    expect(
      res.results
        .filter((r) => r.status === "ok")
        .map((r) => r.name)
        .sort(),
    ).toEqual(["providers.resolve-hints", "providers.sync"]);
    expect(m.d1.rowsWritten).toBe(0);
    expect(m.d1.queries).toBeLessThanOrEqual(5);
    expect(mock.calls.length - before).toBe(1);
  });
});

describe("backfill", () => {
  it("pages through every stream inside cron runs and finishes", async () => {
    const { site } = await ownerWithSite();
    const v = await visitorWithSessions(site.id, [{ at: T0 - 30 * DAY, channel: "Referral" }]);
    await connect(site.id, "stripe", {
      credentials: { apiKey: KEY },
      backfill: true,
      syncCursor: JSON.stringify({ id: "evt_1" }),
    });
    const session = (i: number) => ({
      id: `cs_${i}`,
      mode: "subscription",
      status: "complete",
      payment_status: "paid",
      amount_total: 1000,
      currency: "usd",
      customer: "cus_B",
      invoice: `in_${i}`,
      subscription: "sub_B",
      metadata: { datagoat_visitor_id: v.visitorId },
      created: sec(T0 - 20 * DAY),
    });
    mock = mockProviders({
      [`GET ${STRIPE_API}/events`]: () => list([]),
      [`GET ${STRIPE_API}/checkout/sessions`]: (c) =>
        new URL(c.url).searchParams.get("starting_after")
          ? list([session(2)])
          : list([session(1)], true),
      [`GET ${STRIPE_API}/subscriptions`]: () => list([]),
      [`GET ${STRIPE_API}/invoices`]: () =>
        list([
          {
            id: "in_9",
            status: "paid",
            amount_paid: 1000,
            currency: "usd",
            customer: "cus_B",
            subscription: "sub_B",
            billing_reason: "subscription_cycle",
            status_transitions: { paid_at: sec(T0 - 5 * DAY) },
          },
        ]),
      [`GET ${STRIPE_API}/payment_intents`]: () => list([]),
      [`GET ${STRIPE_API}/refunds`]: () => json({ error: { message: "forbidden" } }, 403),
      [`GET ${STRIPE_API}/disputes`]: () => list([]),
    });
    // One backfill page per connection per run (plus the events poll).
    for (let i = 0; i < 8; i++) {
      const before = mock.calls.length;
      await runJobs(sync, T0 + i * MIN);
      expect(mock.calls.length - before).toBeLessThanOrEqual(2);
    }
    const backfillCalls = mock.calls.filter((c) => !c.url.includes("/events"));
    expect(backfillCalls).toHaveLength(7);
    const done = await env.DB.prepare(
      "SELECT done, last_error FROM provider_sync_state WHERE site_id = ? AND stream = 'backfill'",
    )
      .bind(site.id)
      .first<{ done: number; last_error: string }>();
    expect(done?.done).toBe(1);
    expect(done?.last_error).toMatch(/refunds/);
    const rows = await paymentRows(site.id);
    expect(rows.map((r) => [r.provider_txn_id, r.kind, r.attributed_via, r.source])).toEqual([
      ["in_1", "payment", "metadata", "backfill"],
      ["in_2", "payment", "metadata", "backfill"],
      ["in_9", "renewal", "customer", "backfill"],
    ]);
  });
});

describe("webhooks", () => {
  const SECRET = "whsec_test_signing_secret";

  async function deliver(siteId: string, payload: unknown, secret = SECRET, at = Date.now()) {
    const body = JSON.stringify(payload);
    return api(`/webhooks/stripe/${siteId}`, {
      method: "POST",
      body,
      origin: null,
      headers: { "stripe-signature": await sign.stripe(secret, body, sec(at)) },
    });
  }

  it("verifies signatures, dedupes deliveries and ingests the event", async () => {
    const { site } = await ownerWithSite();
    const v = await visitorWithSessions(site.id, [{ at: Date.now() - DAY }]);
    await connect(site.id, "stripe", { credentials: { apiKey: KEY }, webhookSecret: SECRET });
    const payload = event(
      "checkout.session.completed",
      {
        id: "cs_live_w",
        mode: "payment",
        status: "complete",
        payment_status: "paid",
        amount_total: 1500,
        currency: "gbp",
        payment_intent: "pi_w",
        client_reference_id: v.visitorId,
        created: sec(Date.now()),
      },
      Date.now(),
    );
    const ok = await deliver(site.id, payload);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ received: true });
    const dup = await deliver(site.id, payload);
    expect(dup.body).toEqual({ received: true, duplicate: true });
    const rows = await paymentRows(site.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider_txn_id: "pi_w",
      currency: "GBP",
      visitor_id: v.visitorId,
      attributed_via: "metadata",
      source: "webhook",
    });

    expect((await deliver(site.id, payload, "whsec_wrong")).status).toBe(401);
    const old = await deliver(site.id, { ...payload, id: "evt_old" }, SECRET, Date.now() - 600_000);
    expect(old.status).toBe(401);
    expect((await deliver("000000000000000000000000", payload)).status).toBe(404);
  });

  it("needs a configured secret and a connection", async () => {
    const { site } = await ownerWithSite();
    expect((await deliver(site.id, { id: "evt_1" })).status).toBe(404);
    await connect(site.id, "stripe", { credentials: { apiKey: KEY } });
    const res = await deliver(site.id, { id: "evt_1" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/No webhook signing secret/);
  });

  it("records disputes against the original visitor and reverses a won dispute", async () => {
    const { site } = await ownerWithSite();
    const v = await visitorWithSessions(site.id, [{ at: Date.now() - DAY }]);
    await connect(site.id, "stripe", { credentials: { apiKey: KEY }, webhookSecret: SECRET });
    await deliver(
      site.id,
      event(
        "payment_intent.succeeded",
        {
          id: "pi_d",
          status: "succeeded",
          amount_received: 8000,
          currency: "usd",
          metadata: { datafast_visitor_id: v.visitorId },
        },
        Date.now(),
      ),
    );
    const dispute = {
      id: "dp_1",
      amount: 8000,
      currency: "usd",
      payment_intent: "pi_d",
      charge: "ch_d",
      status: "needs_response",
      created: sec(Date.now()),
    };
    await deliver(site.id, event("charge.dispute.created", dispute, Date.now()));
    await deliver(
      site.id,
      event("charge.dispute.closed", { ...dispute, status: "won" }, Date.now()),
    );
    const rows = await paymentRows(site.id);
    expect(
      rows
        .map((r) => [r.provider_txn_id, r.kind, r.amount_minor, r.reason, r.visitor_id])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ["dp_1", "refund", -8000, "dispute", v.visitorId],
      ["dp_1:won", "refund", 8000, "dispute_won", v.visitorId],
      ["pi_d", "payment", 8000, null, v.visitorId],
    ]);
  });

  it("records refunds (with or without the refunds list) as negative revenue", async () => {
    const { site } = await ownerWithSite();
    const v = await visitorWithSessions(site.id, [{ at: Date.now() - DAY }]);
    await connect(site.id, "stripe", { credentials: { apiKey: KEY }, webhookSecret: SECRET });
    await deliver(
      site.id,
      event(
        "payment_intent.succeeded",
        {
          id: "pi_r",
          status: "succeeded",
          amount_received: 3000,
          currency: "usd",
          metadata: { datafast_visitor_id: v.visitorId },
        },
        Date.now(),
      ),
    );
    await deliver(
      site.id,
      event(
        "charge.refunded",
        { id: "ch_r", payment_intent: "pi_r", amount_refunded: 1000, currency: "usd" },
        Date.now(),
      ),
    );
    await deliver(
      site.id,
      event(
        "charge.refunded",
        { id: "ch_r", payment_intent: "pi_r", amount_refunded: 3000, currency: "usd" },
        Date.now(),
      ),
    );
    const refund = (await paymentRows(site.id)).filter((r) => r.kind === "refund");
    expect(refund).toHaveLength(1);
    expect(refund[0]).toMatchObject({
      provider_txn_id: "ch_r:refund",
      amount_minor: -3000,
      visitor_id: v.visitorId,
      refund_of: "pi_r",
    });
  });

  it("skips invoice PaymentIntents (recorded from invoice.paid)", async () => {
    const { site } = await ownerWithSite();
    await connect(site.id, "stripe", { credentials: { apiKey: KEY }, webhookSecret: SECRET });
    await deliver(
      site.id,
      event(
        "payment_intent.succeeded",
        {
          id: "pi_inv",
          status: "succeeded",
          amount_received: 900,
          currency: "usd",
          invoice: "in_1",
          metadata: {},
        },
        Date.now(),
      ),
    );
    await deliver(
      site.id,
      event(
        "payment_intent.succeeded",
        { id: "pi_new", status: "succeeded", amount_received: 900, currency: "usd", metadata: {} },
        Date.now(),
      ),
    );
    expect(await paymentRows(site.id)).toHaveLength(0);
  });
});

describe("subscription lifecycle", () => {
  it("emits DataFast's reserved goals across a subscription's life", async () => {
    const { site } = await ownerWithSite();
    const v = await visitorWithSessions(site.id, [{ at: T0 - DAY, channel: "Paid Search" }]);
    await connect(site.id, "stripe", {
      credentials: { apiKey: KEY },
      syncCursor: JSON.stringify({ id: "evt_s0" }),
    });
    const sub = (patch: Record<string, unknown>) => ({
      id: "sub_L",
      object: "subscription",
      customer: "cus_L",
      status: "active",
      cancel_at_period_end: false,
      currency: "usd",
      items: {
        data: [
          {
            quantity: 1,
            price: { unit_amount: 2000, recurring: { interval: "month", interval_count: 1 } },
          },
        ],
      },
      start_date: sec(T0),
      ...patch,
    });
    const events: Array<{ id: string }> = [
      { id: "evt_s0" },
      event(
        "customer.subscription.created",
        sub({ status: "trialing", trial_start: sec(T0), trial_end: sec(T0 + 14 * DAY) }),
        T0,
      ),
      event(
        "checkout.session.completed",
        {
          id: "cs_L",
          mode: "subscription",
          status: "complete",
          payment_status: "no_payment_required",
          amount_total: 0,
          currency: "usd",
          customer: "cus_L",
          subscription: "sub_L",
          metadata: { datafast_visitor_id: v.visitorId },
        },
        T0 + 1000,
      ),
    ];
    mock = mockProviders({ [`GET ${STRIPE_API}/events`]: eventsApi(events) });
    await runJobs(sync, T0 + MIN);
    expect((await goalEvents(site.id)).map((g) => g.name)).toEqual(["trial_started", "free_trial"]);
    const t1 = T0 + 14 * DAY;
    events.push(
      event("customer.subscription.updated", sub({ status: "active" }), t1, { status: "trialing" }),
      event(
        "invoice.paid",
        {
          id: "in_L1",
          status: "paid",
          amount_paid: 2000,
          currency: "usd",
          customer: "cus_L",
          subscription: "sub_L",
          billing_reason: "subscription_cycle",
          status_transitions: { paid_at: sec(t1) },
        },
        t1,
      ),
    );
    await runJobs(sync, t1 + MIN);
    events.push(
      event("customer.subscription.updated", sub({ cancel_at_period_end: true }), t1 + DAY),
    );
    events.push(
      event("customer.subscription.updated", sub({ cancel_at_period_end: false }), t1 + 2 * DAY),
    );
    events.push(
      event(
        "customer.subscription.updated",
        sub({
          items: {
            data: [{ quantity: 2, price: { unit_amount: 2000, recurring: { interval: "month" } } }],
          },
        }),
        t1 + 3 * DAY,
      ),
    );
    events.push(
      event(
        "invoice.paid",
        {
          id: "in_L2",
          status: "paid",
          amount_paid: 4000,
          currency: "usd",
          customer: "cus_L",
          subscription: "sub_L",
          billing_reason: "subscription_cycle",
          status_transitions: { paid_at: sec(t1 + 30 * DAY) },
        },
        t1 + 30 * DAY,
      ),
    );
    events.push(event("customer.subscription.deleted", sub({ status: "canceled" }), t1 + 40 * DAY));
    await runJobs(sync, t1 + 41 * DAY);
    expect((await goalEvents(site.id)).map((g) => g.name)).toEqual([
      "trial_started",
      "free_trial",
      "trial_converted",
      "payment",
      "subscription_cancel_scheduled",
      "subscription_reactivated",
      "subscription_upgraded",
      "subscription_renewed",
      "subscription_ended",
    ]);
    const rows = await paymentRows(site.id);
    expect(rows.map((r) => [r.provider_txn_id, r.kind, r.attributed_via])).toEqual([
      ["sub_L:trial", "free_trial", "customer"],
      ["in_L1", "payment", "customer"],
      ["in_L2", "renewal", "customer"],
    ]);
    const stored = await env.DB.prepare("SELECT * FROM provider_subscriptions WHERE site_id = ?")
      .bind(site.id)
      .first();
    expect(stored).toMatchObject({
      status: "ended",
      visitor_id: v.visitorId,
      mrr_minor: 2000,
      had_trial: 1,
    });
  });
});

describe("Payment Links (success-page hints)", () => {
  async function hint(siteId: string, visitorId: string, sessionId: string, ref: string) {
    await env.DB.prepare(
      "INSERT INTO payment_hints (site_id, provider, ref, visitor_id, session_id, created_at) VALUES (?, 'stripe', ?, ?, ?, ?)",
    )
      .bind(siteId, ref, visitorId, sessionId, T0)
      .run();
  }
  const paidSession = {
    id: "cs_live_link",
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    amount_total: 2500,
    currency: "usd",
    payment_intent: "pi_link",
    customer: "cus_K",
    created: sec(T0),
  };

  it("resolves a hint through the Checkout Session and attributes it via link", async () => {
    const { site } = await ownerWithSite();
    const v = await visitorWithSessions(site.id, [{ at: T0 - 5 * MIN, channel: "Organic Social" }]);
    await connect(site.id, "stripe", { credentials: { apiKey: KEY } });
    await hint(site.id, v.visitorId, v.sessions[0]?.id ?? "", "cs_live_link");
    mock = mockProviders({
      [`GET ${STRIPE_API}/checkout/sessions/cs_live_link`]: () => json(paidSession),
    });
    await runJobs(hints, T0 + MIN);
    const [row] = await paymentRows(site.id);
    expect(row).toMatchObject({
      provider_txn_id: "pi_link",
      attributed_via: "link",
      visitor_id: v.visitorId,
      source: "hint",
      last_session_id: v.sessions[0]?.id,
    });
    const h = await env.DB.prepare("SELECT resolved_at, attempts FROM payment_hints").first();
    expect(h).toEqual({ resolved_at: T0 + MIN, attempts: 1 });
    // A later webhook/poll of the same payment is a duplicate, not a second payment.
    await connect(site.id, "stripe", { credentials: { apiKey: KEY }, webhookSecret: "whsec_x" });
    const body = JSON.stringify(event("checkout.session.completed", paidSession, T0));
    await api(`/webhooks/stripe/${site.id}`, {
      method: "POST",
      body,
      origin: null,
      headers: { "stripe-signature": await sign.stripe("whsec_x", body, sec(Date.now())) },
    });
    expect(await paymentRows(site.id)).toHaveLength(1);
  });

  it("upgrades an unattributed payment when the hint arrives after it", async () => {
    const { site } = await ownerWithSite();
    const v = await visitorWithSessions(site.id, [{ at: T0 - 5 * MIN }]);
    await connect(site.id, "stripe", {
      credentials: { apiKey: KEY },
      syncCursor: JSON.stringify({ id: "evt_h0" }),
    });
    mock = mockProviders({
      [`GET ${STRIPE_API}/events`]: eventsApi([
        { id: "evt_h0" },
        event("checkout.session.completed", paidSession, T0),
      ]),
      [`GET ${STRIPE_API}/checkout/sessions/cs_live_link`]: () => json(paidSession),
    });
    await runJobs(sync, T0 + MIN);
    expect((await paymentRows(site.id))[0]).toMatchObject({ attributed_via: "none" });
    expect(await goalEvents(site.id)).toHaveLength(0);
    await hint(site.id, v.visitorId, v.sessions[0]?.id ?? "", "cs_live_link");
    await runJobs(hints, T0 + 2 * MIN);
    expect((await paymentRows(site.id))[0]).toMatchObject({
      attributed_via: "link",
      visitor_id: v.visitorId,
    });
    expect((await goalEvents(site.id)).map((g) => g.name)).toEqual(["payment"]);
  });

  it("retries unpaid sessions with backoff and gives up on unknown ones", async () => {
    const { site } = await ownerWithSite();
    const v = await visitorWithSessions(site.id, [{ at: T0 - 5 * MIN }]);
    await connect(site.id, "stripe", { credentials: { apiKey: KEY } });
    await hint(site.id, v.visitorId, v.sessions[0]?.id ?? "", "cs_live_open");
    await hint(site.id, v.visitorId, v.sessions[0]?.id ?? "", "cs_live_missing");
    mock = mockProviders({
      [`GET ${STRIPE_API}/checkout/sessions/cs_live_open`]: () =>
        json({ ...paidSession, id: "cs_live_open", status: "open", payment_status: "unpaid" }),
      [`GET ${STRIPE_API}/checkout/sessions/cs_live_missing`]: () =>
        json({ error: { message: "No such checkout.session" } }, 404),
    });
    await runJobs(hints, T0 + MIN);
    const rows = await env.DB.prepare(
      "SELECT ref, attempts, next_attempt_at, resolved_at, last_error FROM payment_hints ORDER BY ref",
    ).all();
    expect(rows.results).toEqual([
      {
        ref: "cs_live_missing",
        attempts: 1,
        next_attempt_at: null,
        resolved_at: T0 + MIN,
        last_error: expect.stringMatching(/no paid checkout/),
      },
      {
        ref: "cs_live_open",
        attempts: 1,
        next_attempt_at: T0 + 2 * MIN,
        resolved_at: null,
        last_error: null,
      },
    ]);
    // Not due yet: no request.
    const calls = mock.calls.length;
    await runJobs(hints, T0 + MIN + 30_000);
    expect(mock.calls.length).toBe(calls);
  });
});
