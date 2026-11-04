# WooCommerce

DataGoat attributes WooCommerce orders through the order meta field **`_datagoat_visitor_id`**,
which the DataGoat WordPress plugin writes at checkout from the visitor cookie (with
`_datagoat_session_id`). ([How attribution works](README.md))

## With the DataGoat WordPress plugin (recommended)

Install the plugin, open **Settings → DataGoat**, connect your site. The plugin adds the tracking
script, writes the order meta and registers the order webhook; the connection appears under
**Integrations → WooCommerce**.

## Manual setup

1. WooCommerce → **Settings → Advanced → Webhooks → Add webhook**: topic **Order updated** (add
   **Order created** too), delivery URL `https://<your DataGoat>/webhooks/woocommerce/<websiteId>`,
   API version v3, and a secret.
2. Optional, for importing past orders: **Settings → Advanced → REST API → Add key** with **Read**
   permission.
3. Connect:

```sh
curl -X POST ".../api/v1/admin/websites/$WEBSITE_ID/integrations/woocommerce" \
  -H "Authorization: Bearer dft_…" -H "Content-Type: application/json" \
  -d '{"storeUrl":"https://shop.example.com","webhookSecret":"…","consumerKey":"ck_…","consumerSecret":"cs_…"}'
```

4. Without the plugin, store the visitor id on the order yourself, for example in your theme's
   `functions.php`:

```php
add_action('woocommerce_checkout_create_order', function ($order) {
  if (!empty($_COOKIE['datafast_visitor_id'])) {
    $order->update_meta_data('_datagoat_visitor_id', sanitize_text_field($_COOKIE['datafast_visitor_id']));
  }
  if (!empty($_COOKIE['datafast_session_id'])) {
    $order->update_meta_data('_datagoat_session_id', sanitize_text_field($_COOKIE['datafast_session_id']));
  }
});
```

Deliveries are verified with `X-WC-Webhook-Signature`; WooCommerce's unsigned creation ping is
acknowledged.

## What is recorded

Orders once paid (`processing` / `completed` with a paid date; amount = order total), refunds from
the order's `refunds` list (negative), WooCommerce Subscriptions renewal orders as renewals. Orders
without the meta attribute through the customer and billing email.
