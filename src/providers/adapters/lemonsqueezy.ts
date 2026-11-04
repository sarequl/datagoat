/**
 * Lemon Squeezy (plan §10.4).
 *
 * - Connect with an API key and the store id (`lemonsqueezyApiKey`, `lemonsqueezyStoreId`). The
 *   store's currency is returned. Test-mode keys work the same API.
 * - Webhooks: `X-Signature` = hex HMAC-SHA256 of the raw body. On connect the webhook is created
 *   through the API (the key can always do it) with a random signing secret we keep.
 * - The visitor id travels in `checkout[custom][datafast_visitor_id]` (or `datagoat_visitor_id`)
 *   and comes back in webhooks as `meta.custom_data`.
 * - Payment Links redirect with `?order_id=[order_id]`; the hint reads that order.
 * - Polling (every 5 minutes) and backfill cover orders and subscription invoices (renewals).
 *   Lemon Squeezy's API does not return custom data, so polled orders attribute through hints,
 *   the customer map and email; webhooks carry the metadata.
 * - Lemon Squeezy subscriptions carry no price, so upgrades/downgrades are detected from renewal
 *   invoice totals changing (`planChangesFromRenewals`).
 *
 * Transaction ids: orders use the order id, renewals `inv_<subscription-invoice id>`.
 */

import { randomToken } from "../../lib/ids";
import { asRecord, currencyOf, num, str, timeOf, visitorFromMetadata } from "../attribution";
import { describeError, getJson, ProviderHttpError, query, requestJson } from "../http";
import { verifyBodyHmacHex } from "../signatures";
import {
  type Connection,
  emptyBatch,
  type NormalizedBatch,
  type ProviderAdapter,
  type SubscriptionStatus,
} from "../types";

type Obj = Record<string, unknown>;

export const LS_API = "https://api.lemonsqueezy.com/v1";
const PAGE = 50;

export const LS_EVENTS = [
  "order_created",
  "order_refunded",
  "subscription_created",
  "subscription_updated",
  "subscription_cancelled",
  "subscription_resumed",
  "subscription_expired",
  "subscription_paused",
  "subscription_unpaused",
  "subscription_payment_success",
  "subscription_payment_refunded",
  "subscription_plan_changed",
];

function headers(key: string) {
  return {
    authorization: `Bearer ${key}`,
    accept: "application/vnd.api+json",
    "content-type": "application/vnd.api+json",
  };
}

interface JsonApiResource {
  type: string;
  id: string;
  attributes: Obj;
}

interface JsonApiList {
  data: JsonApiResource[];
  meta?: { page?: { currentPage?: number; lastPage?: number } };
}

export function normalizeOrder(res: JsonApiResource, custom: unknown, at: number): NormalizedBatch {
  const out = emptyBatch();
  const a = res.attributes ?? {};
  const status = str(a.status);
  if (status !== "paid" && status !== "refunded" && status !== "partial_refund") return out;
  const ref = visitorFromMetadata(custom);
  const currency = currencyOf(a.currency) ?? "USD";
  const occurredAt = timeOf(a.created_at, at);
  const customerId =
    a.customer_id !== undefined && a.customer_id !== null ? String(a.customer_id) : undefined;
  const total = num(a.total) ?? 0;
  const firstItem = asRecord(a.first_order_item);
  if (total > 0) {
    out.payments.push({
      providerTxnId: String(res.id),
      providerCustomerId: customerId,
      kind: "payment",
      amountMinor: total,
      currency,
      occurredAt,
      ...ref,
      email: str(a.user_email),
      name: str(a.user_name),
      hintRefs: [String(res.id), str(a.identifier)].filter((x): x is string => !!x),
      metadata: firstItem ? { product: str(firstItem.product_name) } : undefined,
    });
  }
  const refunded = num(a.refunded_amount) ?? (a.refunded === true ? total : 0);
  if (refunded > 0) {
    out.payments.push({
      providerTxnId: `${String(res.id)}:refund`,
      providerCustomerId: customerId,
      kind: "refund",
      amountMinor: -refunded,
      currency,
      occurredAt: timeOf(a.refunded_at ?? a.updated_at, occurredAt),
      refundOf: [String(res.id)],
      updateAmount: true,
    });
  }
  return out;
}

export function normalizeInvoice(
  res: JsonApiResource,
  custom: unknown,
  at: number,
): NormalizedBatch {
  const out = emptyBatch();
  const a = res.attributes ?? {};
  const reason = str(a.billing_reason);
  const status = str(a.status);
  const txn = `inv_${String(res.id)}`;
  const currency = currencyOf(a.currency) ?? "USD";
  const customerId =
    a.customer_id !== undefined && a.customer_id !== null ? String(a.customer_id) : undefined;
  const subscriptionId =
    a.subscription_id !== undefined && a.subscription_id !== null
      ? String(a.subscription_id)
      : undefined;
  const occurredAt = timeOf(a.created_at, at);
  const total = num(a.total) ?? 0;
  // The initial invoice duplicates order_created; only renewals and plan-change charges count.
  if (
    reason !== "initial" &&
    (status === "paid" || status === "refunded" || status === "partial_refund") &&
    total > 0
  ) {
    out.payments.push({
      providerTxnId: txn,
      providerCustomerId: customerId,
      kind: "renewal",
      amountMinor: total,
      currency,
      occurredAt,
      ...visitorFromMetadata(custom),
      email: str(a.user_email),
      name: str(a.user_name),
      subscriptionId,
    });
  }
  const refunded = num(a.refunded_amount) ?? (a.refunded === true ? total : 0);
  if (refunded > 0 && reason !== "initial") {
    out.payments.push({
      providerTxnId: `${txn}:refund`,
      providerCustomerId: customerId,
      kind: "refund",
      amountMinor: -refunded,
      currency,
      occurredAt: timeOf(a.refunded_at ?? a.updated_at, occurredAt),
      refundOf: [txn],
      updateAmount: true,
    });
  }
  return out;
}

const STATUS: Record<string, SubscriptionStatus> = {
  on_trial: "trialing",
  active: "active",
  past_due: "past_due",
  unpaid: "past_due",
  paused: "paused",
  cancelled: "active", // cancelled = scheduled to end at ends_at
  expired: "ended",
};

export function normalizeSubscription(
  res: JsonApiResource,
  custom: unknown,
  at: number,
): NormalizedBatch {
  const out = emptyBatch();
  const a = res.attributes ?? {};
  const raw = String(a.status ?? "");
  const status = STATUS[raw] ?? "incomplete";
  out.subscriptions.push({
    id: String(res.id),
    customerId:
      a.customer_id !== undefined && a.customer_id !== null ? String(a.customer_id) : undefined,
    status,
    cancelAtPeriodEnd: raw === "cancelled" || a.cancelled === true,
    trialEndAt: a.trial_ends_at ? timeOf(a.trial_ends_at, at) : undefined,
    trialStartAt: raw === "on_trial" ? timeOf(a.created_at, at) : undefined,
    startedAt: timeOf(a.created_at, at),
    occurredAt: timeOf(a.updated_at, at),
    ...visitorFromMetadata(custom),
    email: str(a.user_email),
    hintRefs: a.order_id ? [String(a.order_id)] : undefined,
  });
  return out;
}

export function normalizeLsWebhook(payload: Obj, now: number): NormalizedBatch {
  const meta = asRecord(payload.meta) ?? {};
  const event = String(meta.event_name ?? "");
  const data = asRecord(payload.data) as JsonApiResource | null;
  if (!data) return emptyBatch();
  const custom = meta.custom_data;
  const at = timeOf(asRecord(data.attributes)?.updated_at, now);
  switch (data.type) {
    case "orders":
      return normalizeOrder(data, custom, at);
    case "subscription-invoices":
      return normalizeInvoice(data, custom, at);
    case "subscriptions": {
      const b = normalizeSubscription(data, custom, at);
      if (event === "subscription_expired") for (const s of b.subscriptions) s.status = "ended";
      return b;
    }
    default:
      return emptyBatch();
  }
}

function merge(target: NormalizedBatch, b: NormalizedBatch) {
  target.payments.push(...b.payments);
  target.subscriptions.push(...b.subscriptions);
  target.customers.push(...b.customers);
}

function storeId(conn: Connection): string {
  return String(conn.settings.storeId ?? conn.accountId ?? "");
}

const STREAMS = ["orders", "subscription-invoices", "subscriptions"] as const;
type Stream = (typeof STREAMS)[number];

function normalizeStream(stream: Stream, r: JsonApiResource, now: number) {
  if (stream === "orders") return normalizeOrder(r, null, now);
  if (stream === "subscription-invoices") return normalizeInvoice(r, null, now);
  return normalizeSubscription(r, null, now);
}

export const lemonSqueezyAdapter: ProviderAdapter = {
  id: "lemonsqueezy",
  displayName: "Lemon Squeezy",
  pollEveryMinutes: 5,
  planChangesFromRenewals: true,

  async validateCredentials(input, ctx) {
    const key = typeof input.lemonsqueezyApiKey === "string" ? input.lemonsqueezyApiKey.trim() : "";
    const store =
      typeof input.lemonsqueezyStoreId === "string" || typeof input.lemonsqueezyStoreId === "number"
        ? String(input.lemonsqueezyStoreId).trim()
        : "";
    if (!key) return { ok: false, error: "lemonsqueezyApiKey is required" };
    if (!/^\d+$/.test(store))
      return { ok: false, error: "lemonsqueezyStoreId must be a numeric store id" };
    try {
      const res = await getJson<{ data: JsonApiResource }>(
        ctx,
        `${LS_API}/stores/${store}`,
        headers(key),
      );
      const a = res.data?.attributes ?? {};
      return {
        ok: true,
        credentials: { apiKey: key },
        accountId: store,
        accountName: str(a.name) ?? null,
        currency: currencyOf(a.currency) ?? null,
        settings: { storeId: store },
      };
    } catch (err) {
      if (err instanceof ProviderHttpError && (err.isAuth || err.isPermission))
        return { ok: false, error: "Lemon Squeezy rejected the API key" };
      if (err instanceof ProviderHttpError && err.isNotFound)
        return { ok: false, error: "Lemon Squeezy store not found for this API key" };
      return { ok: false, error: `Could not reach Lemon Squeezy: ${describeError(err)}` };
    }
  },

  async sync(conn, cursorRaw, ctx) {
    const key = conn.credentials.apiKey ?? "";
    const cursor: Record<string, number> = cursorRaw
      ? (JSON.parse(cursorRaw) as Record<string, number>)
      : {};
    const batch = emptyBatch();
    const next: Record<string, number> = {};
    for (const stream of STREAMS) {
      const since = cursor[stream] ?? conn.createdAt;
      const list = await getJson<JsonApiList>(
        ctx,
        `${LS_API}/${stream}${query({ "filter[store_id]": storeId(conn), "page[size]": PAGE })}`,
        headers(key),
      );
      let newest = since;
      for (const r of list.data ?? []) {
        const t = timeOf(r.attributes?.updated_at ?? r.attributes?.created_at, 0);
        if (t <= since) continue;
        newest = Math.max(newest, t);
        merge(batch, normalizeStream(stream, r, ctx.now));
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
      : { stream: STREAMS[0], page: 1 };
    const list = await getJson<JsonApiList>(
      ctx,
      `${LS_API}/${cur.stream}${query({ "filter[store_id]": storeId(conn), "page[size]": PAGE, "page[number]": cur.page })}`,
      headers(key),
    );
    const batch = emptyBatch();
    for (const r of list.data ?? []) merge(batch, normalizeStream(cur.stream, r, ctx.now));
    const last = list.meta?.page?.lastPage ?? cur.page;
    let next: string | null = null;
    if (cur.page < last && list.data?.length) next = JSON.stringify({ ...cur, page: cur.page + 1 });
    else {
      const i = STREAMS.indexOf(cur.stream);
      const following = STREAMS[i + 1];
      if (following) next = JSON.stringify({ stream: following, page: 1 });
    }
    return { batch, next };
  },

  async verifyWebhook(rawBody, hdrs, secret) {
    if (!(await verifyBodyHmacHex(rawBody, hdrs.get("x-signature"), secret))) return null;
    const payload = JSON.parse(rawBody) as Obj;
    const meta = asRecord(payload.meta) ?? {};
    const data = asRecord(payload.data) ?? {};
    const attrs = asRecord(data.attributes) ?? {};
    const eventId = `${String(meta.event_name ?? hdrs.get("x-event-name") ?? "")}:${String(data.type)}:${String(data.id)}:${String(attrs.updated_at ?? "")}`;
    return { eventId, payload, headers: {} };
  },

  normalizeWebhook(webhook) {
    return normalizeLsWebhook(webhook.payload as Obj, Date.now());
  },

  async resolveHint(conn, ref, ctx) {
    if (!/^\d+$/.test(ref)) return emptyBatch();
    try {
      const res = await getJson<{ data: JsonApiResource }>(
        ctx,
        `${LS_API}/orders/${ref}`,
        headers(conn.credentials.apiKey ?? ""),
      );
      if (String(res.data?.attributes?.store_id ?? storeId(conn)) !== storeId(conn))
        return emptyBatch();
      const b = normalizeOrder(res.data, null, ctx.now);
      return b.payments.length ? b : null;
    } catch (err) {
      if (err instanceof ProviderHttpError && err.isNotFound) return emptyBatch();
      throw err;
    }
  },

  async setupWebhook(conn, url, ctx) {
    const secret = randomToken(24);
    try {
      const res = await requestJson<{ data: JsonApiResource }>(ctx, `${LS_API}/webhooks`, {
        method: "POST",
        headers: headers(conn.credentials.apiKey ?? ""),
        body: JSON.stringify({
          data: {
            type: "webhooks",
            attributes: { url, events: LS_EVENTS, secret },
            relationships: { store: { data: { type: "stores", id: storeId(conn) } } },
          },
        }),
      });
      return { secret, webhookId: res.data.data?.id ? String(res.data.data.id) : null };
    } catch {
      return null;
    }
  },

  async removeWebhook(conn, ctx) {
    const id = str(conn.settings.webhookId);
    if (!id) return;
    await requestJson(ctx, `${LS_API}/webhooks/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: headers(conn.credentials.apiKey ?? ""),
    }).catch(() => undefined);
  },
};
