# DataGoat on Squarespace

Code Injection needs a Core, Plus, Advanced (or legacy Business/Commerce) plan.

1. Go to **Settings > Developer Tools > Code Injection** (older sites: **Settings > Advanced > Code
   Injection**).
2. In **Header**, paste:

   ```html
   <script
     defer
     data-website-id="dfid_XXXXXXXXXXXXXXXX"
     data-domain="example.com"
     src="https://a.example.com/js/script.js"
   ></script>
   ```

   `src` is your collector ([where it lives](README.md#2-where-the-collector-lives)).
3. **Save**.

## Squarespace Commerce revenue

In **Code Injection > Order Confirmation Page**, Squarespace replaces order placeholders such as
`{customerEmailAddress}` and `{orderId}` in the injected code. Report the customer's email so
DataGoat can link the payment to the visitor (connect the Stripe account behind Squarespace
Payments in DataGoat, or send orders with the Payments API):

```html
<script>
  window.datafast = window.datafast || function () { (window.datafast.q = window.datafast.q || []).push(arguments); };
  window.datafast("payment", { email: "{customerEmailAddress}" });
</script>
```

## Verify

Open the live site in a private window (logged-in editors are tracked too) and check **Realtime**.
