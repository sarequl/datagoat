/**
 * Cross-team revenue attribution, end to end through the real Worker entry point: the tracker's
 * `POST /api/events` (W1 ingest) feeds the revenue engine (W3) without either side mocked. Only the
 * payment provider's HTTP API is mocked (no real third-party calls).
 *
 * 1. Stripe success page: a visitor with a session lands on `?session_id=cs_test_…`, the tracker
 *    sends a `payment` event with `extraData.stripe_session_id`, and `providers.resolve-hints`
 *    reads that Checkout Session from Stripe and stores an attributed payment (`link`).
 * 2. Email match: a visitor identifies with an email, then the provider reports a payment by the
 *    same customer email without any visitor metadata (`email`).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { providerJobs } from "../../../src/providers";
import { STRIPE_API } from "../../../src/providers/adapters/stripe";
import { sign } from "../../../src/providers/signatures";
import { addMember, createUser, sessionCookie } from "../../helpers/factories";
import { api } from "../../helpers/http";
import { eventBody, freshIp, ingestSite, postEvent, resetIngest, rows } from "../ingest/helpers";
import { connect, json, mockProviders, runJobs } from "../providers/helpers";

const VISITOR = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const SESSION = "s0b7f8a3c-1d2e-4f5a-8b9c-0d1e2f3a4b5c";
const KEY = "rk_live_51Hcrossteamtestkey0000";
const MIN = 60_000;

let mock: ReturnType<typeof mockProviders> | null = null;
beforeEach(resetIngest);
afterEach(() => {
  mock?.restore();
  mock = null;
});

/** A pageview from a Google search, then whatever else the visitor sends in the same session. */
async function visit(websiteId: string, events: Array<Record<string, unknown>>) {
  const ip = freshIp();
  const landing = await postEvent(
    eventBody({
      websiteId,
      href: "https://example.com/pricing?utm_source=google&utm_campaign=launch",
      referrer: "https://www.google.com/",
      visitorId: VISITOR,
      sessionId: SESSION,
    }),
    { ip },
  );
  expect(landing.status).toBe(200);
  for (const e of events) {
    const res = await postEvent(
      eventBody({ websiteId, visitorId: VISITOR, sessionId: SESSION, ...e }),
      { ip },
    );
    expect(res.status).toBe(200);
  }
}

describe("cross-team payment attribution (ingest → revenue engine)", () => {
  it("attributes a Stripe success-page payment to the visitor and session via the hint", async () => {
    const site = await ingestSite({ domain: "example.com" });
    await connect(site.id, "stripe", { credentials: { apiKey: KEY } });
    await visit(site.publicId, [
      {
        type: "payment",
        href: "https://example.com/thanks?session_id=cs_test_a1B2c3D4e5",
        extraData: { stripe_session_id: "cs_test_a1B2c3D4e5" },
      },
    ]);
    // W1 stored the reference for W3 with the visitor and the session that reached the page.
    expect(
      await rows(
        "SELECT provider, ref, visitor_id, session_id FROM payment_hints WHERE site_id = ?",
        site.id,
      ),
    ).toEqual([
      { provider: "stripe", ref: "cs_test_a1B2c3D4e5", visitor_id: VISITOR, session_id: SESSION },
    ]);

    const now = Date.now();
    mock = mockProviders({
      [`GET ${STRIPE_API}/checkout/sessions/cs_test_a1B2c3D4e5`]: () =>
        json({
          id: "cs_test_a1B2c3D4e5",
          object: "checkout.session",
          mode: "payment",
          status: "complete",
          payment_status: "paid",
          amount_total: 4900,
          currency: "usd",
          payment_intent: "pi_crossteam_1",
          customer: "cus_crossteam",
          customer_details: { email: "buyer@example.com", name: "Buyer" },
          created: Math.floor(now / 1000),
        }),
    });
    await runJobs(
      providerJobs.filter((j) => j.name === "providers.resolve-hints"),
      now + MIN,
    );

    const [payment] = await rows<Record<string, unknown>>(
      `SELECT provider, provider_txn_id, amount_minor, currency, visitor_id, first_session_id,
              last_session_id, last_non_direct_session_id, attributed_via
       FROM payments WHERE site_id = ?`,
      site.id,
    );
    expect(payment).toEqual({
      provider: "stripe",
      provider_txn_id: "pi_crossteam_1",
      amount_minor: 4900,
      currency: "USD",
      visitor_id: VISITOR,
      first_session_id: SESSION,
      last_session_id: SESSION,
      last_non_direct_session_id: SESSION,
      attributed_via: "link",
    });
    expect(mock.to(`${STRIPE_API}/checkout/sessions/cs_test_a1B2c3D4e5`)).toHaveLength(1);
    // The payment goal joins the visitor's journey, in the session that paid.
    expect(
      await rows(
        "SELECT name, visitor_id, session_id FROM events WHERE site_id = ? AND type = 'custom'",
        site.id,
      ),
    ).toEqual([{ name: "payment", visitor_id: VISITOR, session_id: SESSION }]);
    // And the analytics API credits the visitor's channel (Organic Search) with the revenue.
    const revenue = await api(
      `/api/v1/analytics/revenue/sources?websiteId=${site.id}&groupBy=channel`,
      { cookie: await ownerCookie(site.id) },
    );
    expect(revenue.status).toBe(200);
    expect(revenue.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "Organic Search", revenue: 49, customers: 1 }),
      ]),
    );
  });

  it("attributes a provider payment to the visitor who identified with the same email", async () => {
    const site = await ingestSite({ domain: "example.com" });
    await connect(site.id, "stripe", {
      credentials: { apiKey: KEY },
      webhookSecret: "whsec_cross",
    });
    await visit(site.publicId, [
      { type: "identify", extraData: { user_id: "user_42", email: "Buyer@Example.com" } },
    ]);
    expect(
      await rows<{ email_hash: string | null }>(
        "SELECT email_hash FROM visitors WHERE site_id = ? AND id = ?",
        site.id,
        VISITOR,
      ),
    ).toEqual([{ email_hash: expect.stringMatching(/^[0-9a-f]{64}$/) }]);

    // Later the provider reports a payment for that customer email, with no visitor metadata.
    const at = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      id: "evt_crossteam_email",
      object: "event",
      type: "checkout.session.completed",
      created: at,
      data: {
        object: {
          id: "cs_live_email_1",
          object: "checkout.session",
          mode: "payment",
          status: "complete",
          payment_status: "paid",
          amount_total: 2500,
          currency: "usd",
          payment_intent: "pi_crossteam_email",
          customer: "cus_email",
          customer_details: { email: "buyer@example.com" },
          metadata: {},
          created: at,
        },
      },
    });
    const res = await api(`/webhooks/stripe/${site.id}`, {
      method: "POST",
      body,
      origin: null,
      headers: { "stripe-signature": await sign.stripe("whsec_cross", body, at) },
    });
    expect(res.status).toBe(200);

    const [payment] = await rows<Record<string, unknown>>(
      "SELECT provider_txn_id, visitor_id, last_session_id, attributed_via FROM payments WHERE site_id = ?",
      site.id,
    );
    expect(payment).toEqual({
      provider_txn_id: "pi_crossteam_email",
      visitor_id: VISITOR,
      last_session_id: SESSION,
      attributed_via: "email",
    });
  });
});

async function ownerCookie(siteId: string): Promise<string> {
  const user = await createUser();
  await addMember(siteId, user.id, "owner");
  return sessionCookie(user.id);
}
