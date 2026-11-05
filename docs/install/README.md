# Installing DataGoat on your site

DataGoat's tracker uses the same script tag and attributes as DataFast, and its `window.datagoat()`
API also answers to `window.datafast()`, so every DataFast installation method works with DataGoat
once you point it at your own collector (add `data-compat="datafast"` to keep DataFast's cookie
names; see [switching from DataFast](../switching-from-datafast.md)). This folder has a guide for
each platform and each way of serving the collector.

## 1. The snippet

Your website's tracking id is in the dashboard under **Settings > Tracking**. Paste this in the
`<head>` of every page:

```html
<script
  defer
  data-website-id="dgid_XXXXXXXXXXXXXXXX"
  data-domain="example.com"
  src="https://a.example.com/js/script.js"
></script>
```

- `data-website-id`: the tracking id. If you are moving from DataFast you can keep your existing id
  (DataGoat accepts any id you imported).
- `data-domain`: your root domain, so the visitor cookie covers `www.` and every subdomain.
- `src`: where your DataGoat collector serves the tracker. Pick the address in step 2.
- Other builds: `script.cookieless.js` (no cookies) and `script.hash.js` (hash-based routers).
- Other attributes (`data-api-url`, `data-allowed-hostnames`, `data-allow-localhost`,
  `data-debug`, `data-disable-payments`, ...) behave as DataFast documents them.

To call goals or `identify` before the script has loaded, add the queue first:

```html
<script>
  window.datagoat = window.datagoat || function () {
    (window.datagoat.q = window.datagoat.q || []).push(arguments);
  };
</script>
```

## 2. Where the collector lives

The collector is your DataGoat Worker: it serves `/js/script.js` (a static asset that costs no Worker
request) and receives `/api/events`. Choose, in this order of preference:

| Setup                                                                  | Code needed | Visitor IP and location               | First-party cookies | Guide                                   |
| ---------------------------------------------------------------------- | ----------- | ------------------------------------- | ------------------- | --------------------------------------- |
| **Worker route on your own zone** (`example.com/js/script.js`)         | none        | exact (Cloudflare sees the visitor)   | yes                 | [cloudflare-route.md](cloudflare-route.md) |
| **Custom subdomain** (`a.example.com`)                                 | none        | exact                                 | yes                 | [custom-domain.md](custom-domain.md)    |
| **Proxy through your own server or host** (`/js/script.js` on your app) | a few lines | IP forwarded by you; see the caveat   | yes                 | [proxy.md](proxy.md)                    |
| `*.workers.dev`                                                        | none        | exact                                 | script-set only     | this page                               |

Setups 1 and 2 are DataGoat's equivalent of DataFast's "managed proxy": your visitors talk to
Cloudflare directly under your own domain, so there is nothing to maintain and nothing that can
drop the visitor's IP. Use a proxy only when your site is not on Cloudflare DNS.

## 3. Platform guides

**Website builders and CMS:** [WordPress](wordpress.md) · [WooCommerce](woocommerce.md) ·
[Shopify](shopify.md) · [Webflow](webflow.md) · [Framer](framer.md) ·
[Squarespace](squarespace.md) · [Wix](wix.md) · [Ghost](ghost.md) · [Bubble](bubble.md) ·
[Kajabi](kajabi.md) · [Podia](podia.md) · [Easytool](easytool.md) ·
[Google Tag Manager](google-tag-manager.md)

**AI app builders:** [Lovable](lovable.md) · [Bolt](bolt.md) · [Replit](replit.md) ·
[v0 by Vercel](vercel-v0.md)

**Frameworks:** [Next.js](nextjs.md) · [React Router / Remix](react-router.md) · [Vue](vue.md) ·
[Astro](astro.md) · [Django](django.md) · [Laravel](laravel.md) · [npm package](npm.md)

**Apps:** [React Native / Expo](react-native.md) · [Web-to-app funnels](web-to-app.md) ·
[DataGoat mobile app](mobile-app.md)

**Proxies:** [overview](proxy.md) · [Cloudflare route](cloudflare-route.md) ·
[custom subdomain](custom-domain.md) · [Next.js](proxy-nextjs.md) · [Vercel](proxy-vercel.md) ·
[Netlify](proxy-netlify.md) · [Nginx](proxy-nginx.md) · [Caddy](proxy-caddy.md) ·
[Express](proxy-express.md) · [Laravel](proxy-laravel.md) · [Django](proxy-django.md) ·
[Flask](proxy-flask.md) · [FastAPI](proxy-fastapi.md) · [PHP](proxy-php.md) ·
[Firebase Hosting](proxy-firebase.md) · [DigitalOcean](proxy-digitalocean.md) ·
[Astro](proxy-astro.md) · [Vue / Vite](proxy-vue.md)

## 4. Check it works

1. Open your live site (not `localhost`, unless you added `data-allow-localhost="true"`).
2. In the browser's Network tab, `script.js` loads from your collector and a request to
   `/api/events` answers `200`.
3. The visit appears in the dashboard's **Realtime** view within a few seconds.

Nothing showing up? Ad blockers block some setups (use setup 1 or 2), a Content Security Policy may
block the script (allow your collector host in `script-src` and `connect-src`), and visits from your
own browser are ignored if `localStorage.datagoat_ignore` (or DataFast's
`datafast_ignore`) is `"true"`.
