# Collector on your own domain with a Cloudflare Worker route

If your site's DNS is on Cloudflare (the orange cloud), add routes so that two paths of **your**
domain go straight to your DataGoat Worker. Visitors then load the tracker from
`https://example.com/js/script.js` and send events to `https://example.com/api/events`: fully
first-party, invisible to ad-block lists that target analytics hosts, and Cloudflare sees each
visitor's real IP and location. Nothing else on your site changes.

## 1. Add the routes

Both paths must go to the Worker:

| Route                         | Why                                                       |
| ----------------------------- | --------------------------------------------------------- |
| `example.com/js/script*`      | the tracker builds (`script.js`, `script.cookieless.js`, `script.hash.js`) |
| `example.com/api/events*`     | the collector                                             |

Add `www.example.com/...` too if your site is served on `www`.

**In the Cloudflare dashboard:** Workers & Pages → your DataGoat Worker → Settings → Domains &
Routes → Add → Route. Zone: `example.com`, route: `example.com/js/script*`. Repeat for
`example.com/api/events*`.

**Or in `wrangler.jsonc`** (the update workflow keeps your `routes`):

```jsonc
"routes": [
  { "pattern": "example.com/js/script*", "zone_name": "example.com" },
  { "pattern": "example.com/api/events*", "zone_name": "example.com" }
]
```

then `npm run deploy`.

The Worker answers events only at `/api/events`. If your site already uses that path for
something else, use a [custom subdomain](custom-domain.md) instead of a route.

## 2. Update the script tag

```html
<script
  defer
  data-website-id="dfid_XXXXXXXXXXXXXXXX"
  data-domain="example.com"
  src="/js/script.js"
></script>
```

No `data-api-url` is needed: the tracker posts to `/api/events` on your page's origin, which is now
the Worker.

## Notes

- **Caching:** the tracker is a static asset of the Worker, so serving it costs no Worker request
  and stays available even if a Free-plan account reaches its daily request limit.
- **Page rules and Cache Rules** on your zone apply to these paths too. Do not cache `/api/events`.
- **Security products:** if Bot Fight Mode or a WAF rule challenges requests, exempt
  `/api/events` (a `POST` from `navigator.sendBeacon` cannot solve a challenge).
- **Several sites:** each site's zone gets its own two routes to the same Worker. Each site keeps
  its own `data-website-id`.

## Verify

Open your site, check in the Network tab that `script.js` comes from your own domain and that the
`POST /api/events` answers `200`, then look at **Realtime** in the dashboard.
