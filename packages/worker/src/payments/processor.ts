import type { Env, Website } from '../env';
import { dayBucket } from '../util/time';
import { adaptPaymentEvent, providerEventId, providerEventType } from './adapters';
import { type CreditResult, type CreditSet, computeCredit, emptyCredit } from './credit';
import { type JoinResult, linkCustomer, resolvePaymentVisitor } from './join';
import type { CreditModel, PaymentEvent, Provider } from './types';

export const DEFAULT_ATTRIBUTION_WINDOW_DAYS = 30;
export const DEFAULT_REATTRIBUTION_DAYS = 90;
/** raw_event retention (§10); a daily cleanup job prunes older rows. */
export const RAW_EVENT_TTL_DAYS = 90;

function envInt(
  env: Env,
  key: 'ATTRIBUTION_WINDOW_DAYS' | 'REATTRIBUTION_DAYS',
  fallback: number,
): number {
  const raw = env[key];
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

export function attributionWindowDays(env: Env): number {
  return envInt(env, 'ATTRIBUTION_WINDOW_DAYS', DEFAULT_ATTRIBUTION_WINDOW_DAYS);
}

export function reattributionDays(env: Env): number {
  return envInt(env, 'REATTRIBUTION_DAYS', DEFAULT_REATTRIBUTION_DAYS);
}

export function normalizeModel(value: string | null | undefined): CreditModel {
  return value === 'first_touch' || value === 'last_touch' ? value : 'last_non_direct';
}

function modelSet(model: CreditModel, credit: CreditResult): CreditSet {
  if (model === 'first_touch') return credit.firstTouch;
  if (model === 'last_touch') return credit.lastTouch;
  return credit.lastNonDirect;
}

const STATUS_RANK: Record<string, number> = {
  failed: 0,
  processing: 1,
  paid: 2,
  partially_refunded: 3,
  refunded: 4,
  disputed: 5,
};

async function getWebsite(env: Env, websiteId: string): Promise<Website | null> {
  return env.DB.prepare('SELECT * FROM websites WHERE id = ?').bind(websiteId).first<Website>();
}

async function convertToUsd(
  env: Env,
  currency: string,
  occurredAt: number,
  amountMinor: number,
): Promise<number | null> {
  const code = currency.toLowerCase();
  if (code === 'usd') return amountMinor;
  const date = dayBucket(occurredAt, 'UTC');
  const row = await env.DB.prepare('SELECT usd_rate FROM fx_rates WHERE date = ? AND currency = ?')
    .bind(date, code)
    .first<{ usd_rate: number }>();
  return row ? Math.round(amountMinor * row.usd_rate) : null;
}

async function isFirstPurchase(
  env: Env,
  websiteId: string,
  visitorId: string,
  occurredAt: number,
): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM payments
     WHERE website_id = ? AND visitor_id = ? AND occurred_at < ? AND status <> 'failed'`,
  )
    .bind(websiteId, visitorId, occurredAt)
    .first<{ n: number }>();
  return row && row.n > 0 ? 0 : 1;
}

interface PaymentAgg {
  n: number;
  net: number;
  first_at: number | null;
  last_at: number | null;
}

/**
 * Recomputes the denormalised revenue cache on `visitors` from `payments`
 * (§6.3 step 4, §9.1). Called after every payment, refund, and dispute.
 */
export async function updateVisitorRevenue(
  env: Env,
  websiteId: string,
  visitorId: string,
  now: number,
): Promise<void> {
  const agg = await env.DB.prepare(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(amount_minor - refunded_minor - disputed_minor), 0) AS net,
            MIN(occurred_at) AS first_at,
            MAX(occurred_at) AS last_at
     FROM payments
     WHERE website_id = ? AND visitor_id = ? AND status <> 'failed'`,
  )
    .bind(websiteId, visitorId)
    .first<PaymentAgg>();

  const firstAt = agg?.first_at ?? null;
  const visitsRow = firstAt
    ? await env.DB.prepare(
        `SELECT COUNT(DISTINCT session_id) AS n FROM events
         WHERE website_id = ? AND visitor_id = ? AND session_id IS NOT NULL AND ts < ?`,
      )
        .bind(websiteId, visitorId, firstAt)
        .first<{ n: number }>()
    : null;

  const firstTouch = await env.DB.prepare(
    `SELECT MIN(ts) AS t FROM events WHERE website_id = ? AND visitor_id = ? AND is_bot = 0`,
  )
    .bind(websiteId, visitorId)
    .first<{ t: number | null }>();

  const existing = await env.DB.prepare(
    'SELECT first_seen, first_channel, first_channel_name, first_referrer FROM visitors WHERE website_id = ? AND visitor_id = ?',
  )
    .bind(websiteId, visitorId)
    .first<{
      first_seen: number;
      first_channel: string | null;
      first_channel_name: string | null;
      first_referrer: string | null;
    }>();

  const firstSeen = existing?.first_seen ?? firstTouch?.t ?? now;
  const firstRow =
    existing?.first_channel != null
      ? null
      : await env.DB.prepare(
          `SELECT channel, channel_name, referrer FROM events
           WHERE website_id = ? AND visitor_id = ? AND is_bot = 0
           ORDER BY ts ASC, id ASC LIMIT 1`,
        )
          .bind(websiteId, visitorId)
          .first<{
            channel: string | null;
            channel_name: string | null;
            referrer: string | null;
          }>();
  const channel = existing?.first_channel ?? firstRow?.channel ?? null;
  const channelName = existing?.first_channel_name ?? firstRow?.channel_name ?? null;
  const referrer = existing?.first_referrer ?? firstRow?.referrer ?? null;

  const daysToPurchase =
    firstAt === null ? null : Math.max(0, Math.floor((firstAt - firstSeen) / 86400));
  const paymentCount = agg?.n ?? 0;
  const net = agg?.net ?? 0;

  await env.DB.prepare(
    `INSERT INTO visitors (
        website_id, visitor_id, first_seen, last_seen, first_channel, first_channel_name,
        first_referrer, first_touch_at, is_buyer, first_purchase_at, last_purchase_at,
        days_to_purchase, visits_to_purchase, ltv_cents, payment_count, revenue_minor, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (website_id, visitor_id) DO UPDATE SET
        last_seen = MAX(visitors.last_seen, excluded.last_seen),
        first_channel = COALESCE(visitors.first_channel, excluded.first_channel),
        first_channel_name = COALESCE(visitors.first_channel_name, excluded.first_channel_name),
        first_referrer = COALESCE(visitors.first_referrer, excluded.first_referrer),
        first_touch_at = COALESCE(visitors.first_touch_at, excluded.first_touch_at),
        is_buyer = 1,
        first_purchase_at = COALESCE(visitors.first_purchase_at, excluded.first_purchase_at),
        last_purchase_at = MAX(COALESCE(visitors.last_purchase_at, 0), excluded.last_purchase_at),
        days_to_purchase = COALESCE(visitors.days_to_purchase, excluded.days_to_purchase),
        visits_to_purchase = MAX(COALESCE(visitors.visits_to_purchase, 0), excluded.visits_to_purchase),
        ltv_cents = excluded.ltv_cents,
        payment_count = excluded.payment_count,
        revenue_minor = excluded.revenue_minor,
        updated_at = excluded.updated_at`,
  )
    .bind(
      websiteId,
      visitorId,
      firstSeen,
      now,
      channel,
      channelName,
      referrer,
      firstTouch?.t ?? null,
      paymentCount > 0 ? 1 : 0,
      firstAt,
      agg?.last_at ?? null,
      daysToPurchase,
      visitsRow?.n ?? 0,
      net,
      paymentCount,
      net,
      now,
    )
    .run();
}

async function upsertPayment(
  env: Env,
  websiteId: string,
  event: PaymentEvent,
  join: JoinResult,
  credit: CreditResult,
  model: CreditModel,
  usd: number | null,
  firstPurchase: number,
  rawBody: string,
  now: number,
): Promise<string> {
  const paymentId = `${event.provider}:${event.provider_payment_id}`;
  const selected = modelSet(model, credit);
  const status = event.status ?? 'paid';

  const existing = await env.DB.prepare(
    `SELECT refunded_minor, disputed_minor, status FROM payments
     WHERE website_id = ? AND provider = ? AND provider_payment_id = ?`,
  )
    .bind(websiteId, event.provider, event.provider_payment_id)
    .first<{ refunded_minor: number | null; disputed_minor: number | null; status: string }>();

  const priorRefunded = existing?.refunded_minor ?? 0;
  const priorDisputed = existing?.disputed_minor ?? 0;
  const refundedMinor = Math.max(priorRefunded, 0);
  const disputedMinor = Math.max(priorDisputed, 0);
  const rank = STATUS_RANK[status] ?? 0;
  const priorRank = existing ? (STATUS_RANK[existing.status] ?? 0) : -1;
  const forwardStatus = priorRank > rank ? existing?.status : status;

  const sql = `
    INSERT INTO payments (
      id, website_id, provider, provider_payment_id, provider_event_id,
      provider_customer_id, provider_subscription_id, provider_subscription_ids,
      email, visitor_id, session_id, join_method, join_confidence,
      gross_minor, tax_minor, discount_minor, amount_minor, amount_usd_minor, currency,
      refunded_minor, disputed_minor, disputed_at, status, kind, product_id, product_name, plan_id,
      occurred_at, attribution_window_days, attributed,
      first_touch_channel, first_touch_source, first_touch_medium, first_touch_campaign, first_touch_at,
      last_touch_channel, last_touch_source, last_touch_medium, last_touch_campaign, last_touch_at,
      last_non_direct_channel, last_non_direct_source, last_non_direct_medium, last_non_direct_campaign, last_non_direct_at,
      last_non_direct_fallback, touch_count, primary_model,
      amount_cents, customer_id, attribution_model, credited_channel, credited_channel_name,
      credited_referrer, credited_landing_path, is_first_purchase, raw, created_at, updated_at, reattributed_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
    ON CONFLICT (website_id, provider, provider_payment_id) DO UPDATE SET
      provider_event_id = excluded.provider_event_id,
      provider_customer_id = COALESCE(excluded.provider_customer_id, payments.provider_customer_id),
      provider_subscription_id = COALESCE(excluded.provider_subscription_id, payments.provider_subscription_id),
      provider_subscription_ids = COALESCE(excluded.provider_subscription_ids, payments.provider_subscription_ids),
      email = COALESCE(excluded.email, payments.email),
      visitor_id = COALESCE(excluded.visitor_id, payments.visitor_id),
      session_id = COALESCE(excluded.session_id, payments.session_id),
      join_method = COALESCE(excluded.join_method, payments.join_method),
      join_confidence = COALESCE(excluded.join_confidence, payments.join_confidence),
      gross_minor = excluded.gross_minor,
      tax_minor = excluded.tax_minor,
      discount_minor = excluded.discount_minor,
      amount_minor = excluded.amount_minor,
      amount_usd_minor = excluded.amount_usd_minor,
      refunded_minor = MAX(COALESCE(payments.refunded_minor, 0), excluded.refunded_minor),
      disputed_minor = MAX(COALESCE(payments.disputed_minor, 0), excluded.disputed_minor),
      disputed_at = COALESCE(payments.disputed_at, excluded.disputed_at),
      status = excluded.status,
      kind = COALESCE(excluded.kind, payments.kind),
      product_id = COALESCE(excluded.product_id, payments.product_id),
      product_name = COALESCE(excluded.product_name, payments.product_name),
      plan_id = COALESCE(excluded.plan_id, payments.plan_id),
      attribution_window_days = excluded.attribution_window_days,
      attributed = excluded.attributed,
      first_touch_channel = excluded.first_touch_channel,
      first_touch_source = excluded.first_touch_source,
      first_touch_medium = excluded.first_touch_medium,
      first_touch_campaign = excluded.first_touch_campaign,
      first_touch_at = excluded.first_touch_at,
      last_touch_channel = excluded.last_touch_channel,
      last_touch_source = excluded.last_touch_source,
      last_touch_medium = excluded.last_touch_medium,
      last_touch_campaign = excluded.last_touch_campaign,
      last_touch_at = excluded.last_touch_at,
      last_non_direct_channel = excluded.last_non_direct_channel,
      last_non_direct_source = excluded.last_non_direct_source,
      last_non_direct_medium = excluded.last_non_direct_medium,
      last_non_direct_campaign = excluded.last_non_direct_campaign,
      last_non_direct_at = excluded.last_non_direct_at,
      last_non_direct_fallback = excluded.last_non_direct_fallback,
      touch_count = excluded.touch_count,
      primary_model = excluded.primary_model,
      amount_cents = excluded.amount_cents,
      customer_id = COALESCE(excluded.customer_id, payments.customer_id),
      credited_channel = excluded.credited_channel,
      credited_channel_name = excluded.credited_channel_name,
      credited_referrer = excluded.credited_referrer,
      credited_landing_path = excluded.credited_landing_path,
      is_first_purchase = MAX(COALESCE(payments.is_first_purchase, 0), excluded.is_first_purchase),
      raw = excluded.raw,
      updated_at = excluded.updated_at,
      reattributed_at = payments.reattributed_at`;

  await env.DB.prepare(sql)
    .bind(
      paymentId,
      websiteId,
      event.provider,
      event.provider_payment_id,
      event.provider_event_id,
      event.provider_customer_id,
      event.provider_subscription_id,
      event.provider_subscription_ids ? JSON.stringify(event.provider_subscription_ids) : null,
      event.email,
      join.visitorId,
      join.sessionId,
      join.joinMethod,
      join.confidence,
      event.gross_minor,
      event.tax_minor,
      event.discount_minor,
      event.amount_minor,
      usd,
      event.currency,
      refundedMinor,
      disputedMinor,
      null,
      forwardStatus,
      event.kind,
      event.product_id,
      event.product_name,
      event.plan_id,
      event.occurred_at,
      attributionWindowDays(env),
      credit.attributed,
      credit.firstTouch.channel,
      credit.firstTouch.source,
      credit.firstTouch.medium,
      credit.firstTouch.campaign,
      credit.firstTouch.at,
      credit.lastTouch.channel,
      credit.lastTouch.source,
      credit.lastTouch.medium,
      credit.lastTouch.campaign,
      credit.lastTouch.at,
      credit.lastNonDirect.channel,
      credit.lastNonDirect.source,
      credit.lastNonDirect.medium,
      credit.lastNonDirect.campaign,
      credit.lastNonDirect.at,
      credit.lastNonDirectFallback,
      credit.touchCount,
      model,
      event.amount_minor,
      event.provider_customer_id,
      model,
      selected.channel,
      selected.source,
      selected.source,
      null,
      firstPurchase,
      rawBody,
      now,
      now,
      null,
    )
    .run();

  return paymentId;
}

async function applyPayment(
  env: Env,
  websiteId: string,
  event: PaymentEvent,
  rawBody: string,
  now: number,
): Promise<string> {
  const website = await getWebsite(env, websiteId);
  const model = normalizeModel(website?.attribution_model);
  const join = await resolvePaymentVisitor(env, websiteId, event);
  const credit = join.visitorId
    ? await computeCredit(
        env,
        websiteId,
        join.visitorId,
        event.occurred_at,
        attributionWindowDays(env),
      )
    : emptyCredit();
  const usd = await convertToUsd(env, event.currency, event.occurred_at, event.amount_minor);
  const firstPurchase = join.visitorId
    ? await isFirstPurchase(env, websiteId, join.visitorId, event.occurred_at)
    : 0;

  const paymentId = await upsertPayment(
    env,
    websiteId,
    event,
    join,
    credit,
    model,
    usd,
    firstPurchase,
    rawBody,
    now,
  );

  if (join.visitorId) {
    await updateVisitorRevenue(env, websiteId, join.visitorId, now);
    await linkCustomer(env, websiteId, event, join.visitorId, now);
    await reattributeUnresolved(env, websiteId, event, join.visitorId, now);
  } else if (event.email || event.provider_customer_id) {
    // Keep the bridge warm so a later identify/sign-in can resolve it.
    await linkCustomer(env, websiteId, event, null, now);
  }

  return paymentId;
}

async function applyRefundOrDispute(
  env: Env,
  websiteId: string,
  event: PaymentEvent,
  now: number,
): Promise<string> {
  const existing = await env.DB.prepare(
    `SELECT id, visitor_id, amount_minor, refunded_minor, disputed_minor, status FROM payments
     WHERE website_id = ? AND provider = ? AND provider_payment_id = ?`,
  )
    .bind(websiteId, event.provider, event.provider_payment_id)
    .first<{
      id: string;
      visitor_id: string | null;
      amount_minor: number | null;
      refunded_minor: number | null;
      disputed_minor: number | null;
      status: string;
    }>();

  if (!existing) {
    // Out-of-order: the refund arrived before the charge. Store a stub keyed on
    // the same payment id; the charge upsert preserves the accumulated delta.
    const paymentId = `${event.provider}:${event.provider_payment_id}`;
    const isRefund = event.role === 'refund';
    await env.DB.prepare(
      `INSERT INTO payments (
        id, website_id, provider, provider_payment_id, provider_event_id, provider_customer_id,
        email, amount_minor, amount_cents, refunded_minor, disputed_minor, disputed_at, status, currency,
        occurred_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (website_id, provider, provider_payment_id) DO UPDATE SET
        refunded_minor = MAX(COALESCE(payments.refunded_minor, 0), excluded.refunded_minor),
        disputed_minor = MAX(COALESCE(payments.disputed_minor, 0), excluded.disputed_minor),
        disputed_at = COALESCE(payments.disputed_at, excluded.disputed_at),
        updated_at = excluded.updated_at`,
    )
      .bind(
        paymentId,
        websiteId,
        event.provider,
        event.provider_payment_id,
        event.provider_event_id,
        event.provider_customer_id,
        event.email,
        isRefund ? event.amount_minor : 0,
        isRefund ? 0 : event.amount_minor,
        isRefund ? null : now,
        event.status ?? 'paid',
        event.currency,
        event.occurred_at,
        now,
        now,
      )
      .run();
    return paymentId;
  }

  if (event.role === 'refund') {
    const refunded = (existing.refunded_minor ?? 0) + event.amount_minor;
    const status =
      existing.amount_minor !== null && refunded >= existing.amount_minor
        ? 'refunded'
        : 'partially_refunded';
    await env.DB.prepare(
      `UPDATE payments SET refunded_minor = ?, status = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(refunded, status, now, existing.id)
      .run();
  } else {
    const disputed = (existing.disputed_minor ?? 0) + event.amount_minor;
    await env.DB.prepare(
      `UPDATE payments SET disputed_minor = ?, disputed_at = ?, status = 'disputed', updated_at = ? WHERE id = ?`,
    )
      .bind(disputed, now, now, existing.id)
      .run();
  }

  if (existing.visitor_id) {
    await updateVisitorRevenue(env, websiteId, existing.visitor_id, now);
  }

  return existing.id;
}

/**
 * Back-fill: within REATTRIBUTION_DAYS, a newly resolved visitor re-attributes
 * the customer's unresolved payments in place (§9.2). No new rows are inserted,
 * so counts stay stable.
 */
export async function reattributeUnresolved(
  env: Env,
  websiteId: string,
  event: PaymentEvent,
  visitorId: string,
  now: number,
): Promise<number> {
  const cutoff = now - reattributionDays(env) * 86400;
  const rows = await env.DB.prepare(
    `SELECT id, provider_payment_id, occurred_at, email, provider_customer_id
     FROM payments
     WHERE website_id = ? AND visitor_id IS NULL AND occurred_at >= ? AND occurred_at <= ?
       AND (email IS NOT NULL AND email = ? OR provider_customer_id IS NOT NULL AND provider_customer_id = ?)`,
  )
    .bind(websiteId, cutoff, now, event.email, event.provider_customer_id)
    .all<{
      id: string;
      provider_payment_id: string;
      occurred_at: number;
      email: string | null;
      provider_customer_id: string | null;
    }>();

  let count = 0;
  for (const row of rows.results) {
    const joinMethod = row.provider_customer_id ? 'provider_customer' : 'email';
    const confidence = row.provider_customer_id ? 0.9 : 0.7;
    const credit = await computeCredit(
      env,
      websiteId,
      visitorId,
      row.occurred_at,
      attributionWindowDays(env),
    );
    await env.DB.prepare(
      `UPDATE payments SET
         visitor_id = ?, join_method = ?, join_confidence = ?, attributed = ?,
         first_touch_channel = ?, first_touch_source = ?, first_touch_medium = ?,
         first_touch_campaign = ?, first_touch_at = ?,
         last_touch_channel = ?, last_touch_source = ?, last_touch_medium = ?,
         last_touch_campaign = ?, last_touch_at = ?,
         last_non_direct_channel = ?, last_non_direct_source = ?, last_non_direct_medium = ?,
         last_non_direct_campaign = ?, last_non_direct_at = ?, last_non_direct_fallback = ?,
         touch_count = ?, reattributed_at = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(
        visitorId,
        joinMethod,
        confidence,
        credit.attributed,
        credit.firstTouch.channel,
        credit.firstTouch.source,
        credit.firstTouch.medium,
        credit.firstTouch.campaign,
        credit.firstTouch.at,
        credit.lastTouch.channel,
        credit.lastTouch.source,
        credit.lastTouch.medium,
        credit.lastTouch.campaign,
        credit.lastTouch.at,
        credit.lastNonDirect.channel,
        credit.lastNonDirect.source,
        credit.lastNonDirect.medium,
        credit.lastNonDirect.campaign,
        credit.lastNonDirect.at,
        credit.lastNonDirectFallback,
        credit.touchCount,
        now,
        now,
        row.id,
      )
      .run();
    await updateVisitorRevenue(env, websiteId, visitorId, now);
    count += 1;
  }
  return count;
}

export type ProcessOutcome = 'processed' | 'ignored' | 'duplicate' | 'error';

/**
 * Shared pipeline after signature verification (§7.1 steps 3–6). Writes the
 * ledger first (insert-or-ignore), then adapts, joins, credits, and updates
 * the derived rows. Provider payloads are never trusted; every field is read
 * through the adapter's narrowing helpers.
 */
export async function processWebhookEvent(
  env: Env,
  websiteId: string,
  provider: Provider,
  payload: Record<string, unknown>,
  rawBody: string,
  headerEventId: string | null,
  now = Math.floor(Date.now() / 1000),
): Promise<ProcessOutcome> {
  const eventType = providerEventType(provider, payload);
  const eventId = providerEventId(provider, payload, headerEventId);
  if (!eventId) return 'error';

  const ledger = await env.DB.prepare(
    `INSERT INTO webhook_events (website_id, event_id, provider, type, received_at, status, payment_id)
     VALUES (?, ?, ?, ?, ?, 'processing', NULL)
     ON CONFLICT (website_id, event_id) DO NOTHING`,
  )
    .bind(websiteId, eventId, provider, eventType, now)
    .run();

  if ((ledger.meta.changes ?? 0) === 0) return 'duplicate';

  try {
    const event = adaptPaymentEvent(provider, eventType ?? '', payload);
    if (!event) {
      await env.DB.prepare(
        `UPDATE webhook_events SET status = 'ignored' WHERE website_id = ? AND event_id = ?`,
      )
        .bind(websiteId, eventId)
        .run();
      return 'ignored';
    }

    let paymentId: string | null = null;
    if (event.role === 'customer') {
      await linkCustomer(env, websiteId, event, null, now);
    } else if (event.role === 'refund' || event.role === 'dispute') {
      paymentId = await applyRefundOrDispute(env, websiteId, event, now);
    } else {
      paymentId = await applyPayment(env, websiteId, event, rawBody, now);
    }

    await env.DB.prepare(
      `UPDATE webhook_events SET status = 'processed', payment_id = ? WHERE website_id = ? AND event_id = ?`,
    )
      .bind(paymentId, websiteId, eventId)
      .run();
    return 'processed';
  } catch (error) {
    await env.DB.prepare(
      `UPDATE webhook_events SET status = 'error' WHERE website_id = ? AND event_id = ?`,
    )
      .bind(websiteId, eventId)
      .run();
    throw error;
  }
}

/** Kept for the daily cleanup job (§10): prunes raw_event after its TTL. */
export async function pruneRawEvents(env: Env, websiteId: string, now: number): Promise<void> {
  const cutoff = now - RAW_EVENT_TTL_DAYS * 86400;
  await env.DB.prepare('UPDATE payments SET raw = NULL WHERE website_id = ? AND created_at < ?')
    .bind(websiteId, cutoff)
    .run();
}

/** Test/ops helper: id for a payments row. */
export function paymentRowId(provider: Provider, providerPaymentId: string): string {
  return `${provider}:${providerPaymentId}`;
}
