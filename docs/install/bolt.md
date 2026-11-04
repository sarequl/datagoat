# DataGoat on Bolt

Bolt (bolt.new) generates the code, so ask it to add DataGoat. Have your **website id**, **domain**
and **collector URL** ready ([where the collector lives](README.md#2-where-the-collector-lives)).

## 1. Prompt: add tracking

```text
Add DataGoat analytics to the whole site.

- Plain HTML / Vite: put this exact tag in the <head> of index.html.
- Next.js: render it in the root layout's <head> (app/layout.tsx), or use next/script with
  strategy="afterInteractive" and the same attributes.
- Astro: put it in the base layout's <head> with is:inline.

<script defer data-website-id="dfid_XXXXXXXXXXXXXXXX" data-domain="example.com" src="https://a.example.com/js/script.js"></script>

Add this before it so early calls are queued:
<script>window.datafast=window.datafast||function(){(window.datafast.q=window.datafast.q||[]).push(arguments)};</script>

Keep the attributes exactly as written. Tell me which file you changed.
```

## 2. Prompt: revenue attribution

Connect your payment provider in DataGoat first (Integrations).

```text
Link payments to DataGoat visitors.
- Stripe Checkout or PaymentIntents: read the "datafast_visitor_id" and "datafast_session_id"
  cookies on the server that creates the session (or send document.cookie values from the client)
  and add them as metadata: { datafast_visitor_id, datafast_session_id }.
  In Node you can use: import { checkoutMetadata } from "@datagoat/sdk/server";
  metadata: checkoutMetadata(request)
- Lemon Squeezy: add them as checkout_data.custom.
- Polar: add them as checkout metadata.
- Anything else: on the success page call window.datafast("payment", { email }).
Tell me what you found and changed.
```

## 3. Deploy and verify

Deploy (Bolt's Netlify deploy or your own host), open the live site and check **Realtime**.
Bolt's in-editor preview runs on a WebContainer domain and is not tracked unless you add that
hostname to the website's allowed hostnames.
