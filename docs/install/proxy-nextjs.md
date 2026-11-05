# Proxy DataGoat with Next.js

Serve the tracker and the collector from your Next.js app. Read the [proxy rules](proxy.md) first;
if your DNS is on Cloudflare, a [Worker route](cloudflare-route.md) needs no code at all.

## Option A: rewrites (simplest)

With the SDK:

```js
// next.config.mjs
import { withDataGoat } from "@datagoat/sdk/next";

export default withDataGoat(
  { /* your existing config */ },
  { host: "https://datagoat.yourname.workers.dev" },
);
```

Or by hand:

```js
// next.config.js
module.exports = {
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/js/script.js", destination: "https://datagoat.yourname.workers.dev/js/script.js" },
        { source: "/api/events", destination: "https://datagoat.yourname.workers.dev/api/events" },
      ],
    };
  },
};
```

`beforeFiles` makes the rewrites win over your own `public/` files and routes. Next.js proxies
external rewrites with `X-Forwarded-For` set to the visitor's address (`next start` and Vercel
both do). If your app runs behind another load balancer and every visitor shows the same IP, use
option B, which sets the headers explicitly.

## Option B: route handlers (explicit header control)

```ts
// app/api/events/route.ts
const COLLECTOR = process.env.DATAGOAT_HOST ?? "https://datagoat.yourname.workers.dev";

export async function POST(req: Request) {
  const forwardedFor = req.headers.get("x-forwarded-for");
  const realIp = req.headers.get("x-real-ip") ?? forwardedFor?.split(",")[0]?.trim() ?? "";
  const headers: Record<string, string> = {
    "content-type": req.headers.get("content-type") ?? "text/plain",
    "user-agent": req.headers.get("user-agent") ?? "",
    "x-forwarded-for": forwardedFor ?? realIp,
    "x-real-ip": realIp,
  };
  const gpc = req.headers.get("sec-gpc");
  if (gpc) headers["sec-gpc"] = gpc;
  const res = await fetch(`${COLLECTOR}/api/events`, {
    method: "POST",
    headers,
    body: await req.text(),
    cache: "no-store",
  });
  return new Response(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}
```

```ts
// app/js/script.js/route.ts   (a folder named "script.js")
const COLLECTOR = process.env.DATAGOAT_HOST ?? "https://datagoat.yourname.workers.dev";

export async function GET() {
  const res = await fetch(`${COLLECTOR}/js/script.js`, { next: { revalidate: 3600 } });
  return new Response(await res.text(), {
    status: res.status,
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
```

## Script tag

```tsx
// app/layout.tsx
import { DataGoatScript } from "@datagoat/sdk/next";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <DataGoatScript websiteId="dgid_XXXXXXXXXXXXXXXX" domain="example.com" />
      </head>
      <body>{children}</body>
    </html>
  );
}
```

Without `host`, the SDK renders `src="/js/script.js"` and the tracker posts to `/api/events` on
your domain. Using `next/script` instead works too:
`<Script src="/js/script.js" data-website-id="..." data-domain="example.com" strategy="afterInteractive" />`.

## Verify

Deploy, open your site, and check that `script.js` and `POST /api/events` go to your own domain.
