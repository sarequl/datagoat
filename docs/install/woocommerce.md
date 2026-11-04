# DataGoat on WooCommerce

Like DataFast's WooCommerce integration, DataGoat then:

- tracks visitors (pageviews, referrers, devices, countries, ...);
- sends the `add_to_cart` and `initiate_checkout` goals, ready for conversion funnels;
- records every order's revenue and attributes it to the visit it came from.

## 1. Install the plugin

Install and configure the [DataGoat WordPress plugin](wordpress.md). Keep **Send add_to_cart and
initiate_checkout goals** checked.

At checkout (classic checkout and the checkout block, HPOS or not) the plugin copies the visitor's
`datafast_visitor_id` and `datafast_session_id` cookies onto the order as the meta fields
`_datagoat_visitor_id` and `_datagoat_session_id`. That is what lets DataGoat attribute the order.

## 2. Connect the store

1. In the DataGoat dashboard open your website, then **Integrations > WooCommerce**.
2. Enter your store URL (`https://shop.example.com`) and click **Connect WooCommerce**.
   (The dashboard sends you to
   `/api/apps/woocommerce/connect?websiteId=<id>&storeUrl=<store>`.)
3. You land on your store's WooCommerce approval screen ("DataGoat would like to connect to your
   store"). Make sure you are logged in as an administrator and click **Approve**.
4. You are sent back to DataGoat. The connection is stored encrypted; DataGoat then reads the
   store currency and registers `order.created` and `order.updated` webhooks pointing to your
   instance.

The approval creates a WooCommerce REST API key with read/write access (write is needed to create
the webhooks). You can see and revoke it under **WooCommerce > Settings > Advanced > REST API**.

Requirements: the store must be reachable over HTTPS (WooCommerce requires it for the key
callback), WordPress permalinks must not be "Plain" (the REST API needs pretty permalinks), and a
security plugin must not block `/wc-auth/v1/authorize` or `/wp-json/wc/v3/`.

## Verify

Browse the store, add something to the cart and place a test order. The goals appear in the
dashboard right away; the order appears under Revenue once DataGoat has received the webhook.

## Troubleshooting

- **"Invalid or expired connection request"**: the approval took longer than 30 minutes; start
  again from the dashboard.
- **Orders without a source**: the visitor had no tracking cookie (ad blocker, consent not given,
  or the tracker is excluded on the checkout page by a caching plugin).
- **Webhooks missing** (the integration shows an error): create them under
  WooCommerce > Settings > Advanced > Webhooks with topic "Order updated", delivery URL
  `https://<your DataGoat>/webhooks/woocommerce/<website id>`, or disconnect and connect again.
