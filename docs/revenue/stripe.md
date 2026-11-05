# Stripe

DataGoat reads Stripe with a **restricted, read-only key** and polls Stripe's Events API every
minute, so no webhook is required. ([How attribution works](README.md))

## 1. Create a restricted key

Stripe Dashboard → **Developers → API keys → Create restricted key**. Name it "DataGoat" and set
**Read** on:

| Resource          | Why                                                  |
| ----------------- | ---------------------------------------------------- |
| Events            | the polling feed (required)                          |
| Checkout Sessions | metadata, Payment Links, backfill (required)         |
| Charges           | refunds and disputes (required)                      |
| Invoices          | subscription payments and renewals (required)        |
| Subscriptions     | trials, upgrades, cancellations (required)           |
| PaymentIntents    | PaymentIntent API flows (recommended)                |
| Customers, Disputes, Refunds | backfill of history (recommended)         |

Leave everything else at **None**. The key starts with `rk_live_`. DataGoat refuses publishable
(`pk_`) and secret (`sk_`) keys, and tells you which required permissions are missing.

## 2. Connect

Dashboard: **Settings → Integrations → Stripe**, paste the key. Or:

```sh
curl -X POST "https://analytics.example.com/api/v1/admin/websites/$WEBSITE_ID/integrations/stripe" \
  -H "Authorization: Bearer dgt_…" -H "Content-Type: application/json" \
  -d '{"stripeRak":"rk_live_…"}'
```

Polling starts at the newest event; a backfill then imports history (checkout sessions,
subscriptions, paid invoices, PaymentIntents, refunds, disputes) a page per minute.

## 3. Pass the visitor id to Checkout

Checkout Sessions (server side):

```js
const session = await stripe.checkout.sessions.create({
  // …line_items, mode, success_url…
  metadata: {
    datagoat_visitor_id: cookies.get("datagoat_visitor_id"),
    datagoat_session_id: cookies.get("datagoat_session_id"),
  },
  // Subscriptions: also put it on the subscription so renewals carry it.
  subscription_data: { metadata: { datagoat_visitor_id: cookies.get("datagoat_visitor_id") } },
});
```

`datafast_visitor_id` / `datafast_session_id` are also accepted. PaymentIntent API (Stripe Elements): put the
same `metadata` on `stripe.paymentIntents.create`. Pricing Tables and Payment Links can pass the
visitor id as `client_reference_id`.

**Payment Links (no code):** in the link's **After payment** settings, redirect to your site with
`?session_id={CHECKOUT_SESSION_ID}` appended. The tracker reports the session id and DataGoat looks
the payment up.

**Anything else:** call `window.datagoat("payment", { email })` on your success page; the payment
is matched by the customer's email.

## Optional: webhooks (instant sales)

Polling has up to a minute of delay. For instant updates add an endpoint in Stripe (**Developers →
Webhooks → Add endpoint**) with the URL shown after connecting
(`https://<your DataGoat>/webhooks/stripe/<websiteId>`) and these events:
`checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`payment_intent.succeeded`, `invoice.paid`, `charge.refunded`, `charge.dispute.created`,
`charge.dispute.closed`, `customer.subscription.created`, `customer.subscription.updated`,
`customer.subscription.deleted`. Then paste the signing secret (`whsec_…`):

```sh
curl -X PATCH ".../integrations/stripe" -H "Authorization: Bearer dgt_…" \
  -H "Content-Type: application/json" -d '{"webhookSecret":"whsec_…"}'
```

Signatures are verified (`Stripe-Signature`, 5-minute tolerance) and deliveries deduplicated, so
webhooks and polling never double-count.

## What is recorded

| Stripe                                         | DataGoat                                          |
| ---------------------------------------------- | ------------------------------------------------- |
| Checkout Session, mode `payment`, paid         | payment (id: its PaymentIntent)                   |
| PaymentIntent succeeded (not from an invoice)  | payment                                           |
| Invoice paid, `subscription_create`            | payment (id: the invoice)                         |
| Invoice paid, `subscription_cycle` / `_update` | renewal (the first charge after a trial is a sale) |
| Charge refunded / refund                       | negative revenue on the original visitor          |
| Dispute created / won                          | negative / reversed                               |
| Subscription created/updated/deleted           | lifecycle goals                                   |

Notes: amounts include tax (what the customer paid). Stripe keeps events for 30 days; if DataGoat
is offline longer it restarts at the newest event and re-runs the backfill. Renewals in API
versions from 2025 that drop `invoice.payment_intent` attribute through the customer map.
