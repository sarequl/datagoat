# The npm package: `@datagoat/sdk`

A typed ESM wrapper around the tracker. `init()` adds the tracker `<script>` with the same
attributes as a hand-written tag, and every call goes through the tracker's public
`window.datagoat()` API (`window.datafast()` is an alias), so the SDK behaves exactly like the
script tag (and also works with DataFast's own script). Source: [`packages/sdk`](../../packages/sdk).

```bash
npm install @datagoat/sdk
```

| Entry point             | For                                                                 |
| ----------------------- | ------------------------------------------------------------------- |
| `@datagoat/sdk`         | browser: `init`, `track`, `identify`, `payment`, `consent`, `getVisitorId`, cross-domain helpers, opt-out |
| `@datagoat/sdk/react`   | `DataGoatProvider`, `useDataGoat`, `useIdentify`, `useGoalOnMount`   |
| `@datagoat/sdk/next`    | `DataGoatScript` (server component), `withDataGoat` proxy rewrites, cookie helpers |
| `@datagoat/sdk/server`  | read the visitor from a request, checkout metadata, server API client |

## Quick start

```ts
import { init, track, identify } from "@datagoat/sdk";

init({
  websiteId: "dgid_XXXXXXXXXXXXXXXX",
  domain: "example.com",
  host: "https://a.example.com", // your collector; omit when you proxy /js/script.js and /api/events
});

track("signup", { plan: "pro" });
identify("user_123", { name: "Ada Lovelace", plan: "pro" });
```

Pageviews, SPA route changes, outbound links, scroll goals and `data-fast-goal` attributes are
handled by the tracker itself: there is no `trackPageview()` to call.

### Options

| Option              | Script attribute             | Default                                   |
| ------------------- | ---------------------------- | ----------------------------------------- |
| `websiteId`         | `data-website-id`            | required                                  |
| `domain`            | `data-domain`                | the tracker's default (page hostname)     |
| `host`              | `src` origin                 | the page's origin                         |
| `scriptUrl`         | `src`                        | `<host>/js/<variant file>`                |
| `apiUrl`            | `data-api-url`               | `<host>/api/events` when `host` is set    |
| `variant`           | `script.js` / `script.cookieless.js` / `script.hash.js` | `default` |
| `allowedHostnames`  | `data-allowed-hostnames`     | none                                      |
| `allowLocalhost`, `allowFileProtocol`, `debug`, `disableConsole`, `disablePayments` | the matching `data-*` flag | off |
| `nonce`             | CSP nonce on the tag         | none                                      |

`init()` adds the tag once; calling it again returns the same client. If the page already has a
tracker tag, it does not add another. It is safe to import during server rendering: without
`window`, calls do nothing.

### API

| Function                                  | Does                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| `track(goal, params?)`                    | `window.datagoat(goal, params)`. Goal names are lowercased and must be `a-z 0-9 _ - :`, at most 64 characters; up to 10 parameters, names `a-z 0-9 _ -` (kebab-case becomes snake_case), values cut to 255 characters. Returns `false` (and warns with `debug`) when rejected. |
| `identify(userId, profile?)`              | `window.datagoat("identify", {user_id, ...profile})`                      |
| `payment(email)`                          | `window.datagoat("payment", {email})` for success pages                   |
| `consent(granted)`                        | consent mode: `true` switches to cookies, `false` deletes them            |
| `getVisitorId()` / `getSessionId()`       | the `datagoat_visitor_id` / `datagoat_session_id` cookie (falls back to `datafast_*`), or the cookieless id |
| `getTrackingParams()`, `buildCrossDomainUrl(url)` | `_dg_vid`, `_dg_sid`, `_dg_vfs`, `_dg_vsn` for links to your other domains (the tracker decorates links to `allowedHostnames` automatically) |
| `optOut()` / `optIn()`                    | sets / clears `localStorage.datagoat_ignore`                              |
| `client.ready`                            | promise that resolves when the script has loaded                          |

## React

```tsx
import { DataGoatProvider, useDataGoat, useIdentify } from "@datagoat/sdk/react";

<DataGoatProvider websiteId="dgid_XXXXXXXXXXXXXXXX" domain="example.com" host="https://a.example.com">
  <App />
</DataGoatProvider>

function Upgrade({ user }) {
  const { track } = useDataGoat();
  useIdentify(user?.id, { name: user?.name });
  return <button onClick={() => track("upgrade_click")}>Upgrade</button>;
}
```

## Next.js

See [nextjs.md](nextjs.md): `DataGoatScript` in the root layout, `withDataGoat()` for a
first-party proxy, `checkoutMetadata(await cookies())` for Stripe.

## Revenue attribution on your server

Attach the visitor to the checkout so DataGoat credits the right channel:

```ts
import { checkoutMetadata, lemonSqueezyCheckoutData } from "@datagoat/sdk/server";

// Stripe Checkout / PaymentIntents
await stripe.checkout.sessions.create({ ..., metadata: checkoutMetadata(req) });

// Polar
await polar.checkouts.create({ ..., metadata: checkoutMetadata(req) });

// Lemon Squeezy
checkout_data: lemonSqueezyCheckoutData(req) // → { custom: { datagoat_visitor_id, datagoat_session_id } }
```

`req` can be a `Cookie` header string, a Fetch `Request` or `Headers`, Next.js `cookies()`, an
Express request (with or without cookie-parser) or a plain object. Invalid or missing cookies give
`{}`, never a broken value.

### Server API client

```ts
import { createServerClient } from "@datagoat/sdk/server";

const dg = createServerClient({ baseUrl: "https://a.example.com", apiKey: process.env.DATAGOAT_KEY! });
await dg.goal(visitorId, "trial_started", { plan: "pro" });   // POST /api/v1/goals
await dg.identify(visitorId, "user_123", { name: "Ada" });    // POST /api/v1/identify
await dg.payment({ amount: 29, currency: "USD", transaction_id: "inv_1", datagoat_visitor_id: visitorId });
```

With a `dgt_` account token, also pass `websiteId`. Errors throw `DataGoatApiError` with the
server's message and status.

## Moving from the `datafast` package

| DataFast SDK                          | `@datagoat/sdk`                              |
| ------------------------------------- | -------------------------------------------- |
| `await initDataFast({websiteId, ...})`| `init({websiteId, host, ...})` (synchronous) |
| `datafast.track(name, data)`          | `track(name, params)`                        |
| `datafast.identify(id, props)`        | `identify(id, props)`                        |
| `autoCapturePageviews`                | always on (done by the tracker)              |
| `datafast.trackPageview()`            | not needed; not available                    |
| `getTrackingParams()` / `buildCrossDomainUrl()` | same names                         |
| `datafast/react-native`               | [`@datagoat/react-native`](react-native.md)  |
