# Data model

One D1 database, created by [`migrations/0001_init.sql`](../../migrations/0001_init.sql). Feature
teams add tables and columns only in their migration ranges ([CONTRACTS.md](../CONTRACTS.md) §4) and
document them here (their rows only).

## Conventions

- Timestamps: INTEGER epoch milliseconds (UTC), columns named `*_at` or `ts`. Calendar days:
  TEXT `YYYY-MM-DD` in the website timezone unless noted (UTC for `bot_daily`, `fx_rates`,
  `cookieless_salts`).
- Money: INTEGER minor units plus an ISO 4217 currency column. Conversion: `src/lib/money.ts`.
- JSON: TEXT. Booleans: INTEGER 0/1.
- Ids: 24-hex `newId()` (ObjectId-like, time-sortable). Visitor ids are DataFast's UUID v4 cookie
  value (or a cookieless hash); session ids are `s` + UUID.
- Analytics tables lead with `site_id` and are `WITHOUT ROWID` when the primary key is the access
  path. `site_id` on every site-scoped table: the website purge job finds such tables automatically.
- Secrets: hashed (SHA-256) when only verified, AES-GCM encrypted (`ENCRYPTION_KEY`, AAD
  `provider:<provider>:<site_id>` or `integration:<kind>:<site_id>`) when they must be read back.

## Write budget (plan §7)

D1 bills one written row per table row plus one per index entry touched. Free plan: 100,000 rows
written and 5,000,000 read per day.

| Pageview kind                   | Statements                                                                           | Rows written  |
| ------------------------------- | ------------------------------------------------------------------------------------ | ------------- |
| Within an existing session      | `INSERT events` (row + `events_time`) + `UPSERT sessions` updating unindexed columns | 2 + 1 = **3** |
| First pageview of a session     | `INSERT events` + `INSERT sessions` (row + `sessions_time` + `sessions_visitor`)     | 2 + 3 = **5** |
| First pageview of a new visitor | the above + `INSERT OR IGNORE visitors`                                              | 5 + 1 = **6** |

A goal, outbound click, identify or payment-goal event writes 4 event rows instead of 2: the row,
`events_time` and W2's two partial indexes `events_activity (site_id, type, ts)` and
`events_visitor_activity (site_id, visitor_id)`, both `WHERE type <> 'pageview'` (migration 0200),
so pageviews are unaffected. They let goal, exit-click, funnel and realtime-event queries read only
non-pageview events, and visitor profiles / server-side goal deletion find a visitor's events without
scanning the site. Queries must repeat the predicate (`type <> 'pageview'`) for SQLite to use them.

`INSERT OR IGNORE` on an existing visitor writes 0 rows. Measured in workerd by
`test/worker/schema-write-budget.test.ts`, which also pins the index list of the hot tables.

## Tables

`Writes` names the team whose code inserts/updates the table; everyone may read.

### Instance and accounts

| Table               | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Key                                                          | Writes                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------ |
| `instance_settings` | Install-wide key/values: `setup_completed_at`, `public_url` (origin of the setup request, for links in emails/digests), future email sender config                                                                                                                                                                                                                                                                                                                                                                     | `key`                                                        | F0 (W6 may add keys)                                               |
| `sites`             | Websites and every setting: domain, name, logo, timezone, currency, `privacy_mode` (cookie/cookieless/consent), `attribution_model`, `bot_level` (off/standard/strict = attack mode), `honor_gpc`, allowed hostnames (+ all-hostnames flag), exclusions (IPs/CIDRs, path globs, countries, hostnames, and W1's `excluded_user_agents` from migration 0100), `kpi` + colour, `revenue_metric`, `include_renewal_revenue`, `store_customer_emails`, `retention_days`, weekly reports and viral-traffic flags, `share_token` + `public_data_enabled`, soft delete `deleted_at` | `id`; unique `public_id`, `share_token`                      | F0 (settings API); W2 writes `share_token` via the share endpoints |
| `users`             | Dashboard users, PBKDF2 hashes, `password_changed_at`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `id`; unique `email`                                         | F0                                                                 |
| `memberships`       | Role per site: owner/member/viewer; `position` (0900, nullable) = the user's website order on the All websites dashboard                                                                                                                                                                                                                                                                                                                                                                                           | `(site_id, user_id)`; index `user_id`                        | F0; finisher (`position`)                                          |
| `auth_sessions`     | Dashboard sessions (SHA-256 of the cookie token), 30-day expiry                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `id_hash`; index `user_id`                                   | F0                                                                 |
| `invites`           | Team invites (hashed token, 7 days)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `id`; unique `token_hash`; unique pending `(site_id, email)` | F0                                                                 |
| `password_resets`   | One-time reset links from `npm run reset-password`                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `token_hash`                                                 | F0                                                                 |
| `api_keys`          | `df_` website keys and `dft_` account tokens: hash, prefix, masked display, permissions, website allowlist, `include_pii`, `is_mobile`, `oauth_connection_id`, expiry, lazy usage counters                                                                                                                                                                                                                                                                                                                             | `id`; unique `key_hash`; indexes `site_id`, `user_id`        | F0; W7 (keys minted via OAuth); W8 (`is_mobile` keys)              |

### MCP OAuth (W7)

| Table               | Purpose                                                                | Key                                 |
| ------------------- | ---------------------------------------------------------------------- | ----------------------------------- |
| `oauth_clients`     | Registered clients (dynamic registration or metadata URL)              | `id`                                |
| `oauth_connections` | Approved consent: user, client, scopes, sites, resource, 90-day expiry | `id`; index `user_id`               |
| `oauth_codes`       | Authorization codes (hashed, PKCE S256, 2 min, single use)             | `code_hash`                         |
| `oauth_tokens`      | Access (1 h) and rotating refresh (30 d) tokens, hashed                | `token_hash`; index `connection_id` |
| `idempotency_keys`  | Replay protection for retried writes (MCP write tools, notes)          | `(scope, key)`                      |

W7 notes: OAuth access tokens are `dgo_…`, refresh tokens `dgr_…`, codes `dgac_…`, client ids
`dgc_…` (or an HTTPS metadata-document URL), all stored as SHA-256 hashes. MCP idempotency rows use
scope `mcp:<credential kind>:<credential id>`, keep only redacted responses (never issued secrets)
and expire after 24 hours; `mcp.cleanup` (daily) deletes expired codes, tokens, connections,
registrations and `mcp:` idempotency rows. `api_keys` rows minted through an OAuth connection get
`oauth_connection_id` and the connection's expiry and are revoked with it.

### Raw analytics (W1 writes, W2 reads)

| Table              | Purpose                                                                                                                                                                                                                                                                                                                                                                                                  | Key / indexes                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `visitors`         | One row per visitor, written once plus on identify/payment email: first seen (server and cookie), first session, identify profile (`user_id`, `name`, `image`, `profile` JSON, `identified_at`), `email` (when allowed) and `email_hash`                                                                                                                                                                 | `(site_id, id)`; partial indexes `(site_id, user_id)`, `(site_id, email_hash)`        |
| `sessions`         | One row per session; dimensions from the first pageview, never overwritten: entry/exit path, hostname, pageviews, interactions, referrer + domain, `channel`, `source` (display name), UTM fields, `ref`, `source_param`, `via`, ad click ids, geo (country, region, city, lat, lon), device/browser/OS (+ versions, vendor, model), language, timezone, screen/viewport, `session_number`, `cookieless`; W1's migration 0100 adds `engaged_ms` and `max_scroll` (engagement beacon, unindexed) | `(site_id, id)`; indexes `(site_id, started_at)`, `(site_id, visitor_id, started_at)` |
| `events`           | Every pageview, goal (`custom`), identify, payment and outbound click (`external_link`); `path` includes `#hash` for the hash build; `name` = goal name; `props` JSON                                                                                                                                    | rowid; index `(site_id, ts)`; partial (non-pageview, W2) `(site_id, type, ts)` and `(site_id, visitor_id)` |
| `cookieless_salts` | Daily random salts for HMAC(site, IP, UA); today and yesterday only                                                                                                                                                                                                                                                                                                                                      | `day` (UTC)                                                                           |
| `bot_daily`        | Count of ingest hits dropped as bots, by reason                                                                                                                                                                                                                                                                                                                                                          | `(site_id, day, reason)`                                                              |

W3 also inserts `events` rows (type `custom`, names `payment`, `free_trial` and DataFast's lifecycle
goals) for attributed payments, so goal filters and journeys include them. These rows have
`hostname`/`path` NULL, `ts` = the payment or subscription change time, `session_id` = the visitor's
last session before it, and `props` JSON `{"origin": "payment_provider", "type": "payment" |
"subscription_lifecycle", "provider", "transaction_id"?, "subscription_id"?, "amount"? (major units),
"currency"?}` (the visitor profile's `completedGoals[].origin/type` come from these keys).

W1 writes into two revenue tables from ingest: it inserts `payment_hints` rows for success-page
references the tracker reports (`?session_id=cs_…`, `?checkout_id=`, `?order_id=`,
`?transaction_id=txn_…`; providers `stripe`, `polar`, `lemonsqueezy`, `paddle`), and when a visitor
sends an email (`datafast("payment", {email})` or `identify` with an email) it attributes that site's
unattributed `payments` with the same `email_hash` (`attributed_via = 'email'`, visitor, first/last/
last-non-direct sessions). Ingest write costs per path are in `src/ingest/write.ts` and asserted by
`test/worker/ingest/write-budget.test.ts`.

### Revenue (W3)

Written only by `src/providers/` (migrations 0001 and 0300). Guides: [`docs/revenue/`](../revenue/README.md).

| Table                    | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Key / indexes                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payments`               | Every payment/renewal/refund/free trial: original and reporting amounts (`fx_rate` NULL = no rate yet, re-converted by `providers.fx`), provider ids, visitor and the three attribution sessions (`first_session_id`, `last_session_id`, `last_non_direct_session_id`), `attributed_via` (metadata/link/customer/email/api/none), customer email/name (when allowed) and hash, `lifecycle_goal` (goal emitted), `refund_of`, `source`; 0300 adds `subscription_id` and `reason` (refund/dispute/dispute_won) | `(site_id, id)`; unique `(site_id, provider, provider_txn_id)`; indexes `(site_id, occurred_at)`, `(site_id, visitor_id)`, partial `(site_id, email_hash)` for unattributed |
| `provider_connections`   | Encrypted credentials (`provider:<p>:<site>`) and webhook secret (`provider:<p>:<site>:webhook`), status (`error` after an auth failure; retried hourly), account, provider currency, settings JSON (store/org id, sandbox, auto-created `webhookId`), `last_synced_at` (written at most hourly when idle)                                                                                                                                                                       | `(site_id, provider)`                                                                                                                                                       |
| `provider_sync_state`    | Cursors per stream: `sync` (events cursor / last-seen times), `backfill` (`done` = 1 when finished; `last_error` holds skipped-stream warnings)                                                                                                                                                                                                                                                                                                                          | `(site_id, provider, stream)`                                                                                                                                               |
| `provider_customers`     | Provider customer → visitor, set at the first attributed payment/checkout, for renewals                                                                                                                                                                                                                                                                                                                                                                                  | `(site_id, provider, customer_id)`                                                                                                                                          |
| `provider_subscriptions` | (0300) Last known subscription state: status (trialing/active/past_due/paused/incomplete/ended), monthly MRR, cancel-at-period-end, had trial, first paid time, last paid amount, customer, visitor; diffed to emit lifecycle goals; one row per subscription, written only on change                                                                                                                                                                                      | `(site_id, provider, subscription_id)`                                                                                                                                      |
| `payment_hints`          | Success-page references from the tracker. **W1 inserts** with `paymentHintStatement()` (`provider` = adapter id: stripe, polar, lemonsqueezy, paddle, dodo, creem); W3's `providers.resolve-hints` resolves them (`attempts`, `next_attempt_at` backoff, `resolved_at`, `last_error`)                                                                                                                                                                                      | `(site_id, provider, ref)`; partial index pending by `created_at`                                                                                                           |
| `webhook_events`         | Webhook dedupe; `event_id` = `<siteId>:<provider event id>` (pruned after 30 days by `providers.cleanup`)                                                                                                                                                                                                                                                                                                                                                                | `(provider, event_id)`                                                                                                                                                      |
| `fx_rates`               | Daily ECB reference rates as units per USD (`providers.fx`, hourly check, one fetch a day)                                                                                                                                                                                                                                                                                                                                                                               | `(day, currency)`                                                                                                                                                           |

Write cost of one new attributed payment: 4 rows (row, unique key, time and visitor indexes) + 2
for its goal event + 1 for a new customer mapping (`test/worker/providers/engine.test.ts`). A
duplicate delivery writes nothing; an idle poll writes nothing (`stripe.test.ts`).

### Product configuration (W2)

| Table                 | Purpose                                                  | Key / indexes                                                               |
| --------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------- |
| `funnels`             | Funnel definitions (steps JSON, soft delete `is_active`) | `id`; index `site_id`; unique active `(site_id, name)`                      |
| `goal_customizations` | Display name, colour, description, hidden                | `(site_id, name)`                                                           |
| `segments`            | Saved filter sets (`{"filter_country": "is:US"}`)        | `id`; index `site_id`                                                       |
| `notes`               | Manual chart notes with author and idempotency key       | `id`; index `(site_id, ts)`; unique `(site_id, author_id, idempotency_key)` |
| `prediction_models`   | Per-site purchase-likelihood model (JSON: baseline and per-dimension `[visitors, conversions, revenue]` for channel, referrer, country, device, browser, os), trained daily by `query.predictions` when the site has 1,000+ visitors and 10+ attributed payments; written only when it changed | `site_id`                                                                   |
| `rollup_state`        | Rollup watermark per site (0200): `timezone` the rollups were computed in, `first_day`, `through_day` (last rolled closed day) | `site_id`                                                                   |

### Rollups (W2)

Written by the hourly `query.rollups` job (src/query/jobs/rollups.ts) with
`INSERT … SELECT … ON CONFLICT DO UPDATE … WHERE <changed>` for **closed** days in the site timezone,
from the day before the watermark to yesterday (14 days per run while backfilling), so idle sites and
unchanged days write nothing. Queries read them only for days up to `rollup_state.through_day` and
only while its timezone equals the site's; later days come from raw tables. On a timezone change the
job deletes the site's rollups in bounded chunks and rebuilds them. `DELETE /api/v1/goals` removes
affected `daily_goals` rows and moves the watermark back so the days are rebuilt. Revenue columns are
a snapshot at rollup time; analytics revenue is always read from `payments`.

| Table              | Grain                                                                                                                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `daily_stats`      | site, day: visitors, new/returning, sessions, pageviews, bounces, duration, `events` (0200: events stored, for the usage page), revenue (total/new/renewal/refunds), payments, paying visitors |
| `daily_pages`      | site, day, hostname, path: pageviews, daily unique visitors, entries, exits                                                                                                                                                  |
| `daily_dimensions` | site, day, dimension, value: visitors, sessions, pageviews, bounces, duration, revenue, payments (dimension in referrer, channel, country, region, city, device, browser (Mobile Safari merged), os, hostname; `''` = unknown; entry/exit pages use `daily_pages`, campaigns read raw sessions) |
| `daily_goals`      | site, day, goal: completions, visitors                                                                                                                                                                                       |

### Alerts and delivery (W6)

| Table | Purpose | Key / indexes |
| --- | --- | --- |
| `alerts` | Goal / new-sale / traffic-spike / daily and weekly digest rules; email, Telegram or webhook (bot token / signing secret AES-GCM encrypted with AAD `alert:<site>:<alert>`); trigger counters (daily/monthly reset lazily). Rebuilt by 0600 to widen its CHECKs | `id`; index `site_id` |
| `alert_history` | Delivery log (sent/failed, error, visitor) + 0600 `channel`, `trigger_type`, `summary`; pruned after 180 days | rowid; index `(site_id, triggered_at)` |
| `outbox` | Outbound deliveries with retries (email, Telegram, webhooks; alerts, digests, weekly reports, invites, password resets). Any team may enqueue with `enqueueStatement()` from `src/growth/delivery/outbox.ts`; W6 delivers. Settled rows pruned after 30 days | rowid; unique `dedupe_key`; partial index pending by `next_attempt_at` |

### Growth (W6)

| Table | Purpose | Key / indexes |
| --- | --- | --- |
| `bot_traffic` | Accepted crawler requests per UTC hour, crawler, page, status, verification (one upsert per distinct key: 1 written row) | full composite primary key |
| `bot_settings` | Bot traffic settings JSON | `site_id` |
| `bot_tokens` | `dfbot_` request token (SHA-256 of `dfbot:<token>`) | `site_id`; unique `token_hash` |
| `crawler_ip_ranges` (0600) | Published crawler IP ranges per source, refreshed daily, rewritten only on change | `source` |
| `bot_usage` (0600) | Accepted/dropped bot requests per UTC month while `BOT_TRAFFIC_ALLOWANCE` is set (flushed ≤ once a minute per isolate) | `period` |
| `attack_mode` (0600) | Auto attack-mode settings and the active automatic period (`active_until`, `previous_level`) | `site_id` |
| `attack_mode_events` (0600) | Attack mode on/off log (auto or manual, reason, details) | `id`; index `(site_id, started_at)` |
| `integration_connections` | GitHub, Search Console, Meta Ads, X: encrypted credentials (`integration:<kind>:<site>`), settings (repo, property, ad accounts and campaigns, keywords, handles), sync cursor, status | `(site_id, kind)` |
| `mentions` | X and Reddit mentions (`INSERT OR IGNORE`) | `id`; unique `(site_id, platform, external_id)`; index `(site_id, ts)` |
| `x_links` | `https://t.co/<code>` → post (or link-in-bio profile), for X link attribution; joined to `sessions.referrer` | `(site_id, tco_url)` |
| `github_commits` | Commits for chart markers | `(site_id, sha)`; index `(site_id, committed_at)` |
| `gsc_daily` | Search Console metrics per day: `query = '' AND page = ''` rows are daily totals, others the top query × page rows | `(site_id, day, query, page)` |
| `ad_spend_daily` | Meta campaign spend, impressions, clicks, reach, purchase value per day | `(site_id, platform, account_id, campaign_id, day)` |
| `imports` | Plausible (and DataFast) import jobs | `id`; index `site_id` |
| `imported_daily` | Imported aggregates per day and dimension (`''` = totals) | `(site_id, day, dimension, value, import_id)` |

W6 also updates `sites.bot_level` (to and from `strict`) for automatic and manual attack mode.

**Imported data in analytics (contract for W2):** count only rows of `imports.status =
'completed'` and only days before the first native session (`importCutoff()`), so periods are
never double counted. `dimension = ''` rows are daily totals (`visits` = sessions,
`duration_sum` in ms). Other dimensions use DataGoat's values: `referrer` (source display name,
`Direct / None`), `channel`, `utm_source` … `utm_content`, `page`, `entry_page`, `exit_page`,
`country` (ISO code), `region`, `city` (Plausible GeoNames id), `device`, `browser`, `os`. Summed
visitors are sums of daily uniques. Helpers: `src/growth/imports/read.ts`.

### Ecosystem (W8)

| Table            | Purpose                                                                                                                                                                                                    | Key / indexes                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `mobile_devices` | Mobile app push devices (migration 0800): user, the mobile `dft_` token (`token_id` = `api_keys.id`), platform, Expo push token, sale/alert switches, muted site ids. User-scoped, no `site_id`; pushes stop when the token is revoked | `id`; unique `push_token`; index `user_id` |

W8 also writes `api_keys` (mobile `dft_` tokens, `is_mobile = 1`), `provider_connections` rows for
`shopify` and `woocommerce` (shapes in [contract §13.1](../api/contract.md)), and, for Shopify's
`customers/redact` and `shop/redact` compliance webhooks only, nulls `customer_email`,
`customer_name` and `email_hash` on `payments` rows with `provider = 'shopify'`.

### Operations (F0)

| Table       | Purpose                                                                             | Key    |
| ----------- | ----------------------------------------------------------------------------------- | ------ |
| `job_state` | Cron multiplexer state per job: last run/slot/success, error, failures, JSON cursor | `name` |

## Retention and deletion

- `events` older than `sites.retention_days` are pruned by W2's hourly `query.retention` job (at most
  `RETENTION_ROWS_PER_RUN`, default 2000, per run, and only for days already rolled up); sessions,
  visitors and payments are kept so attribution survives pruning, and rollups keep the history.
- Deleting a website (dashboard only) sets `sites.deleted_at`, revokes its keys and invites; the
  `sites.purge` job (hourly) deletes its rows from every site-scoped table, at most
  `PURGE_ROWS_PER_RUN` (default 1000) rows per run because deletes cost writes, then deletes the site.
