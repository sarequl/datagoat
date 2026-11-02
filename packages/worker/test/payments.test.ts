import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src';
import {
  cohorts,
  ltvAllVisitors,
  ltvBySource,
  pathToPurchase,
  revenueBySource,
  revenuePerVisitor,
} from '../src/payments/queries';
import {
  verifyCreemSignature,
  verifyDodoSignature,
  verifyPolarSignature,
  verifyStripeSignature,
} from '../src/payments/signature';
import {
  applySchema,
  countPayments,
  countWebhookEvents,
  creemEvent,
  creemSignature,
  dodoEvent,
  firstPayment,
  getPayment,
  insertEvent,
  polarEvent,
  resetData,
  seedPaymentIntegration,
  standardWebhooksSignature,
  stripeEvent,
  stripeSignature,
  TEST_SITE,
  webhookRequest,
} from './helpers';

const SECRET = 'whsec_test_secret';
const DAY = 86400;

async function call(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function seedStripeIntegration(): Promise<void> {
  await seedPaymentIntegration(TEST_SITE.id, 'stripe', SECRET);
}

function stripeCheckout(overrides: Record<string, unknown> = {}) {
  return stripeEvent(
    'checkout.session.completed',
    {
      id: 'cs_test_1',
      mode: 'payment',
      amount_total: 2198,
      currency: 'usd',
      payment_status: 'paid',
      customer: 'cus_123',
      customer_details: { email: 'a@b.com' },
      metadata: { datagoat_visitor_id: 'vid_1', session_id: 'sess_1' },
      client_reference_id: 'vid_1',
      total_details: { amount_discount: 0, amount_tax: 0 },
      ...overrides,
    },
    'evt_stripe_1',
  );
}

async function postStripe(payload: unknown) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const headers = { 'stripe-signature': await stripeSignature(body, SECRET) };
  const response = await call(webhookRequest('stripe', body, { headers }));
  expect(response.status).toBe(200);
  return response;
}

// ---------------------------------------------------------------------------
// Signature verification (§7.2)
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await applySchema();
});

describe('webhook signature verification', () => {
  const body = '{"id":"evt_1","type":"checkout.session.completed"}';
  const now = Math.floor(Date.now() / 1000);

  it('accepts a valid Stripe signature and rejects a tampered body', async () => {
    const header = await stripeSignature(body, SECRET, now);
    expect(await verifyStripeSignature(body, header, SECRET, now)).toBe(true);
    expect(await verifyStripeSignature(`${body} `, header, SECRET, now)).toBe(false);
    expect(await verifyStripeSignature(body, header, 'whsec_other', now)).toBe(false);
  });

  it('rejects a Stripe signature outside the 5-minute skew', async () => {
    const header = await stripeSignature(body, SECRET, now - 600);
    expect(await verifyStripeSignature(body, header, SECRET, now)).toBe(false);
  });

  it('accepts Polar Standard Webhooks and the legacy key encoding', async () => {
    const headers = {
      'webhook-id': 'msg_1',
      'webhook-timestamp': String(now),
      'webhook-signature': await standardWebhooksSignature('msg_1', body, SECRET, now),
    };
    expect(await verifyPolarSignature(body, headers, SECRET, now)).toBe(true);
    const legacy = await standardWebhooksSignature('msg_1', body, btoa(SECRET), now);
    expect(
      await verifyPolarSignature(body, { ...headers, 'webhook-signature': legacy }, SECRET, now),
    ).toBe(true);
    expect(await verifyPolarSignature(body, headers, 'whsec_other', now)).toBe(false);
  });

  it('accepts Dodo Standard Webhooks and rejects a bad signature', async () => {
    const headers = {
      'webhook-id': 'msg_2',
      'webhook-timestamp': String(now),
      'webhook-signature': await standardWebhooksSignature('msg_2', body, SECRET, now),
    };
    expect(await verifyDodoSignature(body, headers, SECRET, now)).toBe(true);
    expect(
      await verifyDodoSignature(
        body,
        { ...headers, 'webhook-signature': 'v1,deadbeef' },
        SECRET,
        now,
      ),
    ).toBe(false);
  });

  it('accepts a valid Creem signature and rejects a tampered body', async () => {
    const header = await creemSignature(body, SECRET);
    expect(await verifyCreemSignature(body, header, SECRET)).toBe(true);
    expect(await verifyCreemSignature(`${body}x`, header, SECRET)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Shared pipeline (§7.1)
// ---------------------------------------------------------------------------

describe('payment webhook pipeline', () => {
  beforeEach(async () => {
    await resetData();
    await seedStripeIntegration();
  });

  it('upserts one payments row from a Stripe checkout and credits the visitor', async () => {
    const now = Math.floor(Date.now() / 1000);
    await insertEvent({
      website_id: TEST_SITE.id,
      visitor_id: 'vid_1',
      ts: now - 40 * DAY,
      channel: 'organic',
      utm_source: 'google',
      utm_medium: 'organic',
    });
    await insertEvent({
      website_id: TEST_SITE.id,
      visitor_id: 'vid_1',
      ts: now - 10 * DAY,
      channel: 'paid',
      utm_source: 'google',
      utm_medium: 'cpc',
    });
    await insertEvent({
      website_id: TEST_SITE.id,
      visitor_id: 'vid_1',
      ts: now - DAY,
      channel: 'direct',
    });
    await postStripe(stripeCheckout());

    expect(await countPayments()).toBe(1);
    const payment = await getPayment('cs_test_1');
    expect(payment).not.toBeNull();
    expect(payment?.join_method).toBe('metadata');
    expect(payment?.join_confidence).toBe(1.0);
    expect(payment?.visitor_id).toBe('vid_1');
    expect(payment?.amount_minor).toBe(2198);
    expect(payment?.status).toBe('paid');
    expect(payment?.kind).toBe('one_time');
    expect(payment?.attributed).toBe(1);
    expect(payment?.first_touch_channel).toBe('organic');
    expect(payment?.last_touch_channel).toBe('direct');
    expect(payment?.last_non_direct_channel).toBe('paid');
    expect(payment?.touch_count).toBe(2);
    expect(payment?.last_non_direct_fallback).toBe(0);
    expect(payment?.credited_channel).toBe('paid');
    expect(payment?.is_first_purchase).toBe(1);

    const ledger = await env.DB.prepare('SELECT * FROM webhook_events').first<{
      status: string;
      payment_id: string;
    }>();
    expect(ledger?.status).toBe('processed');
    expect(ledger?.payment_id).toBe('stripe:cs_test_1');
  });

  it('is idempotent: the same webhook id twice yields one payments row', async () => {
    await postStripe(stripeCheckout());
    const replay = await call(
      webhookRequest('stripe', JSON.stringify(stripeCheckout()), {
        headers: {
          'stripe-signature': await stripeSignature(JSON.stringify(stripeCheckout()), SECRET),
        },
      }),
    );
    expect(replay.status).toBe(200);
    const body = (await replay.json()) as { duplicate: boolean };
    expect(body.duplicate).toBe(true);
    expect(await countPayments()).toBe(1);
    expect(await countWebhookEvents()).toBe(1);
  });

  it('rejects an invalid signature with 401 and writes nothing', async () => {
    const body = JSON.stringify(stripeCheckout());
    const response = await call(
      webhookRequest('stripe', body, { headers: { 'stripe-signature': 't=1,v1=deadbeef' } }),
    );
    expect(response.status).toBe(401);
    expect(await countPayments()).toBe(0);
    expect(await countWebhookEvents()).toBe(0);
  });

  it('rejects an unknown site with 404', async () => {
    const body = JSON.stringify(stripeCheckout());
    const response = await call(
      webhookRequest('stripe', body, {
        site: 'nope',
        headers: { 'stripe-signature': await stripeSignature(body, SECRET) },
      }),
    );
    expect(response.status).toBe(404);
  });

  it('records an ignored ledger row for a non-revenue event', async () => {
    await postStripe(stripeEvent('customer.subscription.updated', { id: 'sub_9' }, 'evt_sub'));
    expect(await countPayments()).toBe(0);
    const ledger = await env.DB.prepare('SELECT status FROM webhook_events').first<{
      status: string;
    }>();
    expect(ledger?.status).toBe('ignored');
  });
});

// ---------------------------------------------------------------------------
// Join paths (§6)
// ---------------------------------------------------------------------------

describe('payment to visitor join', () => {
  beforeEach(async () => {
    await resetData();
    await seedStripeIntegration();
    await env.DB.prepare(
      `INSERT INTO customers (id, website_id, email, visitor_id, provider, provider_customer_id, first_seen_at, last_seen_at)
       VALUES ('c1', ?, 'a@b.com', 'vid_email', 'stripe', 'cus_x', 1, 2)`,
    )
      .bind(TEST_SITE.id)
      .run();
  });

  it('prefers metadata over provider_customer and email', async () => {
    await postStripe(
      stripeCheckout({
        metadata: { datagoat_visitor_id: 'vid_meta' },
        customer: 'cus_x',
        customer_details: { email: 'a@b.com' },
      }),
    );
    expect((await getPayment('cs_test_1'))?.join_method).toBe('metadata');
  });

  it('uses provider_customer when metadata is absent', async () => {
    await postStripe(
      stripeCheckout({
        metadata: {},
        client_reference_id: null,
        customer: 'cus_x',
        customer_details: { email: 'other@b.com' },
      }),
    );
    expect((await getPayment('cs_test_1'))?.join_method).toBe('provider_customer');
    expect((await getPayment('cs_test_1'))?.join_confidence).toBe(0.9);
  });

  it('uses email when neither metadata nor provider customer match', async () => {
    await postStripe(
      stripeCheckout({
        metadata: {},
        client_reference_id: null,
        customer: 'cus_unknown',
        customer_details: { email: 'a@b.com' },
      }),
    );
    expect((await getPayment('cs_test_1'))?.join_method).toBe('email');
    expect((await getPayment('cs_test_1'))?.join_confidence).toBe(0.7);
  });

  it('stays unresolved when nothing matches', async () => {
    await postStripe(
      stripeCheckout({
        metadata: {},
        client_reference_id: null,
        customer: 'cus_unknown',
        customer_details: { email: 'nobody@b.com' },
      }),
    );
    const payment = await getPayment('cs_test_1');
    expect(payment?.join_method).toBe('unresolved');
    expect(payment?.attributed).toBe(0);
    expect(payment?.visitor_id).toBeNull();
  });

  it('accepts the DataFast migration alias in metadata', async () => {
    await postStripe(
      stripeCheckout({
        metadata: { datafast_visitor_id: 'vid_legacy' },
        customer_details: { email: 'legacy@b.com' },
      }),
    );
    expect((await getPayment('cs_test_1'))?.visitor_id).toBe('vid_legacy');
  });
});

// ---------------------------------------------------------------------------
// Credit rules (§3–§5)
// ---------------------------------------------------------------------------

describe('credit rules', () => {
  beforeEach(async () => {
    await resetData();
    await seedStripeIntegration();
  });

  it('computes all three credit sets with the 30-day window', async () => {
    const now = Math.floor(Date.now() / 1000);
    await insertEvent({
      website_id: TEST_SITE.id,
      visitor_id: 'vid_1',
      ts: now - 40 * DAY,
      channel: 'organic',
      utm_source: 'google',
      utm_medium: 'organic',
    });
    await insertEvent({
      website_id: TEST_SITE.id,
      visitor_id: 'vid_1',
      ts: now - 10 * DAY,
      channel: 'paid',
      utm_source: 'google',
      utm_medium: 'cpc',
    });
    await insertEvent({
      website_id: TEST_SITE.id,
      visitor_id: 'vid_1',
      ts: now - DAY,
      channel: 'direct',
    });
    await postStripe(stripeCheckout());

    const payment = await getPayment('cs_test_1');
    expect(payment?.first_touch_channel).toBe('organic');
    expect(payment?.first_touch_at).toBe(now - 40 * DAY);
    expect(payment?.last_touch_channel).toBe('direct');
    expect(payment?.last_non_direct_channel).toBe('paid');
    expect(payment?.last_non_direct_fallback).toBe(0);
    expect(payment?.touch_count).toBe(2);
  });

  it('excludes a touch in the same second as the payment (strictly before)', async () => {
    const now = Math.floor(Date.now() / 1000);
    await insertEvent({ website_id: TEST_SITE.id, visitor_id: 'vid_1', ts: now, channel: 'paid' });
    await postStripe(stripeCheckout());
    const payment = await getPayment('cs_test_1');
    expect(payment?.touch_count).toBe(0);
    expect(payment?.attributed).toBe(0);
  });

  it('falls back to direct with the fallback flag when only direct touches exist', async () => {
    const now = Math.floor(Date.now() / 1000);
    await insertEvent({
      website_id: TEST_SITE.id,
      visitor_id: 'vid_1',
      ts: now - DAY,
      channel: 'direct',
    });
    await postStripe(stripeCheckout());
    const payment = await getPayment('cs_test_1');
    expect(payment?.last_non_direct_channel).toBe('direct');
    expect(payment?.last_non_direct_fallback).toBe(1);
  });

  it('stores the window snapshot so later config changes do not rewrite history', async () => {
    await postStripe(stripeCheckout());
    expect((await getPayment('cs_test_1'))?.attribution_window_days).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// Refunds, disputes, re-attribution (§9)
// ---------------------------------------------------------------------------

describe('refunds, disputes and re-attribution', () => {
  beforeEach(async () => {
    await resetData();
    await seedStripeIntegration();
  });

  it('accumulates a partial refund and reduces net revenue', async () => {
    const now = Math.floor(Date.now() / 1000);
    await insertEvent({
      website_id: TEST_SITE.id,
      visitor_id: 'vid_1',
      ts: now - DAY,
      channel: 'paid',
      utm_source: 'google',
      utm_medium: 'cpc',
    });
    await postStripe(stripeCheckout());
    const body = JSON.stringify(
      stripeEvent(
        'charge.refunded',
        { amount_refunded: 1000, payment_intent: 'cs_test_1', currency: 'usd' },
        'evt_refund_1',
      ),
    );
    await call(
      webhookRequest('stripe', body, {
        headers: { 'stripe-signature': await stripeSignature(body, SECRET) },
      }),
    );

    const payment = await getPayment('cs_test_1');
    expect(payment?.refunded_minor).toBe(1000);
    expect(payment?.status).toBe('partially_refunded');

    const net = await revenueBySource(
      env,
      TEST_SITE.id,
      0,
      Math.floor(Date.now() / 1000) + DAY,
      'last_non_direct',
    );
    expect(net[0].revenue).toBeCloseTo(11.98, 2);
  });

  it('marks a fully refunded payment', async () => {
    await postStripe(stripeCheckout());
    const body = JSON.stringify(
      stripeEvent(
        'charge.refunded',
        { amount_refunded: 2198, payment_intent: 'cs_test_1', currency: 'usd' },
        'evt_refund_2',
      ),
    );
    await call(
      webhookRequest('stripe', body, {
        headers: { 'stripe-signature': await stripeSignature(body, SECRET) },
      }),
    );
    expect((await getPayment('cs_test_1'))?.status).toBe('refunded');
  });

  it('sets a disputed payment and subtracts it from net revenue', async () => {
    const now = Math.floor(Date.now() / 1000);
    await insertEvent({
      website_id: TEST_SITE.id,
      visitor_id: 'vid_1',
      ts: now - DAY,
      channel: 'paid',
      utm_source: 'google',
      utm_medium: 'cpc',
    });
    await postStripe(stripeCheckout());
    const body = JSON.stringify(
      stripeEvent(
        'charge.dispute.created',
        { amount: 2198, payment_intent: 'cs_test_1', currency: 'usd' },
        'evt_dispute_1',
      ),
    );
    await call(
      webhookRequest('stripe', body, {
        headers: { 'stripe-signature': await stripeSignature(body, SECRET) },
      }),
    );
    const payment = await getPayment('cs_test_1');
    expect(payment?.status).toBe('disputed');
    expect(payment?.disputed_minor).toBe(2198);
    const net = await revenueBySource(
      env,
      TEST_SITE.id,
      0,
      Math.floor(Date.now() / 1000) + DAY,
      'last_non_direct',
    );
    expect(net[0].revenue).toBeCloseTo(0, 2);
  });

  it('re-attributes an unresolved payment once the email link resolves', async () => {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO payments (id, website_id, provider, provider_payment_id, email, status, attribution_model, amount_minor, amount_cents, currency, occurred_at, created_at)
       VALUES ('stripe:cs_old', ?, 'stripe', 'cs_old', 'late@b.com', 'paid', 'last_non_direct', 5000, 5000, 'usd', ?, ?)`,
    )
      .bind(TEST_SITE.id, now - 5 * DAY, now)
      .run();
    expect((await getPayment('cs_old'))?.visitor_id).toBeNull();

    await insertEvent({
      website_id: TEST_SITE.id,
      visitor_id: 'vid_new',
      ts: now - 10 * DAY,
      channel: 'paid',
      utm_source: 'google',
    });
    await postStripe(
      stripeCheckout({
        id: 'cs_new',
        metadata: { datagoat_visitor_id: 'vid_new' },
        customer_details: { email: 'late@b.com' },
      }),
    );

    const old = await getPayment('cs_old');
    expect(old?.visitor_id).toBe('vid_new');
    expect(old?.join_method).toBe('email');
    expect(old?.reattributed_at).not.toBeNull();
    expect(old?.attributed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Provider adapters (§7.4–§7.7)
// ---------------------------------------------------------------------------

describe('provider adapters', () => {
  beforeEach(async () => {
    await resetData();
    await seedPaymentIntegration(TEST_SITE.id, 'polar', SECRET);
    await seedPaymentIntegration(TEST_SITE.id, 'dodo', SECRET);
    await seedPaymentIntegration(TEST_SITE.id, 'creem', SECRET);
  });

  it('maps a Polar order.created to a payment', async () => {
    const payload = polarEvent(
      'order.created',
      {
        id: 'order_1',
        net_amount: 2198,
        amount: 2198,
        currency: 'usd',
        billing_reason: 'purchase',
        customer_id: 'polar_cust_1',
        customer: { email: 'polar@b.com' },
        metadata: { datagoat_visitor_id: 'vid_polar' },
        created_at: new Date().toISOString(),
      },
      'plev_1',
    );
    const body = JSON.stringify(payload);
    const headers = {
      'webhook-id': 'msg_polar_1',
      'webhook-timestamp': String(Math.floor(Date.now() / 1000)),
      'webhook-signature': await standardWebhooksSignature('msg_polar_1', body, SECRET),
    };
    const response = await call(webhookRequest('polar', body, { headers }));
    expect(response.status).toBe(200);
    const payment = await getPayment('order_1');
    expect(payment?.amount_minor).toBe(2198);
    expect(payment?.visitor_id).toBe('vid_polar');
    expect(payment?.kind).toBe('one_time');
  });

  it('maps a Dodo payment.succeeded to a payment', async () => {
    const payload = dodoEvent('payment.succeeded', {
      payment_id: 'pay_1',
      amount: 2198,
      currency: 'usd',
      customer_id: 'dodo_cust_1',
      customer: { email: 'dodo@b.com' },
      metadata: { datagoat_visitor_id: 'vid_dodo' },
      created_at: new Date().toISOString(),
    });
    const body = JSON.stringify(payload);
    const headers = {
      'webhook-id': 'msg_dodo_1',
      'webhook-timestamp': String(Math.floor(Date.now() / 1000)),
      'webhook-signature': await standardWebhooksSignature('msg_dodo_1', body, SECRET),
    };
    const response = await call(webhookRequest('dodo', body, { headers }));
    expect(response.status).toBe(200);
    expect((await getPayment('pay_1'))?.visitor_id).toBe('vid_dodo');
  });

  it('maps a Creem checkout.completed to a payment', async () => {
    const payload = creemEvent(
      'checkout.completed',
      {
        checkout: { id: 'chk_1', metadata: { datagoat_visitor_id: 'vid_creem' } },
        order: {
          id: 'ord_1',
          amount_paid: 2198,
          tax_amount: 0,
          discount_amount: 0,
          currency: 'eur',
        },
        customer: { id: 'creem_cust_1', email: 'creem@b.com' },
        request_id: 'dgf_vid_creem',
      },
      'crev_1',
    );
    const body = JSON.stringify(payload);
    const headers = { 'creem-signature': await creemSignature(body, SECRET) };
    const response = await call(webhookRequest('creem', body, { headers }));
    expect(response.status).toBe(200);
    const payment = await getPayment('chk_1');
    expect(payment?.amount_minor).toBe(2198);
    expect(payment?.currency).toBe('eur');
    expect(payment?.visitor_id).toBe('vid_creem');
  });
});

// ---------------------------------------------------------------------------
// Derived queries (§8)
// ---------------------------------------------------------------------------

describe('derived revenue queries', () => {
  beforeEach(async () => {
    await resetData();
  });

  async function seedPayment(fields: {
    id: string;
    visitor_id: string;
    channel: string;
    amount_minor: number;
    occurred_at: number;
    refunded_minor?: number;
    disputed_minor?: number;
    first_touch_at?: number;
  }): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO payments (
         id, website_id, provider, provider_payment_id, visitor_id, amount_minor, amount_cents, currency,
         status, kind, attribution_model, occurred_at, attributed, first_touch_channel, last_touch_channel,
         last_non_direct_channel, refunded_minor, disputed_minor, first_touch_at, created_at
       ) VALUES (?, ?, 'stripe', ?, ?, ?, ?, 'usd', 'paid', 'one_time', 'last_non_direct', ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        fields.id,
        TEST_SITE.id,
        fields.id,
        fields.visitor_id,
        fields.amount_minor,
        fields.amount_minor,
        fields.occurred_at,
        fields.channel,
        fields.channel,
        fields.channel,
        fields.refunded_minor ?? 0,
        fields.disputed_minor ?? 0,
        fields.first_touch_at ?? fields.occurred_at,
        fields.occurred_at,
      )
      .run();
  }

  it('reports revenue, LTV, revenue-per-visitor, path and cohorts', async () => {
    const now = Math.floor(Date.now() / 1000);
    await insertEvent({
      website_id: TEST_SITE.id,
      visitor_id: 'v1',
      ts: now - 3 * DAY,
      channel: 'paid',
      utm_source: 'google',
      utm_medium: 'cpc',
      path: '/pricing',
    });
    await insertEvent({
      website_id: TEST_SITE.id,
      visitor_id: 'v1',
      ts: now - DAY,
      channel: 'direct',
      path: '/checkout',
    });
    await seedPayment({
      id: 'stripe:p1',
      visitor_id: 'v1',
      channel: 'paid',
      amount_minor: 2198,
      occurred_at: now,
      first_touch_at: now - 3 * DAY,
    });
    await seedPayment({
      id: 'stripe:p2',
      visitor_id: 'v2',
      channel: 'organic',
      amount_minor: 1000,
      occurred_at: now,
      first_touch_at: now - 3 * DAY,
    });

    const revenue = await revenueBySource(env, TEST_SITE.id, 0, now + DAY, 'last_non_direct');
    expect(revenue.find((row) => row.channel === 'paid')?.revenue).toBeCloseTo(21.98, 2);

    const ltv = await ltvBySource(env, TEST_SITE.id, 0, now + DAY, 'last_non_direct');
    expect(ltv.find((row) => row.channel === 'paid')?.ltv).toBeCloseTo(21.98, 2);

    const rpv = await revenuePerVisitor(env, TEST_SITE.id, 0, now + DAY);
    expect(rpv.length).toBeGreaterThan(0);

    const path = await pathToPurchase(env, TEST_SITE.id, 'v1', now);
    expect(path[0].channel).toBe('direct');
    expect(path.some((step) => step.channel === 'paid')).toBe(true);

    const all = await ltvAllVisitors(env, TEST_SITE.id, 0, now + DAY);
    expect(all.length).toBeGreaterThan(0);

    const cohort = await cohorts(env, TEST_SITE.id, 0, now + DAY);
    expect(cohort.length).toBeGreaterThan(0);
  });

  it('exposes the attribution_events view over events', async () => {
    const now = Math.floor(Date.now() / 1000);
    await insertEvent({
      website_id: TEST_SITE.id,
      visitor_id: 'v1',
      ts: now,
      channel: 'paid',
      utm_source: 'google',
      path: '/x',
    });
    const row = await env.DB.prepare(
      'SELECT occurred_at, source, page_path FROM attribution_events LIMIT 1',
    ).first<{ occurred_at: number; source: string; page_path: string }>();
    expect(row?.source).toBe('google');
    expect(row?.page_path).toBe('/x');
  });

  it('returns the first payment row for sanity', async () => {
    expect(await firstPayment()).toBeNull();
  });
});
