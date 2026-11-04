# DataGoat on Lovable

Lovable writes the code for you, so you ask it to add DataGoat. Have your **website id**
(`dfid_...`), your **domain** and your **collector URL** ready (dashboard: Settings > Tracking;
[where the collector lives](README.md#2-where-the-collector-lives)).

## 1. Prompt: add tracking

Replace the three values, then paste into Lovable's chat:

```text
Add DataGoat analytics to every page of this site.

Put this exact script tag in the <head> of index.html (Vite/React apps: the index.html at the
project root, not a component), so it loads once on every page:

<script defer data-website-id="dfid_XXXXXXXXXXXXXXXX" data-domain="example.com" src="https://a.example.com/js/script.js"></script>

Also add this right before it, so calls made before the script loads are queued:

<script>window.datafast=window.datafast||function(){(window.datafast.q=window.datafast.q||[]).push(arguments)};</script>

Do not load it from a React component or a useEffect, do not change the attributes, and do not
add any other analytics library. Tell me the file you changed.
```

The site is a single-page app; the tracker records route changes by itself.

## 2. Prompt: revenue attribution (Stripe)

Connect your Stripe account in DataGoat first (Integrations > Stripe). Then:

```text
Link Stripe payments to DataGoat visitors. Find how this project creates payments and apply the
matching change:

1. Stripe Checkout Sessions (stripe.checkout.sessions.create, usually in a Supabase Edge
   Function or API route): read the cookies "datafast_visitor_id" and "datafast_session_id" from
   the incoming request (pass them from the browser in the request body if the function cannot
   see cookies: document.cookie) and add them to the session:
   metadata: { datafast_visitor_id, datafast_session_id }
2. Stripe PaymentIntents (stripe.paymentIntents.create): add the same metadata to the
   PaymentIntent.
3. Stripe Payment Links: change nothing in code; tell me to set the link's success URL to end with
   ?session_id={CHECKOUT_SESSION_ID}.
4. Anything else: on the payment success page call
   window.datafast("payment", { email: customerEmail }) with the buyer's email.

Tell me which case you found and what you changed.
```

## 3. Publish and verify

Publish (top right), open the live site and check DataGoat's **Realtime** view. If nothing shows:
the tag must be in the published `index.html`, the website id and domain must match the dashboard,
and the preview inside Lovable's editor does not count (it runs on a Lovable domain).
