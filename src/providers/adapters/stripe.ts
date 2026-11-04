/**
 * Stripe (plan §10.3).
 *
 * - Connect with a **restricted, read-only** key (`rk_live_…`; `rk_test_…` only when
 *   ALLOW_TEST_PAYMENT_KEYS is "true"). `pk_` and `sk_` keys are rejected. Validation reads one
 *   object from each resource the integration needs (Events, Checkout Sessions, Charges,
 *   Invoices, Subscriptions) and reports the missing read permissions by name.
 * - Primary path: the minute cron polls the **Events API** from a cursor (`ending_before` the
 *   newest processed event id), at most `MAX_EVENT_PAGES` pages per tick. Needs no webhook.
 * - Optional webhooks: the operator adds `/webhooks/stripe/<websiteId>` in Stripe and pastes the
 *   signing secret; `Stripe-Signature` is verified with Web Crypto (300 s tolerance).
 * - Backfill on connect, one page (50 objects) per call, across these streams in order:
 *   checkout sessions → subscriptions → invoices → payment intents → refunds → disputes.
 * - Payment Links: the success URL carries `?session_id={CHECKOUT_SESSION_ID}`; the tracker
 *   reports it as a hint and `resolveHint` reads the session.
 *
 * Canonical transaction ids keep every path idempotent: a one-off checkout or PaymentIntent is
 * stored under its PaymentIntent id (`pi_`), a subscription charge under its invoice id (`in_`),
 * a refund under `re_` (or `<charge>:refund` with the cumulative amount), a dispute under `dp_`.
 *
 * Objects arrive in whatever API version the account used when an event was created, so the
 * normaliser reads both the 2024 shapes (`invoice.subscription`, `invoice.payment_intent`,
 * `payment_intent.invoice`) and the 2025 "basil" shapes (`invoice.parent.subscription_details`).
 */
import {
  asRecord,
  cleanId,
  currencyOf,
  num,
  str,
  timeOf,
  visitorFromMetadata,
} from "../attribution";
import { describeError, getJson, ProviderHttpError, query } from "../http";
import { monthlyAmount } from "../lifecycle";
import { verifyStripeSignature } from "../signatures";
import {
  type AdapterContext,
  type BackfillResult,
  type Connection,
  type CustomerLink,
  emptyBatch,
  type NormalizedBatch,
  type NormalizedSubscription,
  type ProviderAdapter,
  type SubscriptionStatus,
  type ValidationResult,
} from "../types";

export const STRIPE_API = "https://api.stripe.com/v1";
/** Pinned for objects we fetch; events keep the version they were created with. */
export const STRIPE_VERSION = "2024-06-20";
const PAGE = 50;
/**
 * Events per page and pages per cron run. At most 100 events are parsed and ingested per run to
 * bound CPU (the Free plan allows 10 ms per cron invocation); a backlog drains on later runs.
 */
export const EVENTS_PER_PAGE = 50;
export const MAX_EVENT_PAGES = 2;

export const STRIPE_EVENT_TYPES = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "payment_intent.succeeded",
  "invoice.paid",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
] as const;

const BACKFILL_STREAMS = [
  "checkout_sessions",
  "subscriptions",
  "invoices",
  "payment_intents",
  "refunds",
  "disputes",
] as const;
type Stream = (typeof BACKFILL_STREAMS)[number];

const STREAM_PATH: Record<Stream, string> = {
  checkout_sessions: "/checkout/sessions",
  subscriptions: "/subscriptions",
  invoices: "/invoices",
  payment_intents: "/payment_intents",
  refunds: "/refunds",
  disputes: "/disputes",
};

const STREAM_QUERY: Record<Stream, Record<string, string>> = {
  checkout_sessions: { status: "complete" },
  subscriptions: { status: "all" },
  invoices: { status: "paid" },
  payment_intents: {},
  refunds: {},
  disputes: {},
};

/** Read permissions validated at connect, with the resource used to test each. */
const REQUIRED: Array<{ name: string; path: string }> = [
  { name: "Events", path: "/events?limit=1" },
  { name: "Checkout Sessions", path: "/checkout/sessions?limit=1" },
  { name: "Charges", path: "/charges?limit=1" },
  { name: "Invoices", path: "/invoices?limit=1" },
  { name: "Subscriptions", path: "/subscriptions?limit=1" },
];

function headers(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}`, "stripe-version": STRIPE_VERSION };
}

interface StripeList<T> {
  object: "list";
  data: T[];
  has_more: boolean;
}

type Obj = Record<string, unknown>;

function idOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return str(asRecord(value)?.id);
}

function customerEmail(o: Obj): string | undefined {
  return (
    str(asRecord(o.customer_details)?.email) ??
    str(o.customer_email) ??
    str(o.receipt_email) ??
    str(asRecord(o.billing_details)?.email) ??
    str(asRecord(o.customer)?.email)
  );
}

function upper(c: unknown): string {
  return currencyOf(c) ?? "USD";
}

/** Visitor id from metadata, or from `client_reference_id` when it looks like one. */
function visitorOf(o: Obj, ...more: unknown[]) {
  const ref = visitorFromMetadata(o.metadata, ...more);
  if (!ref.visitorId) {
    const cri = cleanId(o.client_reference_id);
    if (cri && /^[0-9a-f-]{36}$/i.test(cri)) ref.visitorId = cri;
  }
  return ref;
}

function invoiceSubscription(inv: Obj): string | undefined {
  return (
    idOf(inv.subscription) ??
    idOf(asRecord(asRecord(inv.parent)?.subscription_details)?.subscription)
  );
}

function invoiceMetadata(inv: Obj): unknown[] {
  return [
    inv.metadata,
    asRecord(inv.subscription_details)?.metadata,
    asRecord(asRecord(inv.parent)?.subscription_details)?.metadata,
  ];
}

export function normalizeCheckoutSession(s: Obj, at: number): NormalizedBatch {
  const out = emptyBatch();
  if (s.status !== undefined && s.status !== "complete") return out;
  const ref = visitorOf(s);
  const customerId = idOf(s.customer);
  const email = customerEmail(s);
  const name = str(asRecord(s.customer_details)?.name);
  const occurredAt = timeOf(s.created, at);
  const sessionId = String(s.id);
  const amount = num(s.amount_total) ?? 0;
  const currency = upper(s.currency);
  const subscriptionId = idOf(s.subscription);
  const invoiceId = idOf(s.invoice);
  const piId = idOf(s.payment_intent);

  if (s.mode === "subscription") {
    const link: CustomerLink = {
      customerId,
      visitorId: ref.visitorId,
      sessionId: ref.sessionId,
      email,
      occurredAt,
      subscriptionId,
      attachTxnIds: [invoiceId, subscriptionId ? `${subscriptionId}:trial` : undefined].filter(
        (x): x is string => !!x,
      ),
      hintRefs: [sessionId],
    };
    out.customers.push(link);
    if (invoiceId && amount > 0 && s.payment_status === "paid") {
      out.payments.push({
        providerTxnId: invoiceId,
        providerCustomerId: customerId,
        kind: "payment",
        amountMinor: amount,
        currency,
        occurredAt,
        ...ref,
        email,
        name,
        subscriptionId,
        hintRefs: [sessionId],
      });
    }
    return out;
  }
  if (s.mode === "payment" || s.mode === undefined) {
    if (s.payment_status !== "paid") return out;
    out.payments.push({
      providerTxnId: piId ?? sessionId,
      providerCustomerId: customerId,
      kind: "payment",
      amountMinor: amount,
      currency,
      occurredAt,
      ...ref,
      email,
      name,
      hintRefs: [sessionId],
    });
  }
  return out;
}

export function normalizePaymentIntent(pi: Obj, at: number): NormalizedBatch {
  const out = emptyBatch();
  if (pi.status !== undefined && pi.status !== "succeeded") return out;
  const ref = visitorOf(pi);
  // Invoice PaymentIntents are recorded from invoice.paid. Older API versions say so with
  // `invoice`; newer ones dropped the field, so only metadata-carrying PIs are taken there.
  if ("invoice" in pi ? pi.invoice !== null : !ref.visitorId) return out;
  out.payments.push({
    providerTxnId: String(pi.id),
    providerCustomerId: idOf(pi.customer),
    kind: "payment",
    amountMinor: num(pi.amount_received) ?? num(pi.amount) ?? 0,
    currency: upper(pi.currency),
    occurredAt: timeOf(pi.created, at),
    ...ref,
    email: str(pi.receipt_email),
  });
  return out;
}

export function normalizeInvoice(inv: Obj, at: number): NormalizedBatch {
  const out = emptyBatch();
  const amount = num(inv.amount_paid) ?? 0;
  if (inv.status !== undefined && inv.status !== "paid") return out;
  if (amount <= 0) return out;
  const reason = str(inv.billing_reason);
  const kind =
    reason === "subscription_cycle" || reason === "subscription_update" ? "renewal" : "payment";
  const ref = visitorFromMetadata(...invoiceMetadata(inv));
  out.payments.push({
    providerTxnId: String(inv.id),
    providerCustomerId: idOf(inv.customer),
    kind,
    amountMinor: amount,
    currency: upper(inv.currency),
    occurredAt: timeOf(asRecord(inv.status_transitions)?.paid_at ?? inv.created, at),
    ...ref,
    email: str(inv.customer_email),
    name: str(inv.customer_name),
    subscriptionId: invoiceSubscription(inv),
    hintRefs: [idOf(inv.payment_intent)].filter((x): x is string => !!x),
  });
  return out;
}

function refundOfCharge(charge: Obj): string[] {
  return [idOf(charge.invoice), idOf(charge.payment_intent), str(charge.id)].filter(
    (x): x is string => !!x,
  );
}

export function normalizeChargeRefund(
  charge: Obj,
  at: number,
  previous?: Obj | null,
): NormalizedBatch {
  const out = emptyBatch();
  const currency = upper(charge.currency);
  const refundOf = refundOfCharge(charge);
  const customerId = idOf(charge.customer);
  const refunds = asRecord(charge.refunds)?.data;
  if (Array.isArray(refunds) && refunds.length) {
    for (const r of refunds) {
      const rr = asRecord(r);
      if (!rr || (rr.status && rr.status !== "succeeded" && rr.status !== "pending")) continue;
      out.payments.push({
        providerTxnId: String(rr.id),
        providerCustomerId: customerId,
        kind: "refund",
        amountMinor: -(num(rr.amount) ?? 0),
        currency: upper(rr.currency ?? charge.currency),
        occurredAt: timeOf(rr.created, at),
        refundOf,
      });
    }
    return out;
  }
  const refunded = num(charge.amount_refunded) ?? 0;
  if (refunded <= 0) return out;
  void previous;
  out.payments.push({
    providerTxnId: `${String(charge.id)}:refund`,
    providerCustomerId: customerId,
    kind: "refund",
    amountMinor: -refunded,
    currency,
    occurredAt: at,
    refundOf,
    updateAmount: true,
  });
  return out;
}

export function normalizeRefund(r: Obj, at: number): NormalizedBatch {
  const out = emptyBatch();
  if (r.status && r.status !== "succeeded" && r.status !== "pending") return out;
  out.payments.push({
    providerTxnId: String(r.id),
    kind: "refund",
    amountMinor: -(num(r.amount) ?? 0),
    currency: upper(r.currency),
    occurredAt: timeOf(r.created, at),
    refundOf: [idOf(r.payment_intent), idOf(r.charge)].filter((x): x is string => !!x),
  });
  return out;
}

export function normalizeDispute(d: Obj, at: number, closed: boolean): NormalizedBatch {
  const out = emptyBatch();
  const amount = num(d.amount) ?? 0;
  const refundOf = [idOf(d.payment_intent), idOf(d.charge)].filter((x): x is string => !!x);
  const base = {
    kind: "refund" as const,
    currency: upper(d.currency),
    refundOf,
  };
  out.payments.push({
    ...base,
    providerTxnId: String(d.id),
    amountMinor: -amount,
    occurredAt: timeOf(d.created, at),
    reason: "dispute",
  });
  if (closed && d.status === "won") {
    out.payments.push({
      ...base,
      providerTxnId: `${String(d.id)}:won`,
      amountMinor: amount,
      occurredAt: at,
      reason: "dispute_won",
    });
  }
  return out;
}

const STATUS: Record<string, SubscriptionStatus> = {
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  unpaid: "past_due",
  paused: "paused",
  incomplete: "incomplete",
  incomplete_expired: "ended",
  canceled: "ended",
};

export function subscriptionMrr(sub: Obj): number | undefined {
  const items = asRecord(sub.items)?.data;
  if (!Array.isArray(items)) return undefined;
  let total = 0;
  for (const item of items) {
    const it = asRecord(item);
    const price = asRecord(it?.price) ?? asRecord(it?.plan);
    if (!price) continue;
    const unit = num(price.unit_amount) ?? num(price.amount) ?? 0;
    const recurring = asRecord(price.recurring);
    const interval = str(recurring?.interval) ?? str(price.interval);
    const count = num(recurring?.interval_count) ?? num(price.interval_count) ?? 1;
    total += monthlyAmount(unit * (num(it?.quantity) ?? 1), interval, count);
  }
  return total;
}

export function normalizeSubscription(sub: Obj, at: number): NormalizedBatch {
  const out = emptyBatch();
  const status = STATUS[String(sub.status)] ?? "incomplete";
  const ref = visitorFromMetadata(sub.metadata);
  const snapshot: NormalizedSubscription = {
    id: String(sub.id),
    customerId: idOf(sub.customer),
    status,
    mrrMinor: subscriptionMrr(sub),
    currency: currencyOf(sub.currency),
    cancelAtPeriodEnd: sub.cancel_at_period_end === true || (!!sub.cancel_at && status !== "ended"),
    trialStartAt: sub.trial_start ? timeOf(sub.trial_start, at) : undefined,
    trialEndAt: sub.trial_end ? timeOf(sub.trial_end, at) : undefined,
    startedAt: timeOf(sub.start_date ?? sub.created, at),
    occurredAt: at,
    ...ref,
  };
  out.subscriptions.push(snapshot);
  return out;
}

/** One Stripe event → normalized batch. */
export function normalizeEvent(event: Obj): NormalizedBatch {
  const type = String(event.type ?? "");
  const data = asRecord(event.data);
  const obj = asRecord(data?.object);
  if (!obj) return emptyBatch();
  const at = timeOf(event.created, Date.now());
  const withEvent = (b: NormalizedBatch) => {
    for (const p of b.payments) p.eventId = String(event.id ?? "");
    return b;
  };
  switch (type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      return withEvent(normalizeCheckoutSession(obj, at));
    case "payment_intent.succeeded":
      return withEvent(normalizePaymentIntent(obj, at));
    case "invoice.paid":
    case "invoice.payment_succeeded":
      return withEvent(normalizeInvoice(obj, at));
    case "charge.refunded":
      return withEvent(normalizeChargeRefund(obj, at, asRecord(data?.previous_attributes)));
    case "refund.created":
    case "refund.updated":
      return withEvent(normalizeRefund(obj, at));
    case "charge.dispute.created":
      return withEvent(normalizeDispute(obj, at, false));
    case "charge.dispute.closed":
      return withEvent(normalizeDispute(obj, at, true));
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed": {
      const b = normalizeSubscription(obj, at);
      if (type === "customer.subscription.deleted")
        for (const s of b.subscriptions) s.status = "ended";
      return b;
    }
    default:
      return emptyBatch();
  }
}

function mergeInto(target: NormalizedBatch, b: NormalizedBatch): void {
  target.payments.push(...b.payments);
  target.subscriptions.push(...b.subscriptions);
  target.customers.push(...b.customers);
}

function normalizeObject(stream: Stream, o: Obj, now: number): NormalizedBatch {
  switch (stream) {
    case "checkout_sessions":
      return normalizeCheckoutSession(o, now);
    case "subscriptions":
      return normalizeSubscription(o, timeOf(o.created, now));
    case "invoices":
      return normalizeInvoice(o, now);
    case "payment_intents":
      return normalizePaymentIntent(o, now);
    case "refunds":
      return normalizeRefund(o, now);
    case "disputes":
      return normalizeDispute(o, now, o.status === "won");
  }
}

interface EventsCursor {
  id: string | null;
}

function parseCursor(raw: string | null): EventsCursor {
  if (!raw) return { id: null };
  try {
    const c = JSON.parse(raw) as EventsCursor;
    return { id: typeof c.id === "string" ? c.id : null };
  } catch {
    return { id: raw };
  }
}

interface BackfillCursor {
  stream: Stream;
  after: string | null;
}

export const stripeAdapter: ProviderAdapter = {
  id: "stripe",
  displayName: "Stripe",

  async validateCredentials(input, ctx): Promise<ValidationResult> {
    const key = typeof input.stripeRak === "string" ? input.stripeRak.trim() : "";
    if (!key) return { ok: false, error: "stripeRak is required" };
    if (key.startsWith("pk_"))
      return {
        ok: false,
        error: "Publishable keys (pk_) are not accepted. Use a restricted key (rk_).",
      };
    if (key.startsWith("sk_"))
      return {
        ok: false,
        error: "Secret keys (sk_) are not accepted. Use a read-only restricted key (rk_).",
      };
    if (!/^rk_(live|test)_[A-Za-z0-9]{10,}$/.test(key))
      return {
        ok: false,
        error: "Invalid key format: the Stripe restricted key must start with rk_",
      };
    if (key.startsWith("rk_test_") && !ctx.allowTestKeys)
      return {
        ok: false,
        error: "Test keys (rk_test_) are not accepted. Use a live restricted key.",
      };
    const missing: string[] = [];
    let newestEvent: string | null = null;
    for (const r of REQUIRED) {
      try {
        const list = await getJson<StripeList<Obj>>(ctx, `${STRIPE_API}${r.path}`, headers(key));
        if (r.name === "Events") newestEvent = str(list.data[0]?.id) ?? null;
      } catch (err) {
        if (err instanceof ProviderHttpError && err.isAuth)
          return { ok: false, error: "Stripe rejected the key (invalid, expired or revoked)" };
        if (err instanceof ProviderHttpError && err.isPermission) missing.push(r.name);
        else return { ok: false, error: `Could not reach Stripe: ${describeError(err)}` };
      }
    }
    if (missing.length) {
      return {
        ok: false,
        error: `The restricted key is missing read access to: ${missing.join(", ")}`,
      };
    }
    let currency: string | null = null;
    let accountId: string | null = null;
    let accountName: string | null = null;
    try {
      const account = await getJson<Obj>(ctx, `${STRIPE_API}/account`, headers(key));
      currency = currencyOf(account.default_currency) ?? null;
      accountId = str(account.id) ?? null;
      accountName =
        str(asRecord(asRecord(account.settings)?.dashboard)?.display_name) ??
        str(asRecord(account.business_profile)?.name) ??
        null;
    } catch {
      // Account read is optional for restricted keys.
    }
    return {
      ok: true,
      credentials: { apiKey: key },
      currency,
      accountId,
      accountName,
      settings: { livemode: key.startsWith("rk_live_") },
      syncCursor: newestEvent ? JSON.stringify({ id: newestEvent }) : null,
    };
  },

  async sync(conn, cursorRaw, ctx) {
    const key = conn.credentials.apiKey ?? "";
    const cursor = parseCursor(cursorRaw);
    const batch = emptyBatch();
    let newest = cursor.id;
    let more = false;
    for (let page = 0; page < MAX_EVENT_PAGES; page++) {
      const params: Record<string, string | number | string[] | undefined> = {
        limit: EVENTS_PER_PAGE,
        "types[]": [...STRIPE_EVENT_TYPES],
        ending_before: newest ?? undefined,
      };
      let list: StripeList<Obj>;
      try {
        list = await getJson<StripeList<Obj>>(
          ctx,
          `${STRIPE_API}/events${query(params)}`,
          headers(key),
        );
      } catch (err) {
        if (
          err instanceof ProviderHttpError &&
          (err.status === 400 || err.status === 404) &&
          newest
        ) {
          // The cursor event aged out of Stripe's 30-day window (the install was offline): restart
          // from the newest event and re-run the backfill to fill the gap idempotently.
          const head = await getJson<StripeList<Obj>>(
            ctx,
            `${STRIPE_API}/events?limit=1`,
            headers(key),
          );
          return {
            batch,
            cursor: JSON.stringify({ id: str(head.data[0]?.id) ?? null }),
            more: false,
            restartBackfill: true,
          };
        }
        throw err;
      }
      if (!list.data.length) break;
      // Stripe lists newest first; process oldest first.
      for (const event of [...list.data].reverse()) mergeInto(batch, normalizeEvent(event));
      newest = str(list.data[0]?.id) ?? newest;
      more = list.has_more;
      if (!newest || !list.has_more || !cursor.id) {
        // Without a cursor the first page is the newest events; stop there.
        if (!cursor.id) more = false;
        break;
      }
    }
    const next = newest === cursor.id ? cursorRaw : JSON.stringify({ id: newest });
    return { batch, cursor: next, more };
  },

  async backfill(conn, page, ctx): Promise<BackfillResult> {
    const key = conn.credentials.apiKey ?? "";
    let cur: BackfillCursor = { stream: BACKFILL_STREAMS[0], after: null };
    if (page) {
      try {
        cur = JSON.parse(page) as BackfillCursor;
      } catch {
        // restart
      }
    }
    const params = {
      limit: PAGE,
      starting_after: cur.after ?? undefined,
      ...STREAM_QUERY[cur.stream],
    };
    const nextStream = (): string | null => {
      const i = BACKFILL_STREAMS.indexOf(cur.stream);
      const following = BACKFILL_STREAMS[i + 1];
      return following ? JSON.stringify({ stream: following, after: null }) : null;
    };
    let list: StripeList<Obj>;
    try {
      list = await getJson<StripeList<Obj>>(
        ctx,
        `${STRIPE_API}${STREAM_PATH[cur.stream]}${query(params)}`,
        headers(key),
      );
    } catch (err) {
      if (err instanceof ProviderHttpError && err.isPermission) {
        return {
          batch: emptyBatch(),
          next: nextStream(),
          warning: `Backfill skipped ${cur.stream.replace("_", " ")}: the key cannot read them`,
        };
      }
      throw err;
    }
    const batch = emptyBatch();
    for (const o of list.data) mergeInto(batch, normalizeObject(cur.stream, o, ctx.now));
    const last = str(list.data[list.data.length - 1]?.id);
    const next =
      list.has_more && last ? JSON.stringify({ stream: cur.stream, after: last }) : nextStream();
    return { batch, next };
  },

  async verifyWebhook(rawBody, hdrs, secret, now) {
    if (!(await verifyStripeSignature(rawBody, hdrs.get("stripe-signature"), secret, now)))
      return null;
    const payload = JSON.parse(rawBody) as Obj;
    return { eventId: String(payload.id ?? ""), payload, headers: {} };
  },

  normalizeWebhook(webhook) {
    return normalizeEvent(webhook.payload as Obj);
  },

  async resolveHint(conn: Connection, ref: string, ctx: AdapterContext) {
    if (!ref.startsWith("cs_")) return emptyBatch();
    try {
      const session = await getJson<Obj>(
        ctx,
        `${STRIPE_API}/checkout/sessions/${encodeURIComponent(ref)}`,
        headers(conn.credentials.apiKey ?? ""),
      );
      if (session.status !== "complete") return null;
      const b = normalizeCheckoutSession(session, ctx.now);
      return b.payments.length || b.customers.length ? b : null;
    } catch (err) {
      if (err instanceof ProviderHttpError && err.isNotFound) return emptyBatch();
      throw err;
    }
  },
};
