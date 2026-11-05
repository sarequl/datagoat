# DataGoat on v0 by Vercel

v0 generates Next.js projects. Ask it to add DataGoat to the root layout, or add it yourself after
exporting. Have your **website id**, **domain** and **collector URL** ready
([where the collector lives](README.md#2-where-the-collector-lives)).

## Prompt: add tracking

```text
Add DataGoat analytics to app/layout.tsx. Inside <head> render exactly:

<script
  dangerouslySetInnerHTML={{ __html: "window.datagoat=window.datagoat||function(){(window.datagoat.q=window.datagoat.q||[]).push(arguments)};" }}
/>
<script defer data-website-id="dgid_XXXXXXXXXXXXXXXX" data-domain="example.com" src="https://a.example.com/js/script.js"></script>

Do not load it in a client component or useEffect. Keep the attributes exactly as written.
```

Or install the SDK and use its component (works in a server component):

```tsx
import { DataGoatScript } from "@datagoat/sdk/next";
// in <head>:
<DataGoatScript websiteId="dgid_XXXXXXXXXXXXXXXX" domain="example.com" host="https://a.example.com" />
```

To serve DataGoat from your own Vercel domain, add the rewrites from
[proxy-nextjs.md](proxy-nextjs.md) and drop `host`.

## Prompt: revenue attribution

Connect Stripe (or your provider) in DataGoat first.

```text
In the route handler or server action that creates the Stripe Checkout Session (or
PaymentIntent), add DataGoat's visitor metadata:

import { cookies } from "next/headers";
import { checkoutMetadata } from "@datagoat/sdk/next";

metadata: { ...checkoutMetadata(await cookies()) }

If the project uses Stripe Payment Links instead, tell me to set the success URL to end with
?session_id={CHECKOUT_SESSION_ID}. If payments happen another way, call
window.datagoat("payment", { email }) on the success page.
```

## Verify

Deploy to Vercel, open the production URL and check **Realtime**. v0's preview runs on a v0
domain and is not tracked.
