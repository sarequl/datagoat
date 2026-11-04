import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../../src/lib/crypto";
import { siteCache } from "../../../src/lib/site-cache";
import { providerJobs } from "../../../src/providers";
import { ingestBatch } from "../../../src/providers/engine";
import {
  attributeByEmail,
  hintFromExtraData,
  paymentHintStatement,
} from "../../../src/providers/hints";
import {
  lifecycleGoals,
  monthlyAmount,
  type StoredSubscription,
} from "../../../src/providers/lifecycle";
import type { NormalizedBatch, NormalizedSubscription } from "../../../src/providers/types";
import { meterEnv, resetDb } from "../../helpers/db";
import { addMember, createApiKey, createUser, sessionCookie } from "../../helpers/factories";
import { api } from "../../helpers/http";
import {
  connect,
  DAY,
  goalEvents,
  HOUR,
  ownerWithSite,
  paymentRows,
  runJobs,
  T0,
  visitorWithSessions,
} from "./helpers";

beforeEach(() => resetDb());

const batch = (b: Partial<NormalizedBatch>): NormalizedBatch => ({
  payments: [],
  subscriptions: [],
  customers: [],
  ...b,
});

describe("attribution order", () => {
  it("prefers metadata, then link, then customer, then email, and stores all three sessions", async () => {
    const { site } = await ownerWithSite();
    const meta = await visitorWithSessions(site.id, [
      { at: T0 - 3 * DAY, channel: "Organic Search" },
      { at: T0 - 2 * DAY, channel: "Referral" },
      { at: T0 - HOUR, channel: "Direct" },
    ]);
    const linked = await visitorWithSessions(site.id, [{ at: T0 - HOUR }]);
    const customer = await visitorWithSessions(site.id, [{ at: T0 - DAY }]);
    const byEmail = await visitorWithSessions(site.id, [{ at: T0 - DAY }]);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO payment_hints (site_id, provider, ref, visitor_id, session_id, created_at) VALUES (?, 'stripe', 'cs_l', ?, ?, ?)",
      ).bind(site.id, linked.visitorId, linked.sessions[0]?.id, T0),
      env.DB.prepare(
        "INSERT INTO provider_customers (site_id, provider, customer_id, visitor_id, created_at) VALUES (?, 'stripe', 'cus_c', ?, ?)",
      ).bind(site.id, customer.visitorId, T0),
      env.DB.prepare("UPDATE visitors SET email_hash = ? WHERE site_id = ? AND id = ?").bind(
        await sha256Hex("e@x.io"),
        site.id,
        byEmail.visitorId,
      ),
    ]);
    const all = { amountMinor: 100, currency: "USD", occurredAt: T0, kind: "payment" as const };
    const res = await ingestBatch(
      env.DB,
      batch({
        payments: [
          {
            ...all,
            providerTxnId: "t_meta",
            visitorId: meta.visitorId,
            hintRefs: ["cs_l"],
            providerCustomerId: "cus_c",
            email: "e@x.io",
          },
          {
            ...all,
            providerTxnId: "t_link",
            visitorId: "11111111-1111-4111-8111-111111111111",
            hintRefs: ["cs_l"],
            providerCustomerId: "cus_c",
            email: "e@x.io",
          },
          { ...all, providerTxnId: "t_cust", providerCustomerId: "cus_c", email: "e@x.io" },
          { ...all, providerTxnId: "t_email", email: "E@X.io" },
          { ...all, providerTxnId: "t_none", email: "nobody@x.io" },
        ],
      }),
      { site, provider: "stripe", source: "webhook", now: T0 },
    );
    expect(res.payments.map((p) => [p.txnId, p.attributedVia, p.unknownVisitor])).toEqual([
      ["t_meta", "metadata", false],
      ["t_link", "link", true],
      ["t_cust", "customer", false],
      ["t_email", "email", false],
      ["t_none", "none", false],
    ]);
    const rows = Object.fromEntries(
      (await paymentRows(site.id)).map((r) => [r.provider_txn_id, r]),
    );
    expect(rows.t_meta).toMatchObject({
      visitor_id: meta.visitorId,
      first_session_id: meta.sessions[0]?.id,
      last_session_id: meta.sessions[2]?.id,
      last_non_direct_session_id: meta.sessions[1]?.id,
    });
    expect(rows.t_link).toMatchObject({
      visitor_id: linked.visitorId,
      last_session_id: linked.sessions[0]?.id,
    });
    expect(rows.t_none?.email_hash).toMatch(/^[0-9a-f]{64}$/);
    // The hint used by t_link is marked resolved.
    expect(await env.DB.prepare("SELECT resolved_at FROM payment_hints").first("resolved_at")).toBe(
      T0,
    );
  });

  it("writes a bounded number of rows per payment and nothing for a duplicate", async () => {
    const { site } = await ownerWithSite();
    const v = await visitorWithSessions(site.id, [{ at: T0 - HOUR }]);
    const p = {
      providerTxnId: "pi_1",
      kind: "payment" as const,
      amountMinor: 100,
      currency: "USD",
      occurredAt: T0,
      visitorId: v.visitorId,
      providerCustomerId: "cus_1",
    };
    const m = meterEnv();
    await ingestBatch(m.db, batch({ payments: [p] }), {
      site,
      provider: "stripe",
      source: "webhook",
      now: T0,
    });
    // payment row + unique + time + visitor indexes (4), goal event + index (2), customer map (1).
    // The goal event also writes 2 partial-index entries (migration 0200), so 9 in total.
    expect(m.d1.rowsWritten).toBe(9);
    expect(m.d1.queries).toBeLessThanOrEqual(3);
    m.reset();
    await ingestBatch(m.db, batch({ payments: [p] }), {
      site,
      provider: "stripe",
      source: "webhook",
      now: T0,
    });
    expect(m.d1.rowsWritten).toBe(0);
  });
});

describe("lifecycle goals", () => {
  const stored = (patch: Partial<StoredSubscription>): StoredSubscription => ({
    status: "active",
    mrrMinor: 1000,
    currency: "USD",
    cancelAtPeriodEnd: false,
    hadTrial: false,
    firstPaidAt: null,
    lastPaidMinor: null,
    customerId: null,
    visitorId: null,
    startedAt: null,
    ...patch,
  });
  const snap = (patch: Partial<NormalizedSubscription>): NormalizedSubscription => ({
    id: "s",
    status: "active",
    mrrMinor: 1000,
    currency: "USD",
    cancelAtPeriodEnd: false,
    occurredAt: 0,
    ...patch,
  });

  it.each([
    [null, snap({ status: "trialing" }), ["trial_started"]],
    [null, snap({}), ["subscription_started"]],
    [stored({ status: "incomplete" }), snap({}), ["subscription_started"]],
    [stored({ status: "trialing" }), snap({}), ["trial_converted"]],
    [stored({ status: "trialing" }), snap({ status: "ended" }), ["subscription_ended"]],
    [stored({}), snap({ cancelAtPeriodEnd: true }), ["subscription_cancel_scheduled"]],
    [stored({ cancelAtPeriodEnd: true }), snap({}), ["subscription_reactivated"]],
    [stored({ status: "ended" }), snap({}), ["subscription_reactivated"]],
    [stored({}), snap({ mrrMinor: 2000 }), ["subscription_upgraded"]],
    [stored({}), snap({ mrrMinor: 500 }), ["subscription_downgraded"]],
    [stored({}), snap({ mrrMinor: 500, currency: "EUR" }), []],
    [stored({}), snap({}), []],
    [stored({ status: "ended" }), snap({ status: "ended" }), []],
  ])("%j → %j", (prev, next, goals) => {
    expect(lifecycleGoals(prev, next)).toEqual(goals);
  });

  it("normalises recurring amounts to monthly", () => {
    expect(monthlyAmount(12000, "year")).toBe(1000);
    expect(monthlyAmount(3000, "month", 3)).toBe(1000);
    expect(monthlyAmount(700, "week")).toBe(3033);
    expect(monthlyAmount(100, "day")).toBe(3000);
  });
});

describe("hooks for the ingest path (W1)", () => {
  it("maps DataFast's payment extraData to hints and inserts them idempotently", async () => {
    expect(hintFromExtraData({ stripe_session_id: "cs_live_1" })).toEqual({
      provider: "stripe",
      ref: "cs_live_1",
    });
    expect(hintFromExtraData({ lemonsqueezy_order_id: 42 })).toEqual({
      provider: "lemonsqueezy",
      ref: "42",
    });
    expect(hintFromExtraData({ polar_checkout_id: "abc" })).toEqual({
      provider: "polar",
      ref: "abc",
    });
    expect(hintFromExtraData({ email: "a@b.c" })).toBeNull();
    expect(hintFromExtraData({ stripe_session_id: "bad id <x>" })).toBeNull();
    const hint = {
      siteId: "s1",
      provider: "stripe" as const,
      ref: "cs_1",
      visitorId: "v",
      sessionId: "s",
    };
    const m = meterEnv();
    await m.db.batch([paymentHintStatement(m.db, hint, T0)]);
    expect(m.d1.rowsWritten).toBe(2); // row + pending index
    m.reset();
    await m.db.batch([paymentHintStatement(m.db, hint, T0)]);
    expect(m.d1.rowsWritten).toBe(0);
  });

  it("attributes earlier unattributed payments when a visitor's email becomes known", async () => {
    const { site } = await ownerWithSite();
    await ingestBatch(
      env.DB,
      batch({
        payments: [
          {
            providerTxnId: "in_x",
            kind: "payment",
            amountMinor: 900,
            currency: "USD",
            occurredAt: T0,
            email: "late@x.io",
            providerCustomerId: "cus_late",
          },
        ],
      }),
      { site, provider: "stripe", source: "webhook", now: T0 },
    );
    const v = await visitorWithSessions(site.id, [{ at: T0 - HOUR }]);
    expect(await attributeByEmail(env, site.id, v.visitorId, "nobody@x.io")).toBe(0);
    expect(await attributeByEmail(env, site.id, v.visitorId, "LATE@x.io", T0 + HOUR)).toBe(1);
    expect((await paymentRows(site.id))[0]).toMatchObject({
      visitor_id: v.visitorId,
      attributed_via: "email",
    });
    expect((await goalEvents(site.id)).map((g) => g.name)).toEqual(["payment"]);
    // The customer is now mapped: the next renewal attributes through it.
    await ingestBatch(
      env.DB,
      batch({
        payments: [
          {
            providerTxnId: "in_y",
            kind: "renewal",
            amountMinor: 900,
            currency: "USD",
            occurredAt: T0 + DAY,
            providerCustomerId: "cus_late",
          },
        ],
      }),
      { site, provider: "stripe", source: "webhook", now: T0 + DAY },
    );
    expect((await paymentRows(site.id))[1]).toMatchObject({
      visitor_id: v.visitorId,
      attributed_via: "customer",
    });
  });

  it("the hourly email-matching job attributes recent unattributed payments", async () => {
    const { site } = await ownerWithSite();
    await ingestBatch(
      env.DB,
      batch({
        payments: [
          {
            providerTxnId: "o1",
            kind: "payment",
            amountMinor: 900,
            currency: "USD",
            occurredAt: T0,
            email: "m@x.io",
          },
        ],
      }),
      { site, provider: "polar", source: "webhook", now: T0 },
    );
    const v = await visitorWithSessions(site.id, [{ at: T0 - HOUR }]);
    await env.DB.prepare("UPDATE visitors SET email_hash = ? WHERE id = ?")
      .bind(await sha256Hex("m@x.io"), v.visitorId)
      .run();
    await runJobs(
      providerJobs.filter((j) => j.name === "providers.match-emails"),
      T0 + HOUR,
    );
    expect((await paymentRows(site.id))[0]).toMatchObject({
      visitor_id: v.visitorId,
      attributed_via: "email",
    });
  });
});

describe("integration permissions and disconnect", () => {
  it("viewers read status but cannot connect; df_ keys may; disconnect keeps revenue", async () => {
    const { user, site, cookie } = await ownerWithSite();
    const viewer = await createUser();
    await addMember(site.id, viewer.id, "viewer");
    const viewerCookie = await sessionCookie(viewer.id);
    const base = `/api/v1/admin/websites/${site.id}/integrations`;
    expect((await api(base, { cookie: viewerCookie })).status).toBe(200);
    const denied = await api(`${base}/stripe`, {
      cookie: viewerCookie,
      body: { stripeRak: "rk_live_x" },
    });
    expect(denied.status).toBe(403);
    const key = await createApiKey({ userId: user.id, siteId: site.id });
    expect((await api(base, { token: key.secret })).status).toBe(200);
    await connect(site.id, "stripe", { credentials: { apiKey: "rk_live_abcdefghijk" } });
    await ingestBatch(
      env.DB,
      batch({
        payments: [
          {
            providerTxnId: "pi_keep",
            kind: "payment",
            amountMinor: 100,
            currency: "USD",
            occurredAt: T0,
          },
        ],
      }),
      { site, provider: "stripe", source: "poll", now: T0 },
    );
    const del = await api(`${base}/stripe`, { cookie, method: "DELETE" });
    expect(del.body.data).toEqual([{ message: "Stripe disconnected successfully" }]);
    expect(await paymentRows(site.id)).toHaveLength(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM provider_connections").first("n")).toBe(
      0,
    );
    const status = await api(base, { cookie });
    expect(status.body.data[0].stripe).toEqual({ connected: false });
    siteCache.clear();
  });

  it("PATCH stores a pasted webhook secret", async () => {
    const { site, cookie } = await ownerWithSite();
    await connect(site.id, "stripe", { credentials: { apiKey: "rk_live_abcdefghijk" } });
    const res = await api(`/api/v1/admin/websites/${site.id}/integrations/stripe`, {
      cookie,
      method: "PATCH",
      body: { webhookSecret: "whsec_pasted" },
    });
    expect(res.body.data[0].message).toBe("Stripe payment re-sync queued");
    const status = await api(`/api/v1/admin/websites/${site.id}/integrations`, { cookie });
    expect(status.body.data[0].details[0]).toMatchObject({
      webhookConfigured: true,
      backfillComplete: false,
    });
  });
});
