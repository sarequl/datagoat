# Polar

([How attribution works](README.md))

## 1. Create an organization access token

Polar dashboard → **Settings → Developers → New token**. Give it read scopes for orders,
subscriptions, checkouts and organizations, plus **webhooks:write** if you want DataGoat to create
the webhook for you. Copy your organization id too.

## 2. Connect

```sh
curl -X POST ".../api/v1/admin/websites/$WEBSITE_ID/integrations/polar" \
  -H "Authorization: Bearer dft_…" -H "Content-Type: application/json" \
  -d '{"polarAccessToken":"polar_oat_…","polarOrgId":"…"}'
```

With `webhooks:write`, DataGoat creates a webhook endpoint (`/webhooks/polar/<websiteId>`) and
stores its secret. Otherwise create one yourself in Polar (format **Raw**, events `order.*`,
`subscription.*`, `checkout.updated`) and send its secret as `webhookSecret` (in the connect body,
or later with `PATCH …/integrations/polar`). Signatures follow Standard Webhooks; secrets created
under Polar's older scheme verify too.

Without a webhook, DataGoat polls orders and subscriptions every 5 minutes and backfills history.

## 3. Pass the visitor id

Checkout API:

```js
await polar.checkouts.create({
  products: ["…"],
  metadata: {
    datafast_visitor_id: cookies.get("datafast_visitor_id"),
    datafast_session_id: cookies.get("datafast_session_id"),
  },
});
```

**Checkout Links (no code):** set the link's success URL to your site with
`?checkout_id={CHECKOUT_ID}`. **Other flows:** `window.datafast("payment", { email })`.

## What is recorded

Paid orders (billing reason `purchase` / `subscription_create` = payment, `subscription_cycle` /
`subscription_update` = renewal), refunds (`refunded_amount`), and subscription changes as
lifecycle goals (`subscription.canceled` with cancel at period end = cancel scheduled,
`subscription.uncanceled` = reactivated, `subscription.revoked` = ended).
