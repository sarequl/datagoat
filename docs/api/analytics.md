# Analytics API

DataGoat serves DataFast's analytics, visitors, server-side events and website admin API at the same
paths with the same parameters, field names and errors, so a DataFast API client works after changing
its base URL from `https://datafa.st` to your DataGoat URL. The full endpoint list and shapes are in
[contract.md](contract.md); this page explains how to use them and what to expect.

## Authenticate

```bash
# A website key (dg_...) picks its website automatically.
curl -H "Authorization: Bearer dg_xxx" "https://analytics.example.com/api/v1/analytics/overview"

# An account token (dgt_...) needs ?websiteId= (the website id or its tracking id).
curl -H "Authorization: Bearer dgt_xxx" \
  "https://analytics.example.com/api/v1/analytics/overview?websiteId=665f0b3c4d2e1a0012345678"
```

Create keys in **Settings → API keys**. Account tokens can be limited to permissions such as
`analytics:read`, `goals:write`, `identify:write`, `funnels:write`, `notes:write`, `alerts:write` and
`settings:write`, and to some websites. API credentials are limited to 60 requests per minute
(`X-RateLimit-*` headers; 429 with `Retry-After` beyond).

## Date ranges, timezones and filters

- `startAt` and `endAt` go together. `YYYY-MM-DD` covers whole days in `timezone` (end day included);
  ISO timestamps with `Z` or an offset are exact. Omit both for all time (the timeseries uses a
  default window: 24 hours for `hour`, 30 days for `day`/`week`, 12 months for `month`, 30 minutes for
  `minute`).
- `timezone` defaults to the website timezone.
- Every analytics endpoint takes `filter_*` parameters: `filter_country=US,Canada`,
  `filter_device=mobile`, `filter_referrer=Google`, `filter_referrer=Direct/None`,
  `filter_page=contains:/docs`, `filter_entry_page=/pricing`, `filter_goal=signup`,
  `filter_visit_count=gte:2`, `filter_utm_campaign=launch`, `filter_ref=hn`, `filter_hostname=…`,
  `filter_channel=Organic Search` and more. Prefix a value with `is:`, `is_not:`, `contains:`,
  `does_not_contain:` (or `gte:`/`lte:` for the visit count); comma-separated values match any.
  `filter_page` and `filter_goal` select visitors who viewed the page / completed the goal in the range.
  Revenue under filters counts the payments whose attributed session (see **Attribution** below)
  matches.

## What you can ask

| Question | Request |
|---|---|
| Headline numbers, with last period | `GET /api/v1/analytics/overview?startAt=…&endAt=…&compare=previous` |
| A chart | `GET /api/v1/analytics/timeseries?interval=day&fields=visitors,revenue` |
| Bounce rate and session time per day, goals per day | `…/timeseries?interval=day&fields=bounce_rate,avg_session_duration,goals` |
| The last 30 minutes, minute by minute | `…/timeseries?interval=minute&fields=visitors,pageviews` |
| Visitors on the site right now | `GET /api/v1/analytics/realtime`, `…/realtime/map` |
| The last 8 hours on the globe | `GET /api/v1/analytics/realtime/replay` |
| Top pages, entry and exit pages, outbound links | `…/pages`, `…/entry-pages`, `…/exit-pages`, `…/exit-clicks` |
| Where visitors and revenue come from | `…/referrers`, `…/channels`, `…/campaigns` |
| Where they are and what they use | `…/countries`, `…/regions`, `…/cities`, `…/devices`, `…/browsers`, `…/operating-systems`, `…/hostnames` |
| Goals and their properties | `…/goals`, `…/goals/properties?eventName=signup&propertyName=plan` |
| When people browse | `GET /api/v1/analytics/heatmap` (weekday × hour) |
| A funnel | `GET /api/v1/analytics/funnels/{funnelId}` |
| Find visitors, see one journey | `GET /api/v1/visitors?completedGoal=signup`, `GET /api/v1/visitors/{id}` |

Breakdowns take `fields`, `limit` (default 100, max 1000), `offset`, sort by visitors and return
`pagination {limit, offset, total, hasMore}`.

## Metrics

- **visitors**: distinct visitors with a session that started in the range. **new / returning**:
  by the visitor's lowest session number in the range (below 2 = new; cookieless sessions are neither).
- **bounce_rate**: share of sessions with at most one pageview or interaction.
  **avg_session_duration**: seconds from a session's first to last event, averaged.
- **revenue**: payments that occurred in the range, in the website currency (refunds negative,
  renewals included unless the website excludes renewal revenue). **payments** counts payments (and
  renewals). **conversion_rate**: paying visitors ÷ visitors, in percent.
- On page and goal rows, revenue is the revenue of the visitors who viewed the page / completed the
  goal; on every other breakdown it follows the attribution model.

## Attribution

Each payment remembers the visitor's first session, last session and last non-direct session. The
website's attribution model (**Settings → Attribution**: first touch, last touch or last non-direct)
picks which one a breakdown credits. Changing it applies to all past data immediately.

## Long ranges and "approximate"

Raw data gives exact numbers. For long ranges on busy websites (by default once the range holds 5,000
sessions, configurable with the `ROLLUP_MIN_SESSIONS` variable) breakdowns, pages, goals and the
timeseries read daily rollups instead, which keeps a dashboard load to a small fraction of the
Cloudflare Free plan's daily read allowance. Rollup visitor counts add up each day's unique visitors,
so a visitor who came on three days counts three times; such responses include `"approximate": true`.
Filters, a timezone other than the website's or ranges that do not cover whole days always use raw
data. The overview's visitor count is always exact.

Rollups are computed hourly for days that have ended in the website timezone. If you prune old
events (**Settings → Data retention**), long-range reports keep working from the rollups.

## Imported history

After a Plausible import completes (**Settings → Import**), its days appear in the overview, the
day/week/month chart and the referrer, channel, country, device, browser, operating system, page,
entry page and exit page breakdowns. Only days before DataGoat's first tracked session are used, so
nothing is counted twice. Imported numbers have no revenue, goals or new/returning split, are left out
of filtered views, hourly charts and other timezones, and their visitor counts are daily uniques
(`"approximate": true`). Regions, cities, hostnames and campaign combinations cannot be matched to
Plausible's export and show tracked data only.

## Purchase-likelihood prediction

Once a website has tracked 1,000 visitors and 10 attributed payments, a daily job learns how
visitors with each channel, referrer, country, device, browser and operating system converted over the
last 90 days. The realtime map then shows a score from 0 to 100 for each visitor (50 = average; 100 for
existing customers), and the visitor profile includes `prediction {score, conversionRate,
expectedValue, confidence}`. `expectedValue` is in the website currency.

## Server-side events

```bash
# Record a goal from your backend (the visitor needs at least one pageview).
curl -X POST -H "Authorization: Bearer dg_xxx" -H "Content-Type: application/json" \
  -d '{"datagoat_visitor_id":"a3ab2331-989f-4cfa-91c6-2461c9e3c6bd","name":"newsletter_signup","metadata":{"plan":"pro"}}' \
  https://analytics.example.com/api/v1/goals

# Link a visitor to your user (extra fields are merged into the profile).
curl -X POST -H "Authorization: Bearer dg_xxx" -H "Content-Type: application/json" \
  -d '{"user_id":"user_123","datagoat_visitor_id":"a3ab2331-989f-4cfa-91c6-2461c9e3c6bd","email":"jane@example.com","plan":"pro"}' \
  https://analytics.example.com/api/v1/identify

# Delete test goals (a range is required when no visitor or name is given).
curl -X DELETE -H "Authorization: Bearer dg_xxx" \
  "https://analytics.example.com/api/v1/goals?name=signup&startAt=2026-05-01T00:00:00Z&endAt=2026-05-19T23:59:59Z"
```

## Website resources

Under `/api/v1/admin/websites/{websiteId}`: tracked goals (`/goals`), goal display names and colours
(`/goals/customizations`), funnels (`/funnels`), chart notes (`/notes`, with an `idempotencyKey` for
safe retries), saved segments (`/segments`), alert rules and their history (`/alerts`,
`/alerts/history`), the public share link (`/share`) and database usage (`/usage`: events stored, D1
size and plan limits; set `D1_PLAN=paid` on Workers Paid for the right limits).

## Public dashboards

`POST /api/v1/admin/websites/{id}/share` creates a link `https://…/share/<token>` that anyone can open
without signing in. It serves the same charts and breakdowns (and the realtime globe) without visitor
details, notes or personal data; revenue appears only when **public data** is enabled. Posting again
rotates the token; `DELETE` disables it.

## Caching

On a custom domain, responses are cached by Cloudflare: a day for ranges that ended before today, 60
seconds otherwise (`X-Cache: HIT|MISS`). Send `Cache-Control: no-cache` to force fresh numbers, for
example right after importing or deleting data. `*.workers.dev` hostnames do not cache.
