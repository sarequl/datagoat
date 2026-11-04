# Proxy DataGoat with Astro

Read the [proxy rules](proxy.md) first. Which way depends on how the site is built.

## Static build (`output: "static"`)

A static Astro site has no server to proxy with. Proxy at the host:
[Vercel](proxy-vercel.md), [Netlify](proxy-netlify.md), [Firebase](proxy-firebase.md),
[Nginx](proxy-nginx.md), [Caddy](proxy-caddy.md); or, with DNS on Cloudflare, a
[Worker route](cloudflare-route.md) or [custom subdomain](custom-domain.md). Cloudflare Pages
sites can add the [Worker route](cloudflare-route.md) on the same zone.

## Server or hybrid output (an adapter is installed)

Two endpoints:

```ts
// src/pages/api/events.ts
import type { APIRoute } from "astro";

export const prerender = false;
const COLLECTOR = import.meta.env.DATAGOAT_HOST ?? "https://datagoat.yourname.workers.dev";

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const prior = request.headers.get("x-forwarded-for");
  const headers: Record<string, string> = {
    "content-type": request.headers.get("content-type") ?? "text/plain",
    "user-agent": request.headers.get("user-agent") ?? "",
    "x-real-ip": clientAddress,
    "x-forwarded-for": prior ? `${prior}, ${clientAddress}` : clientAddress,
  };
  const gpc = request.headers.get("sec-gpc");
  if (gpc) headers["sec-gpc"] = gpc;
  const upstream = await fetch(`${COLLECTOR}/api/events`, {
    method: "POST",
    headers,
    body: await request.text(),
  });
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    },
  });
};
```

```ts
// src/pages/js/script.js.ts   (served at /js/script.js)
import type { APIRoute } from "astro";

export const prerender = false;
const COLLECTOR = import.meta.env.DATAGOAT_HOST ?? "https://datagoat.yourname.workers.dev";

export const GET: APIRoute = async () => {
  const upstream = await fetch(`${COLLECTOR}/js/script.js`);
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
};
```

`clientAddress` is the visitor's address as your adapter sees it (Node adapter: the socket peer;
Vercel, Netlify and Cloudflare adapters: the platform's client IP).

## Script tag

In your base layout (see [astro.md](astro.md)):

```astro
<script is:inline defer data-website-id="dfid_XXXXXXXXXXXXXXXX" data-domain="example.com" src="/js/script.js"></script>
```

`is:inline` stops Astro from bundling the tag.
