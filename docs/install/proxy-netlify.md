# Proxy DataGoat on Netlify

Netlify proxies a rewrite to an external URL when the rule has status `200`. Read the
[proxy rules](proxy.md) first.

`netlify.toml`:

```toml
[[redirects]]
  from = "/js/script.js"
  to = "https://datagoat.yourname.workers.dev/js/script.js"
  status = 200
  force = true

[[redirects]]
  from = "/api/events"
  to = "https://datagoat.yourname.workers.dev/api/events"
  status = 200
  force = true
```

or the same in `_redirects`:

```
/js/script.js  https://datagoat.yourname.workers.dev/js/script.js  200!
/api/events    https://datagoat.yourname.workers.dev/api/events    200!
```

`force` (`!`) makes the rule apply even if a file exists at that path. Netlify's proxy forwards the
method, body and user agent, and adds the visitor's address to `X-Forwarded-For`.

Script tag:

```html
<script defer data-website-id="dfid_XXXXXXXXXXXXXXXX" data-domain="example.com" src="/js/script.js"></script>
```

Location data comes from the Netlify edge node Cloudflare sees (see
[proxy.md](proxy.md#location-data-behind-a-proxy)); with DNS on Cloudflare, prefer a
[custom subdomain](custom-domain.md).
