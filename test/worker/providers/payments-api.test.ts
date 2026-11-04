import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "../../helpers/db";
import { createApiKey, createSession } from "../../helpers/factories";
import { api } from "../../helpers/http";
import { goalEvents, ownerWithSite, paymentRows, visitorWithSessions } from "./helpers";

beforeEach(() => resetDb());

const NOW = Date.now();

async function setup(overrides: Parameters<typeof ownerWithSite>[0] = {}) {
  const ctx = await ownerWithSite(overrides);
  const key = await createApiKey({ userId: ctx.user.id, siteId: ctx.site.id });
  return { ...ctx, key: key.secret };
}

describe("POST /api/v1/payments", () => {
  it("records and attributes a payment with DataFast's exact response", async () => {
    const { site, key } = await setup();
    const v = await visitorWithSessions(site.id, [
      { at: NOW - 3 * 86_400_000, channel: "Organic Search", source: "Google" },
      { at: NOW - 3_600_000, channel: "Direct" },
    ]);
    const res = await api("/api/v1/payments", {
      token: key,
      body: {
        amount: 29.99,
        currency: "USD",
        transaction_id: "payment_456",
        datafast_visitor_id: v.visitorId,
        email: "Customer@Example.com",
        name: "Pat Customer",
      },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      message: "Payment recorded and attributed successfully",
      transaction_id: "payment_456",
    });
    const [row] = await paymentRows(site.id);
    expect(row).toMatchObject({
      provider: "api",
      provider_txn_id: "payment_456",
      kind: "payment",
      amount_minor: 2999,
      reporting_minor: 2999,
      currency: "USD",
      visitor_id: v.visitorId,
      attributed_via: "api",
      first_session_id: v.sessions[0]?.id,
      last_session_id: v.sessions[1]?.id,
      last_non_direct_session_id: v.sessions[0]?.id,
      customer_email: "customer@example.com",
      customer_name: "Pat Customer",
      source: "api",
    });
    expect(row?.email_hash).toMatch(/^[0-9a-f]{64}$/);
    const goals = await goalEvents(site.id);
    expect(goals.map((g) => g.name)).toEqual(["payment"]);
    expect(goals[0]?.session_id).toBe(v.sessions[1]?.id);
    expect(JSON.parse(goals[0]?.props ?? "{}")).toMatchObject({
      origin: "payment_provider",
      type: "payment",
      provider: "api",
      transaction_id: "payment_456",
      amount: 29.99,
      currency: "USD",
    });
  });

  it("is idempotent on transaction_id: a repeat returns a duplicate message only", async () => {
    const { site, key } = await setup();
    const body = { amount: 10, currency: "usd", transaction_id: "txn_dup" };
    expect((await api("/api/v1/payments", { token: key, body })).body).toEqual({
      message: "Payment recorded successfully",
      transaction_id: "txn_dup",
    });
    const again = await api("/api/v1/payments", { token: key, body });
    expect(again.status).toBe(200);
    expect(again.body.transaction_id).toBeUndefined();
    expect(again.body.message).toMatch(/already recorded/);
    expect(await paymentRows(site.id)).toHaveLength(1);
  });

  it("returns plain {error} bodies for invalid input", async () => {
    const { key } = await setup();
    const cases: Array<[unknown, RegExp]> = [
      [{ currency: "USD", transaction_id: "a" }, /amount/],
      [{ amount: 1, transaction_id: "a" }, /currency/],
      [{ amount: 1, currency: "USD" }, /transaction_id/],
      [{ amount: -5, currency: "USD", transaction_id: "a" }, /amount/],
      [{ amount: 5, currency: "DOLLARS", transaction_id: "a" }, /currency/],
      [{ amount: 5, currency: "USD", transaction_id: "a", timestamp: "yesterday" }, /timestamp/],
      [{ amount: 5, currency: "USD", transaction_id: "a", datafast_visitor_id: "x y" }, /visitor/],
      [
        { amount: 5, currency: "USD", transaction_id: "a", refunded: true, renewal: true },
        /combination/,
      ],
    ];
    for (const [body, pattern] of cases) {
      const res = await api("/api/v1/payments", { token: key, body });
      expect(res.status).toBe(400);
      expect(Object.keys(res.body)).toEqual(["error"]);
      expect(res.body.error).toMatch(pattern);
    }
    const bad = await api("/api/v1/payments", { token: key, body: "{nope" });
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: "Invalid JSON body" });
  });

  it("requires payments:write and authentication", async () => {
    const { user, site } = await setup();
    expect((await api("/api/v1/payments", { body: { amount: 1 } })).status).toBe(401);
    const readOnly = await createApiKey({ userId: user.id, permissions: ["analytics:read"] });
    const res = await api(`/api/v1/payments?websiteId=${site.id}`, {
      token: readOnly.secret,
      body: { amount: 1, currency: "USD", transaction_id: "t" },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe("Missing permission: payments:write");
    const token = await createApiKey({ userId: user.id, permissions: ["payments:write"] });
    const ok = await api(`/api/v1/payments?websiteId=${site.id}`, {
      token: token.secret,
      body: { amount: 1, currency: "USD", transaction_id: "t" },
    });
    expect(ok.status).toBe(200);
  });

  it("treats amount 0 or is_free_trial as a free trial and emits free_trial", async () => {
    const { site, key } = await setup();
    const v = await visitorWithSessions(site.id, [{ at: NOW - 60_000 }]);
    const res = await api("/api/v1/payments", {
      token: key,
      body: { amount: 0, currency: "USD", transaction_id: "trial_1", visitorId: v.visitorId },
    });
    expect(res.body.message).toBe("Free trial recorded and attributed successfully");
    await api("/api/v1/payments", {
      token: key,
      body: { amount: 9, currency: "USD", transaction_id: "trial_2", is_free_trial: true },
    });
    const rows = await paymentRows(site.id);
    expect(rows.map((r) => [r.kind, r.amount_minor])).toEqual([
      ["free_trial", 0],
      ["free_trial", 0],
    ]);
    expect((await goalEvents(site.id)).map((g) => g.name)).toEqual(["free_trial"]);
  });

  it("records renewals and attributes them through the customer map", async () => {
    const { site, key } = await setup();
    const v = await visitorWithSessions(site.id, [{ at: NOW - 86_400_000, channel: "Referral" }]);
    await api("/api/v1/payments", {
      token: key,
      body: {
        amount: 20,
        currency: "USD",
        transaction_id: "first",
        datafast_visitor_id: v.visitorId,
        customer_id: "cus_1",
      },
    });
    const res = await api("/api/v1/payments", {
      token: key,
      body: {
        amount: 20,
        currency: "USD",
        transaction_id: "second",
        customer_id: "cus_1",
        renewal: true,
      },
    });
    expect(res.body.message).toBe("Payment recorded and attributed successfully");
    const rows = await paymentRows(site.id);
    expect(rows.find((r) => r.provider_txn_id === "second")).toMatchObject({
      kind: "renewal",
      visitor_id: v.visitorId,
      attributed_via: "customer",
    });
    expect((await goalEvents(site.id)).map((g) => g.name)).toEqual([
      "payment",
      "subscription_renewed",
    ]);
  });

  it("records refunds as negative revenue against the original visitor", async () => {
    const { site, key } = await setup();
    const v = await visitorWithSessions(site.id, [{ at: NOW - 86_400_000 }]);
    await api("/api/v1/payments", {
      token: key,
      body: { amount: 50, currency: "USD", transaction_id: "orig", visitorId: v.visitorId },
    });
    const res = await api("/api/v1/payments", {
      token: key,
      body: { amount: 50, currency: "USD", transaction_id: "orig", refunded: true },
    });
    expect(res.body).toEqual({
      message: "Refund recorded and attributed successfully",
      transaction_id: "orig",
    });
    const refund = (await paymentRows(site.id)).find((r) => r.kind === "refund");
    expect(refund).toMatchObject({
      provider_txn_id: "orig:refund",
      amount_minor: -5000,
      reporting_minor: -5000,
      visitor_id: v.visitorId,
      refund_of: "orig",
      reason: "refund",
    });
    const dup = await api("/api/v1/payments", {
      token: key,
      body: { amount: 50, currency: "USD", transaction_id: "orig", refunded: true },
    });
    expect(dup.body.message).toMatch(/already recorded/);
  });

  it("stores a payment for an unknown visitor unattributed, with a message-only answer", async () => {
    const { site, key } = await setup();
    const res = await api("/api/v1/payments", {
      token: key,
      body: {
        amount: 5,
        currency: "USD",
        transaction_id: "ghost",
        datafast_visitor_id: "a3ab2331-989f-4cfa-91c6-2461c9e3c6bd",
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.transaction_id).toBeUndefined();
    const [row] = await paymentRows(site.id);
    expect(row).toMatchObject({ visitor_id: null, attributed_via: "none" });
    expect(JSON.parse(String(row?.metadata))).toEqual({
      unknownVisitorId: "a3ab2331-989f-4cfa-91c6-2461c9e3c6bd",
    });
  });

  it("attributes by customer email when no visitor id is sent", async () => {
    const { site, key } = await setup();
    const v = await visitorWithSessions(site.id, [{ at: NOW - 60_000 }]);
    const { sha256Hex } = await import("../../../src/lib/crypto");
    await env.DB.prepare("UPDATE visitors SET email_hash = ? WHERE site_id = ? AND id = ?")
      .bind(await sha256Hex("buyer@example.com"), site.id, v.visitorId)
      .run();
    await api("/api/v1/payments", {
      token: key,
      body: {
        amount: 12,
        currency: "USD",
        transaction_id: "byemail",
        customer_email: "BUYER@example.com",
      },
    });
    const [row] = await paymentRows(site.id);
    expect(row).toMatchObject({ visitor_id: v.visitorId, attributed_via: "email" });
  });

  it("does not store customer emails when the website opts out", async () => {
    const { site, key } = await setup();
    await env.DB.prepare("UPDATE sites SET store_customer_emails = 0 WHERE id = ?")
      .bind(site.id)
      .run();
    const { siteCache } = await import("../../../src/lib/site-cache");
    siteCache.clear();
    await api("/api/v1/payments", {
      token: key,
      body: { amount: 1, currency: "USD", transaction_id: "x", email: "a@b.co", name: "A" },
    });
    const [row] = await paymentRows(site.id);
    expect(row).toMatchObject({ customer_email: null, customer_name: null });
    expect(row?.email_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("converts to the website currency with stored ECB rates and keeps the original", async () => {
    const { site, key } = await setup({ currency: "USD" });
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO fx_rates (day, currency, per_usd) VALUES ('2026-10-30', 'EUR', 0.9)",
      ),
      env.DB.prepare(
        "INSERT INTO fx_rates (day, currency, per_usd) VALUES ('2026-11-02', 'EUR', 0.8)",
      ),
      env.DB.prepare(
        "INSERT INTO fx_rates (day, currency, per_usd) VALUES ('2026-11-02', 'JPY', 150)",
      ),
    ]);
    await api("/api/v1/payments", {
      token: key,
      body: {
        amount: 90,
        currency: "EUR",
        transaction_id: "eur1",
        timestamp: "2026-10-31T10:00:00Z",
      },
    });
    await api("/api/v1/payments", {
      token: key,
      body: {
        amount: 3000,
        currency: "JPY",
        transaction_id: "jpy1",
        timestamp: "2026-11-03T10:00:00Z",
      },
    });
    const rows = await paymentRows(site.id);
    expect(rows.find((r) => r.provider_txn_id === "eur1")).toMatchObject({
      amount_minor: 9000,
      currency: "EUR",
      reporting_minor: 10000, // 90 EUR / 0.9 per USD (latest rate on or before 31 Oct)
      reporting_currency: "USD",
    });
    expect(rows.find((r) => r.provider_txn_id === "jpy1")).toMatchObject({
      amount_minor: 3000,
      reporting_minor: 2000, // 3000 JPY / 150
    });
  });

  it("stores the unconverted amount with fx_rate NULL when no rate exists", async () => {
    const { site, key } = await setup({ currency: "USD" });
    await api("/api/v1/payments", {
      token: key,
      body: { amount: 10, currency: "GBP", transaction_id: "gbp1" },
    });
    const [row] = await paymentRows(site.id);
    expect(row).toMatchObject({ amount_minor: 1000, reporting_minor: 1000, fx_rate: null });
  });
});

describe("DELETE /api/v1/payments", () => {
  async function seed() {
    const ctx = await setup();
    const v = await visitorWithSessions(ctx.site.id, [{ at: Date.UTC(2026, 4, 1) }]);
    const post = (transaction_id: string, timestamp: string, extra = {}) =>
      api("/api/v1/payments", {
        token: ctx.key,
        body: { amount: 10, currency: "USD", transaction_id, timestamp, ...extra },
      });
    await post("a", "2026-05-02T00:00:00Z", { datafast_visitor_id: v.visitorId });
    await post("b", "2026-05-10T00:00:00Z", { datafast_visitor_id: v.visitorId });
    await post("c", "2026-06-10T00:00:00Z");
    return { ...ctx, visitorId: v.visitorId };
  }

  it("deletes one transaction, its refunds and its goal events", async () => {
    const { site, key } = await seed();
    await api("/api/v1/payments", {
      token: key,
      body: { amount: 10, currency: "USD", transaction_id: "a", refunded: true },
    });
    expect(await goalEvents(site.id)).toHaveLength(2);
    const res = await api("/api/v1/payments?transaction_id=a", { token: key, method: "DELETE" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "success",
      data: [{ message: "Payment deleted successfully", transaction_id: "a" }],
    });
    expect((await paymentRows(site.id)).map((r) => r.provider_txn_id)).toEqual(["b", "c"]);
    expect(await goalEvents(site.id)).toHaveLength(1);
    const again = await api("/api/v1/payments?tx_id=a", { token: key, method: "DELETE" });
    expect(again.status).toBe(404);
    expect(again.body.error.message).toBe("Transaction not found");
  });

  it("deletes by visitor with an optional range", async () => {
    const { site, key, visitorId } = await seed();
    const res = await api(
      `/api/v1/payments?datafast_visitor_id=${visitorId}&startAt=2026-05-05T00:00:00Z&endAt=2026-05-31T23:59:59Z`,
      { token: key, method: "DELETE" },
    );
    expect(res.body.data[0]).toMatchObject({
      message: "1 payment deleted successfully",
      datafast_visitor_id: visitorId,
      timeRange: { start: "2026-05-05T00:00:00.000Z", end: "2026-05-31T23:59:59.000Z" },
    });
    expect((await paymentRows(site.id)).map((r) => r.provider_txn_id)).toEqual(["a", "c"]);
    const bad = await api("/api/v1/payments?datafast_visitor_id=bad%20id", {
      token: key,
      method: "DELETE",
    });
    expect(bad.status).toBe(400);
  });

  it("bulk-deletes a range (start/end aliases accepted) and requires one", async () => {
    const { site, key } = await seed();
    const none = await api("/api/v1/payments", { token: key, method: "DELETE" });
    expect(none.status).toBe(400);
    const half = await api("/api/v1/payments?startAt=2026-05-01", { token: key, method: "DELETE" });
    expect(half.status).toBe(400);
    const conflict = await api(
      "/api/v1/payments?startAt=2026-05-01&endAt=2026-05-31&start=2026-04-01&end=2026-05-31",
      { token: key, method: "DELETE" },
    );
    expect(conflict.status).toBe(400);
    const res = await api("/api/v1/payments?start=2026-05-01&end=2026-05-31", {
      token: key,
      method: "DELETE",
    });
    expect(res.body.data[0].message).toBe("2 payments deleted successfully");
    expect((await paymentRows(site.id)).map((r) => r.provider_txn_id)).toEqual(["c"]);
  });
});

describe("GET /api/v1/payments", () => {
  it("lists payments with channel, filters, attribution and PII rules", async () => {
    const { user, site, key, cookie } = await setup();
    const v = await visitorWithSessions(site.id, [
      { at: Date.UTC(2026, 9, 1), channel: "Organic Search", country: "US" },
    ]);
    const post = (body: Record<string, unknown>) =>
      api("/api/v1/payments", { token: key, body: { currency: "USD", ...body } });
    await post({
      amount: 30,
      transaction_id: "p1",
      visitorId: v.visitorId,
      email: "a@x.io",
      timestamp: "2026-10-02T00:00:00Z",
    });
    await post({ amount: 5, transaction_id: "p2", timestamp: "2026-10-03T00:00:00Z" });
    const all = await api(`/api/v1/payments?websiteId=${site.id}`, { cookie });
    expect(all.status).toBe(200);
    expect(all.body.pagination).toMatchObject({ total: 2, limit: 100, offset: 0 });
    expect(all.body.data[0]).toMatchObject({
      transactionId: "p2",
      channel: null,
      attributedVia: "none",
    });
    expect(all.body.data[1]).toMatchObject({
      transactionId: "p1",
      amount: 30,
      currency: "USD",
      originalAmount: 30,
      kind: "payment",
      channel: "Organic Search",
      visitorId: v.visitorId,
      customerEmail: "a@x.io",
      timestamp: "2026-10-02T00:00:00.000Z",
    });
    const filtered = await api(`/api/v1/payments?websiteId=${site.id}&filter_country=US`, {
      cookie,
    });
    expect(filtered.body.data.map((p: { transactionId: string }) => p.transactionId)).toEqual([
      "p1",
    ]);
    const unattributed = await api(`/api/v1/payments?websiteId=${site.id}&attributed=false`, {
      cookie,
    });
    expect(unattributed.body.data).toHaveLength(1);
    const noPii = await createApiKey({ userId: user.id, permissions: ["payments:read"] });
    const masked = await api(`/api/v1/payments?websiteId=${site.id}`, { token: noPii.secret });
    expect(masked.body.data[1].customerEmail).toBeNull();
    const badKind = await api(`/api/v1/payments?websiteId=${site.id}&kind=nope`, { cookie });
    expect(badKind.status).toBe(400);
    void createSession;
  });
});
