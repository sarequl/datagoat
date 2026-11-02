/**
 * Normalized payment contract (design/attribution.md §7.3). Every provider
 * adapter produces this one shape before any D1 write; the processor never
 * sees provider-specific fields.
 */

export type Provider = 'stripe' | 'polar' | 'dodo' | 'creem';

export const PROVIDERS: readonly Provider[] = ['stripe', 'polar', 'dodo', 'creem'];

export function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);
}

/** Revenue status. Amends worker.md's `paid | renewal | trial | failed`. */
export type PaymentStatus =
  | 'paid'
  | 'processing'
  | 'failed'
  | 'refunded'
  | 'partially_refunded'
  | 'disputed';

export type PaymentKind =
  | 'one_time'
  | 'subscription_initial'
  | 'subscription_renewal'
  | 'subscription_update'
  | 'credit_purchase';

export type JoinMethod = 'metadata' | 'provider_customer' | 'email' | 'unresolved';

export type CreditModel = 'first_touch' | 'last_touch' | 'last_non_direct';

export const CREDIT_MODELS: readonly CreditModel[] = [
  'first_touch',
  'last_touch',
  'last_non_direct',
];

/**
 * What the event does to the payments ledger:
 * - `payment`  — a charge; creates or updates the revenue row.
 * - `refund`   — a refund delta; accumulates into `refunded_minor`.
 * - `dispute`  — a dispute delta; accumulates into `disputed_minor`.
 * - `customer` — a provider customer record; upserts the identity bridge only.
 */
export type EventRole = 'payment' | 'refund' | 'dispute' | 'customer';

export interface PaymentEvent {
  provider: Provider;
  provider_event_id: string;
  /** The provider's charge/payment/invoice/transaction id — the upsert key. */
  provider_payment_id: string;
  provider_customer_id: string | null;
  provider_subscription_id: string | null;
  /** Dodo multi-subscription carts; null when there is a single subscription. */
  provider_subscription_ids: string[] | null;
  email: string | null;
  /** From checkout metadata (`datagoat_visitor_id` / `datafast_visitor_id`). */
  visitor_id: string | null;
  session_id: string | null;
  gross_minor: number;
  tax_minor: number;
  discount_minor: number;
  /** Net revenue for this event. For refund/dispute roles this is the delta. */
  amount_minor: number;
  currency: string;
  refunded_minor: number;
  status: PaymentStatus | null;
  kind: PaymentKind | null;
  product_id: string | null;
  product_name: string | null;
  plan_id: string | null;
  /** Provider event time — the credit anchor (unix seconds). */
  occurred_at: number;
  role: EventRole;
  /** Original provider payload, kept for replay/debug (§10 TTL). */
  raw: Record<string, unknown>;
}

export interface PaymentIntegration {
  website_id: string;
  provider: string;
  account_id: string | null;
  webhook_secret: string | null;
  enabled: number;
}
