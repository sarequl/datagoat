# Revenue attribution

DataGoat shows revenue next to your traffic: every payment is linked to the visitor who made it,
so each channel, referrer, campaign, page, country and device row carries revenue, payments and
conversion rate. This page explains how it works; each provider has its own setup guide.

| Provider          | Guide                                    | Data path                                     |
| ----------------- | ---------------------------------------- | --------------------------------------------- |
| Stripe            | [stripe.md](stripe.md)                   | Events API polling (no webhook needed), optional webhook |
| Polar             | [polar.md](polar.md)                     | Webhook (created on connect when allowed) + polling     |
| Lemon Squeezy     | [lemonsqueezy.md](lemonsqueezy.md)       | Webhook (created on connect) + polling        |
| Paddle Billing    | [paddle.md](paddle.md)                   | Events API polling, optional webhook          |
| Dodo Payments     | [dodo.md](dodo.md)                       | Webhook + polling                             |
| Creem             | [creem.md](creem.md)                     | Webhook + polling                             |
| Shopify           | [shopify.md](shopify.md)                 | Orders webhooks (+ backfill with a token)     |
| WooCommerce       | [woocommerce.md](woocommerce.md)         | Order webhooks (+ backfill with REST keys)    |
| Anything else     | [payments-api.md](payments-api.md)       | `POST /api/v1/payments` from your server      |

Connect providers in the dashboard (**Settings → Integrations**) or with the API
(`POST /api/v1/admin/websites/<websiteId>/integrations/<provider>`, see
[the API contract](../api/contract.md#10-revenue-w3)). Credentials are encrypted at rest with your
`ENCRYPTION_KEY` and never returned. You can connect several providers to one website.

## How a payment finds its visitor

DataGoat tries these in order and records which one worked (`attributedVia`):

1. **metadata**: the visitor id travels with the payment. Put the `datafast_visitor_id` cookie
   (and `datafast_session_id`) in your checkout's metadata / custom data under
   `datafast_visitor_id` or `datagoat_visitor_id`. Code written for DataFast works unchanged.
2. **link**: the customer lands on your success page with the provider's reference in the URL
   (`?session_id=` for Stripe Payment Links, `?checkout_id=` for Polar, `?order_id=` for Lemon
   Squeezy). The tracker reports it and a cron job looks the payment up.
3. **customer**: the provider customer (or subscription) already paid once from a known visitor, so
   renewals and later purchases attribute without metadata.
4. **email**: the customer's email matches a visitor who called `datafast("identify", …)` or
   `datafast("payment", {email})`. Matching uses a SHA-256 hash.
5. **api**: the visitor id you sent to `POST /api/v1/payments`.
6. **none**: stored and shown as **Unattributed**, so the coverage figure stays honest.

A candidate counts only when that visitor has at least one session on the website. A payment
stores three sessions: the visitor's first (first touch), the last before the payment (last touch;
the checkout's own session when metadata carries it) and the last non-Direct one. Switching the
website's attribution model therefore needs no reprocessing.

Getting the same payment twice through metadata **and** a success-page link is harmless: both
resolve to the same provider transaction id, so it is stored once (DataFast's "duplicate payments"
problem does not occur, and `data-disable-payments` is not required).

## What gets recorded

| Kind         | Revenue                     | Goal emitted on the visitor |
| ------------ | --------------------------- | --------------------------- |
| `payment`    | positive                    | `payment`                   |
| `renewal`    | positive (optional in KPIs) | `subscription_renewed`      |
| `free_trial` | 0                           | `free_trial`                |
| `refund`     | negative, on the original payment's visitor; chargebacks too (a won chargeback adds it back) | – |

Subscriptions also emit DataFast's reserved lifecycle goals: `trial_started`, `trial_converted`,
`subscription_started`, `subscription_upgraded`, `subscription_downgraded`,
`subscription_cancel_scheduled`, `subscription_reactivated` and `subscription_ended`. The first paid
charge after a trial is a sale (`payment` + `trial_converted`), not a renewal. Goals appear in
goal reports, filters (`filter_goal=subscription_ended`), funnels and visitor journeys. Do not send
custom goals with these names. Historical data imported by a backfill gets payment goals but no
lifecycle goals (those describe live changes).

## Currency

Each payment keeps its original amount and currency and is converted to the website currency with
the European Central Bank's daily reference rates (fetched once a day into `fx_rates`; the first
run loads the last 90 days). A payment uses the latest rate published on or before its day.
Currencies the ECB does not publish, or payments arriving before the first rates are loaded, are
stored unconverted and re-converted automatically once a rate exists. Changing the website
currency re-converts existing payments within the hour.

## Revenue reports

- `GET /api/v1/analytics/revenue`: revenue, new vs renewal, refunds, customers, attribution
  coverage by method, lifetime value by first channel, and `pathToPurchase` (average days,
  sessions and pageviews to a first purchase, and the most common channel sequences, e.g.
  Organic Search → Direct; repeats collapsed, first touch plus the last four steps).
- `GET /api/v1/analytics/revenue/sources?groupBy=channel&model=last_touch`: revenue by channel,
  referrer, UTM, country, device … under any attribution model, with an Unattributed row.
- `GET /api/v1/analytics/revenue/path-to-purchase`: days and sessions from first visit to first
  purchase, and first → last channel paths.
- `GET /api/v1/payments`: the payments list with filters (`attributed=false` lists unattributed).

## Background jobs and the Free plan

| Job                       | When          | What                                                        |
| ------------------------- | ------------- | ----------------------------------------------------------- |
| `providers.sync`          | every minute  | Stripe and Paddle events every minute (up to 100 per run); Polar, Lemon Squeezy, Dodo, Creem every 5 minutes; one backfill page per connection (2 per run); ≤ 20 provider requests per run |
| `providers.resolve-hints` | every minute  | up to 8 success-page references, retried 1 min → 1 day      |
| `providers.fx`            | hourly :23    | ECB rates once a day, re-conversion                         |
| `providers.match-emails`  | hourly :37    | email matches for recent unattributed payments              |
| `providers.cleanup`       | daily 04:41   | prune webhook dedupe rows (30 d) and resolved hints (90 d)  |

An idle poll writes no rows. A new attributed payment writes about 7 rows (payment, its indexes,
its goal event and the customer mapping). Stripe keeps events for 30 days: if an install is
offline longer, polling restarts at the newest event and the backfill re-runs to close the gap.

## Test and sandbox keys

Live keys only by default (`rk_test_`, `pdl_sdbx_`, `creem_test_`, Polar sandbox and Dodo test
mode are rejected, as DataFast rejects test keys in production). For a development instance set
the variable `ALLOW_TEST_PAYMENT_KEYS = "true"` (wrangler `vars` or `.dev.vars`).

## Re-sync and disconnect

`PATCH …/integrations/<provider>` re-runs the historical backfill (idempotent: existing payments
are not duplicated) and can replace the webhook secret (`{"webhookSecret": "…"}`).
`DELETE …/integrations/<provider>` stops importing and removes webhooks DataGoat created; revenue
already recorded is kept. Delete payments with `DELETE /api/v1/payments`.
