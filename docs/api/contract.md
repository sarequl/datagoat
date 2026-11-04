# DataGoat HTTP API contract

This is the contract every team builds against. The TypeScript half lives in
[`shared/api-types.ts`](../../shared/api-types.ts): the dashboard client and the mock fixtures are typed
against it, and Worker handlers return those shapes. **Change both in the same commit** and say so in
your report.

Endpoints marked **DF** exist in DataFast's API and must behave as DataFast documents (field names,
defaults, errors), so DataFast API users can switch by changing the base URL. Endpoints marked **DG**
are DataGoat extensions. The owning team is in the last column; F0 endpoints are implemented.

## 1. Conventions

### 1.1 Base URLs and transports

| Prefix                         | What                                    | Auth                                                     |
| ------------------------------ | --------------------------------------- | -------------------------------------------------------- |
| `/api/events`                  | Tracker ingest (W1)                     | none (public site id)                                    |
| `/api/ai-crawls`               | Server-side crawler ingest (W6)         | optional `dfbot_` token                                  |
| `/api/setup`, `/api/auth/*`    | First-run setup and dashboard auth (F0) | cookie                                                   |
| `/api/v1/*`                    | Public + dashboard API                  | session cookie **or** `Authorization: Bearer df_…/dft_…` |
| `/api/share/:token/*`          | Read-only share-link API (W2)           | the share token                                          |
| `/mcp`, `/api/mcp`             | MCP server, streamable HTTP (W7)        | Bearer `dft_` or MCP OAuth token                         |
| `/oauth/*`, `/.well-known/*`   | MCP OAuth 2.1 (W7)                      | per OAuth spec                                           |
| `/webhooks/<provider>/:siteId` | Provider webhooks (W3, W6 for GitHub)   | provider signature                                       |
| `/share/:token`                | Public dashboard page shell (W2)        | the share token                                          |

The dashboard uses the same `/api/v1` endpoints as API clients, authenticated by the session cookie
and passing `?websiteId=` like a `dft_` token. There is no separate internal API.

### 1.2 Authentication and website resolution

Implemented in `src/auth/middleware.ts` (`requireSiteAccess`, `requireAccountAccess`). Handlers call
`getAccess(c)` → `{user, site, role, scopes, auth}`.

| Credential                  | Website on website routes                     | Permissions             | Role                               |
| --------------------------- | --------------------------------------------- | ----------------------- | ---------------------------------- |
| Session cookie `dg_session` | `?websiteId=` (or path `:websiteId`) required | all (`*`)               | the user's membership role         |
| `df_` website key           | inferred; a different `websiteId` → **403**   | all website permissions | creator's role, capped at `member` |
| `dft_` account token        | `?websiteId=` required (**400** without)      | the token's list        | the user's membership role         |
| MCP OAuth token (W7)        | per connection                                | the connection's scopes | membership role                    |

- `websiteId` accepts the internal id (`_id`, 24 hex) or the public tracking id (`trackingId`).
- Unknown website or no membership → **404** `Website not found`. Website outside a token's
  allowlist → **403**. Missing permission → **403** `Missing permission: <perm>`. Role does not allow →
  **403** `Your role (<role>) does not allow <perm>`.
- Roles: `viewer` = every `:read`; `member` = everything except `team:write`; `owner` = everything.
  Owner-only actions additionally use `minRole: "owner"`.
- `df_` keys cannot call account-level routes (access tokens, website creation, OAuth connections) or
  owner-only routes (team writes) → **403**. A `df_` key stops working (**401**) when its creator
  loses membership.
- Invalid/expired/revoked Bearer → **401** `Invalid, expired or revoked API key`. Malformed header →
  **401**.
- Cookie-authenticated unsafe requests (POST/PUT/PATCH/DELETE) must be same-origin (`Origin` header
  or `Sec-Fetch-Site`), else **403**. Bearer requests are exempt.
- Customer names and emails (PII) are returned only when `auth.includePii` is true: sessions always;
  keys/tokens only when created with `includePii: true`. Otherwise those fields are `null`.

### 1.3 Envelopes and errors

```jsonc
// success
{ "status": "success", "data": <array|object>, "pagination"?: { "limit", "offset", "total", "hasMore"? }, ...extra }
// error
{ "status": "error", "error": { "code": <HTTP status>, "message": "<human readable>" } }
```

- Most DataFast endpoints return `data` as an **array with one object** (`[{...}]`) even for single
  resources; keep that where DataFast does it (marked `[obj]` below).
- Exceptions, both DataFast-compatible: `POST /api/v1/payments` returns a plain
  `{message, transaction_id}`; **429** bodies are
  `{"error": "Too many requests", "message", "limit", "remaining", "reset"}`.
- Build envelopes with `success()`, `errorResponse()`; throw `ApiError(status, message)` anywhere
  (`src/lib/errors.ts`, `src/lib/response.ts`). Validation failures → **400** naming the field.
- Unbuilt routes answer **501** `Not implemented yet: <METHOD> <path> (owner: Wn)`.
- Unknown `/api/*` paths → **404** `No route for <METHOD> <path>`.
- API responses carry `Cache-Control: no-store` unless the handler sets it, plus `X-Request-Id`.

### 1.4 Rate limits

Bearer credentials: 60 requests/minute per credential (`API_LIMITER` binding). Every response has
`X-RateLimit-Limit`, `X-RateLimit-Remaining` (approximate, per isolate) and `X-RateLimit-Reset` (epoch
seconds); over the limit → **429** + `Retry-After`. Dashboard sessions are not limited. Ingest uses
`INGEST_IP_LIMITER` (60/min, key `${siteId}:${ip}`) and `INGEST_SITE_LIMITER` (600/min, key `siteId`).

### 1.5 Dates, timezones, pagination, fields

- `startAt`/`endAt`: both or neither (**400** otherwise). `YYYY-MM-DD` covers whole local days in
  `timezone` (end inclusive); ISO with `Z`/offset keeps exact instants; ISO without zone is read in
  `timezone`. Omitted → all time, unless the endpoint documents a default window. Use
  `parseRange()` from `src/lib/time.ts`. Deprecated aliases `start`/`end` are accepted together on the
  DataFast delete endpoints.
- `timezone`: IANA name, defaults to the website timezone; invalid → **400**.
- `limit` default 100, max 1000 (visitors list: max 250); `offset` ≥ 0 (`parsePagination()`).
- `fields`: comma-separated response columns; unknown → **400** `Invalid fields value: …`
  (`parseFields()`).
- Timestamps in responses: ISO 8601 UTC strings. Money: major units of the website currency
  (2 decimals, 0 for JPY etc.). Percentages: 0–100 with 2 decimals.

### 1.6 Filters (`filter_*`)

Compiled by `src/lib/filters.ts` (`parseFilters` + `compileFilters`). Value syntax:
`[operator:]value[,value…]` (max 50 values; several values match any). Default operator `is`.

| Parameter                                   | Level   | Operators                              | Column / semantics                                                                                                             |
| ------------------------------------------- | ------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `filter_country`                            | session | is, is_not                             | `sessions.country`; names or ISO codes (`US`, `United States`, `UK`)                                                           |
| `filter_region`, `filter_city`              | session | is, is_not, contains, does_not_contain | `region`, `city`                                                                                                               |
| `filter_device`                             | session | is, is_not                             | `desktop` / `mobile` / `tablet`                                                                                                |
| `filter_browser`                            | session | is, is_not                             | `Safari` also matches `Mobile Safari`                                                                                          |
| `filter_os`                                 | session | is, is_not                             | `os`                                                                                                                           |
| `filter_referrer`                           | session | is, is_not, contains, does_not_contain | source display name **or** referrer domain; `Direct / None` (also `Direct/None`, `direct`, `none`) = no referrer and no source |
| `filter_entry_page`                         | session | is, is_not, contains, does_not_contain | `entry_path`                                                                                                                   |
| `filter_hostname`                           | session | is, is_not, contains, does_not_contain | entry hostname                                                                                                                 |
| `filter_visit_count`                        | session | is, is_not, gte, lte                   | `session_number`; cookieless (NULL) never matches                                                                              |
| `filter_utm_source` … `filter_utm_content`  | session | text ops                               | `utm_*`                                                                                                                        |
| `filter_ref`, `filter_source`, `filter_via` | session | text ops                               | `ref`, `source_param`, `via` URL parameters                                                                                    |
| `filter_channel` (DG)                       | session | is, is_not                             | `channel`                                                                                                                      |
| `filter_page`                               | visitor | is, is_not, contains, does_not_contain | visitors who viewed a matching page **in the range** (or the event row itself with `eventAlias`)                               |
| `filter_goal`                               | visitor | is, is_not                             | visitors who completed the goal in the range (`events.type='custom'`)                                                          |

Text comparisons are case-insensitive; `is_not`/`does_not_contain` keep sessions whose column is
unknown. Unknown or repeated `filter_*` → **400**. Endpoints may restrict keys (`allowed`), e.g. goal
properties reject entry_page, hostname, visit_count, channel and goal.

### 1.7 Metrics

Defined once in `src/lib/metrics.ts` (see the table there): `visitors`, `new_visitors`,
`returning_visitors`, `visitorBreakdown`, `pageviews`, `sessions`, `bounce_rate`,
`avg_session_duration` (seconds), `currency`, `revenue`, `payments`, `revenue_per_visitor`,
`conversion_rate`. Breakdown revenue joins payments to the session chosen by the website's
attribution model (`first_touch` → `first_session_id`, `last_touch` → `last_session_id`,
`last_non_direct` → `last_non_direct_session_id`). Revenue counts payments that **occurred** in the
range; refunds are negative; renewals are excluded when `includeRenewalRevenue` is false.

### 1.8 Permissions

DataFast's names (`shared/permissions.ts`): `analytics:read`, `goals:read|write`,
`payments:read|write`, `identify:write`, `websites:read|write`, `settings:read|write`,
`funnels:read|write`, `alerts:read|write`, `team:read|write`, `api-keys:read|write`,
`notes:read|write`, `*`. DataGoat-only endpoints reuse them as listed below.

## 2. Setup and dashboard auth (F0, implemented)

| Method | Path                               | Body                                                                                                   | Response `data`                                       | Errors                                                          |
| ------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- | --------------------------------------------------------------- |
| GET    | `/api/setup`                       | –                                                                                                      | `SetupStatus {needsSetup, configErrors[]}`            | –                                                               |
| POST   | `/api/setup`                       | `SetupRequest {token, email, password(8–256), name?, website?: {domain, timezone?, name?, currency?}}` | `SetupResult {user, websites, website}` + sets cookie | 403 token, 409 done, 503 weak secrets, 400                      |
| POST   | `/api/auth/login`                  | `{email, password}`                                                                                    | `Me {user, websites}` + sets cookie                   | 401 `Invalid email or password`, 429 throttled (+`Retry-After`) |
| POST   | `/api/auth/logout`                 | –                                                                                                      | `{message}`, clears cookie                            | –                                                               |
| GET    | `/api/auth/me`                     | –                                                                                                      | `Me` + `authKind` (any credential)                    | 401                                                             |
| PUT    | `/api/auth/password`               | `{currentPassword, newPassword}` (session only)                                                        | `{message}`; other sessions revoked                   | 400, 403 for Bearer                                             |
| GET    | `/api/auth/invites/:token`         | –                                                                                                      | `InviteInfo`                                          | 404, 410 used/expired                                           |
| POST   | `/api/auth/invites/:token/accept`  | `{name?, password?}`                                                                                   | `Me` + `websiteId`; new users get a session           | 400 password missing, 401 sign in first, 403 other email, 410   |
| GET    | `/api/auth/password-resets/:token` | –                                                                                                      | `{email}`                                             | 404, 410                                                        |
| POST   | `/api/auth/password-resets/:token` | `{password}`                                                                                           | `{message}`; all sessions revoked                     | 404, 410                                                        |
| GET    | `/api/health`                      | –                                                                                                      | `{ok: true}`                                          | –                                                               |

Cookie: `dg_session`, HttpOnly, Secure (https and localhost), SameSite=Lax, Path=/, 30 days. Login
throttling: 20 failures per IP or 8 per email per 15 minutes (KV, written only on failures).

## 3. Account API `/api/v1/admin` (F0, implemented)

| Method      | Path                                              | Perm (`df_`?)                                         | Body / query                                                                                                          | Response `data`                                                                                       |
| ----------- | ------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| GET         | `/account`                                        | analytics:read (yes)                                  | –                                                                                                                     | `[Account]`; `websiteId` with `df_`                                                                   |
| PUT         | `/account`                                        | analytics:read (no)                                   | `{name}` 1–100                                                                                                        | `[{id, name, email, image}]`                                                                          |
| GET         | `/access-tokens`                                  | api-keys:read (no)                                    | –                                                                                                                     | `AccessToken[]` (masked)                                                                              |
| POST        | `/access-tokens`                                  | api-keys:write (no)                                   | `CreateAccessTokenRequest {name?, permissions? (default ["*"]), websiteIds? ([] = all), includePii?, expiresInDays?}` | `[AccessToken & {key}]` (key shown once)                                                              |
| DELETE      | `/access-tokens/:tokenId`                         | api-keys:write (no)                                   | –                                                                                                                     | `[{message}]`; 404 if not the caller's                                                                |
| GET         | `/websites`                                       | websites:read (yes: own site)                         | –                                                                                                                     | `WebsiteSummary[]` with `role`                                                                        |
| POST        | `/websites`                                       | websites:write (no; tokens restricted to sites → 403) | `{domain, timezone, name?, currency?}`                                                                                | `[{websiteId, domain, trackingId}]`; 409 duplicate domain                                             |
| GET         | `/websites/:websiteId`                            | settings:read (yes)                                   | –                                                                                                                     | `[Website]`                                                                                           |
| PUT         | `/websites/:websiteId`                            | settings:write (yes)                                  | `WebsiteUpdate` (only changed fields; unknown fields → 400)                                                           | `[Website]`                                                                                           |
| DELETE      | `/websites/:websiteId`                            | websites:write                                        | –                                                                                                                     | Bearer → **403** (dashboard-only, as DataFast); session owner → soft delete, `[{message, websiteId}]` |
| GET         | `/websites/:websiteId/apikeys`                    | api-keys:read (yes)                                   | –                                                                                                                     | `WebsiteKey[]` (mobile keys hidden)                                                                   |
| POST        | `/websites/:websiteId/apikeys`                    | api-keys:write (yes)                                  | `{name?, includePii?, isMobile?}`                                                                                     | `[WebsiteKey & {key}]`; 400 over 10 keys                                                              |
| PUT         | `/websites/:websiteId/apikeys/:apiKeyId`          | api-keys:write                                        | –                                                                                                                     | `[WebsiteKey & {key}]` rolled; old secret dies                                                        |
| DELETE      | `/websites/:websiteId/apikeys/:apiKeyId`          | api-keys:write                                        | –                                                                                                                     | `[{deleted: true}]`                                                                                   |
| GET         | `/websites/:websiteId/team`                       | team:read (yes)                                       | –                                                                                                                     | `TeamMember[]` (owner first)                                                                          |
| POST        | `/websites/:websiteId/team`                       | team:write + owner (no)                               | `{email, role: viewer\|member}`                                                                                       | `[CreatedInvite]` incl. `inviteUrl` (DG); 400 self, 409 member/pending                                |
| DELETE      | `/websites/:websiteId/team`                       | team:write + owner (no)                               | `{userId}`                                                                                                            | `[{message}]`; 400 self, 404                                                                          |
| PUT (DG)    | `/websites/:websiteId/team`                       | team:write + owner (no)                               | `{userId, role: owner\|member\|viewer}`                                                                               | `[{message, userId, role}]`; 400 would remove last owner                                              |
| GET (DG)    | `/websites/:websiteId/team/invites`               | team:read                                             | –                                                                                                                     | `PendingInvite[]`                                                                                     |
| DELETE (DG) | `/websites/:websiteId/team/invites/:invitationId` | team:write + owner                                    | –                                                                                                                     | `[{message}]`                                                                                         |

`Website` = DataFast's fields (`_id, domain, name, logo, trackingId, timezone, currency, kpi,
kpiColorScheme, revenueMetric, isCookieless, isAttackModeEnabled, includeRenewalRevenue,
allowedHostnames, isAllHostnamesAllowed, excludedIps, excludedPaths, excludedCountries,
excludedHostnames, sendWeeklyReports, sendViralTrafficAlerts, isPublicDashboardEnabled,
isPublicDataEnabled, createdAt`) plus DG `privacyMode (cookie|cookieless|consent), attributionModel,
botLevel (off|standard|strict; strict = attack mode), honorGpc, storeCustomerEmails, retentionDays
(30–36500|null), shareToken, updatedAt, role`. `isCookieless`/`isAttackModeEnabled` map onto
`privacyMode`/`botLevel` (the explicit DG field wins). `kpi: "revenue"` or `null` means revenue.
`excludedCountries` accepts names or codes and stores ISO codes. `isPublicDashboardEnabled: true`
mints a share token; `false` deletes it.

## 4. Ingest (W1)

| Method  | Path          | Notes                                                                                                                                                                                              |
| ------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST    | `/api/events` | DataFast body (plan §3.4), any content type, ≤ 8 KB. 200 `{}`; cookieless adds `{visitorId}`. Malformed → 400. Write with one `db.batch()` in `waitUntil`. CORS: `Access-Control-Allow-Origin: *`. |
| OPTIONS | `/api/events` | CORS preflight (DataFast's script sends `application/json`).                                                                                                                                       |

## 5. Server-side events (W2, DF)

| Method | Path               | Perm           | Body / query                                                                                                    | Response                                                                          |
| ------ | ------------------ | -------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| POST   | `/api/v1/goals`    | goals:write    | `{datafast_visitor_id\|visitorId, name, description?, metadata? (≤10 keys, key ^[a-z0-9_-]+$ ≤64, value ≤255)}` | `[{message, eventId}]`; 400, 403 suspended, 404 visitor has no pageviews          |
| DELETE | `/api/v1/goals`    | goals:write    | query `datafast_visitor_id?`, `name?`, `startAt&endAt` (required when unfiltered)                               | `[{message, datafast_visitor_id?, goal_name?, timeRange?}]`                       |
| POST   | `/api/v1/identify` | identify:write | `{user_id ≤255, datafast_visitor_id, ...profile}` (shallow merge)                                               | `{message, profileId?, action?: created\|updated\|unchanged}` (object, not array) |

## 6. Analytics `/api/v1/analytics` (W2 unless noted, `analytics:read`)

All take `websiteId` (non-`df_`), `startAt`, `endAt`, `timezone`, `filter_*`. Breakdowns take
`fields`, `limit`, `offset`, sort by visitors desc, and return `pagination`.

| Method | Path                                                                                    | Extra params                                                                                                                                                                                                                                                                              | Response                                                                                                                                                  |
| ------ | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/overview` (DF)                                                                        | `fields`                                                                                                                                                                                                                                                                                  | `[Overview]`                                                                                                                                              |
| GET    | `/timeseries` (DF)                                                                      | `fields` (required: name, visitors, new_visitors, returning_visitors, visitor_breakdown, pageviews, sessions, revenue, payments, conversion_rate; DG: bounce_rate, avg_session_duration, goals), `interval` (required: hour, day, week, month; DG: minute for ranges up to 6 h); default window 24 h / 30 d / 12 mo; same-day range → hour; `revenue` implies `payments` | `TimeseriesPoint[]` + top-level `fields, interval, timezone, currency, totals` (with `visitorBreakdown`, `revenueBreakdown`) + `pagination`               |
| GET    | `/metadata` (DF)                                                                        | `fields`                                                                                                                                                                                                                                                                                  | `[Metadata]`                                                                                                                                              |
| GET    | `/realtime` (DF)                                                                        | `fields=visitors`                                                                                                                                                                                                                                                                         | `[{visitors}]` active in the last 10 min                                                                                                                  |
| GET    | `/realtime/map` (DF)                                                                    | –                                                                                                                                                                                                                                                                                         | `RealtimeMap` (object): `count, visitors[], conversionMetrics?, hasConversionPredictions, recentEvents[], recentPayments[]`; PII fields need `includePii` |
| GET    | `/realtime/replay` (DG) | – | `RealtimeReplay` (object): the last 8 h in 15-minute `frames[]` of `{at, visitors[{visitorId, latitude, longitude, countryCode, city, isCustomer, conversionScore}], pageviews, goals, payments}`; no PII |
| GET    | `/pages` (DF)                                                                           | fields: hostname, path, visitors, revenue, payments                                                                                                                                                                                                                                       | `PageRow[]`                                                                                                                                               |
| GET    | `/entry-pages` (DG)                                                                     | same as pages                                                                                                                                                                                                                                                                             | `EntryPageRow[]`                                                                                                                                          |
| GET    | `/exit-pages` (DG)                                                                      | same as pages                                                                                                                                                                                                                                                                             | `EntryPageRow[]`                                                                                                                                          |
| GET    | `/exit-clicks` (DF)                                                                     | fields: url, visitors, clicks (sorted by visitors)                                                                                                                                                                                                                                        | `ExitClickRow[]`                                                                                                                                          |
| GET    | `/referrers` (DF)                                                                       | fields: referrer, visitors, revenue, payments                                                                                                                                                                                                                                             | `ReferrerRow[]`; `referrer` = source display name, else domain, else `Direct / None`                                                                      |
| GET    | `/channels` (DG)                                                                        | fields: channel, visitors, revenue, payments                                                                                                                                                                                                                                              | `ChannelRow[]`                                                                                                                                            |
| GET    | `/campaigns` (DF)                                                                       | fields: utm_source, utm_medium, utm_campaign, utm_term, utm_content, ref, source, via, visitors, revenue, payments                                                                                                                                                                        | `CampaignRow[]` (`""` for absent)                                                                                                                         |
| GET    | `/countries` (DF)                                                                       | fields: country, image, visitors, revenue, payments                                                                                                                                                                                                                                       | `CountryRow[]` (`country` = English name, `image` = flag emoji, DG `code`)                                                                                |
| GET    | `/regions`, `/cities`, `/devices`, `/browsers`, `/operating-systems`, `/hostnames` (DF) | fields: the dimension + visitors, revenue, payments                                                                                                                                                                                                                                       | `RegionRow[]` … (`operating_system` key; Mobile Safari merged into Safari)                                                                                |
| GET    | `/goals` (DF)                                                                           | fields: name→`goal`, completions, visitors                                                                                                                                                                                                                                                | `GoalRow[]`; DG adds `revenue`, `conversion_rate`                                                                                                         |
| GET    | `/goals/properties` (DF)                                                                | `eventName` (required), `propertyName?`; strict params; filters except entry_page/hostname/visit_count/channel/goal                                                                                                                                                                       | `GoalPropertyRow[]` + `pagination.hasMore` + `meta {eventName, propertyName, timezone, startAt, endAt}`                                                   |
| GET    | `/funnels/:funnelId` (DF)                                                               | –                                                                                                                                                                                                                                                                                         | `[FunnelResult]`; inactive funnel → 404                                                                                                                   |
| GET    | `/revenue` (DG, **W3**)                                                                 | –                                                                                                                                                                                                                                                                                         | `RevenueSummary` (object)                                                                                                                                 |
| GET    | `/bot-traffic` (DF, **W6**)                                                             | `interval`, `category`, `verification`, `company`, `crawlerId`; default last 30 days                                                                                                                                                                                                      | `[BotTrafficSummary]`                                                                                                                                     |
| GET    | `/bot-traffic/pages` (DF, **W6**)                                                       | + `pageSearch`, `limit` 1–100, `offset`                                                                                                                                                                                                                                                   | `BotTrafficPage[]` + `context` + `pagination {limit, offset, hasMore, nextOffset}`                                                                        |

DG time-series extensions used by the dashboard (W4): `bounce_rate` and `avg_session_duration`
per bucket (same definitions as the overview) feed the metric trend charts; `goals` returns
`goals: {<goalName>: completions}` per bucket for the goals-over-time chart; `interval=minute`
serves the "Now" period (last 30 minutes, one-minute buckets). The dashboard tolerates their
absence. `/realtime/replay` feeds the globe replay.

## 7. Visitors (W2, DF, `analytics:read`)

| Method | Path                          | Params                                                                                                                                                                                                                                                                                                                    | Response                                                                                                                               |
| ------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/v1/visitors`            | `limit` ≤250, `offset`, `startAt/endAt`, `visitedPage\|page`, `visitedPageContains\|pageContains`, `completedGoal\|goal`, `visitCount\|visit_count`, `country, region, city, browser, os, device, referrer, hostname, utm_*, ref, source, via`, `isCustomer\|hasRevenue`; DG `q` (search user id / name / email with PII) | `VisitorListRow[]` + `pagination.hasMore`; 400 unknown param, `completedGoal` with `isCustomer`                                        |
| GET    | `/api/v1/visitors/:visitorId` | –                                                                                                                                                                                                                                                                                                                         | `VisitorProfile` (object) incl. DG `sessions[]`, `payments[]`; 400 not a UUID v4 (cookieless hashes allowed for cookieless sites), 404 |

## 8. Website admin resources `/api/v1/admin/websites/:websiteId` (W2)

| Method | Path                         | Perm           | Body / query                                                                             | Response                                                |
| ------ | ---------------------------- | -------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| GET    | `/goals` (DF tracked goals)  | settings:read  | –                                                                                        | `TrackedGoal[]`                                         |
| GET    | `/goals/customizations` (DF) | goals:read     | `goalName?`                                                                              | `GoalCustomization[]` + top-level `colors: GoalColor[]` |
| PATCH  | `/goals/customizations` (DF) | goals:write    | `{goalName, displayName? ≤80, color? (palette), description? ≤300, hidden?}`; body ≤4 KB | `[GoalCustomization]` + `colors`                        |
| DELETE | `/goals/customizations` (DF) | goals:write    | `?goalName=`                                                                             | `[{deleted, goalName}]`                                 |
| GET    | `/funnels` (DF)              | funnels:read   | –                                                                                        | `Funnel[]` (active only)                                |
| POST   | `/funnels` (DF)              | funnels:write  | `{name, steps: FunnelStep[2..8]}`                                                        | `[Funnel]`; 409 duplicate name                          |
| PUT    | `/funnels/:funnelId` (DF)    | funnels:write  | `{name?, steps? (2..10), isActive?}`                                                     | `[Funnel]`                                              |
| DELETE | `/funnels/:funnelId` (DF)    | funnels:write  | –                                                                                        | `[{message}]` (soft delete)                             |
| GET    | `/notes` (DF)                | notes:read     | `startAt/endAt` (default last 30 d), `timezone`, `q`, `limit`, `offset`, `order`         | `Note[]` + `pagination.hasMore`                         |
| POST   | `/notes` (DF)                | notes:write    | `{text ≤500, timestamp, idempotencyKey?}`                                                | `[Note]`, **201** new / 200 replay / 409 key reuse      |
| PUT    | `/notes/:noteId` (DF)        | notes:write    | `{text?, timestamp?}`                                                                    | `[Note]`                                                |
| DELETE | `/notes/:noteId` (DF)        | notes:write    | –                                                                                        | `[{id, deleted: true}]`                                 |
| GET    | `/segments` (DG)             | analytics:read | –                                                                                        | `Segment[]`                                             |
| POST   | `/segments` (DG)             | settings:write | `{name ≤80, filters: {filter_*: value}}` (validated with `parseFilters`)                 | `[Segment]`                                             |
| PUT    | `/segments/:segmentId` (DG)  | settings:write | `{name?, filters?}`                                                                      | `[Segment]`                                             |
| DELETE | `/segments/:segmentId` (DG)  | settings:write | –                                                                                        | `[{deleted: true}]`                                     |
| GET    | `/share` (DG)                | settings:read  | –                                                                                        | `ShareLink`                                             |
| POST   | `/share` (DG)                | settings:write | `{isPublicDataEnabled?}`                                                                 | `ShareLink` (enables or rotates the token)              |
| DELETE | `/share` (DG)                | settings:write | –                                                                                        | `ShareLink` (disabled)                                  |
| GET    | `/usage` (DG)                | settings:read  | –                                                                                        | `Usage`                                                 |

`FunnelStep`: `{name, type: pageview|goal, url? (pageview), urlMatchType?: equals|contains|starts_with|ends_with|not_equals|not_contains|wildcard, hostname?, goalName? (goal), goalCompletionType?: completed|not_completed}`; the server assigns `id`/`_id`.

## 9. Share links (W2)

| Method | Path                                    | Response                                                                                                                                                                                                                                                                                        |
| ------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/share/:token`                         | Dashboard HTML (via `env.ASSETS.fetch` of `/index.html`) when the token is valid, else 404                                                                                                                                                                                                      |
| GET    | `/api/share/:token`                     | `SharedWebsite`                                                                                                                                                                                                                                                                                 |
| GET    | `/api/share/:token/analytics/:endpoint` | Same shapes as `/api/v1/analytics/:endpoint` for `overview, timeseries, pages, entry-pages, referrers, channels, campaigns, countries, regions, cities, devices, browsers, operating-systems, hostnames, goals`. No PII, no visitors, no notes; revenue fields only when `isPublicDataEnabled`. |

## 10. Revenue (W3)

| Method | Path                                           | Perm           | Body / query                                                                   | Response                                                                                                            |
| ------ | ---------------------------------------------- | -------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/v1/payments` (DF)                        | payments:write | `CreatePaymentRequest`                                                         | **plain** `CreatePaymentResult {message, transaction_id?}`; duplicates idempotent; 400 plain `{error}` per DataFast |
| DELETE | `/api/v1/payments` (DF)                        | payments:write | `transaction_id\|tx_id`, or `datafast_visitor_id` (+range), or `startAt&endAt` | `[{message, transaction_id?, datafast_visitor_id?, timeRange?}]`; 404                                               |
| GET    | `/api/v1/payments` (DG)                        | payments:read  | range, `filter_*`, `attributed=true\|false`, `kind`, `limit`, `offset`         | `PaymentRow[]` + `pagination`                                                                                       |
| GET    | `/api/v1/analytics/revenue` (DG)               | analytics:read | range, `filter_*`                                                              | `RevenueSummary`; optional DG `pathToPurchase {customers, averageDaysToPurchase, averageSessionsToPurchase, averagePageviewsToPurchase, topPaths[{channels[], customers, revenue}]}` (W4)                                                                                                    |
| GET    | `/api/v1/admin/websites/:id/integrations` (DF) | settings:read  | –                                                                              | `[IntegrationsStatus]` (DG adds `dodo`, `creem`, `details[]`)                                                       |
| POST   | `…/integrations/stripe` (DF)                   | settings:write | `{stripeRak}` (`rk_` only)                                                     | `[{message, currency}]`                                                                                             |
| POST   | `…/integrations/lemonsqueezy` (DF)             | settings:write | `{lemonsqueezyApiKey, lemonsqueezyStoreId}`                                    | `[{message, currency}]`                                                                                             |
| POST   | `…/integrations/polar` (DF)                    | settings:write | `{polarAccessToken, polarOrgId}`                                               | `[{message}]`                                                                                                       |
| POST   | `…/integrations/paddle` (DF)                   | settings:write | `{paddleApiKey}` (`pdl_live_`)                                                 | `[{message, currency}]`                                                                                             |
| POST   | `…/integrations/dodo`, `…/creem` (DG)          | settings:write | `{apiKey, webhookSecret?}`                                                     | `[{message, currency}]`                                                                                             |
| PATCH  | `…/integrations/<provider>` (DF for paddle)    | settings:write | –                                                                              | `[{message}]` re-sync queued                                                                                        |
| DELETE | `…/integrations/<provider>` (DF)               | settings:write | –                                                                              | `[{message}]` (stripe, polar, lemonsqueezy, paddle, dodo, creem, shopify, woocommerce)                              |
| POST   | `/webhooks/<provider>/:siteId`                 | signature      | provider payload                                                               | 200 quickly; dedupe on event id (`webhook_events`)                                                                  |

## 11. Growth (W6)

| Method                    | Path                                                                                     | Perm                                  | Notes / response                                                                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST                      | `/api/ai-crawls` (DF)                                                                    | `dfbot_` if required                  | `{websiteId, domain, href, ai: {userAgent, ip?, statusCode?, source}}` ≤16 KB → `{success: true}`                                                                                                       |
| GET                       | `/api/v1/admin/bot-traffic/usage` (DF)                                                   | analytics:read, all-sites `dft_`      | `[{usage, websiteStats, …}]` (self-host: no allowance, `isCounting: false`)                                                                                                                             |
| GET / PATCH               | `/api/v1/admin/websites/:id/bot-traffic/settings` (DF)                                   | settings:read / settings:write, owner | `[{websiteId, domain, settings: BotTrafficSettings, crawlerCatalog}]`; PATCH fields per DataFast (`disableCompanies`, `enableCrawlerIds`, `verifiedOnly`, …)                                            |
| GET / POST / PUT / DELETE | `/api/v1/admin/websites/:id/bot-traffic/token` (DF)                                      | settings:read / write, owner          | `[BotTokenStatus]`; create/rotate include `requestAuthToken` once; POST with existing token → 409                                                                                                       |
| GET / POST                | `/api/v1/admin/websites/:id/alerts` (DF)                                                 | alerts:read / write                   | `Alert[]` / `[Alert]`; body `{name, trigger: {goalName} \| {type, …}, template: {message 10–2000, subject?}, destination?: {type: email\|telegram, email?, chatId?, botToken?}, isEnabled?}`; max 25    |
| PUT / DELETE              | `/api/v1/admin/websites/:id/alerts/:alertId` (DF)                                        | alerts:write                          | `[Alert]` / `[{message}]`                                                                                                                                                                               |
| GET                       | `/api/v1/admin/websites/:id/alerts/history` (DF)                                         | alerts:read                           | `alertId?`, `limit` ≤100 → `AlertHistoryEntry[]` + top-level `counts {sent, failed, total}`                                                                                                             |
| POST                      | `/api/v1/admin/websites/:id/alerts/:alertId/test` (DG)                                   | alerts:write                          | `[{message}]`                                                                                                                                                                                           |
| GET                       | `/api/v1/mentions` (DF)                                                                  | analytics:read                        | `startAt/endAt` (default 30 d), `q`, `platform`, `limit`, `offset`, `order` → `Mention[]` + `pagination.hasMore` + `meta {totalMentions, sampled: false, mentionLimit: null, timezone, startAt, endAt}` |
| GET                       | `/api/v1/x/links` (DG)                                                                   | analytics:read                        | range, filters → `XLinkRow[]`                                                                                                                                                                           |
| GET                       | `/api/v1/github/commits` (DG)                                                            | analytics:read                        | range, `q` (message prefix like `feat:`) → `GithubCommit[]`                                                                                                                                             |
| GET                       | `/api/v1/search-console` (DG)                                                            | analytics:read                        | range, `groupBy=query\|page`, `filter_page` → `SearchConsoleRow[]`                                                                                                                                      |
| GET                       | `/api/v1/ads/campaigns` (DG)                                                             | analytics:read                        | range → `AdCampaignRow[]`                                                                                                                                                                               |
| GET                       | `/api/v1/ads/summary` (DG)                                                               | analytics:read                        | range → `{currency, spend, revenue, roas, campaigns}`                                                                                                                                                   |
| GET / PUT / DELETE        | `/api/v1/admin/websites/:id/integrations/{github,google-search-console,meta-ads,x}` (DG) | settings:read / write                 | `GrowthIntegrationStatus`; PUT stores settings (repo, property, ad accounts and campaigns, X keywords 4–15 chars, link-in-bio handles)                                                                  |
| GET                       | `/api/connect/{github,google-search-console,meta-ads,x}/start` (DG)                      | session, settings:write               | `?websiteId=` → 302 to provider OAuth                                                                                                                                                                   |
| GET                       | `/api/connect/…/callback` (DG)                                                           | state cookie                          | stores encrypted credentials, 302 back to `/app/:siteId/integrations`                                                                                                                                   |
| POST                      | `/webhooks/github/:siteId` (DG)                                                          | GitHub signature                      | push events → `github_commits`                                                                                                                                                                          |
| GET / POST                | `/api/v1/admin/websites/:id/imports` (DG)                                                | settings:read / write                 | `ImportJob[]` / create `{source: "plausible", fileName}` → `[ImportJob]`                                                                                                                                |
| GET / DELETE              | `…/imports/:importId` (DG)                                                               | settings:read / write                 | `[ImportJob]`                                                                                                                                                                                           |
| POST                      | `…/imports/:importId/rows` (DG)                                                          | settings:write                        | `{rows: [{day, dimension, value, visitors, visits, pageviews, bounces, durationSum}]}` ≤1000 rows; the dashboard parses Plausible CSVs in the browser → `[{accepted}]`                                  |
| POST                      | `…/imports/:importId/complete` (DG)                                                      | settings:write                        | `[ImportJob]`                                                                                                                                                                                           |

## 12. MCP and OAuth (W7)

| Method          | Path                                                                                     | Notes                                                                                                                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST/GET/DELETE | `/mcp`, `/api/mcp`                                                                       | Streamable HTTP, stateless. Tools mirror DataFast's (`datafast_*` names plus aliases), each calling the same handlers as REST. Unauthenticated → 401 with `WWW-Authenticate` pointing to resource metadata. |
| GET             | `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource[/mcp]` | RFC 8414 / RFC 9728 metadata                                                                                                                                                                                |
| GET/POST        | `/oauth/authorize`                                                                       | Code + PKCE S256 only; GET renders the SPA consent (`/oauth/consent`), POST records approval                                                                                                                |
| POST            | `/oauth/token`, `/oauth/register`, `/oauth/revoke`                                       | form-encoded; rotating refresh tokens; access 1 h, refresh 30 d, connection 90 d                                                                                                                            |
| GET / DELETE    | `/api/v1/admin/oauth/connections[/:id]` (DG)                                             | session or `dft_` with api-keys:read/write → `OAuthConnection[]`                                                                                                                                            |

OAuth access tokens authenticate only at `/mcp`; they register with `registerBearerResolver()`.

## 13. Ecosystem (W8)

| Method        | Path                                                                                         | Notes                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| POST          | `/api/v1/mobile/session`                                                                     | `{email, password}` → mints an `is_mobile` `df_` key per website or a `dft_` token for the app |
| POST / DELETE | `/api/v1/mobile/devices[/:deviceId]`                                                         | push notification devices                                                                      |
| GET           | `/api/apps/shopify/install`, `/api/apps/shopify/callback`; POST `/api/apps/shopify/webhooks` | Shopify app install; creates `provider_connections` rows for W3                                |
| POST          | `/api/apps/woocommerce/connect`                                                              | WordPress/WooCommerce plugin connection                                                        |
