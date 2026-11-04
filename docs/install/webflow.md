# DataGoat on Webflow

Custom code needs a paid Site plan (or a Workspace plan that allows it).

1. In the Webflow Designer open **Site settings > Custom code**.
2. In **Head code**, paste:

   ```html
   <script
     defer
     data-website-id="dfid_XXXXXXXXXXXXXXXX"
     data-domain="example.com"
     src="https://a.example.com/js/script.js"
   ></script>
   ```

   `src` is your collector ([where it lives](README.md#2-where-the-collector-lives)). With DNS on
   Cloudflare, a [custom subdomain](custom-domain.md) such as `a.example.com` keeps the script
   first-party.
3. **Save changes**, then **Publish** to your custom domain (custom code does not run in the
   Designer preview).

## Goals without code

Give any button or link the custom attribute `data-fast-goal` = `signup` (Element settings >
Custom attributes). Extra attributes `data-fast-goal-plan` = `pro` become goal parameters.

## Webflow Ecommerce revenue

Webflow Ecommerce charges through your Stripe account: connect it in DataGoat (Integrations >
Stripe) and the orders arrive as payments. To attribute them to the visit, report the buyer's email
on the order confirmation page. Add an Embed element to that template; the selector below finds the
email in Webflow's default confirmation layout, adjust it if your template differs:

```html
<script>
  window.datafast = window.datafast || function () { (window.datafast.q = window.datafast.q || []).push(arguments); };
  var email = document.querySelector(".w-commerce-commerceorderconfirmationcontainer [href^='mailto:']");
  if (email) window.datafast("payment", { email: (email.textContent || "").trim() });
</script>
```

DataGoat matches the email with the Stripe payment and attributes it to the visitor.

## Verify

Open the published site and check the dashboard's **Realtime** view.
