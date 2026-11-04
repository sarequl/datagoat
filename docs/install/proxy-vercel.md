# Proxy DataGoat on Vercel

Any site on Vercel (static, Vite, SvelteKit, Nuxt, ...) can proxy DataGoat with two rewrites in
`vercel.json`. For Next.js apps, [proxy-nextjs.md](proxy-nextjs.md) does the same in
`next.config.js`. Read the [proxy rules](proxy.md) first.

```json
{
  "rewrites": [
    { "source": "/js/script.js", "destination": "https://datagoat.yourname.workers.dev/js/script.js" },
    { "source": "/api/events", "destination": "https://datagoat.yourname.workers.dev/api/events" }
  ]
}
```

Vercel proxies external rewrites from its edge and passes the visitor's address in
`X-Forwarded-For` and `X-Real-IP`, so no extra configuration is needed for the IP. Rewrites run
after the filesystem: if your build outputs a file at `/js/script.js` or a function at
`/api/events`, rename it or proxy another path and set `data-api-url`.

Script tag:

```html
<script defer data-website-id="dfid_XXXXXXXXXXXXXXXX" data-domain="example.com" src="/js/script.js"></script>
```

Location data: Vercel's edge is the connection Cloudflare sees, so country and city may reflect a
Vercel region rather than the visitor (see [proxy.md](proxy.md#location-data-behind-a-proxy)). If
your domain's DNS is on Cloudflare, prefer a [custom subdomain](custom-domain.md).
