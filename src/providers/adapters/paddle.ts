/**
 * Paddle Billing.
 *
 * - Connect with an API key (`paddleApiKey`): production keys start with `pdl_live_`; sandbox
 *   keys (`pdl_sdbx_`, sandbox-api.paddle.com) only when ALLOW_TEST_PAYMENT_KEYS is "true".
 * - Paddle has an events API, so the minute cron polls `GET /events?after=<cursor>` (ascending),
 *   like Stripe. Backfill pages through completed transactions, subscriptions and adjustments.
 * - Webhooks: `Paddle-Signature: ts=…;h1=…` over `${ts}:${rawBody}`. On connect a notification
 *   destination is created through the API when the key may write notification settings.
 * - Visitor id in `custom_data` (`datafast_visitor_id` / `datagoat_visitor_id`), set on the
 *   transaction (Checkout API) or through `customData` in Paddle.js overlay checkout.
 * - PATCH …/integrations/paddle queues a historical re-sync (DataFast's endpoint).
 *
 * Amounts: `details.totals.grand_total` (minor units, as a string). Renewals: `origin`
 * `subscription_recurring`/`subscription_update`/`subscription_charge`. Refunds and chargebacks
 * are adjustments (`action: refund | chargeback | chargeback_reverse`).
 */
import { asRecord, currencyOf, num, str, timeOf, visitorFromMetadata } from "../attribution";
import { describeError, getJson, ProviderHttpError, query, requestJson } from "../http";
import { monthlyAmount } from "../lifecycle";
import { verifyPaddleSignature } from "../signatures";
import {
  type Connection,
  emptyBatch,
  type NormalizedBatch,
  type ProviderAdapter,
  type SubscriptionStatus,
} from "../types";

type Obj = Record<string, unknown>;

export const PADDLE_API = "https://api.paddle.com";
export const PADDLE_SANDBOX_API = "https://sandbox-api.paddle.com";
const PAGE = 50;
const MAX_EVENT_PAGES = 3;

export const PADDLE_EVENTS = [
  "transaction.completed",
  "transaction.paid",
  "adjustment.created",
  "adjustment.updated",
  "subscription.created",
  "subscription.activated",
  "subscription.trialing",
  "subscription.updated",
  "subscription.canceled",
  "subscription.paused",
  "subscription.resumed",
  "subscription.past_due",
];

function base(conn: Pick<Connection, "credentials">): string {
  return (conn.credentials.apiKey ?? "").startsWith("pdl_sdbx_") ? PADDLE_SANDBOX_API : PADDLE_API;
}

function headers(key: string) {
  return { authorization: `Bearer ${key}`, "paddle-version": "1" };
}

interface PaddleList {
  data: Obj[];
  meta?: { pagination?: { next?: string; has_more?: boolean } };
}

export function normalizeTransaction(t: Obj, at: number): NormalizedBatch {
  const out = emptyBatch();
  const status = str(t.status);
  if (status !== "completed" && status !== "paid") return out;
  const totals = asRecord(asRecord(t.details)?.totals);
  const amount = num(totals?.grand_total) ?? num(totals?.total) ?? 0;
  if (amount <= 0) return out;
  const origin = str(t.origin);
  const recurring =
    origin === "subscription_recurring" ||
    origin === "subscription_update" ||
    origin === "subscription_charge";
  const ref = visitorFromMetadata(t.custom_data);
  const customer = asRecord(t.customer);
  out.payments.push({
    providerTxnId: String(t.id),
    providerCustomerId: str(t.customer_id) ?? str(customer?.id),
    kind: recurring ? "renewal" : "payment",
    amountMinor: amount,
    currency: currencyOf(t.currency_code) ?? "USD",
    occurredAt: timeOf(t.billed_at ?? t.updated_at ?? t.created_at, at),
    ...ref,
    email: str(customer?.email),
    name: str(customer?.name),
    subscriptionId: str(t.subscription_id),
    hintRefs: [String(t.id)],
  });
  return out;
}

export function normalizeAdjustment(adj: Obj, at: number): NormalizedBatch {
  const out = emptyBatch();
  const action = str(adj.action);
  if (adj.status !== "approved") return out;
  const total = num(asRecord(adj.totals)?.total) ?? 0;
  if (total <= 0) return out;
  const base = {
    providerTxnId: String(adj.id),
    providerCustomerId: str(adj.customer_id),
    kind: "refund" as const,
    currency: currencyOf(adj.currency_code) ?? "USD",
    occurredAt: timeOf(adj.updated_at ?? adj.created_at, at),
    refundOf: [str(adj.transaction_id)].filter((x): x is string => !!x),
    subscriptionId: str(adj.subscription_id),
  };
  if (action === "refund") out.payments.push({ ...base, amountMinor: -total, reason: "refund" });
  else if (action === "chargeback")
    out.payments.push({ ...base, amountMinor: -total, reason: "dispute" });
  else if (action === "chargeback_reverse")
    out.payments.push({ ...base, amountMinor: total, reason: "dispute_won" });
  return out;
}

const STATUS: Record<string, SubscriptionStatus> = {
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  paused: "paused",
  canceled: "ended",
};

export function normalizeSubscription(s: Obj, at: number): NormalizedBatch {
  const out = emptyBatch();
  const status = STATUS[String(s.status)] ?? "incomplete";
  let mrr = 0;
  let currency = currencyOf(s.currency_code);
  for (const item of Array.isArray(s.items) ? s.items : []) {
    const it = asRecord(item);
    const price = asRecord(it?.price);
    const unit = asRecord(price?.unit_price);
    const cycle = asRecord(price?.billing_cycle);
    currency ??= currencyOf(unit?.currency_code);
    mrr += monthlyAmount(
      (num(unit?.amount) ?? 0) * (num(it?.quantity) ?? 1),
      str(cycle?.interval),
      num(cycle?.frequency) ?? 1,
    );
  }
  const scheduled = asRecord(s.scheduled_change);
  out.subscriptions.push({
    id: String(s.id),
    customerId: str(s.customer_id),
    status,
    mrrMinor: Array.isArray(s.items) ? mrr : undefined,
    currency,
    cancelAtPeriodEnd: status !== "ended" && scheduled?.action === "cancel",
    trialStartAt: status === "trialing" ? timeOf(s.started_at ?? s.created_at, at) : undefined,
    startedAt: timeOf(s.started_at ?? s.created_at, at),
    occurredAt: timeOf(s.updated_at, at),
    ...visitorFromMetadata(s.custom_data),
    hintRefs: s.transaction_id ? [String(s.transaction_id)] : undefined,
  });
  return out;
}

export function normalizePaddleEvent(event: Obj, now: number): NormalizedBatch {
  const type = String(event.event_type ?? "");
  const data = asRecord(event.data);
  if (!data) return emptyBatch();
  const at = timeOf(event.occurred_at, now);
  let b = emptyBatch();
  if (type.startsWith("transaction.")) b = normalizeTransaction(data, at);
  else if (type.startsWith("adjustment.")) b = normalizeAdjustment(data, at);
  else if (type.startsWith("subscription.")) b = normalizeSubscription(data, at);
  for (const p of b.payments) p.eventId = str(event.event_id);
  return b;
}

function merge(target: NormalizedBatch, b: NormalizedBatch) {
  target.payments.push(...b.payments);
  target.subscriptions.push(...b.subscriptions);
  target.customers.push(...b.customers);
}

const STREAMS = ["transactions", "subscriptions", "adjustments"] as const;
type Stream = (typeof STREAMS)[number];

const STREAM_QUERY: Record<Stream, Record<string, string>> = {
  transactions: { status: "completed,paid", order_by: "created_at[DESC]" },
  subscriptions: { order_by: "id[DESC]" },
  adjustments: { action: "refund,chargeback,chargeback_reverse", order_by: "id[DESC]" },
};

export const paddleAdapter: ProviderAdapter = {
  id: "paddle",
  displayName: "Paddle",

  async validateCredentials(input, ctx) {
    const key = typeof input.paddleApiKey === "string" ? input.paddleApiKey.trim() : "";
    if (!key) return { ok: false, error: "paddleApiKey is required" };
    const sandbox = key.startsWith("pdl_sdbx_");
    if (!key.startsWith("pdl_live_") && !sandbox)
      return {
        ok: false,
        error: "Invalid Paddle API key format: production keys start with pdl_live_",
      };
    if (sandbox && !ctx.allowTestKeys)
      return { ok: false, error: "Paddle sandbox keys only work in development" };
    const conn = { credentials: { apiKey: key } };
    try {
      await getJson<PaddleList>(ctx, `${base(conn)}/transactions?per_page=1`, headers(key));
      const head = await getJson<PaddleList>(
        ctx,
        `${base(conn)}/events${query({ order_by: "id[DESC]", per_page: 1 })}`,
        headers(key),
      );
      return {
        ok: true,
        credentials: { apiKey: key },
        currency: null,
        settings: { sandbox },
        syncCursor: str(head.data[0]?.event_id) ?? null,
      };
    } catch (err) {
      if (err instanceof ProviderHttpError && err.isAuth)
        return { ok: false, error: "Paddle rejected the API key (invalid or expired)" };
      if (err instanceof ProviderHttpError && err.isPermission)
        return {
          ok: false,
          error: "The Paddle API key needs read access to transactions and events",
        };
      return { ok: false, error: `Could not reach Paddle: ${describeError(err)}` };
    }
  },

  async sync(conn, cursorRaw, ctx) {
    const key = conn.credentials.apiKey ?? "";
    const batch = emptyBatch();
    let after = cursorRaw;
    let more = false;
    for (let page = 0; page < MAX_EVENT_PAGES; page++) {
      const list = await getJson<PaddleList>(
        ctx,
        `${base(conn)}/events${query({ after: after ?? undefined, order_by: "id[ASC]", per_page: PAGE })}`,
        headers(key),
      );
      if (!list.data.length) {
        more = false;
        break;
      }
      for (const e of list.data) merge(batch, normalizePaddleEvent(e, ctx.now));
      after = str(list.data[list.data.length - 1]?.event_id) ?? after;
      more = list.meta?.pagination?.has_more === true;
      if (!more) break;
    }
    return { batch, cursor: after, more };
  },

  async backfill(conn, page, ctx) {
    const key = conn.credentials.apiKey ?? "";
    const cur = page
      ? (JSON.parse(page) as { stream: Stream; after: string | null })
      : { stream: STREAMS[0], after: null };
    const list = await getJson<PaddleList>(
      ctx,
      `${base(conn)}/${cur.stream}${query({ ...STREAM_QUERY[cur.stream], per_page: PAGE, after: cur.after ?? undefined })}`,
      headers(key),
    );
    const batch = emptyBatch();
    for (const o of list.data) {
      merge(
        batch,
        cur.stream === "transactions"
          ? normalizeTransaction(o, ctx.now)
          : cur.stream === "subscriptions"
            ? normalizeSubscription(o, ctx.now)
            : normalizeAdjustment(o, ctx.now),
      );
    }
    const last = str(list.data[list.data.length - 1]?.id);
    let next: string | null = null;
    if (list.meta?.pagination?.has_more && last) next = JSON.stringify({ ...cur, after: last });
    else {
      const following = STREAMS[STREAMS.indexOf(cur.stream) + 1];
      if (following) next = JSON.stringify({ stream: following, after: null });
    }
    return { batch, next };
  },

  async verifyWebhook(rawBody, hdrs, secret, now) {
    if (!(await verifyPaddleSignature(rawBody, hdrs.get("paddle-signature"), secret, now)))
      return null;
    const payload = JSON.parse(rawBody) as Obj;
    return {
      eventId: String(payload.event_id ?? payload.notification_id ?? ""),
      payload,
      headers: {},
    };
  },

  normalizeWebhook(webhook) {
    return normalizePaddleEvent(webhook.payload as Obj, Date.now());
  },

  async resolveHint(conn, ref, ctx) {
    if (!ref.startsWith("txn_")) return emptyBatch();
    try {
      const res = await getJson<{ data: Obj }>(
        ctx,
        `${base(conn)}/transactions/${encodeURIComponent(ref)}${query({ include: "customer" })}`,
        headers(conn.credentials.apiKey ?? ""),
      );
      const b = normalizeTransaction(res.data, ctx.now);
      return b.payments.length ? b : null;
    } catch (err) {
      if (err instanceof ProviderHttpError && err.isNotFound) return emptyBatch();
      throw err;
    }
  },

  async setupWebhook(conn, url, ctx) {
    try {
      const res = await requestJson<{ data: Obj }>(ctx, `${base(conn)}/notification-settings`, {
        method: "POST",
        headers: { ...headers(conn.credentials.apiKey ?? ""), "content-type": "application/json" },
        body: JSON.stringify({
          description: "DataGoat revenue attribution",
          destination: url,
          type: "url",
          subscribed_events: PADDLE_EVENTS,
          include_sensitive_fields: false,
          api_version: 1,
        }),
      });
      const secret = str(res.data.data?.endpoint_secret_key);
      return secret ? { secret, webhookId: str(res.data.data?.id) ?? null } : null;
    } catch {
      return null;
    }
  },

  async removeWebhook(conn, ctx) {
    const id = str(conn.settings.webhookId);
    if (!id) return;
    await requestJson(ctx, `${base(conn)}/notification-settings/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: headers(conn.credentials.apiKey ?? ""),
    }).catch(() => undefined);
  },
};
