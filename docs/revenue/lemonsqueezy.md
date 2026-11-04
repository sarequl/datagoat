# Lemon Squeezy

([How attribution works](README.md))

## 1. Connect

Lemon Squeezy → **Settings → API → New API key**. Find your numeric store id under
**Settings → Stores**.

```sh
curl -X POST ".../api/v1/admin/websites/$WEBSITE_ID/integrations/lemonsqueezy" \
  -H "Authorization: Bearer dft_…" -H "Content-Type: application/json" \
  -d '{"lemonsqueezyApiKey":"…","lemonsqueezyStoreId":"12345"}'
```

DataGoat creates a webhook for the store through the API, with a random signing secret it keeps
(`X-Signature` is verified on every delivery). To manage the webhook yourself instead, create it
pointing at `/webhooks/lemonsqueezy/<websiteId>` with the order and subscription events and pass
its secret as `webhookSecret`. Orders and subscription invoices are also polled every 5 minutes and
backfilled.

## 2. Pass the visitor id

Checkout API: add it to the checkout's custom data.

```js
await createCheckout(storeId, variantId, {
  checkoutData: {
    custom: {
      datafast_visitor_id: cookies.get("datafast_visitor_id"),
      datafast_session_id: cookies.get("datafast_session_id"),
    },
  },
});
```

Checkout URLs take it as `?checkout[custom][datafast_visitor_id]=…`. It comes back in webhooks as
`meta.custom_data` (the Lemon Squeezy API does not return custom data, which is why the webhook
matters).

**Payment Links (no code):** set the confirmation button link to your site with
`?order_id=[order_id]`. **Other flows:** `window.datafast("payment", { email })`.

## What is recorded

Paid orders (id: the order id), subscription renewals (`subscription_payment_success`, id
`inv_<invoice id>`; the initial invoice is the order itself), refunds, and subscription lifecycle
(`cancelled` = cancel scheduled until `ends_at`, `resumed` = reactivated, `expired` = ended).
Lemon Squeezy subscriptions carry no price, so upgrades and downgrades are detected when a renewal
amount changes.
