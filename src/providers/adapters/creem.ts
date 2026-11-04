/**
 * Creem.
 *
 * - Connect with an API key (`apiKey`, header `x-api-key`) and optionally the webhook secret
 *   (`webhookSecret`). `creem_test_` keys use test-api.creem.io and are accepted only when
 *   ALLOW_TEST_PAYMENT_KEYS is "true".
 * - Webhooks: `creem-signature` = hex HMAC-SHA256 of the raw body. Events: `checkout.completed`,
 *   `subscription.*`, `refund.created`, `dispute.created`.
 * - Visitor id: checkout `metadata` (`datafast_visitor_id` / `datagoat_visitor_id`), passed when
 *   the checkout session is created.
 * - Polling (every 5 minutes) and backfill over transactions. A transaction of a subscription is
 *   a sale the first time and a renewal afterwards (`kind: auto`).
 * - Success-page hint: `?checkout_id=ch_…` resolves through GET /v1/checkouts.
 *
 * Transaction ids: the Creem transaction (`tran_…`) when known, else the order id.
 */
import { asRecord, currencyOf, num, str, timeOf, visitorFromMetadata } from "../attribution";
import { describeError, getJson, ProviderHttpError, query } from "../http";
import { monthlyAmount } from "../lifecycle";
import { verifyBodyHmacHex } from "../signatures";
import {
  type Connection,
  emptyBatch,
  type NormalizedBatch,
  type ProviderAdapter,
  type SubscriptionStatus,
} from "../types";

type Obj = Record<string, unknown>;

export const CREEM_API = "https://api.creem.io";
export const CREEM_TEST_API = "https://test-api.creem.io";
const PAGE = 50;

function base(conn: Pick<Connection, "credentials">) {
  return (conn.credentials.apiKey ?? "").startsWith("creem_test_") ? CREEM_TEST_API : CREEM_API;
}

function headers(key: string) {
  return { "x-api-key": key };
}

function idOf(v: unknown): string | undefined {
  return typeof v === "string" ? v : str(asRecord(v)?.id);
}

function customerOf(o: Obj) {
  const c = asRecord(o.customer);
  return { customerId: idOf(o.customer), email: str(c?.email), name: str(c?.name) };
}

export function normalizeCheckout(c: Obj, at: number): NormalizedBatch {
  const out = emptyBatch();
  if (c.status !== "completed") return out;
  const order = asRecord(c.order);
  const { customerId, email, name } = customerOf(c);
  const ref = visitorFromMetadata(c.metadata, order?.metadata);
  const subscriptionId = idOf(c.subscription);
  const amount = num(order?.amount_paid) ?? num(order?.amount) ?? 0;
  const txn = str(order?.transaction) ?? idOf(order);
  if (txn && amount > 0) {
    out.payments.push({
      providerTxnId: txn,
      providerCustomerId: customerId,
      kind: "payment",
      amountMinor: amount,
      currency: currencyOf(order?.currency) ?? "USD",
      occurredAt: timeOf(order?.created_at ?? c.created_at, at),
      ...ref,
      email,
      name,
      subscriptionId,
      hintRefs: [String(c.id)],
    });
  }
  out.customers.push({
    customerId,
    ...ref,
    email,
    occurredAt: at,
    subscriptionId,
    attachTxnIds: subscriptionId ? [`${subscriptionId}:trial`] : undefined,
    hintRefs: [String(c.id)],
  });
  return out;
}

export function normalizeTransaction(t: Obj, at: number): NormalizedBatch {
  const out = emptyBatch();
  const status = str(t.status);
  const amount = num(t.amount_paid) ?? num(t.amount) ?? 0;
  if (status !== "paid" && status !== "refunded" && status !== "partialRefund") return out;
  const subscriptionId = idOf(t.subscription);
  const currency = currencyOf(t.currency) ?? "USD";
  const occurredAt = timeOf(t.created_at, at);
  if (amount > 0) {
    out.payments.push({
      providerTxnId: String(t.id),
      providerCustomerId: idOf(t.customer),
      kind: subscriptionId ? "auto" : "payment",
      amountMinor: amount,
      currency,
      occurredAt,
      subscriptionId,
      ...visitorFromMetadata(t.metadata),
    });
  }
  const refunded = num(t.refunded_amount) ?? 0;
  if (refunded > 0) {
    out.payments.push({
      providerTxnId: `${String(t.id)}:refund`,
      providerCustomerId: idOf(t.customer),
      kind: "refund",
      amountMinor: -refunded,
      currency,
      occurredAt,
      refundOf: [String(t.id)],
      updateAmount: true,
    });
  }
  return out;
}

/** Creem billing periods: every-month, every-three-months, every-six-months, every-year. */
function creemInterval(period: string | undefined): [string, number] {
  switch (period) {
    case "every-three-months":
      return ["month", 3];
    case "every-six-months":
      return ["month", 6];
    case "every-year":
      return ["year", 1];
    default:
      return ["month", 1];
  }
}

const STATUS: Record<string, SubscriptionStatus> = {
  trialing: "trialing",
  active: "active",
  paid: "active",
  past_due: "past_due",
  unpaid: "past_due",
  paused: "paused",
  incomplete: "incomplete",
  canceled: "ended",
  expired: "ended",
  scheduled_cancel: "active",
};

export function normalizeSubscription(s: Obj, at: number, event = ""): NormalizedBatch {
  const out = emptyBatch();
  const { customerId, email } = customerOf(s);
  const product = asRecord(s.product);
  const raw = String(s.status ?? "");
  let status = STATUS[raw] ?? "incomplete";
  if (event === "subscription.expired") status = "ended";
  const price = num(product?.price);
  const [interval, count] = creemInterval(str(product?.billing_period));
  const id = String(s.id);
  out.subscriptions.push({
    id,
    customerId,
    status,
    mrrMinor: price === undefined ? undefined : monthlyAmount(price, interval, count),
    currency: currencyOf(product?.currency),
    cancelAtPeriodEnd:
      status !== "ended" &&
      (raw === "scheduled_cancel" || (event === "subscription.canceled" && raw !== "canceled")),
    startedAt: timeOf(s.created_at, at),
    occurredAt: timeOf(s.updated_at, at),
    ...visitorFromMetadata(s.metadata),
    email,
  });
  // A renewal: the subscription's latest transaction.
  const txn = str(s.last_transaction_id) ?? idOf(s.last_transaction);
  if (event === "subscription.paid" && txn && price !== undefined && price > 0) {
    out.payments.push({
      providerTxnId: txn,
      providerCustomerId: customerId,
      kind: "auto",
      amountMinor: num(asRecord(s.last_transaction)?.amount_paid) ?? price,
      currency: currencyOf(product?.currency) ?? "USD",
      occurredAt: timeOf(s.last_transaction_date ?? s.updated_at, at),
      subscriptionId: id,
      email,
      ...visitorFromMetadata(s.metadata),
    });
  }
  return out;
}

export function normalizeCreemRefund(r: Obj, at: number): NormalizedBatch {
  const out = emptyBatch();
  const amount = num(r.refund_amount) ?? 0;
  if (amount <= 0) return out;
  const t = asRecord(r.transaction);
  out.payments.push({
    providerTxnId: String(r.id),
    providerCustomerId: idOf(r.customer),
    kind: "refund",
    amountMinor: -amount,
    currency: currencyOf(r.refund_currency ?? t?.currency) ?? "USD",
    occurredAt: timeOf(r.created_at, at),
    refundOf: [idOf(r.transaction), idOf(r.order)].filter((x): x is string => !!x),
  });
  return out;
}

export function normalizeCreemEvent(payload: Obj, now: number): NormalizedBatch {
  const type = String(payload.eventType ?? payload.type ?? "");
  const object = asRecord(payload.object);
  if (!object) return emptyBatch();
  const at = timeOf(payload.created_at, now);
  if (type === "checkout.completed") return normalizeCheckout(object, at);
  if (type.startsWith("subscription.")) return normalizeSubscription(object, at, type);
  if (type === "refund.created") return normalizeCreemRefund(object, at);
  if (type === "dispute.created") {
    const amount = num(object.amount) ?? 0;
    const b = emptyBatch();
    if (amount > 0)
      b.payments.push({
        providerTxnId: String(object.id),
        kind: "refund",
        amountMinor: -amount,
        currency: currencyOf(object.currency) ?? "USD",
        occurredAt: at,
        refundOf: [idOf(object.transaction), idOf(object.order)].filter((x): x is string => !!x),
        reason: "dispute",
      });
    return b;
  }
  return emptyBatch();
}

function merge(target: NormalizedBatch, b: NormalizedBatch) {
  target.payments.push(...b.payments);
  target.subscriptions.push(...b.subscriptions);
  target.customers.push(...b.customers);
}

interface CreemList {
  items: Obj[];
  pagination?: { total_pages?: number; next_page?: number | null };
}

export const creemAdapter: ProviderAdapter = {
  id: "creem",
  displayName: "Creem",
  pollEveryMinutes: 5,

  async validateCredentials(input, ctx) {
    const key = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    if (!key) return { ok: false, error: "apiKey is required" };
    if (key.startsWith("creem_test_") && !ctx.allowTestKeys)
      return { ok: false, error: "Creem test keys are not accepted on this instance" };
    try {
      await getJson<CreemList>(
        ctx,
        `${base({ credentials: { apiKey: key } })}/v1/transactions/search${query({ page_number: 1, page_size: 1 })}`,
        headers(key),
      );
      return { ok: true, credentials: { apiKey: key }, currency: null, settings: {} };
    } catch (err) {
      if (err instanceof ProviderHttpError && (err.isAuth || err.isPermission))
        return { ok: false, error: "Creem rejected the API key" };
      return { ok: false, error: `Could not reach Creem: ${describeError(err)}` };
    }
  },

  async sync(conn, cursorRaw, ctx) {
    const since = cursorRaw ? Number(cursorRaw) : conn.createdAt;
    const list = await getJson<CreemList>(
      ctx,
      `${base(conn)}/v1/transactions/search${query({ page_number: 1, page_size: PAGE })}`,
      headers(conn.credentials.apiKey ?? ""),
    );
    const batch = emptyBatch();
    let newest = since;
    for (const t of list.items ?? []) {
      const ts = timeOf(t.updated_at ?? t.created_at, 0);
      if (ts <= since) continue;
      newest = Math.max(newest, ts);
      merge(batch, normalizeTransaction(t, ctx.now));
    }
    return {
      batch,
      cursor: newest !== since || !cursorRaw ? String(newest) : cursorRaw,
      more: false,
    };
  },

  async backfill(conn, page, ctx) {
    const n = page ? Number(page) : 1;
    const list = await getJson<CreemList>(
      ctx,
      `${base(conn)}/v1/transactions/search${query({ page_number: n, page_size: PAGE })}`,
      headers(conn.credentials.apiKey ?? ""),
    );
    const batch = emptyBatch();
    // Oldest first, so the first charge of a subscription is the sale.
    for (const t of [...(list.items ?? [])].reverse())
      merge(batch, normalizeTransaction(t, ctx.now));
    const total = list.pagination?.total_pages ?? n;
    return { batch, next: n < total && (list.items ?? []).length ? String(n + 1) : null };
  },

  async verifyWebhook(rawBody, hdrs, secret) {
    if (!(await verifyBodyHmacHex(rawBody, hdrs.get("creem-signature"), secret))) return null;
    const payload = JSON.parse(rawBody) as Obj;
    return { eventId: String(payload.id ?? ""), payload, headers: {} };
  },

  normalizeWebhook(webhook) {
    return normalizeCreemEvent(webhook.payload as Obj, Date.now());
  },

  async resolveHint(conn, ref, ctx) {
    if (!ref.startsWith("ch_")) return emptyBatch();
    try {
      const c = await getJson<Obj>(
        ctx,
        `${base(conn)}/v1/checkouts${query({ checkout_id: ref })}`,
        headers(conn.credentials.apiKey ?? ""),
      );
      if (c.status !== "completed") return null;
      return normalizeCheckout(c, ctx.now);
    } catch (err) {
      if (err instanceof ProviderHttpError && err.isNotFound) return emptyBatch();
      throw err;
    }
  },
};
