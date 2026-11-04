# Proxy DataGoat on DigitalOcean

Read the [proxy rules](proxy.md) first.

## App Platform

App Platform runs your app behind its own load balancer, which puts the visitor's address in
`X-Forwarded-For` (and the `do-connecting-ip` header). Proxy from your app's code:

- Next.js: [proxy-nextjs.md](proxy-nextjs.md)
- Express or another Node server: [proxy-express.md](proxy-express.md) (keep
  `app.set("trust proxy", true)`)
- Django, Flask, FastAPI, Laravel, PHP: the matching guide in [proxy.md](proxy.md#guides)

Static sites on App Platform have no server code; for those use a
[custom subdomain](custom-domain.md) if the domain's DNS is on Cloudflare, or serve the site from
an app component that can proxy.

## Droplet with Nginx

Follow [proxy-nginx.md](proxy-nginx.md) in your site's server block
(`/etc/nginx/sites-available/<site>`). If a DigitalOcean Load Balancer sits in front of the
Droplet, add to the `server` block so `$remote_addr` is the visitor:

```nginx
set_real_ip_from 10.0.0.0/8;     # your load balancer's private network
real_ip_header X-Forwarded-For;
real_ip_recursive on;
```

Then `sudo nginx -t && sudo systemctl reload nginx`.

## Droplet with Caddy

Follow [proxy-caddy.md](proxy-caddy.md); behind a load balancer add
`trusted_proxies static private_ranges` to Caddy's global `servers` options.

Script tag in all cases:

```html
<script defer data-website-id="dfid_XXXXXXXXXXXXXXXX" data-domain="example.com" src="/js/script.js"></script>
```
