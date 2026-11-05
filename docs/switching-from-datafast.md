# Switching from DataFast

DataGoat's tracker and collector speak DataFast's protocol, so a site moves by changing one URL
and adding `data-compat="datafast"` to the tag. Your visitors keep their ids, your checkout code
keeps working, and DataFast's own script can even send to DataGoat during the move.

New sites use DataGoat's own names by default: `datagoat_*` cookies, `window.datagoat(...)`,
`datagoat_visitor_id` metadata, `dgid_` tracking ids and `dg_`/`dgt_` API keys. DataFast's names are
accepted so existing sites can move without code changes.

## 1. Create the website

In DataGoat, add the website with the same root domain. Copy its tracking id (Settings → General).
Recreate settings you had in DataFast: allowed hostnames (cross-domain), excluded IPs, paths,
countries and hostnames, the cookieless toggle (privacy mode) and attack mode (bot level "strict").

## 2. Replace the script tag

```html
<!-- before -->
<script defer data-website-id="dfid_OLD" data-domain="example.com"
        src="https://datafa.st/js/script.js"></script>

<!-- after -->
<script defer data-website-id="dgid_NEW" data-domain="example.com" data-compat="datafast"
        src="https://analytics.example.com/js/script.js"></script>
```

- `data-compat="datafast"` makes the tracker also write DataFast's `datafast_visitor_id`,
  `datafast_session_id`, `datafast_visitor_first_seen_at` and `datafast_visitor_session_count`
  cookies, next to its own `datagoat_*` cookies. Checkout code that reads `datafast_visitor_id`
  keeps working unchanged. Once your code reads `datagoat_visitor_id`, you can drop the attribute.

- Keep every other attribute as it is: `data-allowed-hostnames`, `data-api-url`,
  `data-allow-localhost`, `data-allow-file-protocol`, `data-debug`, `data-disable-console`,
  `data-disable-payments` all mean the same thing.
- `script.cookieless.js` and `script.hash.js` exist under the same names.
- If you proxied DataFast through your own domain (`/js/script.js` and `/api/events`), point the
  proxy at your DataGoat Worker instead; no tag change is needed beyond the website id.
- The collector accepts any opaque tracking id, so a website whose tracking id is your old
  `dfid_…` value (for example one created by an import) needs no tag change at all. Websites
  created in the dashboard get a new `dgid_…` id: update `data-website-id`.

Without `data-api-url`, DataGoat's script sends events to `/api/events` on the host it was loaded
from (DataFast's script sends to the page origin when proxied). If you load the script from one
host and want events on another, set `data-api-url` to the full events URL.

## 3. Nothing else changes in your code

| You use                                                          | Status                                                                 |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `window.datafast("goal", {...})`, the queue snippet               | Works; an alias of `window.datagoat`.                                  |
| `window.datafast("identify", {...})`                             | Works; profiles shallow-merge.                                         |
| `window.datafast("payment", {email})`                            | Works.                                                                 |
| `data-fast-goal`, `data-fast-goal-*`                              | Works (click, Enter, Space).                                           |
| `data-fast-scroll`, `-threshold`, `-delay`, `-*`                  | Works.                                                                 |
| `datafast_visitor_id` / `datafast_session_id` cookies in checkout metadata | Read and accepted; written with `data-compat="datafast"`.      |
| Stripe `?session_id=`, Polar `?checkout_id=`, Lemon Squeezy `?order_id=` success pages | Works; Paddle `?transaction_id=txn_…` added.     |
| `localStorage.datafast_ignore = true`                             | Works (DataGoat's own key is `datagoat_ignore`).                       |
| Cross-domain `_df_vid` / `_df_sid` links                          | Read on arrival; DataGoat's own links use `_dg_*`.                     |
| REST API (`/api/v1/...`), `datafast_visitor_id` fields            | DataFast-compatible; change the base URL and use a `dg_`/`dgt_` key.   |

The tracker reads DataFast's cookies when its own are missing and copies them onto the
`datagoat_*` cookies (same format), so a visitor who was tracked by DataFast is the same visitor in
DataGoat from their first DataGoat pageview (history before the switch stays in DataFast unless you
import it).

## 4. Optional: keep DataFast's script for a while

DataGoat's collector accepts DataFast's unmodified script. To run both side by side or to test
before switching the script itself, point DataFast's script at DataGoat:

```html
<script defer data-website-id="dgid_NEW" data-domain="example.com"
        data-api-url="https://analytics.example.com/api/events"
        src="https://datafa.st/js/script.js"></script>
```

## 5. What is different

- **More reliable delivery.** DataGoat sends with `sendBeacon` (falling back to `fetch` with
  `keepalive`), so events fired while a page unloads, such as outbound clicks, are not lost.
- **Cookie flags.** Cookies get `SameSite=Lax`, and `Secure` on https.
- **Parameter names up to 64 characters**, as DataFast documents (DataFast's script stops at 32).
- **Extras you can opt into:** `data-require-consent` with `datagoat("consent", true|false)`,
  `data-track-engagement` (active time and scroll depth), Global Privacy Control support, and
  user-agent exclusions.
- **Content Security Policy.** Replace `https://datafa.st` with your DataGoat host in `script-src`
  and `connect-src` (or nothing, if you proxy through your own domain). See
  [tracking.md](tracking.md#content-security-policy).
- **Mobile apps.** Events from DataFast's React Native SDK use `datafast://ios/<Screen>` URLs; the
  collector accepts them (and `datagoat://`). Use the same website id and `user_id` on web and app
  to link journeys.

The full reference for attributes, the API, goals, payments and privacy modes is
[tracking.md](tracking.md).
