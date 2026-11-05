# DataGoat on Kajabi

## Tracking script

1. In Kajabi go to **Website > Design** (or **Themes**), click **Customize** on your live theme.
2. Open **Settings > Site details** (older themes: **Theme settings > Custom code**) and find
   **Page scripts** / **Header code**.
3. Paste:

   ```html
   <script
     defer
     data-website-id="dgid_XXXXXXXXXXXXXXXX"
     data-domain="example.com"
     src="https://a.example.com/js/script.js"
   ></script>
   ```

   `src` is your collector ([where it lives](README.md#2-where-the-collector-lives)).
4. **Save**. Landing pages built separately have their own **Custom code** setting; add the
   snippet there too.

## Revenue attribution

Connect the Stripe account Kajabi pays out through in DataGoat (Integrations > Stripe). Then, in
**Sales > Offers > (your offer) > Checkout > Thank you page**, add a custom code block that reports
the buyer's email:

```html
<script>
  window.datagoat = window.datagoat || function () { (window.datagoat.q = window.datagoat.q || []).push(arguments); };
  try {
    var params = new URLSearchParams(location.search);
    var email = params.get("email") ||
      (document.querySelector("[data-customer-email]") || {}).textContent ||
      (document.querySelector("input[name='email']") || {}).value;
    if (email) window.datagoat("payment", { email: email.trim() });
  } catch (e) {}
</script>
```

DataGoat matches the email to the payment and attributes it to the visit.

## Verify

Open your Kajabi site, then check **Realtime**; after a test purchase check **Revenue**.
