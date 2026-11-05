# DataGoat with Easytool

DataFast has a built-in Easytool integration: Easytool itself sends payments, `add_to_cart` and
`initiate_checkout` to DataFast's servers. That integration is operated by Easytool and talks only
to DataFast, so it cannot be pointed at a self-hosted DataGoat.

What works with DataGoat:

1. **Pageviews and goals**: if your Easytool store or checkout page lets you add custom head code
   (Store settings > Analytics / Custom code), paste the DataGoat snippet:

   ```html
   <script
     defer
     data-website-id="dgid_XXXXXXXXXXXXXXXX"
     data-domain="example.com"
     src="https://a.example.com/js/script.js"
   ></script>
   ```

   and add `data-allowed-hostnames="cart.easy.tools"` (or your checkout domain) to the snippet on
   your own site, so the visitor keeps the same id from your site to the checkout.
2. **Revenue**: send each sale to DataGoat's DataFast-compatible Payments API from an Easytool
   webhook or an automation tool (Zapier, Make, n8n):

   ```http
   POST https://a.example.com/api/v1/payments
   Authorization: Bearer dg_your_website_key
   Content-Type: application/json

   {"amount": 49, "currency": "USD", "transaction_id": "<easytool order id>", "email": "<buyer email>"}
   ```

   With the buyer's email, DataGoat attributes the sale to the visitor who reported the same email
   (`window.datagoat("payment", {email})` on the thank-you page, or `identify`). With the visitor
   id in your checkout's custom fields, pass it as `datagoat_visitor_id` instead.

If Easytool's checkout is also paid out through Stripe, connecting that Stripe account in DataGoat
records the payments automatically; the email or visitor id still links them to the visit.
