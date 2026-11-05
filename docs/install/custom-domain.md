# Collector on a custom subdomain

Serve your DataGoat Worker on a subdomain of your site, such as `a.example.com`. The tracker and
the collector are then on your own domain, the visitor cookie is set for `.example.com`, and
Cloudflare sees each visitor directly (exact IP and location). This is DataGoat's equivalent of
DataFast's managed proxy, except that it runs in your own Cloudflare account.

Requirement: the domain's DNS zone is on Cloudflare (it may be on the Free plan). If it is not, use
a [proxy](proxy.md) on your own server instead.

## 1. Pick a neutral name

Use something short that does not say "analytics": `a`, `cdn`, `s`, `t1`. Blocklists target names
such as `analytics.`, `tracking.`, `metrics.` and `stats.`. Do not use your main hostname.

## 2. Attach it to the Worker

**Dashboard:** Workers & Pages → your DataGoat Worker → Settings → Domains & Routes → Add →
Custom domain → `a.example.com`. Cloudflare creates the DNS record and the certificate
(usually within a minute or two).

**Or `wrangler.jsonc`** (kept by the update workflow), then `npm run deploy`:

```jsonc
"routes": [{ "pattern": "a.example.com", "custom_domain": true }]
```

The same hostname also serves your dashboard (`https://a.example.com/`), which is convenient. If you
prefer to keep the dashboard elsewhere, give the collector its own custom domain and use that one in
the script tag.

## 3. Update the script tag

Use the full URL in both `src` and `data-api-url`. A relative `data-api-url` would resolve against
the page's host, not the collector's.

```html
<script
  defer
  data-website-id="dgid_XXXXXXXXXXXXXXXX"
  data-domain="example.com"
  data-api-url="https://a.example.com/api/events"
  src="https://a.example.com/js/script.js"
></script>
```

`data-domain` stays your real site domain, not the subdomain.

For local development add `data-allow-localhost="true"` and keep the full collector URLs.

## Troubleshooting

- **Certificate pending:** wait a few minutes; the hostname must not already have a DNS record
  pointing elsewhere.
- **Events blocked:** check that the name is neutral and that the page loads `script.js` from your
  subdomain, not from `*.workers.dev`.
- **Content Security Policy:** allow `https://a.example.com` in `script-src` and `connect-src`.
- **Events go to your main site:** `data-api-url` is missing or relative.

## Removing it

Delete the custom domain in the Worker's settings and point the script tag back at the Worker's
`*.workers.dev` URL.
