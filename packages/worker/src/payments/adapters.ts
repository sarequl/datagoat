import type { JsonObject } from './json';
import { arr, getNum, getObj, getStr, getTime, str, toUnixSeconds } from './json';
import type { PaymentEvent, PaymentKind, PaymentStatus, Provider } from './types';

function emailOf(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    const value = str(candidate);
    if (value) return value.toLowerCase();
  }
  return null;
}

function currencyOf(...candidates: Array<string | null | undefined>): string {
  return str(candidates.find((candidate) => candidate))?.toLowerCase() ?? 'usd';
}

/**
 * Explicit checkout handoff (§6.2): `datagoat_visitor_id` first, then the
 * DataFast migration alias, then Stripe's `client_reference_id` which the
 * script sets to the visitor id.
 */
function visitorFrom(metadata: JsonObject | null, clientReferenceId: string | null): string | null {
  if (metadata) {
    const direct = str(metadata.datagoat_visitor_id) ?? str(metadata.datafast_visitor_id);
    if (direct) return direct;
  }
  return clientReferenceId;
}

/** Creem's `request_id` is `dgf_<visitor_id>` (§6.2). */
function visitorFromRequestId(requestId: string | null): string | null {
  const value = str(requestId);
  if (!value) return null;
  return value.startsWith('dgf_') ? value.slice(4) : value;
}

function makeEvent(
  provider: Provider,
  eventId: string,
  paymentId: string,
  occurredAt: number,
  raw: JsonObject,
  role: PaymentEvent['role'],
  status: PaymentStatus | null,
  kind: PaymentKind | null,
  fields: Partial<PaymentEvent> = {},
): PaymentEvent {
  return {
    provider,
    provider_event_id: eventId,
    provider_payment_id: paymentId,
    provider_customer_id: null,
    provider_subscription_id: null,
    provider_subscription_ids: null,
    email: null,
    visitor_id: null,
    session_id: null,
    gross_minor: 0,
    tax_minor: 0,
    discount_minor: 0,
    amount_minor: 0,
    currency: 'usd',
    refunded_minor: 0,
    status,
    kind,
    product_id: null,
    product_name: null,
    plan_id: null,
    occurred_at: occurredAt,
    role,
    raw,
    ...fields,
  };
}

function metadataOf(source: JsonObject | null): JsonObject | null {
  return getObj(source, 'metadata');
}

// ---------------------------------------------------------------------------
// Stripe (§7.4)
// ---------------------------------------------------------------------------

export function adaptStripe(eventType: string, payload: JsonObject): PaymentEvent | null {
  const object = getObj(payload, 'data', 'object');
  const eventId = str(payload.id) ?? `stripe:${eventType}`;
  const occurredAt = toUnixSeconds(payload.created) ?? Math.floor(Date.now() / 1000);
  const metadata = metadataOf(object);

  switch (eventType) {
    case 'checkout.session.completed': {
      // `payment_status = 'paid'` is the revenue signal, not `status = 'complete'`.
      if (getStr(object, 'payment_status') !== 'paid') return null;
      const mode = getStr(object, 'mode') ?? 'payment';
      return makeEvent(
        'stripe',
        eventId,
        getStr(object, 'id') ?? eventId,
        occurredAt,
        payload,
        'payment',
        'paid',
        mode === 'subscription' ? 'subscription_initial' : 'one_time',
        {
          provider_customer_id: getStr(object, 'customer'),
          provider_subscription_id: getStr(object, 'subscription'),
          email: emailOf(
            getStr(object, 'customer_details', 'email'),
            getStr(object, 'customer_email'),
          ),
          visitor_id: visitorFrom(metadata, getStr(object, 'client_reference_id')),
          session_id: getStr(metadata, 'session_id'),
          gross_minor: getNum(object, 'amount_total') ?? 0,
          tax_minor: getNum(object, 'total_details', 'amount_tax') ?? 0,
          discount_minor: getNum(object, 'total_details', 'amount_discount') ?? 0,
          amount_minor: getNum(object, 'amount_total') ?? 0,
          currency: currencyOf(getStr(object, 'currency')),
          product_id: getStr(metadata, 'product_id'),
        },
      );
    }

    case 'invoice.paid': {
      const billingReason = getStr(object, 'billing_reason');
      const kind: PaymentKind =
        billingReason === 'subscription_create' ? 'subscription_initial' : 'subscription_renewal';
      return makeEvent(
        'stripe',
        eventId,
        getStr(object, 'id') ?? eventId,
        occurredAt,
        payload,
        'payment',
        'paid',
        kind,
        {
          provider_customer_id: getStr(object, 'customer'),
          provider_subscription_id: getStr(object, 'subscription'),
          email: emailOf(getStr(object, 'customer_email')),
          visitor_id: visitorFrom(metadata, null),
          session_id: getStr(metadata, 'session_id'),
          gross_minor: getNum(object, 'amount_paid') ?? 0,
          tax_minor: 0,
          discount_minor: 0,
          amount_minor: getNum(object, 'amount_paid') ?? 0,
          currency: currencyOf(getStr(object, 'currency')),
        },
      );
    }

    case 'payment_intent.succeeded': {
      return makeEvent(
        'stripe',
        eventId,
        getStr(object, 'id') ?? eventId,
        occurredAt,
        payload,
        'payment',
        'paid',
        'one_time',
        {
          provider_customer_id: getStr(object, 'customer'),
          email: null,
          visitor_id: visitorFrom(metadata, null),
          session_id: getStr(metadata, 'session_id'),
          gross_minor: getNum(object, 'amount') ?? 0,
          amount_minor: getNum(object, 'amount') ?? 0,
          currency: currencyOf(getStr(object, 'currency')),
        },
      );
    }

    case 'charge.refunded': {
      const original =
        getStr(object, 'payment_intent') ?? getStr(object, 'invoice') ?? getStr(object, 'charge');
      if (!original) return null;
      return makeEvent(
        'stripe',
        eventId,
        original,
        occurredAt,
        payload,
        'refund',
        'refunded',
        null,
        {
          amount_minor: getNum(object, 'amount_refunded') ?? 0,
          currency: currencyOf(getStr(object, 'currency')),
        },
      );
    }

    default: {
      if (eventType.startsWith('charge.dispute.')) {
        const original = getStr(object, 'payment_intent') ?? getStr(object, 'charge');
        if (!original) return null;
        return makeEvent(
          'stripe',
          eventId,
          original,
          occurredAt,
          payload,
          'dispute',
          'disputed',
          null,
          {
            amount_minor: getNum(object, 'amount') ?? 0,
            currency: currencyOf(getStr(object, 'currency')),
          },
        );
      }
      if (eventType === 'customer.created' || eventType === 'customer.updated') {
        return makeEvent(
          'stripe',
          eventId,
          `customer:${getStr(object, 'id') ?? eventId}`,
          occurredAt,
          payload,
          'customer',
          null,
          null,
          {
            provider_customer_id: getStr(object, 'id'),
            email: emailOf(getStr(object, 'email')),
          },
        );
      }
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Polar (§7.5)
// ---------------------------------------------------------------------------

export function adaptPolar(eventType: string, payload: JsonObject): PaymentEvent | null {
  const data = getObj(payload, 'data');
  if (!data) return null;
  const eventId = str(payload.id) ?? `polar:${eventType}:${str(data.id) ?? ''}`;
  const metadata = metadataOf(data);
  const occurredAt =
    toUnixSeconds(data.created_at) ??
    toUnixSeconds(payload.timestamp) ??
    Math.floor(Date.now() / 1000);

  switch (eventType) {
    case 'order.created':
    case 'order.paid': {
      const billingReason = getStr(data, 'billing_reason');
      const kind: PaymentKind =
        eventType === 'order.created'
          ? billingReason === 'subscription_create'
            ? 'subscription_initial'
            : 'one_time'
          : getStr(data, 'subscription_id')
            ? 'subscription_renewal'
            : 'one_time';
      return makeEvent(
        'polar',
        eventId,
        str(data.id) ?? eventId,
        occurredAt,
        payload,
        'payment',
        'paid',
        kind,
        {
          provider_customer_id: getStr(data, 'customer_id'),
          provider_subscription_id: getStr(data, 'subscription_id'),
          email: emailOf(getStr(data, 'customer', 'email')),
          visitor_id: visitorFrom(metadata, null),
          session_id: getStr(metadata, 'session_id'),
          gross_minor: getNum(data, 'amount') ?? getNum(data, 'net_amount') ?? 0,
          amount_minor: getNum(data, 'net_amount') ?? getNum(data, 'amount') ?? 0,
          currency: currencyOf(getStr(data, 'currency')),
          product_id: getStr(data, 'product_id'),
          product_name: getStr(data, 'product', 'name'),
        },
      );
    }

    default:
      // subscription.created / updated / revoked / canceled and order lifecycle
      // events carry no revenue (§7.5 "lifecycle only").
      return null;
  }
}

// ---------------------------------------------------------------------------
// Dodo Payments (§7.6)
// ---------------------------------------------------------------------------

export function adaptDodo(eventType: string, payload: JsonObject): PaymentEvent | null {
  const data = getObj(payload, 'data');
  if (!data) return null;
  const eventId = str(payload.id) ?? `dodo:${eventType}:${str(data.payment_id) ?? ''}`;
  const metadata = metadataOf(data);
  const occurredAt =
    toUnixSeconds(data.created_at) ??
    toUnixSeconds(payload.timestamp) ??
    Math.floor(Date.now() / 1000);

  switch (eventType) {
    case 'payment.succeeded': {
      const subscriptionIds = arr(data.subscription_ids)
        .map((value) => str(value))
        .filter((value): value is string => value !== null);
      const single = getStr(data, 'subscription_id');
      return makeEvent(
        'dodo',
        eventId,
        str(data.payment_id) ?? eventId,
        occurredAt,
        payload,
        'payment',
        'paid',
        single ? 'subscription_initial' : 'one_time',
        {
          provider_customer_id: getStr(data, 'customer_id'),
          provider_subscription_id: single,
          provider_subscription_ids: subscriptionIds.length > 0 ? subscriptionIds : null,
          email: emailOf(getStr(data, 'customer', 'email')),
          visitor_id: visitorFrom(metadata, null),
          session_id: getStr(metadata, 'session_id'),
          gross_minor: getNum(data, 'amount') ?? 0,
          amount_minor: getNum(data, 'amount') ?? 0,
          currency: currencyOf(getStr(data, 'currency')),
        },
      );
    }

    case 'subscription.renewed':
      return makeEvent(
        'dodo',
        eventId,
        str(data.payment_id) ?? eventId,
        occurredAt,
        payload,
        'payment',
        'paid',
        'subscription_renewal',
        {
          provider_customer_id: getStr(data, 'customer_id'),
          provider_subscription_id: getStr(data, 'subscription_id'),
          amount_minor: getNum(data, 'amount') ?? 0,
          currency: currencyOf(getStr(data, 'currency')),
        },
      );

    case 'refund.succeeded':
      return makeEvent(
        'dodo',
        eventId,
        str(data.payment_id) ?? eventId,
        occurredAt,
        payload,
        'refund',
        'refunded',
        null,
        {
          amount_minor: getNum(data, 'amount') ?? 0,
          currency: currencyOf(getStr(data, 'currency')),
        },
      );

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Creem (§7.7)
// ---------------------------------------------------------------------------

export function adaptCreem(eventType: string, payload: JsonObject): PaymentEvent | null {
  const object = getObj(payload, 'object');
  if (!object) return null;
  const eventId = str(payload.id) ?? `creem:${eventType}`;
  const metadata = metadataOf(object);
  const checkoutMetadata = getObj(object, 'checkout', 'metadata');
  const occurredAt = toUnixSeconds(payload.created_at) ?? Math.floor(Date.now() / 1000);

  switch (eventType) {
    case 'checkout.completed': {
      const order = getObj(object, 'order');
      const subscription = getObj(object, 'subscription');
      return makeEvent(
        'creem',
        eventId,
        getStr(object, 'checkout', 'id') ?? getStr(order, 'id') ?? eventId,
        occurredAt,
        payload,
        'payment',
        'paid',
        subscription ? 'subscription_initial' : 'one_time',
        {
          provider_customer_id: getStr(object, 'customer', 'id'),
          provider_subscription_id: getStr(subscription, 'id'),
          email: emailOf(getStr(object, 'customer', 'email')),
          visitor_id:
            visitorFrom(metadata, null) ??
            visitorFrom(checkoutMetadata, null) ??
            visitorFromRequestId(getStr(object, 'request_id')),
          session_id: getStr(metadata, 'session_id') ?? getStr(checkoutMetadata, 'session_id'),
          gross_minor: getNum(order, 'amount_paid') ?? 0,
          tax_minor: getNum(order, 'tax_amount') ?? 0,
          discount_minor: getNum(order, 'discount_amount') ?? 0,
          amount_minor: getNum(order, 'amount_paid') ?? 0,
          currency: currencyOf(getStr(order, 'currency')),
        },
      );
    }

    case 'subscription.paid': {
      const transaction = getObj(object, 'last_transaction');
      // Creem fires `subscription.paid` for the first payment and every
      // renewal without a first/renewal flag; the first purchase is detected
      // in the processor via `is_first_purchase`, so this defaults to renewal.
      return makeEvent(
        'creem',
        eventId,
        getStr(transaction, 'id') ?? getStr(object, 'id') ?? eventId,
        getTime(transaction, 'created_at') ?? occurredAt,
        payload,
        'payment',
        'paid',
        'subscription_renewal',
        {
          provider_customer_id: getStr(object, 'customer', 'id'),
          provider_subscription_id: getStr(object, 'id'),
          email: emailOf(getStr(object, 'customer', 'email')),
          visitor_id: visitorFrom(metadata, null),
          session_id: getStr(metadata, 'session_id'),
          gross_minor: getNum(transaction, 'amount_paid') ?? 0,
          tax_minor: getNum(transaction, 'tax_amount') ?? 0,
          amount_minor: getNum(transaction, 'amount_paid') ?? 0,
          currency: currencyOf(getStr(transaction, 'currency')),
        },
      );
    }

    case 'refund.created': {
      const original = getStr(object, 'transaction', 'id') ?? getStr(object, 'checkout', 'id');
      if (!original) return null;
      return makeEvent(
        'creem',
        eventId,
        original,
        occurredAt,
        payload,
        'refund',
        'refunded',
        null,
        {
          provider_customer_id: getStr(object, 'customer', 'id'),
          amount_minor: getNum(object, 'refund_amount') ?? 0,
        },
      );
    }

    case 'dispute.created': {
      const original = getStr(object, 'transaction', 'id');
      if (!original) return null;
      return makeEvent(
        'creem',
        eventId,
        original,
        occurredAt,
        payload,
        'dispute',
        'disputed',
        null,
        {
          provider_customer_id: getStr(object, 'customer', 'id'),
          amount_minor: getNum(object, 'amount') ?? 0,
        },
      );
    }

    default:
      return null;
  }
}

/** Dispatcher: provider event -> normalized PaymentEvent, or null when the
 * event carries no revenue, refund, dispute, or customer link. */
export function adaptPaymentEvent(
  provider: Provider,
  eventType: string,
  payload: JsonObject,
): PaymentEvent | null {
  switch (provider) {
    case 'stripe':
      return adaptStripe(eventType, payload);
    case 'polar':
      return adaptPolar(eventType, payload);
    case 'dodo':
      return adaptDodo(eventType, payload);
    case 'creem':
      return adaptCreem(eventType, payload);
  }
}

/** Provider event type for the ledger (Stripe/Dodo use `type`, Creem `eventType`). */
export function providerEventType(provider: Provider, payload: JsonObject): string | null {
  if (provider === 'creem') return getStr(payload, 'eventType');
  return getStr(payload, 'type');
}

/**
 * Idempotency key for the ledger. Polar/Dodo use the Standard Webhooks
 * `webhook-id` header; Stripe/Creem use the body id.
 */
export function providerEventId(
  provider: Provider,
  payload: JsonObject,
  headerEventId: string | null,
): string | null {
  if (provider === 'polar' || provider === 'dodo') {
    const fromHeader = str(headerEventId);
    if (fromHeader) return fromHeader;
  }
  return str(payload.id) ?? null;
}
