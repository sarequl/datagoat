# Dodo Payments

([How attribution works](README.md))

## 1. Connect

Dodo Payments → **Developer → API keys**: create a key. Then **Developer → Webhooks → Add
endpoint** with the URL `https://<your DataGoat>/webhooks/dodo/<websiteId>` and the payment,
refund, dispute and subscription events; copy its signing secret (`whsec_…`).

```sh
curl -X POST ".../api/v1/admin/websites/$WEBSITE_ID/integrations/dodo" \
  -H "Authorization: Bearer dft_…" -H "Content-Type: application/json" \
  -d '{"apiKey":"…","webhookSecret":"whsec_…"}'
```

Webhooks follow Standard Webhooks and are verified. Payments, refunds and subscriptions are also
polled every 5 minutes and backfilled. Test mode (`"testMode": true`) needs
`ALLOW_TEST_PAYMENT_KEYS = "true"`.

## 2. Pass the visitor id

```js
await dodopayments.checkoutSessions.create({
  product_cart: [{ product_id: productId, quantity: 1 }],
  metadata: { datafast_visitor_id: cookies.get("datafast_visitor_id") },
});
```

A success page reached with `?payment_id=…` is resolved when the tracker reports it as a
payment reference (`dodo_payment_id`).

## What is recorded

`payment.succeeded` (the first payment of a subscription is a sale, later ones renewals),
`refund.succeeded`, disputes (opened/lost negative, won reversed), and subscription lifecycle
(`on_hold` = past due, `cancelled` / `expired` = ended, cancel at next billing date = scheduled).
