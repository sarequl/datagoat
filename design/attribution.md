# DataGoat — Revenue Attribution & LTV Model

**Owner:** Attribution Engineer
**Status:** Proposal v1 (design only — no app code, no repo)
**Date:** 2026-11-02
**Scope:** credit rules (first-touch / last-touch / last-non-direct), payment schema,
how a payment joins to a visitor, and the Stripe / Polar / Dodo Payments / Creem webhook design.

This document proposes a model. The Worker Engineer owns the final D1 DDL and the
ingestion Worker; the Script & SDK Engineer owns the client-side capture; the Dashboard
Engineer owns the reporting views built on the tables below. Nothing here is final until
the Worker Engineer reviews the DDL.

### 0.1 Relationship to the sibling design docs

This doc is the **attribution semantics** layer; it is not a competing schema. Where it
overlaps with the other proposals it defers to them:

- `worker.md` is authoritative for the D1 DDL, tenancy (`website_id` on every table), the
  ingestion routes, and the webhook pipeline. The tables in §5 are the attribution
  **extension** to worker.md's `events` / `sessions` / `visitors` / `payments`; the
  Worker Engineer should merge them, not adopt a parallel set.
- `script.md` is authoritative for `visitor_id` / `session_id` generation and the beacon
  payload. §6.2 is the checkout-specific contract that sits on top of it.
- `dashboard.md` is authoritative for the UI; §8 lists the queries it should call.
- Naming adopted from worker.md: `website_id` scopes every table; the credit model lives on
  `websites.attribution_model` (values `first_touch` | `last_touch` | `last_non_direct`),
  not on each payment; `visitors.first_channel` is the authoritative first-touch channel.
  `visitors.ltv_cents` is a denormalised cache and must be recomputed from `payments`
  whenever a refund or re-attribution lands.

**One real amendment this doc asks worker.md to adopt:** store all three credit sets on
`payments` (§5.1) instead of only the model selected by `websites.attribution_model`. The
cost is a few extra TEXT columns per payment; the benefit is that switching models in the
dashboard is a column swap with no back-fill and no re-read of `events`. If the Worker
Engineer rejects this, §8's queries must recompute credit from `events` at read time.

---

## 1. Identity model

### 1.1 `visitor_id`

The stable, anonymous identity of a browser/device. It is **not** a user account id.

- Format: 16-byte random value, base64url, no padding (22 chars). Stored first in a
  first-party cookie `_dgf_vid`, then mirrored to `localStorage` as a fallback.
- Lifetime: 1 year, sliding. Refreshed on every event.
- Rotates never automatically. A visitor_id is never reused for a different person.
- The tracking script creates it lazily on first event, and exposes
  `window.__datagoat.getVisitorId()` for checkout integrations.
- On consent denial or `doNotTrack`, we still need *some* id to keep counts honest, so we
  fall back to a per-session id and mark `consent = 'none'`; those events are counted in
  sessions but excluded from LTV.

### 1.2 `session_id`

- A session is a visitor's activity with ≤ 30 minutes between consecutive events.
- Format: random id + `started_at` timestamp. The session rolls over (new id) after a gap.
- Used for: session counts, the last-touch *touch*, and the path-to-purchase view.

### 1.3 `touch` (attribution event)

One row per attributed interaction. A touch is a pageview that carries any of: UTM
parameters, a cross-site referrer, or a click id (`gclid`, `fbclid`, `ttclid`, `msclkid`).
Pageviews with no attribution signals still count as sessions but are not touches.

### 1.4 `customer` (identity bridge)

A `customers` table maps **email** and **provider customer id** to a `visitor_id`. This
is what lets a payment that arrives without a cookie (e.g. a renewals webhook, or a
checkout in a fresh browser) still be attributed.

| column | type | notes |
| - | - | - |
| `website_id` | TEXT | tenancy key |
| `email` | TEXT | lower-cased; unique per website |
| `visitor_id` | TEXT | primary, may be null until resolved |
| `provider_customer_id` | TEXT | one per provider; unique index on (provider, id) |
| `first_seen_at` | INTEGER | unix seconds |
| `last_seen_at` | INTEGER | |

Resolution is many-to-one: one email can map to several visitor_ids over time (shared
laptops, cookie clears). We keep the **most recent** mapping as the active one and store
the history so LTV can be re-computed under a different policy if needed.

---

## 2. Touch capture & channel classification

Captured by the tracking script (Script & SDK Engineer) on every pageview, sent as
`POST /ingest` with the payload described in §5. The Worker derives `channel` and the
UTM triple; the client sends raw values only.

### 2.1 Channel precedence

Resolve in order; first match wins. "Direct" means the visitor typed the URL, used a
bookmark, or came from a same-host referrer with no marketing params.

| precedence | condition | channel |
| - | - | - |
| 1 | `utm_medium` in (`cpc`, `ppc`, `paidsearch`) or `gclid`/`msclkid` present | `paid_search` |
| 2 | `utm_medium` in (`cpc`, `paid`, `paidsocial`) or `fbclid`/`ttclid` present | `paid_social` |
| 3 | `utm_medium` = `email` | `email` |
| 4 | `utm_medium` in (`organic`, `search`) or referrer is a known search engine | `organic_search` |
| 5 | `utm_medium` = `referral` | `referral` |
| 6 | `utm_medium` = `affiliate` | `affiliate` |
| 7 | `utm_medium` in (`social`, `social-network`, `social-media`) | `social` |
| 8 | `utm_source` present but medium unknown | `other_paid` if `utm_campaign` present else `other` |
| 9 | referrer is cross-host (not our own domain) | `referral` |
| 10 | none of the above | `direct` |

We store **both** the raw `source`/`medium`/`campaign` and the derived `channel`. All
reporting by channel is derived from this table, never re-guessed at query time.

### 2.2 Known search engines

A small built-in list (google, bing, duckduckgo, yahoo, baidu, yandex, ecosia, brave) is
used only for organic detection. This list lives in one place in the Worker so it can be
extended without a client deploy.

### 2.3 Direct vs. "none"

`channel = 'direct'` is a real bucket and is reported. We never silently merge it into
`other`. `last-non-direct` explicitly skips it (§4.2).

---

## 3. Credit rules

We compute **all three** credit sets for every payment and store them on the payment row.
The dashboard picks the model with a toggle; nothing is thrown away.

### 3.1 Definitions

- **Touch window:** a touch is eligible for last-touch / last-non-direct credit if
  `touch.occurred_at <= payment.occurred_at` and
  `payment.occurred_at - touch.occurred_at <= ATTRIBUTION_WINDOW_DAYS` (default **30**).
- **First-touch** has **no window**: it is the visitor's earliest recorded touch, for the
  life of the visitor_id. (Configurable to a window for businesses that want a reset.)

### 3.2 First-touch

Credit the **earliest** touch of the visitor (by `occurred_at`, tie-break by event id).
It is stored once on the visitor row and is immutable unless the visitor_id is deleted.

- Edge case: the visitor's first recorded touch may be *after* their first payment (late
  cookie set). In that case first-touch is marked `unattributed` for that payment and the
  payment falls back to the join result only.
- First-touch is the model we recommend for "where do new customers come from" because it
  is stable and not sensitive to window length.

### 3.3 Last-touch

Credit the **most recent eligible touch** at or before the payment, regardless of channel.
If that touch is `direct`, the payment is credited to `direct` (not dropped).

- Rationale: last-touch is the most responsive to campaigns and the easiest to explain,
  but it over-credits bottom-funnel paid search. Show it next to the others, never alone.

### 3.4 Last-non-direct

Credit the **most recent eligible touch whose channel is not `direct`**.

- If the visitor's only touches are direct, or all touches are older than the window,
  the payment is credited to `direct` and flagged `last_non_direct_fallback = 1`.
- This is the model we recommend as the default for "which channel drove this revenue"
  because it removes the direct-traffic dead end that eats last-touch credit.

### 3.5 Tie-breaking and ordering

- All comparisons use `occurred_at` (unix seconds, provider event time). If a payment and
  a touch share the same second, the touch does **not** count (strictly before).
- We do not use `created_at` for credit; provider webhook arrival is not business time.
- Late-arriving touches are not retro-applied to an already-computed payment (see §9).

---

## 4. Attribution windows & expiry

| setting | default | applies to |
| - | - | - |
| `ATTRIBUTION_WINDOW_DAYS` | 30 | last-touch, last-non-direct |
| `FIRST_TOUCH_WINDOW_DAYS` | 0 (= lifetime) | first-touch |
| `SESSION_GAP_MINUTES` | 30 | session rollover |
| `REATTRIBUTION_DAYS` | 90 | how long a join can be back-filled |

A payment stores `attribution_window_days` at write time so a later config change does not
silently change history. Changing the window re-runs attribution for a date range only on
explicit request (§9).

---

## 5. Payment schema

All amounts are **minor units** (integer cents/paise) in the currency the customer paid in.
All timestamps are **unix seconds**. The Worker Engineer should review and own the final DDL;
this is the proposal.

### 5.1 `payments`

| column | type | notes |
| - | - | - |
| `website_id` | TEXT | tenancy key from worker.md; part of every PK/index below |
| `payment_id` | TEXT | `provider + ':' + provider_payment_id`; part of the PK |
| `provider` | TEXT | `stripe` \| `polar` \| `dodo` \| `creem` |
| `provider_payment_id` | TEXT | provider's charge/payment/transaction id |
| `provider_event_id` | TEXT | provider's webhook event id (idempotency) |
| `provider_customer_id` | TEXT | nullable |
| `provider_subscription_id` | TEXT | nullable; null for multi-subscription carts |
| `provider_subscription_ids` | TEXT | JSON array for Dodo multi-subscription carts |
| `email` | TEXT | lower-cased, nullable |
| `visitor_id` | TEXT | joined, nullable |
| `session_id` | TEXT | nullable |
| `join_method` | TEXT | `metadata` \| `provider_customer` \| `email` \| `unresolved` |
| `join_confidence` | REAL | 0..1 |
| `gross_minor` | INTEGER | amount charged before tax/discount (provider-dependent) |
| `tax_minor` | INTEGER | |
| `discount_minor` | INTEGER | |
| `amount_minor` | INTEGER | net revenue for this payment |
| `currency` | TEXT | ISO 4217 lower-case |
| `amount_usd_minor` | INTEGER | nullable; for cross-currency LTV |
| `refunded_minor` | INTEGER | cumulative refunds applied |
| `status` | TEXT | `paid` \| `processing` \| `failed` \| `refunded` \| `partially_refunded` \| `disputed`. **Amends** worker.md's `paid \| renewal \| trial \| failed`: worker.md folds renewal into `kind`, so `paid` stays the revenue status and `kind` carries renewal/initial. Add `processing`, `partially_refunded`, `disputed` for the webhook states in §7. |
| `kind` | TEXT | `one_time` \| `subscription_initial` \| `subscription_renewal` \| `subscription_update` \| `credit_purchase` |
| `product_id` | TEXT | |
| `product_name` | TEXT | |
| `plan_id` | TEXT | nullable |
| `occurred_at` | INTEGER | provider event time — the credit anchor |
| `attribution_window_days` | INTEGER | snapshot |
| `attributed` | INTEGER | 0/1 |
| `first_touch_channel` | TEXT | |
| `first_touch_source` | TEXT | |
| `first_touch_medium` | TEXT | |
| `first_touch_campaign` | TEXT | |
| `first_touch_at` | INTEGER | |
| `last_touch_channel` | TEXT | |
| `last_touch_source` | TEXT | |
| `last_touch_medium` | TEXT | |
| `last_touch_campaign` | TEXT | |
| `last_touch_at` | INTEGER | |
| `last_non_direct_channel` | TEXT | |
| `last_non_direct_source` | TEXT | |
| `last_non_direct_medium` | TEXT | |
| `last_non_direct_campaign` | TEXT | |
| `last_non_direct_at` | INTEGER | |
| `last_non_direct_fallback` | INTEGER | 1 if the non-direct lookup fell back to direct |
| `touch_count` | INTEGER | eligible touches in window |
| `primary_model` | TEXT | deprecated in favour of `websites.attribution_model`; kept only if worker.md rejects the three-set extension |
| `raw_event` | TEXT | original provider JSON (compressed) for replay/debug |
| `created_at` | INTEGER | |
| `updated_at` | INTEGER | |
| `reattributed_at` | INTEGER | null until a back-fill re-runs attribution (§9.2) |

Indexes (all prefixed with `website_id`): `(occurred_at)`, `(visitor_id, occurred_at)`,
`(provider, provider_payment_id)`, `(provider_customer_id)`, `(first_touch_channel, occurred_at)`,
`(last_non_direct_channel, occurred_at)`, `(email)`. The unique key is
`(website_id, provider, provider_payment_id)`, matching worker.md's `idx_payments_provider`.

**Why store all three credit sets:** computing them at write time is one indexed query per
payment; recomputing at report time is a full scan. Storage is cheap in D1; scans are not.

### 5.2 `attribution_events` (touches)

This is the attribution subset of worker.md's `events` table. Do not create a second table:
worker.md's `events` already carries `channel`, `referrer`, `campaign`, `landing_page`,
and a `direct_type` classification. The columns below are the minimum worker.md's `events`
must expose for attribution; anything worker.md names differently (`events.ts` vs
`occurred_at`, `events.direct_type` vs `is_direct`) is a naming reconciliation, not a
schema change.

| column | type | notes |
| - | - | - |
| `website_id` | TEXT | tenancy key |
| `event_id` | TEXT | client-generated uuid; part of the PK |
| `visitor_id` | TEXT | |
| `session_id` | TEXT | |
| `occurred_at` | INTEGER | client time, clamped to ±5 min of server receive |
| `channel` | TEXT | derived, §2.1 |
| `source` | TEXT | raw utm_source |
| `medium` | TEXT | raw utm_medium |
| `campaign` | TEXT | raw utm_campaign |
| `content` | TEXT | raw utm_content |
| `term` | TEXT | raw utm_term |
| `referrer` | TEXT | full URL or host |
| `referrer_host` | TEXT | |
| `landing_page` | TEXT | full URL |
| `page_path` | TEXT | |
| `gclid` / `fbclid` / `ttclid` / `msclkid` | TEXT | |
| `is_direct` | INTEGER | 0/1 |
| `consent` | TEXT | `full` \| `none` |
| `received_at` | INTEGER | server time |

Indexes: `(visitor_id, occurred_at)`, `(channel, occurred_at)`, `(session_id, occurred_at)`,
`(occurred_at)`.

### 5.3 `visitors` (attribution fields on worker.md's table)

worker.md already defines `visitors` with `(website_id, visitor_id)` as the PK and
`first_channel`, `first_channel_name`, `first_referrer`, `ltv_cents`. This doc only pins
the attribution semantics of those columns and asks for the touch detail alongside them:

| column | type | notes |
| - | - | - |
| `first_channel` | TEXT | authoritative first-touch channel; write-once on first insert |
| `first_channel_name` | TEXT | raw source (worker.md name) |
| `first_referrer` | TEXT | |
| `first_touch_at` | INTEGER | needed for cohort grouping; worker.md has `first_seen` — confirm which is used |
| `ltv_cents` | INTEGER | denormalised cache; recompute from `payments` on refund / re-attribution (§9.1) |
| `consent` | TEXT | latest known; `full` \| `none` |

Do **not** store first-touch on the payment as the source of truth; read it from
`visitors.first_channel`. The payment's `first_touch_*` columns are a snapshot for
query speed only, and are reconciled on re-attribution.

### 5.4 `webhook_events` (idempotency ledger)

| column | type | notes |
| - | - | - |
| `website_id` | TEXT | tenancy key |
| `event_id` | TEXT | provider event id; part of the PK |
| `provider` | TEXT | |
| `type` | TEXT | provider event type |
| `received_at` | INTEGER | |
| `status` | TEXT | `processed` \| `ignored` \| `error` |
| `payment_id` | TEXT | nullable |

### 5.5 `fx_rates`

| column | type | notes |
| - | - | - |
| `date` | TEXT | `YYYY-MM-DD` |
| `currency` | TEXT | |
| `usd_rate` | REAL | 1 unit of currency = X USD |

Filled by a daily job (open exchange rate source of the project's choice). If a rate is
missing, `amount_usd_minor` is null and that payment is excluded from USD LTV with a
visible "missing FX" counter in the dashboard.

---

## 6. How a payment joins to a visitor

Four join paths, tried in order. The first match wins and `join_method` records which.

### 6.1 Priority order

1. **`metadata` — explicit handoff at checkout.** The checkout integration passes
   `visitor_id` and `session_id` into the provider's metadata. Highest confidence (1.0).
2. **`provider_customer` — provider customer id link.** `payments.provider_customer_id`
   matches a `customers.provider_customer_id`. Confidence 0.9.
3. **`email` — email link.** `payments.email` matches `customers.email`. Confidence 0.7.
4. **`unresolved`.** No join. Payment is stored, `attributed = 0`, and queued for
   back-fill (§9).

### 6.2 Checkout handoff per provider

| provider | where to put `visitor_id` | session | notes |
| - | - | - | - |
| Stripe | `metadata.datagoat_visitor_id`, `metadata.session_id`, and `client_reference_id` = visitor_id | same | metadata is echoed on the Checkout Session and on the Customer object |
| Polar | checkout `metadata.datagoat_visitor_id`, `metadata.session_id`; also set `customer.external_id` = visitor_id | same | Polar checkout metadata is returned on the order payload |
| Dodo Payments | checkout session `metadata.datagoat_visitor_id`, `metadata.session_id` | same | metadata object is supported on `POST /checkouts`; echo confirmed on webhook payloads |
| Creem | checkout `metadata.datagoat_visitor_id`, `metadata.session_id`; also `request_id` = `dgf_<visitor_id>` | same | Creem checkout carries `metadata` and `request_id`; `request_id` is a useful second path |

The metadata key is `datagoat_visitor_id` (worker.md's chosen key). The Worker must also
accept `datafast_visitor_id` so a site switching from DataFast keeps attribution during the
migration window. The Script & SDK Engineer ships a `getCheckoutContext()` helper that
returns `{ visitor_id, session_id, utm: {...} }` from the cookie/localStorage, and a
`setCheckoutMetadata(providerPayload, ctx)` that merges it into the provider payload.
This is the single most important correctness lever: **without it, attribution depends on
email joins alone and loses the anonymous first session.**

### 6.3 Attribution is computed at payment write time

Once `visitor_id` is known:

1. Load the visitor's touch history from `attribution_events` where
   `occurred_at <= payment.occurred_at` (plus the first-touch record from `visitors`).
2. Compute the three credit sets (§3).
3. Write the `payments` row with the credit columns populated.
4. Update `visitors.payment_count` / `revenue_minor`.

If `visitor_id` is null at write time, store the payment unattributed and let the back-fill
job resolve it (§9). We do **not** block the webhook on attribution.

---

## 7. Provider webhook design

### 7.1 Routes and shape

One route per provider, matching worker.md's `/api/v1/ingest/payment/:provider` (not a
separate `/webhooks/...` namespace). All four share one processing pipeline:

```
POST /api/v1/ingest/payment/stripe
POST /api/v1/ingest/payment/polar
POST /api/v1/ingest/payment/dodo
POST /api/v1/ingest/payment/creem
```

Pipeline (shared):

1. **Verify signature** (provider-specific, §7.2). On failure: 401, do not log payload.
2. **Read raw body** — never re-serialize; signature verification requires exact bytes.
3. **Idempotency check** — `SELECT` from `webhook_events` by provider event id. If present,
   return 200 immediately.
4. **Acknowledge** — return 2xx within ~1 s (all four providers retry otherwise).
5. **Process async** — `ctx.waitUntil(processEvent(...))`. Provider event → normalized
   `PaymentEvent` → upsert `payments` → compute attribution → update `visitors`.
6. **Record** — insert/update `webhook_events` with the outcome.

**Ordering:** events for the same payment can arrive out of order (e.g. `processing` then
`succeeded`). We key on `occurred_at` and only overwrite a payment's status forward:
`succeeded > processing`, and refunds accumulate rather than replace. A `failed` after
`succeeded` is ignored unless the provider explicitly sends a reversal event.

### 7.2 Signature verification

| provider | header | algorithm | secret | clock skew |
| - | - | - | - | - |
| Stripe | `Stripe-Signature` (`t=…,v1=…`) | HMAC-SHA256 over `"{t}.{rawBody}"` | `whsec_…` endpoint secret | ±5 min |
| Polar | `webhook-id`, `webhook-timestamp`, `webhook-signature` | Standard Webhooks (HMAC-SHA256, `msg_<id>.<ts>.<body>`) | `whsec_…` | ±5 min |
| Dodo Payments | `webhook-id`, `webhook-signature`, `webhook-timestamp` | Standard Webhooks (HMAC-SHA256) | webhook secret | ±5 min |
| Creem | `creem-signature` | HMAC-SHA256 over raw body, hex | webhook secret | none documented |

Polar caveat (verified 2026-11-02): secrets created **on or after 2026-09-08** use Standard
Webhooks; older secrets use the older Polar HMAC scheme, where the key is the base64 of the
full `whsec_…` string. The Worker must try both keys when verifying Polar payloads. Polar's
own SDKs (≥ 1.0.0-alpha.19) do this; if we do not use the SDK, we must implement both.

### 7.3 Normalized `PaymentEvent`

Every provider adapter produces this one shape before any D1 write. This is the contract
between the Worker Engineer's ingestion code and the attribution code.

```json
{
  "provider": "stripe",
  "provider_event_id": "evt_…",
  "provider_payment_id": "cs_… | pi_… | in_…",
  "provider_customer_id": "cus_… | null",
  "provider_subscription_id": "sub_… | null",
  "provider_subscription_ids": ["sub_…"],
  "email": "a@b.com | null",
  "visitor_id": "… | null",
  "session_id": "… | null",
  "gross_minor": 2198,
  "tax_minor": 0,
  "discount_minor": 0,
  "amount_minor": 2198,
  "currency": "usd",
  "refunded_minor": 0,
  "status": "succeeded",
  "kind": "one_time | subscription_initial | subscription_renewal | subscription_update",
  "product_id": "…",
  "product_name": "…",
  "plan_id": null,
  "occurred_at": 1679600215,
  "raw": { }
}
```

### 7.4 Stripe

Signature: `Stripe-Signature`, HMAC-SHA256, `whsec_` secret, ±5 min skew.

| event | → `kind` | fields used |
| - | - | - |
| `checkout.session.completed` (`mode=payment`) | `one_time` | `amount_total`, `currency`, `customer_details.email` \|\| `customer_email`, `customer`, `metadata.datagoat_visitor_id`, `metadata.session_id`, `client_reference_id`, `total_details.amount_discount`, `total_details.amount_tax`, `payment_status` (must be `paid`) |
| `checkout.session.completed` (`mode=subscription`) | `subscription_initial` | `subscription`, `amount_total`, `currency`, `customer`, `metadata` |
| `invoice.paid` | `subscription_initial` if `billing_reason=subscription_create`, else `subscription_renewal` | `amount_paid`, `currency`, `customer`, `customer_email`, `billing_reason`, `subscription` |
| `payment_intent.succeeded` | `one_time` (fallback for non-Checkout) | `amount`, `currency`, `customer`, `metadata` |
| `customer.created` / `customer.updated` | — | upsert `customers` (email ↔ provider_customer_id) |
| `charge.refunded` | status `refunded`/`partially_refunded` | `amount_refunded`, `payment_intent`/`invoice` to find the original payment |
| `charge.dispute.*` | status `disputed` | `amount`, `payment_intent`/`charge` |

Stripe specifics that matter:
- Use `payment_status = 'paid'` on the session, not `status = 'complete'` — a session can
  be complete while the payment is still processing.
- For subscriptions, `invoice.paid` is the reliable revenue signal, not
  `customer.subscription.created`.
- `invoice.billing_reason` distinguishes the initial charge from renewals.

### 7.5 Polar

Signature: Standard Webhooks headers; try both key encodings (§7.2). Payload shape
`{ "type": ..., "timestamp": ..., "data": { ... } }`.

| event | → `kind` | fields used |
| - | - | - |
| `order.created` (`billing_reason=purchase`) | `one_time` | `data.id`, `data.net_amount`, `data.currency`, `data.customer.email`, `data.customer_id`, `data.metadata`, `data.checkout_id`, `data.created_at` |
| `order.created` (`billing_reason=subscription_create`) | `subscription_initial` | same + `data.subscription_id` |
| `order.paid` | revenue event (maps to the order) | `data.id`, `data.net_amount`, `data.customer_id` |
| `subscription.created` / `subscription.active` | lifecycle only | `data.id`, `data.customer_id` |
| `subscription.updated` / `subscription.revoked` / `subscription.canceled` | lifecycle only | `data.id` |

Polar specifics:
- `data.net_amount` is the amount after discount; `data.amount` is gross. Use `net_amount`
  for revenue and keep gross in `gross_minor` if present.
- `data.customer.email` is the primary identity; `data.customer_id` is the Polar customer id.
- Polar emits both `order.created` and `order.paid`; record revenue once per order using
  the order id as the payment key, and let the later event update status.

### 7.6 Dodo Payments

Signature: Standard Webhooks headers (`webhook-id`, `webhook-signature`,
`webhook-timestamp`), HMAC-SHA256. Payload shape
`{ "business_id", "type", "timestamp", "data": { "payload_type", … } }`.

| event | → `kind` | fields used |
| - | - | - |
| `payment.succeeded` | `one_time` or `subscription_initial` | `data.payment_id`, `data.customer_id`, `data.customer.email`, `data.checkout_id`, `data.amount`, `data.currency`, `data.status`, `data.created_at`, `data.subscription_id`, `data.subscription_ids`, `data.is_multi_subscription`, `data.metadata`, `data.custom_field_responses` |
| `subscription.active` | lifecycle | `data.subscription_id`, `data.customer_id` |
| `subscription.renewed` | `subscription_renewal` | `data.subscription_id`, `data.payment_id`, `data.amount`, `data.currency` |
| `refund.succeeded` | status `refunded` | `data.payment_id`, `data.refund_id`, `data.amount` |
| `subscription.cancelled` / `past_due` / `on_hold` | lifecycle only | `data.subscription_id` |

Dodo specifics:
- Multi-subscription carts: `is_multi_subscription = true` and `subscription_ids` is a list.
  We store the list in `payments.provider_subscription_ids` and leave
  `provider_subscription_id` null.
- `custom_field_responses` can carry a `referral_source` custom field; if present, we log
  it as a `referral` touch for the visitor rather than a separate revenue source.
- `subscription.renewed` is the renewal revenue signal (not `subscription.updated`).

### 7.7 Creem

Signature: `creem-signature`, HMAC-SHA256 hex over the raw body, no documented skew.
Payload shape `{ "id", "eventType", "created_at", "object": { … } }`.

| event | → `kind` | fields used |
| - | - | - |
| `checkout.completed` | `one_time` or `subscription_initial` | `object.order.amount_paid`, `object.order.tax_amount`, `object.order.discount_amount`, `object.order.currency`, `object.customer.email`, `object.metadata`, `object.request_id`, `object.checkout.metadata`, `object.subscription.id`, `object.order.status` |
| `subscription.paid` | `subscription_initial` (first) or `subscription_renewal` | `object.last_transaction.amount_paid`, `object.last_transaction.tax_amount`, `object.last_transaction.currency`, `object.customer.email`, `object.metadata`, `object.id` |
| `refund.created` | status `refunded` | `object.refund_amount`, `object.transaction.id`, `object.checkout.id`, `object.customer.id` |
| `dispute.created` | status `disputed` | `object.amount`, `object.transaction.id`, `object.customer.id` |
| `subscription.canceled` / `expired` / `past_due` | lifecycle only | `object.id` |

Creem specifics:
- For subscriptions, revenue comes from `subscription.paid` (which fires for the first
  payment and every renewal), not `subscription.active`.
- `checkout.completed` is the one-time revenue signal; it also carries the checkout
  `metadata` and `request_id`, which is where the visitor handoff lands.
- Amounts are in minor units (e.g. `1000` = €10.00) and `amount_paid` includes tax.

---

## 8. Derived metrics

All computed from `payments` + `attribution_events` (worker.md's `events`); no provider
calls at query time. `attribution_events` is an alias for worker.md's `events` table, so
the queries below should read `events` in the final implementation.

### 8.1 Revenue by source

```sql
SELECT <model>_channel AS channel,
       COUNT(*) AS payments,
       SUM(amount_minor) / 100.0 AS revenue,
       COUNT(DISTINCT visitor_id) AS paying_visitors
FROM payments
WHERE website_id = :website_id
  AND occurred_at BETWEEN :from AND :to AND attributed = 1
GROUP BY <model>_channel;
```

`<model>` is `first_touch`, `last_touch`, or `last_non_direct` (the dashboard toggle).

### 8.2 LTV by source

Two numbers, both reported (they answer different questions):

- **LTV (all visitors):** `SUM(amount_minor) / COUNT(DISTINCT visitor_id)` over visitors
  who have at least one touch in the window. This is "how much is a visitor from channel X
  worth", including those who never pay.
- **LTV (paying visitors):** `SUM(amount_minor) / COUNT(DISTINCT visitor_id)` over visitors
  with at least one payment. This is "how much is a customer from channel X worth".

```sql
-- LTV (paying visitors), last-non-direct model
SELECT p.last_non_direct_channel AS channel,
       SUM(p.amount_minor) / 100.0 / COUNT(DISTINCT p.visitor_id) AS ltv_paying
FROM payments p
WHERE p.website_id = :website_id
  AND p.occurred_at BETWEEN :from AND :to AND p.attributed = 1
GROUP BY p.last_non_direct_channel;
```

### 8.3 Revenue per visitor

```sql
SELECT e.channel,
       COUNT(DISTINCT e.visitor_id) AS visitors,
       COALESCE(SUM(p.amount_minor), 0) / 100.0 AS revenue,
       COALESCE(SUM(p.amount_minor), 0) / 100.0 / COUNT(DISTINCT e.visitor_id) AS rpv
FROM events e
LEFT JOIN payments p ON p.website_id = e.website_id AND p.visitor_id = e.visitor_id
WHERE e.website_id = :website_id
  AND e.ts BETWEEN :from AND :to
GROUP BY e.channel;
```

### 8.4 Path-to-purchase view

For one payment, the ordered touches that led to it (last N, default 10):

```sql
SELECT occurred_at, channel, source, medium, campaign, landing_page
FROM events                       -- worker.md's table
WHERE website_id = :website_id
  AND visitor_id = :visitor_id
  AND ts <= :payment_occurred_at  -- worker.md's timestamp column
  AND direct_type <> 'direct'
ORDER BY ts DESC
LIMIT 10;
```

The dashboard renders this as a timeline ending at the payment. Direct touches are shown
but visually de-emphasised, so the user sees the non-direct path and the direct tail.

### 8.5 Cohorts

`first_touch_at` (date) is the cohort key. Cohort revenue = sum of payments whose
`first_touch_channel = X` and `first_touch_at` in the cohort week, grouped by weeks since
first touch. This is the standard SaaS cohort table and it is the main reason first-touch
is stored even though it is not the default credit model.

---

## 9. Refunds, disputes, re-attribution

### 9.1 Refunds and disputes

- Refunds update `payments.refunded_minor` (cumulative) and flip `status` to
  `refunded` or `partially_refunded`. Revenue in §8 is **net** (`amount_minor -
  refunded_minor`), computed at query time, so a refund is reflected everywhere without
  rewriting history.
- Disputes (`dispute.*` / `dispute.created`) set status `disputed` and subtract the amount
  from net revenue while the dispute is open. A won dispute restores it; a lost dispute
  makes it permanent. Keep the disputed amount in a separate column or derive from status —
  decide with the Worker Engineer.

### 9.2 Re-attribution / back-fill

A payment can become resolvable after it is written (customer signs in, email is
confirmed, provider customer id arrives). Rules:

- `REATTRIBUTION_DAYS` (default 90): within this window, a newly resolved
  `visitor_id`/`email` link triggers a re-attribution of all unresolved payments for that
  customer.
- Re-attribution recomputes the three credit sets and updates the payment row in place.
  It does **not** insert a new row, so counts stay stable.
- Re-attribution never moves a touch across the `occurred_at <= payment.occurred_at`
  boundary; late touches are still ineligible.
- A `payments.reattributed_at` timestamp records the last re-attribution.

### 9.3 Changing the window

Changing `ATTRIBUTION_WINDOW_DAYS` is a one-off back-fill job over a requested date
range, not a live re-read. Each payment keeps its original `attribution_window_days`.

---

## 10. Privacy and data handling

- `visitor_id` is a random id with no PII. Email is stored for the identity bridge and is
  the only PII in these tables; it is not exposed in the dashboard API responses
  (aggregate only).
- On deletion request, delete the visitor_id, its touches, its payments, and its
  `customers` rows. Provide a `DELETE /visitors/:id` admin endpoint for this.
- Consent: events with `consent='none'` are counted in sessions but excluded from
  attribution and LTV. The dashboard shows the share of unattributed sessions.
- `raw_event` is retained for replay/debug; give it a TTL (default 90 days) so provider
  payloads (which can contain names, emails, addresses) do not sit in D1 forever.

---

## 11. Open questions / decisions needed

1. **Reporting currency.** Default to native-currency revenue with USD as the only
   cross-currency rollup? Or pick a single reporting currency per workspace? Needs product
   input.
2. **Dispute handling.** Separate `disputed_minor` column vs. derive from status. Needs
   Worker Engineer DDL decision.
3. **First-touch reset.** Lifetime first-touch vs. a 12-month reset for long sales cycles.
   Product decision.
4. **Identity merging.** If two visitor_ids share an email, do we merge them into one
   customer for LTV, or keep them separate? Recommendation: keep separate for visitor
   metrics, merge for customer/LTV-by-email. Needs CMO sign-off.
5. **Creem `metadata` key.** Confirm the exact metadata key name accepted by the Creem
   checkout API (the docs show `metadata` with `internal_customer_id` and `custom_data`;
   we assume arbitrary keys are accepted). To verify against the Creem API reference.
6. **Polar HMAC dual-key.** Whether to vendor a Standard Webhooks library or implement
   both key encodings in the Worker. Needs Worker Engineer decision.
7. **Multi-currency FX source.** Which rate provider, and how to handle weekends/missing
   days. Needs product + Worker Engineer decision.

---

## 12. Handoff notes

**Worker Engineer**
- Owns the final D1 DDL for §5 (indexes, `TEXT` vs `INTEGER`, JSON columns as TEXT).
- Owns the shared webhook pipeline (§7.1), signature verification (§7.2), and the
  provider adapters (§7.4–§7.7).
- Decides the normalized `PaymentEvent` interface (§7.3) and whether the attribution
  computation lives in the webhook handler or a separate queue consumer.

**Script & SDK Engineer**
- Owns `visitor_id` / `session_id` generation and persistence (§1).
- Owns touch capture and the `getCheckoutContext()` / `setCheckoutMetadata()` helpers
  (§6.2). This is the highest-leverage piece for attribution accuracy.

**Dashboard Engineer**
- Owns the reporting queries in §8, the model toggle (first/last/last-non-direct), the
  path-to-purchase timeline, and the cohort table.
- Surfaces `last_non_direct_fallback` and the "missing FX" counter so unattributed or
  unconverted revenue is visible, not hidden.

**Not in this document:** the tracking script payload spec (Script & SDK Engineer), the
ingestion Worker rate limiting and batching (Worker Engineer), and the dashboard UI
(Dashboard Engineer).
