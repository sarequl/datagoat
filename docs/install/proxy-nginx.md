# Proxy DataGoat with Nginx

Add two `location` blocks to the `server` that serves your site. Read the
[proxy rules](proxy.md) first.

```nginx
# Resolver for the upstream hostname (use your own if you have one).
resolver 1.1.1.1 1.0.0.1 valid=300s ipv6=off;

location = /js/script.js {
    set $datagoat datagoat.yourname.workers.dev;
    proxy_pass https://$datagoat/js/script.js;
    proxy_ssl_server_name on;           # SNI: required by Cloudflare
    proxy_ssl_name $datagoat;
    proxy_set_header Host $datagoat;
    proxy_set_header Cookie "";
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering on;
    expires 1h;
}

location = /api/events {
    set $datagoat datagoat.yourname.workers.dev;
    proxy_pass https://$datagoat/api/events;
    proxy_ssl_server_name on;
    proxy_ssl_name $datagoat;
    proxy_set_header Host $datagoat;
    proxy_set_header Cookie "";
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    client_max_body_size 16k;
    add_header Cache-Control "no-store" always;
}
```

- `proxy_ssl_server_name on` matters: without SNI, Cloudflare answers the TLS handshake for a
  different hostname and the proxy fails with a 421 or handshake error.
- Using a variable in `proxy_pass` together with `resolver` makes Nginx re-resolve the Workers
  hostname instead of pinning the address it saw at startup.
- If Nginx sits behind another proxy or load balancer, configure `set_real_ip_from` and
  `real_ip_header` (ngx_http_realip_module) so `$remote_addr` is the visitor, not the balancer.
- Use `/js/script.cookieless.js` or `/js/script.hash.js` upstream if you use those builds.

Reload with `sudo nginx -t && sudo systemctl reload nginx`, then use the same-origin script tag:

```html
<script defer data-website-id="dgid_XXXXXXXXXXXXXXXX" data-domain="example.com" src="/js/script.js"></script>
```
