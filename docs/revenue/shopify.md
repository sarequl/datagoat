# Shopify

DataGoat attributes Shopify orders to visitors through **cart attributes**: a small storefront
snippet copies the visitor cookie into the cart, Shopify copies cart attributes onto the order
(`note_attributes`), and the orders webhook brings it to DataGoat. ([How attribution works](README.md))

There are two ways to connect:

- **The DataGoat Shopify app** (install flow in the dashboard): creates the connection, the
  webhooks and the script for you.
- **A custom app** (manual, below): works on any plan.

## 1. Custom app

Shopify admin → **Settings → Apps and sales channels → Develop apps → Create an app**. Admin API
scopes: `read_orders` (and `read_customers` for emails). Install it and copy the **Admin API access
token** (`shpat_…`, optional: enables the history backfill) and the app's **API secret key** (it
signs webhooks).

```sh
curl -X POST ".../api/v1/admin/websites/$WEBSITE_ID/integrations/shopify" \
  -H "Authorization: Bearer dgt_…" -H "Content-Type: application/json" \
  -d '{"shopDomain":"your-store.myshopify.com","webhookSecret":"<API secret key>","accessToken":"shpat_…"}'
```

Then add webhooks (app → **Configuration → Webhooks**, or **Settings → Notifications →
Webhooks**, JSON, API version 2025-10) for `orders/paid`, `orders/updated` and `refunds/create`,
all pointing at `https://<your DataGoat>/webhooks/shopify/<websiteId>`. Deliveries are verified
with `X-Shopify-Hmac-Sha256` and must come from the connected shop.

## 2. Storefront snippet

Add the DataGoat (or DataFast) tracking script to your theme, then this snippet just before
`</body>` in `layout/theme.liquid`:

```html
<script>
  (function () {
    function cookie(name) {
      var m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
      return m ? decodeURIComponent(m[1]) : null;
    }
    function sync(tries) {
      var vid = cookie("datagoat_visitor_id") || cookie("datafast_visitor_id");
      if (!vid) return tries > 0 && setTimeout(function () { sync(tries - 1); }, 500);
      var sid = cookie("datagoat_session_id") || cookie("datafast_session_id") || "";
      var key = "datagoat_cart_" + vid + "_" + sid;
      try { if (sessionStorage.getItem(key)) return; } catch (e) {}
      fetch("/cart/update.js", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attributes: { _datagoat_visitor_id: vid, _datagoat_session_id: sid } }),
      }).then(function () {
        try { sessionStorage.setItem(key, "1"); } catch (e) {}
      });
    }
    sync(10);
  })();
</script>
```

Attributes starting with `_` are hidden from customers at checkout. `datagoat_visitor_id`,
`datafast_visitor_id` (with or without the underscore) are all accepted, so an existing DataFast
setup keeps working. Headless stores set the same keys as cart `attributes` through the Storefront
API.

## What is recorded

Paid orders (`financial_status` paid / partially refunded; amount = order total in the shop
currency; orders from subscription contracts are renewals), refunds from `refunds/create` and the
order's `refunds` list (negative, on the order's visitor). Orders without the attribute attribute
through the Shopify customer and email.
