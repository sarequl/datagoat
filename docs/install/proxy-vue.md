# Proxy DataGoat with Vue (Vite, Nuxt)

Read the [proxy rules](proxy.md) first.

## Vue with Vite (an SPA)

A built Vue SPA is static files, so production proxying happens where you host it:
[Vercel](proxy-vercel.md), [Netlify](proxy-netlify.md), [Firebase](proxy-firebase.md),
[Nginx](proxy-nginx.md), [Caddy](proxy-caddy.md), or a [Worker route](cloudflare-route.md) /
[custom subdomain](custom-domain.md) with DNS on Cloudflare.

For local development, Vite's dev server can proxy the same paths so the production tag works
unchanged (add `data-allow-localhost="true"` while developing):

```ts
// vite.config.ts
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const COLLECTOR = "https://datagoat.yourname.workers.dev";

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      "/js/script.js": { target: COLLECTOR, changeOrigin: true, xfwd: true },
      "/api/events": { target: COLLECTOR, changeOrigin: true, xfwd: true },
    },
  },
});
```

`changeOrigin` sends the Workers hostname as `Host` and SNI; `xfwd` adds `X-Forwarded-For`.

## Nuxt 3/4

Route rules proxy in production too (Nitro):

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  routeRules: {
    "/js/script.js": { proxy: "https://datagoat.yourname.workers.dev/js/script.js" },
    "/api/events": { proxy: "https://datagoat.yourname.workers.dev/api/events" },
  },
});
```

Nitro's proxy forwards the body and headers and adds `X-Forwarded-For` (on Vercel and Netlify the
platform's edge does the proxying and sets it).

## Script tag

`index.html` (Vite) or `app.head` in `nuxt.config.ts` (see [vue.md](vue.md)):

```html
<script defer data-website-id="dgid_XXXXXXXXXXXXXXXX" data-domain="example.com" src="/js/script.js"></script>
```
