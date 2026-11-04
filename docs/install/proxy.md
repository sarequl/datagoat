# Proxying the tracker through your own server

When your site's DNS is not on Cloudflare, you can still serve DataGoat from your own domain by
proxying two paths through the server or host that runs your site:

| Your site                     | Forwards to                                           |
| ----------------------------- | ----------------------------------------------------- |
| `GET /js/script.js`           | `GET https://<collector>/js/script.js`                |
| `POST /api/events`            | `POST https://<collector>/api/events`                 |

`<collector>` is your DataGoat Worker's hostname, for example `datagoat.yourname.workers.dev`.
The script tag then uses same-origin paths:

```html
<script
  defer
  data-website-id="dfid_XXXXXXXXXXXXXXXX"
  data-domain="example.com"
  src="/js/script.js"
></script>
```

If your app already has an `/api/events` route, proxy another path (say `/dg/events`) and add
`data-api-url="/dg/events"` to the tag. Use `script.cookieless.js` or `script.hash.js` in the
upstream URL if you use those builds.

> If your DNS **is** on Cloudflare, do not proxy: a [Worker route](cloudflare-route.md) or a
> [custom subdomain](custom-domain.md) needs no code and keeps visitor IP and location exact.

## Rules every proxy must follow

1. **Forward the visitor's IP.** Append it to `X-Forwarded-For` and set `X-Real-IP`. DataGoat
   needs it for IP exclusions, cookieless visitor ids and per-visitor rate limiting; without it,
   every visitor looks like your server.
2. **Send the right `Host`** (the collector's hostname) and, for HTTPS upstreams behind Cloudflare,
   the matching TLS SNI. Most of the guides set this explicitly.
3. **Pass `User-Agent` and `Content-Type` through unchanged.** Devices, browsers and bot filtering
   come from the user agent. Pass `Sec-GPC` through if you honour Global Privacy Control.
4. **Do not forward your site's cookies** to the collector (the tracker sends everything it needs
   in the request body). The guides drop the `Cookie` header.
5. **Do not cache `/api/events`.** `script.js` may be cached for up to an hour.
6. **Keep request bodies small and raw**: events are JSON up to 8 KB, often sent as `text/plain`
   by `navigator.sendBeacon`. Do not parse or re-encode them.

## Location data behind a proxy

Cloudflare geolocates the connection that reaches it. Behind a proxy that connection comes from
your server, so country, region and city can show your server's location even when the IP is
forwarded correctly. If that matters, move to a [Worker route](cloudflare-route.md) or a
[custom subdomain](custom-domain.md) (both need your DNS on Cloudflare), where Cloudflare sees the
visitor directly.

## Guides

[Next.js](proxy-nextjs.md) · [Vercel](proxy-vercel.md) · [Netlify](proxy-netlify.md) ·
[Nginx](proxy-nginx.md) · [Caddy](proxy-caddy.md) · [Express](proxy-express.md) ·
[Laravel](proxy-laravel.md) · [Django](proxy-django.md) · [Flask](proxy-flask.md) ·
[FastAPI](proxy-fastapi.md) · [PHP](proxy-php.md) · [Firebase Hosting](proxy-firebase.md) ·
[DigitalOcean](proxy-digitalocean.md) · [Astro](proxy-astro.md) · [Vue / Vite](proxy-vue.md)

## Verify

In the Network tab, `script.js` and `POST /api/events` both go to your own domain and answer `200`.
Then compare the **Realtime** map with where your visitors really are.
