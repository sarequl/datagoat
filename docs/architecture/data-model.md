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
| `sites`             | Websites and every setting: domain, name, logo, timezone, currency, `privacy_mode` (cookie/cookieless/consent), `attribution_model`, `bot_level` (off/standard/strict = attack mode), `honor_gpc`, allowed hostnames (+ all-hostnames flag), exclusions (IPs/CIDRs, path globs, countries, hostnames), `kpi` + colour, `revenue_metric`, `include_renewal_revenue`, `store_customer_emails`, `retention_days`, weekly reports and viral-traffic flags, `share_token` + `public_data_enabled`, soft delete `deleted_at` | `id`; unique `public_id`, `share_token`                      | F0 (settings API); W2 writes `share_token` via the share endpoints |
| `users`             | Dashboard users, PBKDF2 hashes, `password_changed_at`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `id`; unique `email`                                         | F0                                                                 |
| `memberships`       | Role per site: owner/member/viewer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `(site_id, user_id)`; index `user_id`                        | F0                                                                 |
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

### Raw analytics (W1 writes, W2 reads)

| Table              | Purpose                                                                                                                                                                                                                                                                                                                                                                                                  | Key / indexes                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `visitors`         | One row per visitor, written once plus on identify/payment email: first seen (server and cookie), first session, identify profile (`user_id`, `name`, `image`, `profile` JSON, `identified_at`), `email` (when allowed) and `email_hash`                                                                                                                                                                 | `(site_id, id)`; partial indexes `(site_id, user_id)`, `(site_id, email_hash)`        |
| `sessions`         | One row per session; dimensions from the first pageview, never overwritten: entry/exit path, hostname, pageviews, interactions, referrer + domain, `channel`, `source` (display name), UTM fields, `ref`, `source_param`, `via`, ad click ids, geo (country, region, city, lat, lon), device/browser/OS (+ versions, vendor, model), language, timezone, screen/viewport, `session_number`, `cookieless` | `(site_id, id)`; indexes `(site_id, started_at)`, `(site_id, visitor_id, started_at)` |
| `events`           | Every pageview, goal (`custom`), identify, payment and outbound click (`external_link`); `path` includes `#hash` for the hash build; `name` = goal name; `props` JSON                                                                                                                                    | rowid; index `(site_id, ts)`; partial (non-pageview, W2) `(site_id, type, ts)` and `(site_id, visitor_id)` |
| `cookieless_salts` | Daily random salts for HMAC(site, IP, UA); today and yesterday only                                                                                                                                                                                                                                                                                                                                      | `day` (UTC)                                                                           |
| `bot_daily`        | Count of ingest hits dropped as bots, by reason                                                                                                                                                                                                                                                                                                                                                          | `(site_id, day, reason)`                                                              |

W3 also inserts `events` rows (type `custom`, names `payment`, `free_trial` and DataFast's lifecycle
goals) for attributed payments, so goal filters and journeys include them.

### Revenue (W3)

| Table                  | Purpose                                                                                                                                                                                                                                                                                                                                           | Key / indexes                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payments`             | Every payment/renewal/refund/free trial: original and reporting amounts, FX rate, provider ids, visitor and the three attribution sessions (`first_session_id`, `last_session_id`, `last_non_direct_session_id`), `attributed_via` (metadata/link/customer/email/api/none), customer email/name (when allowed) and hash, lifecycle goal, `source` | `(site_id, id)`; unique `(site_id, provider, provider_txn_id)`; indexes `(site_id, occurred_at)`, `(site_id, visitor_id)`, partial `(site_id, email_hash)` for unattributed |
| `provider_connections` | Encrypted credentials and status per provider                                                                                                                                                                                                                                                                                                     | `(site_id, provider)`                                                                                                                                                       |
| `provider_sync_state`  | Polling/backfill cursors per stream                                                                                                                                                                                                                                                                                                               | `(site_id, provider, stream)`                                                                                                                                               |
| `provider_customers`   | Provider customer → visitor, for renewals                                                                                                                                                                                                                                                                                                         | `(site_id, provider, customer_id)`                                                                                                                                          |
| `payment_hints`        | Success-page references from the tracker, resolved by cron                                                                                                                                                                                                                                                                                        | `(site_id, provider, ref)`; partial index pending by `created_at`                                                                                                           |
| `webhook_events`       | Webhook dedupe by provider event id (prune after 30 days)                                                                                                                                                                                                                                                                                         | `(provider, event_id)`                                                                                                                                                      |
| `fx_rates`             | Daily ECB reference rates as units per USD                                                                                                                                                                                                                                                                                                        | `(day, currency)`                                                                                                                                                           |

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

| Table           | Purpose                                                                                         | Key / indexes                                                          |
| --------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `alerts`        | Goal / new-sale / traffic-spike / digest alerts; email or Telegram (bot token in `secret_enc`, AAD `alert:<site_id>:<alert_id>`); counters. Rules are written by W2's CRUD API, counters by W6 | `id`; index `site_id`                                                  |
| `alert_history` | Delivery log                                                                                    | rowid; index `(site_id, triggered_at)`                                 |
| `outbox`        | Outbound deliveries with retries (email, Telegram); any team may enqueue, W6 delivers           | rowid; unique `dedupe_key`; partial index pending by `next_attempt_at` |

### Growth (W6)

| Table                     | Purpose                                                                                                                       | Key / indexes                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `bot_traffic`             | Accepted crawler requests per UTC hour, crawler, page, status, verification (one upsert per request)                          | full composite primary key                                             |
| `bot_settings`            | Bot traffic settings JSON                                                                                                     | `site_id`                                                              |
| `bot_tokens`              | `dfbot_` request token (hashed)                                                                                               | `site_id`; unique `token_hash`                                         |
| `integration_connections` | GitHub, Search Console, Meta Ads, X: encrypted credentials, settings (repo, property, ad accounts, keywords, handles), cursor | `(site_id, kind)`                                                      |
| `mentions`                | X and Reddit mentions                                                                                                         | `id`; unique `(site_id, platform, external_id)`; index `(site_id, ts)` |
| `x_links`                 | t.co link → tweet, for X link attribution                                                                                     | `(site_id, tco_url)`                                                   |
| `github_commits`          | Commits for chart markers                                                                                                     | `(site_id, sha)`; index `(site_id, committed_at)`                      |
| `gsc_daily`               | Search Console query/page metrics per day                                                                                     | `(site_id, day, query, page)`                                          |
| `ad_spend_daily`          | Meta campaign spend per day                                                                                                   | `(site_id, platform, account_id, campaign_id, day)`                    |
| `imports`                 | Plausible (and DataFast) import jobs                                                                                          | `id`; index `site_id`                                                  |
| `imported_daily`          | Imported aggregates per day and dimension (`''` = totals)                                                                     | `(site_id, day, dimension, value, import_id)`                          |

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
