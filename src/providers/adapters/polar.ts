/**
 * Polar (plan §10.4).
 *
 * - Connect with an organization access token and the organization id (DataFast's
 *   `polarAccessToken` + `polarOrgId`). Sandbox (sandbox-api.polar.sh) with `sandbox: true` when
 *   ALLOW_TEST_PAYMENT_KEYS is "true".
 * - Polling every 5 minutes: newest orders and subscriptions (sorted by recency); only objects
 *   changed since the cursor are processed. Backfill pages through all orders, then subscriptions.
 * - Webhooks follow Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature`).
 *   Secrets of both generations verify (see signatures.ts `standardWebhookKeys`). On connect the
 *   endpoint is created through the API when the token has `webhooks:write`.
 * - Checkout Links redirect with `?checkout_id={CHECKOUT_ID}`; the hint resolves through the order
 *   whose `checkout_id` matches.
 * - Visitor id: order / checkout / customer `metadata` (`datafast_visitor_id`, `datagoat_visitor_id`).
 */
import { asRecord, currencyOf, num, str, timeOf, visitorFromMetadata } from "../attribution";
import { describeError, getJson, ProviderHttpError, query, requestJson } from "../http";
import { monthlyAmount } from "../lifecycle";
import { verifyStandardWebhook } from "../signatures";
import {
  type AdapterContext,
  type Connection,
  emptyBatch,
  type NormalizedBatch,
  type ProviderAdapter,
  type SubscriptionStatus,
} from "../types";

type Obj = Record<string, unknown>;

export const POLAR_API = "https://api.polar.sh/v1";
export const POLAR_SANDBOX_API = "https://sandbox-api.polar.sh/v1";
const PAGE = 50;

export const POLAR_EVENTS = [
  "order.created",
  "order.paid",
  "order.updated",
  "order.refunded",
  "subscription.created",
  "subscription.updated",
  "subscription.active",
  "subscription.canceled",
  "subscription.uncanceled",
  "subscription.revoked",
  "checkout.updated",
];

function base(conn: Pick<Connection, "settings">): string {
  return conn.settings.sandbox === true ? POLAR_SANDBOX_API : POLAR_API;
}

function headers(token: string) {
  return { authorization: `Bearer ${token}` };
}

interface Page<T> {
  items: T[];
  pagination?: { total_count?: number; max_page?: number };
}

function customerOf(o: Obj) {
  const c = asRecord(o.customer);
  return {
    customerId: str(o.customer_id) ?? str(c?.id),
    email: str(c?.email) ?? str(o.customer_email),
    name: str(c?.name) ?? str(o.customer_name),
    metadata: c?.metadata,
  };
}

export function normalizeOrder(o: Obj, at: number): NormalizedBatch {
  const out = emptyBatch();
  const status = str(o.status);
  const paid =
    o.paid === true ||
    status === "paid" ||
    status === "refunded" ||
    status === "partially_refunded";
  if (!paid) return out;
  const { customerId, email, name, metadata: customerMeta } = customerOf(o);
  const ref = visitorFromMetadata(o.metadata, asRecord(o.checkout)?.metadata, customerMeta);
  const currency = currencyOf(o.currency) ?? "USD";
  const amount =
    num(o.total_amount) ?? num(o.amount) ?? (num(o.net_amount) ?? 0) + (num(o.tax_amount) ?? 0);
  const reason = str(o.billing_reason);
  const occurredAt = timeOf(o.created_at, at);
  const checkoutId = str(o.checkout_id);
  const subscriptionId = str(o.subscription_id) ?? str(asRecord(o.subscription)?.id);
  if (amount > 0) {
    out.payments.push({
      providerTxnId: String(o.id),
      providerCustomerId: customerId,
      kind:
        reason === "subscription_cycle" || reason === "subscription_update" ? "renewal" : "payment",
      amountMinor: amount,
      currency,
      occurredAt,
      ...ref,
      email,
      name,
      subscriptionId,
      hintRefs: checkoutId ? [checkoutId] : undefined,
    });
  }
  const refunded = num(o.refunded_amount) ?? 0;
  if (refunded > 0) {
    out.payments.push({
      providerTxnId: `${String(o.id)}:refund`,
      providerCustomerId: customerId,
      kind: "refund",
      amountMinor: -refunded,
      currency,
      occurredAt: timeOf(o.modified_at, occurredAt),
      refundOf: [String(o.id)],
      updateAmount: true,
    });
  }
  return out;
}

const STATUS: Record<string, SubscriptionStatus> = {
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  unpaid: "past_due",
  incomplete: "incomplete",
  incomplete_expired: "ended",
  canceled: "ended",
  revoked: "ended",
};

export function normalizeSubscription(s: Obj, at: number, forceEnded = false): NormalizedBatch {
  const out = emptyBatch();
  const { customerId, email, metadata: customerMeta } = customerOf(s);
  const ref = visitorFromMetadata(s.metadata, customerMeta);
  const amount = num(s.amount) ?? num(asRecord(s.price)?.price_amount);
  const status = forceEnded || s.ended_at ? "ended" : (STATUS[String(s.status)] ?? "incomplete");
  out.subscriptions.push({
    id: String(s.id),
    customerId,
    status,
    mrrMinor:
      amount === undefined
        ? undefined
        : monthlyAmount(amount, str(s.recurring_interval), num(s.recurring_interval_count) ?? 1),
    currency: currencyOf(s.currency),
    cancelAtPeriodEnd: s.cancel_at_period_end === true && status !== "ended",
    trialStartAt: s.trial_start ? timeOf(s.trial_start, at) : undefined,
    trialEndAt: s.trial_end ? timeOf(s.trial_end, at) : undefined,
    startedAt: s.started_at ? timeOf(s.started_at, at) : undefined,
    occurredAt: timeOf(s.modified_at, at),
    ...ref,
    email,
    hintRefs: str(s.checkout_id) ? [String(s.checkout_id)] : undefined,
  });
  return out;
}

export function normalizeCheckout(c: Obj, at: number): NormalizedBatch {
  const out = emptyBatch();
  if (c.status !== "succeeded" && c.status !== "confirmed") return out;
  const ref = visitorFromMetadata(c.metadata, c.customer_metadata);
  out.customers.push({
    customerId: str(c.customer_id),
    ...ref,
    email: str(c.customer_email),
    occurredAt: timeOf(c.modified_at ?? c.created_at, at),
    subscriptionId: str(c.subscription_id),
    hintRefs: [String(c.id)],
  });
  return out;
}

export function normalizePolarEvent(payload: Obj, now: number): NormalizedBatch {
  const type = String(payload.type ?? "");
  const data = asRecord(payload.data);
  if (!data) return emptyBatch();
  const at = timeOf(payload.timestamp, now);
  if (type.startsWith("order.")) return normalizeOrder(data, at);
  if (type === "subscription.revoked") return normalizeSubscription(data, at, true);
  if (type.startsWith("subscription.")) return normalizeSubscription(data, at);
  if (type.startsWith("checkout.")) return normalizeCheckout(data, at);
  return emptyBatch();
}

function merge(target: NormalizedBatch, b: NormalizedBatch) {
  target.payments.push(...b.payments);
  target.subscriptions.push(...b.subscriptions);
  target.customers.push(...b.customers);
}

interface PollCursor {
  orders: number;
  subscriptions: number;
}

export const polarAdapter: ProviderAdapter = {
  id: "polar",
  displayName: "Polar",
  pollEveryMinutes: 5,

  async validateCredentials(input, ctx) {
    const token = typeof input.polarAccessToken === "string" ? input.polarAccessToken.trim() : "";
    const orgId = typeof input.polarOrgId === "string" ? input.polarOrgId.trim() : "";
    if (!token) return { ok: false, error: "polarAccessToken is required" };
    if (!orgId) return { ok: false, error: "polarOrgId is required" };
    const sandbox = input.sandbox === true;
    if (sandbox && !ctx.allowTestKeys)
      return { ok: false, error: "Polar sandbox connections are disabled on this instance" };
    const settings = { sandbox, organizationId: orgId };
    try {
      const org = await getJson<Obj>(
        ctx,
        `${base({ settings })}/organizations/${encodeURIComponent(orgId)}`,
        headers(token),
      );
      await getJson<Page<Obj>>(
        ctx,
        `${base({ settings })}/orders/${query({ organization_id: orgId, limit: 1 })}`,
        headers(token),
      );
      return {
        ok: true,
        credentials: { accessToken: token },
        accountId: orgId,
        accountName: str(org.name) ?? str(org.slug) ?? null,
        currency: currencyOf(org.default_presentment_currency) ?? null,
        settings,
      };
    } catch (err) {
      if (err instanceof ProviderHttpError && (err.isAuth || err.isPermission))
        return { ok: false, error: "Polar rejected the access token or it cannot read orders" };
      if (err instanceof ProviderHttpError && err.isNotFound)
        return { ok: false, error: "Polar organization not found for this token" };
      return { ok: false, error: `Could not reach Polar: ${describeError(err)}` };
    }
  },

  async sync(conn, cursorRaw, ctx) {
    const token = conn.credentials.accessToken ?? "";
    const orgId = String(conn.settings.organizationId ?? conn.accountId ?? "");
    const cursor: PollCursor = cursorRaw
      ? (JSON.parse(cursorRaw) as PollCursor)
      : { orders: conn.createdAt, subscriptions: conn.createdAt };
    const batch = emptyBatch();
    const orders = await getJson<Page<Obj>>(
      ctx,
      `${base(conn)}/orders/${query({ organization_id: orgId, limit: PAGE, page: 1, sorting: "-created_at" })}`,
      headers(token),
    );
    let newestOrder = cursor.orders;
    for (const o of orders.items) {
      const t = Math.max(timeOf(o.created_at, 0), timeOf(o.modified_at, 0));
      if (t <= cursor.orders) continue;
      newestOrder = Math.max(newestOrder, t);
      merge(batch, normalizeOrder(o, ctx.now));
    }
    const subs = await getJson<Page<Obj>>(
      ctx,
      `${base(conn)}/subscriptions/${query({ organization_id: orgId, limit: PAGE, page: 1, sorting: "-started_at" })}`,
      headers(token),
    );
    let newestSub = cursor.subscriptions;
    for (const s of subs.items) {
      const t = Math.max(timeOf(s.modified_at, 0), timeOf(s.started_at, 0));
      if (t <= cursor.subscriptions) continue;
      newestSub = Math.max(newestSub, t);
      merge(batch, normalizeSubscription(s, ctx.now));
    }
    const next: PollCursor = { orders: newestOrder, subscriptions: newestSub };
    const changed = next.orders !== cursor.orders || next.subscriptions !== cursor.subscriptions;
    return {
      batch,
      cursor: changed || !cursorRaw ? JSON.stringify(next) : cursorRaw,
      more: false,
    };
  },

  async backfill(conn, page, ctx) {
    const token = conn.credentials.accessToken ?? "";
    const orgId = String(conn.settings.organizationId ?? conn.accountId ?? "");
    const cur = page
      ? (JSON.parse(page) as { stream: "orders" | "subscriptions"; page: number })
      : { stream: "orders" as const, page: 1 };
    const res = await getJson<Page<Obj>>(
      ctx,
      `${base(conn)}/${cur.stream}/${query({ organization_id: orgId, limit: PAGE, page: cur.page })}`,
      headers(token),
    );
    const batch = emptyBatch();
    for (const item of res.items) {
      merge(
        batch,
        cur.stream === "orders"
          ? normalizeOrder(item, ctx.now)
          : normalizeSubscription(item, ctx.now),
      );
    }
    const maxPage = res.pagination?.max_page ?? (res.items.length < PAGE ? cur.page : cur.page + 1);
    let next: string | null = null;
    if (cur.page < maxPage && res.items.length)
      next = JSON.stringify({ ...cur, page: cur.page + 1 });
    else if (cur.stream === "orders") next = JSON.stringify({ stream: "subscriptions", page: 1 });
    return { batch, next };
  },

  async verifyWebhook(rawBody, hdrs, secret, now) {
    const ok = await verifyStandardWebhook(rawBody, hdrs, secret, now);
    if (!ok) return null;
    return { eventId: ok.id, payload: JSON.parse(rawBody), headers: {} };
  },

  normalizeWebhook(webhook) {
    return normalizePolarEvent(webhook.payload as Obj, Date.now());
  },

  async resolveHint(conn: Connection, ref: string, ctx: AdapterContext) {
    const token = conn.credentials.accessToken ?? "";
    let checkout: Obj;
    try {
      checkout = await getJson<Obj>(
        ctx,
        `${base(conn)}/checkouts/${encodeURIComponent(ref)}`,
        headers(token),
      );
    } catch (err) {
      if (err instanceof ProviderHttpError && err.isNotFound) return emptyBatch();
      throw err;
    }
    if (checkout.status !== "succeeded" && checkout.status !== "confirmed") return null;
    const orders = await getJson<Page<Obj>>(
      ctx,
      `${base(conn)}/orders/${query({ checkout_id: ref, limit: 5 })}`,
      headers(token),
    );
    const batch = normalizeCheckout(checkout, ctx.now);
    for (const o of orders.items) {
      if (str(o.checkout_id) && o.checkout_id !== ref) continue;
      merge(batch, normalizeOrder({ ...o, checkout_id: ref }, ctx.now));
    }
    return batch.payments.length ? batch : null;
  },

  async setupWebhook(conn, url, ctx) {
    try {
      const res = await requestJson<Obj>(ctx, `${base(conn)}/webhooks/endpoints`, {
        method: "POST",
        headers: {
          ...headers(conn.credentials.accessToken ?? ""),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          url,
          format: "raw",
          events: POLAR_EVENTS,
          organization_id: conn.settings.organizationId ?? conn.accountId,
        }),
      });
      const secret = str(res.data.secret);
      return secret ? { secret, webhookId: str(res.data.id) ?? null } : null;
    } catch {
      return null;
    }
  },

  async removeWebhook(conn, ctx) {
    const id = str(conn.settings.webhookId);
    if (!id) return;
    await requestJson(ctx, `${base(conn)}/webhooks/endpoints/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: headers(conn.credentials.accessToken ?? ""),
    }).catch(() => undefined);
  },
};
