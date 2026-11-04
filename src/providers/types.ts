/**
 * Shared types of the revenue module (plan §10.2).
 *
 * Every provider adapter turns provider objects (API pages, webhook payloads, hint lookups) into a
 * `NormalizedBatch`; the engine (engine.ts) attributes, converts and stores it. Adapters never
 * touch D1 and never call `fetch` directly: they get an `AdapterContext` whose `fetch` is counted
 * against the invocation's subrequest budget.
 */

export const PROVIDER_IDS = [
  "stripe",
  "polar",
  "lemonsqueezy",
  "paddle",
  "dodo",
  "creem",
  "shopify",
  "woocommerce",
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
/** `api` is POST /api/v1/payments. */
export type PaymentSourceProvider = ProviderId | "api";

export type PaymentKind = "payment" | "renewal" | "refund" | "free_trial";
export type AttributedVia = "metadata" | "link" | "customer" | "email" | "api" | "none";
export type IngestSource = "webhook" | "poll" | "backfill" | "api" | "hint" | "import";

/** DataFast's reserved goals emitted for payment providers (docs: custom-goals.md). */
export const LIFECYCLE_GOALS = [
  "payment",
  "free_trial",
  "trial_started",
  "trial_converted",
  "subscription_started",
  "subscription_upgraded",
  "subscription_downgraded",
  "subscription_renewed",
  "subscription_cancel_scheduled",
  "subscription_reactivated",
  "subscription_ended",
] as const;
export type LifecycleGoal = (typeof LIFECYCLE_GOALS)[number];

export interface NormalizedPayment {
  /** Idempotency key, unique per site and provider. */
  providerTxnId: string;
  providerCustomerId?: string | undefined;
  /** `auto`: payment, unless the subscription already had a paid charge (then renewal). */
  kind: PaymentKind | "auto";
  /** Minor units of `currency`. Refunds are negative; a reversed dispute is positive. */
  amountMinor: number;
  currency: string;
  occurredAt: number;
  /** Visitor id carried by the payment itself (checkout metadata, custom data, API body). */
  visitorId?: string | undefined;
  /** How `visitorId` was obtained: `metadata` (provider metadata) or `api` (Payments API). */
  visitorVia?: AttributedVia | undefined;
  sessionId?: string | undefined;
  email?: string | undefined;
  name?: string | undefined;
  subscriptionId?: string | undefined;
  /** Provider object ids a success-page hint may reference (checkout session, order, checkout). */
  hintRefs?: string[] | undefined;
  /** For refunds: candidate transaction ids of the original payment, best first. */
  refundOf?: string[] | undefined;
  reason?: "refund" | "dispute" | "dispute_won" | undefined;
  /** Replace the stored amount when the row exists (cumulative refunds). */
  updateAmount?: boolean | undefined;
  metadata?: Record<string, unknown> | undefined;
  eventId?: string | undefined;
}

export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "paused"
  | "incomplete"
  | "ended";

export interface NormalizedSubscription {
  id: string;
  customerId?: string | undefined;
  status: SubscriptionStatus;
  /** Monthly recurring amount in minor units of `currency`; undefined when unknown. */
  mrrMinor?: number | undefined;
  currency?: string | undefined;
  cancelAtPeriodEnd: boolean;
  trialStartAt?: number | undefined;
  trialEndAt?: number | undefined;
  startedAt?: number | undefined;
  /** When this state was observed (event time). */
  occurredAt: number;
  visitorId?: string | undefined;
  sessionId?: string | undefined;
  email?: string | undefined;
  hintRefs?: string[] | undefined;
}

/** A checkout that maps a customer to a visitor without carrying a payment (trials, links). */
export interface CustomerLink {
  customerId?: string | undefined;
  visitorId?: string | undefined;
  /** How `visitorId` was obtained (default `metadata`). */
  visitorVia?: AttributedVia | undefined;
  sessionId?: string | undefined;
  email?: string | undefined;
  occurredAt: number;
  subscriptionId?: string | undefined;
  /** Existing payments to attribute to this visitor if they are still unattributed. */
  attachTxnIds?: string[] | undefined;
  hintRefs?: string[] | undefined;
}

export interface NormalizedBatch {
  payments: NormalizedPayment[];
  subscriptions: NormalizedSubscription[];
  customers: CustomerLink[];
}

export function emptyBatch(): NormalizedBatch {
  return { payments: [], subscriptions: [], customers: [] };
}

export function mergeBatches(...batches: NormalizedBatch[]): NormalizedBatch {
  return {
    payments: batches.flatMap((b) => b.payments),
    subscriptions: batches.flatMap((b) => b.subscriptions),
    customers: batches.flatMap((b) => b.customers),
  };
}

export function batchSize(b: NormalizedBatch): number {
  return b.payments.length + b.subscriptions.length + b.customers.length;
}

/** A decrypted provider connection. */
export interface Connection {
  siteId: string;
  provider: ProviderId;
  credentials: Record<string, string>;
  webhookSecret: string | null;
  settings: Record<string, unknown>;
  accountId: string | null;
  accountName: string | null;
  currency: string | null;
  status: "active" | "error" | "disconnected" | "pending";
  lastSyncedAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface AdapterContext {
  fetch: FetchFn;
  now: number;
  /** Accept sandbox/test credentials (env ALLOW_TEST_PAYMENT_KEYS = "true"). */
  allowTestKeys: boolean;
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
  currency?: string | null;
  accountId?: string | null;
  accountName?: string | null;
  /** Normalised credentials to store (secrets only). */
  credentials?: Record<string, string>;
  /** Non-secret provider settings to store (base URL mode, store id, initial cursor). */
  settings?: Record<string, unknown>;
  keyExpiresAt?: number | null;
  /** Initial polling cursor (e.g. the newest event at connect time, so polling starts there). */
  syncCursor?: string | null;
}

export interface SyncResult {
  batch: NormalizedBatch;
  /** New cursor to persist (unchanged when nothing new). */
  cursor: string | null;
  /** True when the provider has more data right now (keep paging next tick). */
  more: boolean;
  /** The cursor was lost (e.g. aged out): re-run the historical backfill to close the gap. */
  restartBackfill?: boolean;
}

export interface BackfillResult {
  batch: NormalizedBatch;
  /** Next page cursor, or null when the backfill is complete. */
  next: string | null;
  /** A stream the key may not read (permission), reported to the operator. */
  warning?: string;
}

export interface VerifiedWebhook {
  /** Provider delivery/event id used for dedupe. */
  eventId: string;
  payload: unknown;
  /** Lower-cased request headers (topic headers, shop domain, ...). */
  headers: Record<string, string>;
}

export interface WebhookSetup {
  secret: string;
  webhookId: string | null;
}

export interface ProviderAdapter {
  id: ProviderId;
  displayName: string;
  /** Validate credentials on connect (and read the account's currency). */
  validateCredentials(
    input: Record<string, unknown>,
    ctx: AdapterContext,
  ): Promise<ValidationResult>;
  /** Poll for new data since `cursor`. Providers with an events API poll every minute. */
  sync?(conn: Connection, cursor: string | null, ctx: AdapterContext): Promise<SyncResult>;
  /** Minutes between polls (default 1). */
  pollEveryMinutes?: number;
  /** One page of historical data. `page` null = first page. */
  backfill?(conn: Connection, page: string | null, ctx: AdapterContext): Promise<BackfillResult>;
  /** Verify a webhook delivery's signature; null when invalid. */
  verifyWebhook(
    rawBody: string,
    headers: Headers,
    secret: string,
    now: number,
  ): Promise<VerifiedWebhook | null>;
  normalizeWebhook(webhook: VerifiedWebhook, conn: Connection): NormalizedBatch;
  /** Resolve a success-page reference into its payment; null when not paid yet. */
  resolveHint?(conn: Connection, ref: string, ctx: AdapterContext): Promise<NormalizedBatch | null>;
  /** Create the webhook endpoint at the provider when the credentials allow it. */
  setupWebhook?(conn: Connection, url: string, ctx: AdapterContext): Promise<WebhookSetup | null>;
  removeWebhook?(conn: Connection, ctx: AdapterContext): Promise<void>;
  /** Detect upgrades/downgrades from renewal amounts (no plan price in the API). */
  planChangesFromRenewals?: boolean;
}
