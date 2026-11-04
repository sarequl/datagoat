# Paddle Billing

([How attribution works](README.md))

## 1. Create an API key

Paddle → **Developer tools → Authentication → New API key** with read access to transactions,
subscriptions, adjustments, customers and events (and **notification settings: write** if DataGoat
should create the webhook). Production keys start with `pdl_live_`.

## 2. Connect

```sh
curl -X POST ".../api/v1/admin/websites/$WEBSITE_ID/integrations/paddle" \
  -H "Authorization: Bearer dft_…" -H "Content-Type: application/json" \
  -d '{"paddleApiKey":"pdl_live_…"}'
```

DataGoat polls Paddle's events API every minute from the newest event at connect time, so no
webhook is required, and backfills completed transactions, subscriptions and adjustments. When the
key may write notification settings, a notification destination is created
(`/webhooks/paddle/<websiteId>`, `Paddle-Signature` verified). Re-run the history import at any
time (DataFast's endpoint):

```sh
curl -X PATCH ".../integrations/paddle" -H "Authorization: Bearer dft_…"
```

## 3. Pass the visitor id

Transactions API: `custom_data: { datafast_visitor_id, datafast_session_id }`.
Paddle.js overlay / inline checkout:

```js
Paddle.Checkout.open({
  items: [{ priceId: "pri_…", quantity: 1 }],
  customData: {
    datafast_visitor_id: getCookie("datafast_visitor_id"),
    datafast_session_id: getCookie("datafast_session_id"),
  },
});
```

**Other flows:** `window.datafast("payment", { email })`.

## What is recorded

Completed transactions (`origin` web/api = payment, `subscription_recurring` / `_update` /
`_charge` = renewal; amount = grand total), approved refund adjustments (negative), chargebacks and
their reversals, and subscription lifecycle (scheduled cancel = `scheduled_change.action: cancel`).
