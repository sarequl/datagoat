# DataGoat on Wix

Custom code needs a Premium plan and a connected domain.

1. In the Wix dashboard go to **Settings > Custom code** (under Advanced) and click **+ Add Custom
   Code**.
2. Paste:

   ```html
   <script
     defer
     data-website-id="dgid_XXXXXXXXXXXXXXXX"
     data-domain="example.com"
     src="https://a.example.com/js/script.js"
   ></script>
   ```

   `src` is your collector ([where it lives](README.md#2-where-the-collector-lives)).
3. Name it "DataGoat", choose **All pages** and **Load code once**, place it in **Head**, and
   click **Apply**.

Wix sites navigate without full page loads; the tracker records each page change.

## Goals and revenue

With Velo (Dev Mode) you can call the tracker from page code:

```js
$w("#signupButton").onClick(() => {
  if (typeof window !== "undefined" && window.datagoat) window.datagoat("signup");
});
```

For Wix Stores, add a second Custom code snippet on the **Thank You page** only that calls
`window.datagoat("payment", { email })` with the buyer's email if your template exposes it.

## Verify

Publish, open the live site and check **Realtime**.
