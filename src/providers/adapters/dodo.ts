/**
 * Dodo Payments.
 *
 * - Connect with an API key (`apiKey`) and optionally the webhook signing secret
 *   (`webhookSecret`, `whsec_…`). `testMode: true` uses test.dodopayments.com (only when
 *   ALLOW_TEST_PAYMENT_KEYS is "true").
 * - Webhooks follow Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature`).
 * - Polling every 5 minutes and backfill over payments, refunds and subscriptions.
 * - The visitor id is the checkout session's `metadata.datafast_visitor_id` (DataFast's documented
 *   setup) or `datagoat_visitor_id`; Dodo copies checkout metadata onto the payment.
 * - Success-page hint: `?payment_id=…` resolves through GET /payments/{id}.
 *
 * First payments of a subscription are sales and later ones renewals (`kind: auto`).
 */
import { asRecord, currencyOf, num, str, timeOf, visitorFromMetadata } from "../attribution";
import { describeError, getJson, ProviderHttpError, query } from "../http";
import { monthlyAmount } from "../lifecycle";
import { verifyStandardWebhook } from "../signatures";
import {
  type Connection,
  emptyBatch,
  type NormalizedBatch,
  type ProviderAdapter,
  type SubscriptionStatus,
} from "../types";

type Obj = Record<string, unknown>;

export const DODO_API = "https://live.dodopayments.com";
export const DODO_TEST_API = "https://test.dodopayments.com";
const PAGE = 50;

function base(conn: Pick<Connection, "settings">) {
  return conn.settings.testMode === true ? DODO_TEST_API : DODO_API;
}

function headers(key: string) {
  return { authorization: `Bearer ${key}` };
}

interface DodoList {
  items: Obj[];
}

function customerOf(o: Obj) {
  const c = asRecord(o.customer);
  return {
    customerId: str(c?.customer_id) ?? str(o.customer_id),
    email: str(c?.email),
    name: str(c?.name),
  };
}

export function normalizePayment(p: Obj, at: number): NormalizedBatch {
  const out = emptyBatch();
  const status = str(p.status);
  if (status && status !== "succeeded") return out;
  const amount = num(p.total_amount) ?? num(p.amount) ?? 0;
  if (amount <= 0) return out;
  const { customerId, email, name } = customerOf(p);
  const subscriptionId = str(p.subscription_id);
  out.payments.push({
    providerTxnId: String(p.payment_id ?? p.id),
    providerCustomerId: customerId,
    kind: subscriptionId ? "auto" : "payment",
    amountMinor: amount,
    currency: currencyOf(p.currency) ?? "USD",
    occurredAt: timeOf(p.created_at, at),
    ...visitorFromMetadata(p.metadata),
    email,
    name,
    subscriptionId,
    hintRefs: [String(p.payment_id ?? p.id)],
  });
  return out;
}

export function normalizeRefund(r: Obj, at: number): NormalizedBatch {
  const out = emptyBatch();
  const status = str(r.status);
  if (status && status !== "succeeded") return out;
  const amount = num(r.amount) ?? 0;
  if (amount <= 0) return out;
  out.payments.push({
    providerTxnId: String(r.refund_id ?? r.id),
    kind: "refund",
    amountMinor: -amount,
    currency: currencyOf(r.currency) ?? "USD",
    occurredAt: timeOf(r.created_at, at),
    refundOf: [str(r.payment_id)].filter((x): x is string => !!x),
  });
  return out;
}

export function normalizeDispute(d: Obj, at: number, won: boolean): NormalizedBatch {
  const out = emptyBatch();
  const amount = num(d.amount) ?? 0;
  if (amount <= 0) return out;
  const base = {
    kind: "refund" as const,
    currency: currencyOf(d.currency) ?? "USD",
    refundOf: [str(d.payment_id)].filter((x): x is string => !!x),
  };
  const id = String(d.dispute_id ?? d.id);
  out.payments.push({
    ...base,
    providerTxnId: id,
    amountMinor: -amount,
    occurredAt: timeOf(d.created_at, at),
    reason: "dispute",
  });
  if (won)
    out.payments.push({
      ...base,
      providerTxnId: `${id}:won`,
      amountMinor: amount,
      occurredAt: at,
      reason: "dispute_won",
    });
  return out;
}

const STATUS: Record<string, SubscriptionStatus> = {
  active: "active",
  pending: "incomplete",
  on_hold: "past_due",
  paused: "paused",
  cancelled: "ended",
  expired: "ended",
  failed: "ended",
};

export function normalizeSubscription(s: Obj, at: number): NormalizedBatch {
  const out = emptyBatch();
  const { customerId, email } = customerOf(s);
  const trialDays = num(s.trial_period_days) ?? 0;
  const created = timeOf(s.created_at, at);
  let status = STATUS[String(s.status)] ?? "incomplete";
  if (status === "active" && trialDays > 0 && created + trialDays * 86_400_000 > at)
    status = "trialing";
  const amount = num(s.recurring_pre_tax_amount);
  out.subscriptions.push({
    id: String(s.subscription_id ?? s.id),
    customerId,
    status,
    mrrMinor:
      amount === undefined
        ? undefined
        : monthlyAmount(
            amount,
            str(s.payment_frequency_interval)?.toLowerCase(),
            num(s.payment_frequency_count) ?? 1,
          ),
    currency: currencyOf(s.currency),
    cancelAtPeriodEnd: s.cancel_at_next_billing_date === true && status !== "ended",
    trialStartAt: trialDays > 0 ? created : undefined,
    trialEndAt: trialDays > 0 ? created + trialDays * 86_400_000 : undefined,
    startedAt: created,
    occurredAt: at,
    ...visitorFromMetadata(s.metadata),
    email,
  });
  return out;
}

export function normalizeDodoEvent(payload: Obj, now: number): NormalizedBatch {
  const type = String(payload.type ?? "");
  const data = asRecord(payload.data);
  if (!data) return emptyBatch();
  const at = timeOf(payload.timestamp, now);
  if (type === "payment.succeeded") return normalizePayment(data, at);
  if (type.startsWith("refund."))
    return type === "refund.succeeded" ? normalizeRefund(data, at) : emptyBatch();
  if (type === "dispute.opened" || type === "dispute.lost")
    return normalizeDispute(data, at, false);
  if (type === "dispute.won") return normalizeDispute(data, at, true);
  if (type.startsWith("subscription.")) {
    const b = normalizeSubscription(data, at);
    if (type === "subscription.expired" || type === "subscription.cancelled")
      for (const s of b.subscriptions) s.status = "ended";
    return b;
  }
  return emptyBatch();
}

function merge(target: NormalizedBatch, b: NormalizedBatch) {
  target.payments.push(...b.payments);
  target.subscriptions.push(...b.subscriptions);
  target.customers.push(...b.customers);
}

const STREAMS = ["payments", "refunds", "subscriptions"] as const;
type Stream = (typeof STREAMS)[number];

function normalizeStream(stream: Stream, o: Obj, now: number) {
  if (stream === "payments") return normalizePayment(o, now);
  if (stream === "refunds") return normalizeRefund(o, now);
  return normalizeSubscription(o, now);
}

export const dodoAdapter: ProviderAdapter = {
  id: "dodo",
  displayName: "Dodo Payments",
  pollEveryMinutes: 5,

  async validateCredentials(input, ctx) {
    const key = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    if (!key) return { ok: false, error: "apiKey is required" };
    const testMode = input.testMode === true;
    if (testMode && !ctx.allowTestKeys)
      return { ok: false, error: "Dodo Payments test mode is disabled on this instance" };
    const settings = { testMode };
    try {
      await getJson<DodoList>(
        ctx,
        `${base({ settings })}/payments${query({ page_size: 1, page_number: 0 })}`,
        headers(key),
      );
      return { ok: true, credentials: { apiKey: key }, currency: null, settings };
    } catch (err) {
      if (err instanceof ProviderHttpError && (err.isAuth || err.isPermission))
        return { ok: false, error: "Dodo Payments rejected the API key" };
      return { ok: false, error: `Could not reach Dodo Payments: ${describeError(err)}` };
    }
  },

  async sync(conn, cursorRaw, ctx) {
    const key = conn.credentials.apiKey ?? "";
    const cursor: Record<string, number> = cursorRaw ? JSON.parse(cursorRaw) : {};
    const batch = emptyBatch();
    const next: Record<string, number> = {};
    for (const stream of STREAMS) {
      const since = cursor[stream] ?? conn.createdAt;
      const list = await getJson<DodoList>(
        ctx,
        `${base(conn)}/${stream}${query({ page_size: PAGE, page_number: 0 })}`,
        headers(key),
      );
      let newest = since;
      for (const o of list.items ?? []) {
        const t = timeOf(o.updated_at ?? o.created_at, 0);
        if (t <= since) continue;
        newest = Math.max(newest, t);
        merge(batch, normalizeStream(stream, o, ctx.now));
      }
      next[stream] = newest;
    }
    const changed = STREAMS.some((s) => next[s] !== (cursor[s] ?? conn.createdAt));
    return { batch, cursor: changed || !cursorRaw ? JSON.stringify(next) : cursorRaw, more: false };
  },

  async backfill(conn, page, ctx) {
    const key = conn.credentials.apiKey ?? "";
    const cur = page
      ? (JSON.parse(page) as { stream: Stream; page: number })
      : { stream: STREAMS[0], page: 0 };
    const list = await getJson<DodoList>(
      ctx,
      `${base(conn)}/${cur.stream}${query({ page_size: PAGE, page_number: cur.page })}`,
      headers(key),
    );
    const batch = emptyBatch();
    for (const o of list.items ?? []) merge(batch, normalizeStream(cur.stream, o, ctx.now));
    let next: string | null = null;
    if ((list.items ?? []).length === PAGE) next = JSON.stringify({ ...cur, page: cur.page + 1 });
    else {
      const following = STREAMS[STREAMS.indexOf(cur.stream) + 1];
      if (following) next = JSON.stringify({ stream: following, page: 0 });
    }
    return { batch, next };
  },

  async verifyWebhook(rawBody, hdrs, secret, now) {
    const ok = await verifyStandardWebhook(rawBody, hdrs, secret, now);
    if (!ok) return null;
    return { eventId: ok.id, payload: JSON.parse(rawBody), headers: {} };
  },

  normalizeWebhook(webhook) {
    return normalizeDodoEvent(webhook.payload as Obj, Date.now());
  },

  async resolveHint(conn, ref, ctx) {
    if (!/^pay_[A-Za-z0-9]+$/.test(ref)) return emptyBatch();
    try {
      const p = await getJson<Obj>(
        ctx,
        `${base(conn)}/payments/${encodeURIComponent(ref)}`,
        headers(conn.credentials.apiKey ?? ""),
      );
      const b = normalizePayment(p, ctx.now);
      return b.payments.length ? b : null;
    } catch (err) {
      if (err instanceof ProviderHttpError && err.isNotFound) return emptyBatch();
      throw err;
    }
  },
};
