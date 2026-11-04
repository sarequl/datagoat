# Proxy DataGoat with Caddy

Add two handlers to your site block. Read the [proxy rules](proxy.md) first.

```caddyfile
example.com {
    handle /js/script.js {
        reverse_proxy https://datagoat.yourname.workers.dev {
            header_up Host {upstream_hostport}
            header_up -Cookie
            header_up X-Real-IP {remote_host}
        }
    }

    handle /api/events {
        reverse_proxy https://datagoat.yourname.workers.dev {
            header_up Host {upstream_hostport}
            header_up -Cookie
            header_up X-Real-IP {remote_host}
        }
    }

    # ... the rest of your site
    handle {
        root * /var/www/example
        file_server
    }
}
```

- Caddy's `reverse_proxy` already appends the client address to `X-Forwarded-For` and sets
  `X-Forwarded-Proto`; `X-Real-IP` is added for proxies that read only that header.
- `header_up Host {upstream_hostport}` sends the Workers hostname (Caddy also uses it for TLS SNI),
  which Cloudflare needs to route the request.
- Behind another proxy, set `trusted_proxies` in the global options so `{remote_host}` is the
  visitor.

Reload (`caddy reload`) and use the same-origin script tag:

```html
<script defer data-website-id="dfid_XXXXXXXXXXXXXXXX" data-domain="example.com" src="/js/script.js"></script>
```
