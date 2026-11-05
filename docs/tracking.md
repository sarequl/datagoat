# Tracking reference

DataGoat's tracker is a small script (about 5 KB gzipped) served by your DataGoat Worker at
`/js/script.js`. It uses its own names (`datagoat_*` cookies, `window.datagoat(...)`) and is compatible with
DataFast's script tag: the same attributes and request body, `window.datafast(...)` as an alias,
and DataFast's cookies are read. Switching from DataFast? Read
[switching-from-datafast.md](switching-from-datafast.md) first.

```html
<script
  defer
  data-website-id="dgid_XXXXXXXXXXXXXXXX"
  data-domain="example.com"
  src="https://analytics.example.com/js/script.js"
></script>
```

## Builds

| File                      | Use it for                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| `/js/script.js`           | The default: first-party cookies, the most accurate visitor and revenue data.                      |
| `/js/script.cookieless.js` | No cookies. The server derives a daily visitor id (see [Privacy modes](#privacy-modes)).          |
| `/js/script.hash.js`      | Single-page apps with hash routing (`/#/settings`): hash changes count as pageviews.               |

Gzip sizes at the time of writing: `script.js` ~5.0 KB, `script.hash.js` ~5.0 KB,
`script.cookieless.js` ~4.5 KB (`npm run size` prints the current numbers).

## Script-tag attributes

| Attribute                  | Default        | Meaning                                                                                                                                                                                              |
| -------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data-website-id`          | required       | The website's tracking id (Settings → General). Without it nothing is sent.                                                                                                                          |
| `data-domain`              | page hostname  | Your root domain. Cookies are set on `.<domain>` so every subdomain shares the visitor, and it is sent as `domain`.                                                                                  |
| `data-allowed-hostnames`   | none           | Comma-separated other domains for [cross-domain tracking](#cross-domain-tracking).                                                                                                                   |
| `data-api-url`             | see below      | Where events are sent. A full URL, or a path resolved against the **page** (`/custom-events` on `example.com` posts to `https://example.com/custom-events`). An invalid value falls back to the default. |
| `data-allow-localhost`     | `false`        | Track on `localhost`, `127.x`, `::1`, `*.local` and `*.localhost`.                                                                                                                                   |
| `data-allow-file-protocol` | `false`        | Track pages opened from `file://`.                                                                                                                                                                   |
| `data-debug`               | `false`        | Logs every event sent, and allows tracking inside iframes (off otherwise, to avoid double counting).                                                                                                 |
| `data-disable-console`     | `false`        | Silences every console message.                                                                                                                                                                      |
| `data-disable-payments`    | `false`        | Turns off [success-page payment detection](#payments). `datagoat("payment", {email})` still works.                                                                                                   |
| `data-require-consent`     | `false`        | DataGoat: no cookies until `datagoat("consent", true)`. See [Consent mode](#consent-mode).                                                                                                           |
| `data-compat`              | none           | `datafast`: also write DataFast's `datafast_*` cookies, for sites switching from DataFast. See [Browser storage](#browser-storage).                                                                  |
| `data-track-engagement`    | `false`        | DataGoat: send active time and scroll depth when the page is hidden. See [Engagement](#engagement-beacon).                                                                                           |

**Default endpoint.** Without `data-api-url` the tracker posts to `/api/events` on the origin the
script was loaded from. If you proxy `/js/script.js` and `/api/events` through your own site, both
are on your origin and nothing else is needed. If the script comes from
`https://analytics.example.com/js/script.js`, events go to `https://analytics.example.com/api/events`.

**When the tracker stays off.** On development hosts and `file:` pages (unless allowed above),
inside iframes (unless `data-debug`), for automated browsers (`navigator.webdriver`, headless and
automation user agents, PhantomJS/Nightmare/Selenium globals, `webdriver` attributes on `<html>`),
and when `localStorage.datagoat_ignore` (or DataFast's `datafast_ignore`) is `"true"`.
`window.datagoat` still exists and logs what it ignored. Prerendered pages start tracking when the visitor actually opens them.

### Exclude your own visits

In the browser console on your site:

```js
localStorage.datagoat_ignore = true   // stop counting this browser
delete localStorage.datagoat_ignore   // count it again
```

Server-side exclusions (IPs and CIDR ranges, paths with `*` wildcards, countries, exact hostnames,
user agents) are in Settings → Exclusions. Excluded hits are not stored and do not count anywhere.

## Browser storage

| Key                                       | Where          | Lifetime              |
| ----------------------------------------- | -------------- | --------------------- |
| `datagoat_visitor_id`                     | cookie         | 365 days (UUID v4)    |
| `datagoat_session_id`                     | cookie         | 30 minutes, sliding   |
| `datagoat_visitor_first_seen_at`          | cookie         | 365 days              |
| `datagoat_visitor_session_count`          | cookie         | 365 days              |
| `datagoat_consent`                        | cookie         | 365 days, only after `datagoat("consent", …)` |
| `datagoat_pageview_state`                 | sessionStorage | tab (60 s same-URL dedup) |
| `datagoat_<provider>_payment_sent_<id>`   | sessionStorage | tab (payment dedup)   |
| `datagoat_visitor_id`, `datagoat_session_id` | sessionStorage | tab (cookieless only) |

Cookies use `path=/`, `domain=.<data-domain>` (or the hostname when it is outside `data-domain`),
`SameSite=Lax`, and `Secure` on https. Read `datagoat_visitor_id` on your server (for example to
put it into Stripe metadata). The current visitor id is also available as
`window.datagoat.visitorId`.

**DataFast cookies.** The tracker also reads DataFast's `datafast_visitor_id`, `datafast_session_id`,
`datafast_visitor_first_seen_at` and `datafast_visitor_session_count` when its own are missing, so
returning visitors keep their id; the values are copied onto the `datagoat_*` cookies. With
`data-compat="datafast"` on the tag it also keeps writing the `datafast_*` cookies, so checkout code
that reads `datafast_visitor_id` keeps working unchanged. Use it when switching from DataFast.

## JavaScript API

`window.datagoat` and its alias `window.datafast` are the same function. Add the queue snippet to
your `<head>` so calls made before the script loads are kept (they are sent after the first
pageview, in order; `consent` calls run first). A `window.datafast` queue from DataFast's snippet is
drained too:

```html
<script>
  window.datagoat = window.datagoat || function () {
    (window.datagoat.q = window.datagoat.q || []).push(arguments);
  };
</script>
```

### Goals

```js
window.datagoat("signup");
window.datagoat("initiate_checkout", { plan: "pro", price: 49 });
```

- Names: lowercase letters, digits, `_`, `-` and `:`, up to 64 characters. They are lowercased and
  spaces become `_`. `identify`, `payment` and `consent` are commands, not goals.
- Up to 10 parameters. Parameter names `^[a-z0-9_-]+$`, up to 64 characters. Values up to 255
  characters; `< > ' " &`, `javascript:`, `data:`, `vbscript:` and `on…=` are stripped.
- An invalid name or parameter rejects the whole goal (logged to the console).
- Avoid the provider goal names (`payment`, `free_trial`, `trial_started`, `subscription_*` …): they
  are recorded automatically from your payment provider.

### Goals from HTML

```html
<button data-fast-goal="product_added"
        data-fast-goal-product-id="prod_123"
        data-fast-goal-price="49">Add to cart</button>
```

Sends `product_added` with `{product_id: "prod_123", price: "49"}` (kebab-case attribute names
become snake_case) on click, and on Enter or Space for custom controls such as
`<div role="button" tabindex="0">`. Native buttons and links are counted once.

### Scroll goals

```html
<section data-fast-scroll="viewed_pricing"
         data-fast-scroll-threshold="0.7"
         data-fast-scroll-delay="2000"
         data-fast-scroll-section-name="pricing">…</section>
```

Fires once per page view when the element is at least `threshold` visible (default `0.5`), after it
stayed visible for `delay` milliseconds (default `0`). The goal carries `scroll_percentage` (how far
down the page the visitor was), `threshold`, `delay` and your `data-fast-scroll-*` parameters.
Elements added later are picked up at the next SPA navigation.

### Identify

```js
window.datagoat("identify", {
  user_id: "user_123",          // required
  name: "Jane Doe",             // optional
  image: "https://…/jane.png",  // optional
  plan: "pro",                  // up to 10 more fields
});
```

Links the visitor to your user id and shallow-merges the other fields into the profile. If the
`user_id` or an `email` field is an email address, it is hashed for revenue matching (and stored
only when Settings → "Store customer emails" is on). Call it whenever your app knows the user;
repeat calls that change nothing cost almost nothing. The same `user_id` on your website and in
your app links both journeys.

## Outbound links

Clicks (including middle clicks) on links to other sites send an `external_link` event with the
URL and the link text. Links to your own domain and its subdomains are not outbound. They feed the
exit-clicks breakdown.

## Single-page apps

`history.pushState` and the back/forward buttons (`popstate`) count as pageviews when the pathname
changes, 100 ms after the last change. Query-only changes are ignored. The hash build also counts
`history.replaceState` and `hashchange`, and keeps the `#hash` in the page path. A reload of the same
URL within 60 seconds is not counted again.

## Cross-domain tracking

Subdomains of `data-domain` share the visitor automatically. For other root domains (marketing site
on `example.com`, app on `myapp.io`), install the script on both with the **same**
`data-website-id` and `data-domain`, list the other domains, and add them under Settings → General →
allowed hostnames:

```html
<script defer data-website-id="dgid_…" data-domain="example.com"
        data-allowed-hostnames="myapp.io" src="https://analytics.example.com/js/script.js"></script>
```

Links between those domains get `_dg_vid`, `_dg_sid`, `_dg_vfs` and `_dg_vsn` appended when they are
clicked (DataFast's `_df_*` parameters are also read on arrival); the receiving page adopts the
visitor and session and removes the parameters from the address bar before its first pageview. Cookieless mode does not link domains.

## Payments

Revenue comes from your payment provider integration (Settings → Integrations). The tracker adds
two ways to tie a payment to the visitor:

**Success pages.** Redirect customers back to your site with the provider's reference in the URL;
the tracker reports it once per tab and the server resolves it with the provider:

| Provider      | Success URL parameter                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| Stripe        | `?session_id={CHECKOUT_SESSION_ID}` (Payment Links: "After payment" → "Confirmation page"). Only `cs_…` ids count. |
| Polar         | `?checkout_id={CHECKOUT_ID}` (Checkout Links → Success URL)                                                        |
| Lemon Squeezy | `?order_id=[order_id]` (Confirmation modal and receipt button link)                                                |
| Paddle        | `?transaction_id=txn_…` or `?paddle_transaction_id=txn_…`. Paddle does not fill this in itself: redirect from Paddle.js's `checkout.completed` event, e.g. `location.href = "/welcome?transaction_id=" + event.data.transaction_id`. |

**Email.** On any page after a purchase:

```js
window.datagoat("payment", { email: "customer@example.com" });
```

The email is hashed and matched against payments from that customer, including ones that arrived
before the visitor was known. Checkout metadata (`datagoat_visitor_id`, `datagoat_session_id` in
Stripe/Polar metadata, Lemon Squeezy `custom_data`, Paddle `custom_data`/`customData`; DataFast's
`datafast_visitor_id` / `datafast_session_id` are also accepted) remains the most reliable method;
read the cookies server-side or with `document.cookie`. Set `data-disable-payments="true"` if you rely only on metadata and want no success-page
events.

## Privacy modes

Set per website in Settings → General.

| Mode                 | Script                                            | Visitor identity                                                                                                                                       |
| -------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cookie (default)     | `script.js` / `script.hash.js`                    | The first-party cookies above.                                                                                                                          |
| Cookieless           | `script.cookieless.js` (any script works)          | `HMAC-SHA256(daily random salt, website, IP, user agent)`, computed on the server. IP and user agent are never stored. The salt is random, rotates at 00:00 UTC, and is deleted after 48 hours, so the same person is a new visitor each day. |
| Consent              | `script.js` with `data-require-consent="true"`     | Cookieless until `datagoat("consent", true)`, then cookies, continuing the same visitor and session.                                                     |

**Cookieless trade-offs.** Daily numbers and same-day attribution work; returning-visitor metrics,
the visit-count filter, multi-day journeys and long sales cycles do not. `identify` is ignored and
payment emails are not stored for cookieless hits. Sessions spanning midnight UTC continue.

### Consent mode

```js
// your banner's buttons
window.datagoat("consent", true);   // writes the cookies, keeps today's visitor and session
window.datagoat("consent", false);  // deletes the datagoat_* (and datafast_*) cookies; cookieless from now on
```

The choice is remembered in the `datagoat_consent` cookie. `consent` is a DataGoat extension:
DataFast's script would record it as a goal named `consent`, so consent mode needs DataGoat's
script.

**Global Privacy Control.** When a browser sends `Sec-GPC: 1` and the website honours GPC
(default), its hits are processed like cookieless hits.

> Whether a mode removes the need for a consent banner depends on the law that applies to you and
> on your setup. This page describes what the software does technically; it is not legal advice.
> You are responsible for your privacy policy and any notices or consent your site needs.

## Engagement beacon

With `data-track-engagement="true"`, when the page is hidden (tab switch, close, navigation) the
tracker sends the time the visitor was active on it (time visible, counting at most 30 seconds
between interactions) and the deepest scroll position. The server adds them to the session
(`engaged_ms`, `max_scroll`) with a single row write; no event row is stored.

## Content Security Policy

If your site sends a `Content-Security-Policy`, allow the script and the endpoint:

```
script-src 'self' https://analytics.example.com;
connect-src 'self' https://analytics.example.com;
```

`script-src` must allow the script's origin and `connect-src` the events endpoint (the same host
unless you set `data-api-url`). When you proxy both through your own site, `'self'` covers them.
The queue snippet is an inline script: allow it with a nonce or hash, or put it in a file. Look for
"Refused to load the script" or "Refused to connect" in the browser console to confirm a CSP problem.

## Request format

The tracker sends one JSON object per event to `POST /api/events` with `navigator.sendBeacon`
(`text/plain`, no CORS preflight, survives page unload), falling back to `fetch(…, {keepalive: true})`
and then `XMLHttpRequest`. The collector also accepts DataFast's own `application/json` requests
and answers their CORS preflight.

```json
{
  "websiteId": "dgid_…", "domain": "example.com", "href": "https://example.com/?utm_source=x",
  "referrer": null, "viewport": { "width": 1280, "height": 720 },
  "visitorId": "72de85b4-…", "sessionId": "s3457d40-…",
  "visitorFirstSeenAt": "2026-11-04T17:26:33.885Z", "visitorSessionNumber": 1,
  "adClickIds": { "gclid": "…" },
  "language": "en-US", "timezone": "Europe/Berlin", "screenWidth": 1440, "screenHeight": 900,
  "type": "pageview"
}
```

| `type`          | `extraData`                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| `pageview`      | –                                                                                                                  |
| `custom`        | `{eventName, ...params}`                                                                                           |
| `identify`      | `{user_id, name, image, ...profile}`                                                                               |
| `payment`       | `{stripe_session_id}`, `{polar_checkout_id}`, `{lemonsqueezy_order_id}`, `{paddle_transaction_id}` or `{email}`    |
| `external_link` | `{url, text}`                                                                                                      |
| `engagement`    | `{active_ms, max_scroll}` (DataGoat)                                                                               |

The hash build adds `trackHash: true`; cookieless requests add `cookieless: true` and leave out the
first-seen and session-number fields. Responses are `200 {}`; cookieless hits get
`{visitorId, sessionId}`. Errors use the API's error envelope: `400` malformed, `403` hostname not
allowed, `404` unknown website, `413` body over 8 KB, `429` rate limited (60 events a minute per
visitor IP and 600 per website, per Worker location). Bots and excluded hits get a plain `200`.

## Traffic sources

Pages tagged with `ref`, `source`, `via` or `utm_source`/`utm_medium`/`utm_campaign`/`utm_term`/
`utm_content` are attributed to them; ad click ids (`gclid`, `gbraid`, `wbraid`, `msclkid`, `fbclid`,
`ttclid`, `twclid`, `li_fat_id`) mark paid traffic. Each session gets a channel, in this order:

1. `utm_medium` of `email`, `newsletter` or `affiliate` → Email, Newsletter, Affiliate.
2. Search click ids → Paid Search; social click ids → Paid Social.
3. `utm_medium` `cpc`/`ppc`/`paid…` → Paid Search (Paid Social for social sources);
   `display`/`banner`/`cpm` → Display; `social` → Organic Social.
4. `via` → Affiliate.
5. Referrer: search engines → Organic Search, social networks and communities → Organic Social,
   AI assistants (ChatGPT, Perplexity, Claude, Gemini, Copilot, …) → AI, webmail → Email, anything
   else → Referral.
6. A `ref`/`source`/`utm_source` without a referrer → Referral (or the kind of a known name, so
   `utm_source=chatgpt.com` is AI). Nothing at all → Direct.

Referrers from your own domain and allowed hostnames are internal and never start a new source.
A session keeps the source, location and device of its first event.
