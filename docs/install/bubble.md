# DataGoat on Bubble

Custom header scripts need a paid Bubble plan.

1. In the editor open **Settings > SEO / metatags**.
2. In **Script/meta tags in header**, paste:

   ```html
   <script
     defer
     data-website-id="dfid_XXXXXXXXXXXXXXXX"
     data-domain="example.com"
     src="https://a.example.com/js/script.js"
   ></script>
   ```

   `src` is your collector ([where it lives](README.md#2-where-the-collector-lives)).
3. Deploy to Live. The header code runs on every page of the live app.

## Goals and identify from workflows

Install a plugin that runs JavaScript (for example "Toolbox" with its **Run javascript** action)
and add actions to your workflows:

```js
window.datafast && window.datafast("signup");
```

```js
window.datafast && window.datafast("identify", { user_id: "Current User's unique id", name: "Current User's name" });
```

(insert the dynamic values with Bubble's expression editor).

## Revenue

If you charge with Stripe, connect the Stripe account in DataGoat. On your payment success page,
run `window.datafast("payment", { email: "Current User's email" })` so DataGoat can attribute the
payment to the visit.

## Verify

Open the live app and check **Realtime**.
