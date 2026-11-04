# DataGoat with Next.js

## App Router

```tsx
// app/layout.tsx
import { DataGoatScript } from "@datagoat/sdk/next";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <DataGoatScript
          websiteId="dfid_XXXXXXXXXXXXXXXX"
          domain="example.com"
          host="https://a.example.com"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
```

`npm install @datagoat/sdk`. `DataGoatScript` is a server component: it renders the pre-load queue
and `<script defer data-website-id=... src="https://a.example.com/js/script.js">`. Without the SDK,
use `next/script`:

```tsx
import Script from "next/script";

<Script
  src="https://a.example.com/js/script.js"
  data-website-id="dfid_XXXXXXXXXXXXXXXX"
  data-domain="example.com"
  strategy="afterInteractive"
/>
```

## Pages Router

Put the same `<DataGoatScript ... />` (or the `next/script` tag) in `pages/_document.tsx` inside
`<Head>`, or `next/script` in `pages/_app.tsx`.

Route changes are tracked automatically by the tracker (it follows the History API), so no
`usePathname` effect is needed.

## Goals and identify

```tsx
"use client";
import { track, identify } from "@datagoat/sdk";

<button onClick={() => track("signup_click", { plan: "pro" })}>Start</button>
// after sign-in:
identify(user.id, { name: user.name });
```

Declarative goals work too: `<button data-fast-goal="signup_click" data-fast-goal-plan="pro">`.

## Revenue attribution (Stripe Checkout)

```ts
// app/api/checkout/route.ts
import { cookies } from "next/headers";
import Stripe from "stripe";
import { checkoutMetadata } from "@datagoat/sdk/next";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function POST() {
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: process.env.PRICE_ID!, quantity: 1 }],
    success_url: "https://example.com/thanks?session_id={CHECKOUT_SESSION_ID}",
    cancel_url: "https://example.com/pricing",
    metadata: checkoutMetadata(await cookies()),
  });
  return Response.json({ url: session.url });
}
```

`checkoutMetadata` returns `{datafast_visitor_id, datafast_session_id}` when the visitor has
valid tracking cookies, and `{}` otherwise. Use it the same way for PaymentIntents (`metadata`),
Polar (`metadata`) and Lemon Squeezy (`lemonSqueezyCheckoutData(...)` as `checkout_data`).

## First-party proxy

To serve the tracker from your own domain, see [proxy-nextjs.md](proxy-nextjs.md)
(`withDataGoat()` in `next.config.mjs`, then drop `host`).
