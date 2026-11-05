# Creem

([How attribution works](README.md))

## 1. Connect

Creem → **Developers**: copy the API key and create a webhook pointing at
`https://<your DataGoat>/webhooks/creem/<websiteId>`; copy its signing secret.

```sh
curl -X POST ".../api/v1/admin/websites/$WEBSITE_ID/integrations/creem" \
  -H "Authorization: Bearer dgt_…" -H "Content-Type: application/json" \
  -d '{"apiKey":"creem_…","webhookSecret":"…"}'
```

Deliveries are verified with `creem-signature` (HMAC-SHA256 of the body). Transactions are polled
every 5 minutes and backfilled. `creem_test_` keys use Creem's test API and need
`ALLOW_TEST_PAYMENT_KEYS = "true"`.

## 2. Pass the visitor id

```js
await creem.checkouts.create({
  product_id: "prod_…",
  metadata: { datagoat_visitor_id: cookies.get("datagoat_visitor_id") },
});
```

Success pages reached with `?checkout_id=ch_…` are resolved when the tracker reports them as a
payment reference (`creem_checkout_id`).

## What is recorded

`checkout.completed` (payment; maps the customer to the visitor), `subscription.paid` (renewal of
the latest transaction; the first one is the checkout's sale), `refund.created` (negative),
`dispute.created`, and subscription lifecycle (`subscription.canceled` = cancel scheduled while
still active, `subscription.expired` = ended). Polled transactions without metadata attribute
through the customer map and email.
