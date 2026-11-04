# DataGoat on Podia

## Tracking script

1. In Podia go to **Settings > Third party code** (older accounts: **Site > Settings > Advanced >
   Custom HTML head code**).
2. In the **Head code** field, paste:

   ```html
   <script
     defer
     data-website-id="dfid_XXXXXXXXXXXXXXXX"
     data-domain="example.com"
     src="https://a.example.com/js/script.js"
   ></script>
   ```

   `src` is your collector ([where it lives](README.md#2-where-the-collector-lives)).
3. **Save changes**.

## Revenue attribution

Connect the Stripe account Podia pays you through in DataGoat (Integrations > Stripe). In
**Settings > Third party code > Conversion tracking code** (it runs only after a successful
purchase), paste:

```html
<script>
  window.datafast = window.datafast || function () { (window.datafast.q = window.datafast.q || []).push(arguments); };
  try {
    if (typeof Podia !== "undefined" && Podia.Conversion && Podia.Conversion.customer) {
      window.datafast("payment", { email: Podia.Conversion.customer.email });
    }
  } catch (e) {}
</script>
```

## Verify

Open your Podia site and check **Realtime**; after a test purchase check **Revenue**.
