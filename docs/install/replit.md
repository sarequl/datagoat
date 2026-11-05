# DataGoat on Replit

Whether you code by hand or with Replit Agent, the tracker goes into the page `<head>` of your
deployed app. Have your **website id**, **domain** and **collector URL** ready
([where the collector lives](README.md#2-where-the-collector-lives)).

## By hand

Add to the `<head>` of every page (for a React/Vite app: `index.html`; Flask/Django: the base
template; Express: the layout that renders `<head>`):

```html
<script defer data-website-id="dgid_XXXXXXXXXXXXXXXX" data-domain="example.com" src="https://a.example.com/js/script.js"></script>
```

## With Replit Agent

```text
Add DataGoat analytics. Insert this exact tag in the <head> that every page renders (index.html
for Vite/React, the base template for server-rendered apps), once, without changing attributes:

<script defer data-website-id="dgid_XXXXXXXXXXXXXXXX" data-domain="example.com" src="https://a.example.com/js/script.js"></script>

Tell me which file you changed.
```

## Revenue attribution

Connect your provider in DataGoat (Integrations), then ask the Agent:

```text
When this app creates a Stripe Checkout Session or PaymentIntent on the server, read the
"datagoat_visitor_id" and "datagoat_session_id" cookies from the request and add them as
metadata: { datagoat_visitor_id, datagoat_session_id }. For Lemon Squeezy put them in
checkout_data.custom; for Polar in the checkout metadata. If payments happen some other way, call
window.datagoat("payment", { email }) on the success page. Tell me what you changed.
```

Python apps can read the cookies with `request.cookies.get("datagoat_visitor_id")` (Flask) or
`request.COOKIES.get(...)` (Django); Node apps can use `checkoutMetadata(req)` from
`@datagoat/sdk/server`.

## Verify

Deploy (Replit Deployments; the workspace webview is not your domain), open the deployed URL and
check **Realtime**. If you serve the app on a `*.replit.app` address, set that as the website's
domain or add it to the allowed hostnames.
