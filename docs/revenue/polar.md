# Polar

([How attribution works](README.md))

## 1. Create an organization access token

Polar dashboard → **Settings → Access Tokens → Create token**, in your live dashboard (a token from
sandbox.polar.sh only works with the sandbox API). Scopes:

| Scope                 | Needed for                                                    |
| --------------------- | ------------------------------------------------------------- |
| `orders:read`         | Required: payments                                            |
| `subscriptions:read`  | Subscriptions, MRR and renewals                               |
| `checkouts:read`      | Checkout links (`?checkout_id={CHECKOUT_ID}`)                 |
| `organizations:read`  | Optional: shows the organization name and default currency    |
| `webhooks:write`      | Optional: lets DataGoat create the webhook endpoint for you   |

Copy your organization ID from **Settings → General** too.

If connecting fails, the error says what Polar objected to: a token Polar does not recognise
(mistyped, expired, revoked, or a sandbox token), a token without `orders:read`, or an organization
ID that does not match the token.

## 2. Connect

```sh
curl -X POST ".../api/v1/admin/websites/$WEBSITE_ID/integrations/polar" \
  -H "Authorization: Bearer dgt_…" -H "Content-Type: application/json" \
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
    datagoat_visitor_id: cookies.get("datagoat_visitor_id"),
    datagoat_session_id: cookies.get("datagoat_session_id"),
  },
});
```

**Checkout Links (no code):** set the link's success URL to your site with
`?checkout_id={CHECKOUT_ID}`. **Other flows:** `window.datagoat("payment", { email })`.

## What is recorded

Paid orders (billing reason `purchase` / `subscription_create` = payment, `subscription_cycle` /
`subscription_update` = renewal), refunds (`refunded_amount`), and subscription changes as
lifecycle goals (`subscription.canceled` with cancel at period end = cancel scheduled,
`subscription.uncanceled` = reactivated, `subscription.revoked` = ended).
