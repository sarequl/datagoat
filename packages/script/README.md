# datagoat

DataGoat browser tracking script and SDK. Self-hostable web analytics on
Cloudflare Workers + D1.

## Install

Add this tag to every page you want to track, just before `</body>`:

```html
<script
  async
  src="https://<worker-host>/t.js"
  data-site="<SITE_TOKEN>"
  data-domain=".example.com"
  data-spa="true">
</script>
```

- `data-site` — the site token from the dashboard (required).
- `data-domain` — cookie domain; set to `.example.com` to share one visitor id
  across subdomains.
- `data-endpoint` — overrides the beacon endpoint; defaults to the script's origin.
- `data-mode` — `auto` (default), `cookies`, `localstorage`, `cookieless`, or `consent`.
- `data-spa` — `true` (default) tracks client-side route changes.
- `data-hash` — `true` also tracks hash changes.
- `data-respect-dnt` — `true` (default) drops to cookieless when DNT is set.
- `data-dnt` — `cookieless` (default) or `block`.
- `data-require-consent` — `true` starts cookieless until `datagoat('consent', { analytics: true })`.
- `data-block-bots` — `true` (default) drops pageviews whose client bot score is at or above `data-bot-threshold` (default 60).
- `data-redact-url` — `true` (default) strips PII-looking query keys.
- `data-cross-domain` — comma-separated hosts to decorate with `datagoat_v` / `datagoat_g`.

## Commands

Queue before the script loads, then call after:

```js
window.datagoat = window.datagoat || function () {
  (window.datagoat.q = window.datagoat.q || []).push(arguments);
};

datagoat('trackEvent', { name: 'signup', plan: 'pro' });
datagoat('identify', 'user@example.com');
datagoat('reset');
datagoat('optOut');
datagoat('consent', { analytics: true });
datagoat('setDomain', '.example.com');
datagoat('setUserProperties', { plan: 'pro' });
```

`trackEvent` takes one object: `{ name, ...props }`. Custom `name` values become
goals in the dashboard. The script also emits `scroll` (25/50/75/100%) and
`reading_time` automatically.

## npm

```bash
npm install datagoat
```

```js
import DataGoat from 'datagoat';

const tracker = DataGoat.init({
  site: '<SITE_TOKEN>',
  endpoint: 'https://<worker-host>',
  domain: '.example.com',
});

tracker.trackEvent({ name: 'signup' });
tracker.identify('user@example.com');
```

The npm entry loads the same core as `t.js`; it does not reimplement the
protocol.

## Checkout handoff

`getCheckoutContext()` / `setCheckoutMetadata()` are in the standalone
`datagoat/checkout` bundle (IIFE global `DataGoatCheckout`) so the served
`t.js` stays under 5 KB gzipped:

```html
<script async src="https://<worker-host>/checkout.js"></script>
<script>
  const ctx = DataGoatCheckout.getCheckoutContext();
  const payload = DataGoatCheckout.setCheckoutMetadata(
    { amount: 100, currency: 'usd' },
    ctx
  );
  // send `payload` to your provider
</script>
```

`getCheckoutContext()` returns `{ visitor_id, session_id, utm }`.
`setCheckoutMetadata(payload, ctx)` merges `datagoat_visitor_id` (and the
DataFast migration alias `datafast_visitor_id`), `session_id`, and
`utm_source`/`utm_medium`/`utm_campaign`/`utm_term`/`utm_content` into
`payload.metadata`, and sets `client_reference_id` when absent.

## Build

```bash
npm install
npm run build   # writes dist/t.js, dist/datagoat.js, dist/datagoat.cjs, dist/checkout.js
npm test        # build + unit tests, asserts dist/t.js is under 5 KB gzipped
```

The served file is committed so the Worker can serve it without a build step.

## License

MIT
