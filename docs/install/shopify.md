# DataGoat on Shopify

Connect your store and DataGoat installs the tracker for you (no manual `<script>` tag), tracks
`add_to_cart` and `initiate_checkout` for funnels, and records every paid order and refund with its
traffic source. Like DataFast, it uses a Shopify app that **you** create in your own Shopify
account, so no third party ever holds access to your store.

> If you installed the tracking script in your theme by hand, remove it first, or pageviews are
> counted twice.

## 1. Create the Shopify app (2 minutes)

1. Open the [Shopify Dev Dashboard](https://dev.shopify.com/dashboard) and click **Create app**.
   Name it, for example, "DataGoat".
2. Set the **Webhooks API version** to `2025-10`.
3. Under **Access > Scopes** enable `read_orders`, `read_products`, `read_customers` and
   `write_script_tags`.
4. Click **Release**, then **Install app** on the store you want to connect.
5. In the app's **Settings > Credentials**, copy the **Client ID** and the **Secret**.

## 2. Connect it in DataGoat

In the dashboard: your website → **Integrations > Shopify**. Enter:

- **Shop**: the `xxx.myshopify.com` domain (not your custom domain);
- **Client ID** and **Client secret** from step 1.

Click **Connect Shopify**. (API: `POST /api/apps/shopify/connect?websiteId=<id>` with
`{shop, clientId, clientSecret}`.) DataGoat then:

1. gets an Admin API token with the client-credentials grant;
2. reads the shop name and currency;
3. registers the `orders/paid` and `refunds/create` webhooks (revenue) and `app/uninstalled`;
4. installs the storefront loader as a ScriptTag:
   `https://<your DataGoat>/apps/shopify.js?id=<tracking id>`.

The loader adds the tracker, copies the visitor into hidden cart attributes
(`_datafast_visitor_id`, `_datafast_session_id`) that Shopify carries onto the order, and sends the
`add_to_cart` and `initiate_checkout` goals. It is a static file, so it costs no Worker request.

If the storefront runs on a domain other than the website's domain in DataGoat, the connect
response warns you: add the storefront domain to the website's **allowed hostnames**.

### Apps outside your organization: OAuth install

The client-credentials grant works for apps installed on stores of the organization that owns the
app. For any other store, choose **Install with OAuth**
(`grant: "authorization_code"`): DataGoat stores the credentials, then sends you to Shopify's
consent screen through `/api/apps/shopify/install`. Add
`https://<your DataGoat>/api/apps/shopify/callback` to the app's **Allowed redirection URLs** first.

## 3. Optional: custom pixel

Some carts (app-driven drawers, Shop Pay buttons) do not go through the theme's forms. Shopify's
customer events see them. In Shopify admin → **Settings > Customer events > Add custom pixel**,
paste the code served at `https://<your DataGoat>/api/apps/shopify/pixel.js?websiteId=<tracking id>`
and connect it. The pixel sends `add_to_cart` (`product_added_to_cart`) and `initiate_checkout`
(`checkout_started`) with the visitor cookies the tracker set. To avoid counting the goals twice,
change the ScriptTag's URL to end with `&goals=0`, or ask DataGoat to reinstall it that way.

## Uninstalling

Uninstalling the app in Shopify marks the integration as disconnected (DataGoat receives
`app/uninstalled`). 48 hours later Shopify sends `shop/redact`, and DataGoat deletes the stored
credentials and the customer emails and names of that store's orders; revenue totals stay.
`customers/redact` requests remove a customer's email and name from their orders.

## Verify

Visit the store: pageviews appear in Realtime within seconds. Place a test order (or wait for the
next real one): it appears under Revenue with its channel.
