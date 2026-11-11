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
| `/api/ai-crawls`               | Server-side crawler ingest (W6)         | optional `dgbot_` token (legacy `dfbot_`)                |
| `/api/setup`, `/api/auth/*`    | First-run setup and dashboard auth (F0) | cookie                                                   |
| `/api/v1/*`                    | Public + dashboard API                  | session cookie **or** `Authorization: Bearer dg_…/dgt_…` |
| `/api/share/:token/*`          | Read-only share-link API (W2)           | the share token                                          |
| `/mcp`, `/api/mcp`             | MCP server, streamable HTTP (W7)        | Bearer `dgt_` or MCP OAuth token                         |
| `/oauth/*`, `/.well-known/*`   | MCP OAuth 2.1 (W7)                      | per OAuth spec                                           |
| `/webhooks/<provider>/:siteId` | Provider webhooks (W3, W6 for GitHub)   | provider signature                                       |
| `/share/:token`                | Public dashboard page shell (W2)        | the share token                                          |

Credential prefixes: `dg_` website keys, `dgt_` account tokens, `dgbot_` bot-traffic request tokens
(MCP OAuth tokens: `dgo_`). Keys created before the rename keep working with DataFast's prefixes
`df_`, `dft_` and `dfbot_`; everything below that says `dg_` / `dgt_` / `dgbot_` applies to them too.

The dashboard uses the same `/api/v1` endpoints as API clients, authenticated by the session cookie
and passing `?websiteId=` like a `dgt_` token. There is no separate internal API.

### 1.2 Authentication and website resolution

Implemented in `src/auth/middleware.ts` (`requireSiteAccess`, `requireAccountAccess`). Handlers call
`getAccess(c)` → `{user, site, role, scopes, auth}`.

| Credential                  | Website on website routes                     | Permissions             | Role                               |
| --------------------------- | --------------------------------------------- | ----------------------- | ---------------------------------- |
| Session cookie `dg_session` | `?websiteId=` (or path `:websiteId`) required | all (`*`)               | the user's membership role         |
| `dg_` website key           | inferred; a different `websiteId` → **403**   | all website permissions | creator's role, capped at `member` |
| `dgt_` account token        | `?websiteId=` required (**400** without)      | the token's list        | the user's membership role         |
| MCP OAuth token (W7)        | per connection                                | the connection's scopes | membership role                    |

- `websiteId` accepts the internal id (`_id`, 24 hex) or the public tracking id (`trackingId`).
- Unknown website or no membership → **404** `Website not found`. Website outside a token's
  allowlist → **403**. Missing permission → **403** `Missing permission: <perm>`. Role does not allow →
  **403** `Your role (<role>) does not allow <perm>`.
- Roles: `viewer` = every `:read`; `member` = everything except `team:write`; `owner` = everything.
  Owner-only actions additionally use `minRole: "owner"`.
- `dg_` keys cannot call account-level routes (access tokens, website creation, OAuth connections) or
  owner-only routes (team writes) → **403**. A `dg_` key stops working (**401**) when its creator
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
| POST   | `/api/auth/logout-all` (DG)        | – (session only)                                                                                       | `{message}`; every session of the user ends, clears cookie | 401, 403 for Bearer                                             |
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

| Method      | Path                                              | Perm (`dg_`?)                                         | Body / query                                                                                                          | Response `data`                                                                                       |
| ----------- | ------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| GET         | `/account`                                        | analytics:read (yes)                                  | –                                                                                                                     | `[Account]`; `websiteId` with `dg_`                                                                   |
| PUT         | `/account`                                        | analytics:read (no)                                   | `{name}` 1–100                                                                                                        | `[{id, name, email, image}]`                                                                          |
| GET         | `/access-tokens`                                  | api-keys:read (no)                                    | –                                                                                                                     | `AccessToken[]` (masked)                                                                              |
| POST        | `/access-tokens`                                  | api-keys:write (no)                                   | `CreateAccessTokenRequest {name?, permissions? (default ["*"]), websiteIds? ([] = all), includePii?, expiresInDays?}` | `[AccessToken & {key}]` (key shown once)                                                              |
| DELETE      | `/access-tokens/:tokenId`                         | api-keys:write (no)                                   | –                                                                                                                     | `[{message}]`; 404 if not the caller's                                                                |
| GET         | `/websites`                                       | websites:read (yes: own site)                         | –                                                                                                                     | `WebsiteSummary[]` with `role`, in the user's saved order (then oldest first)                         |
| PUT (DG)    | `/account/website-order`                          | websites:read (no)                                    | `{websiteIds: string[1..200]}` (ids or tracking ids; others ignored; unlisted sites follow)                          | `WebsiteSummary[]` in the new order; also orders `GET /api/auth/me` websites                          |
| GET (DG)    | `/account/overview-layout?websiteId=`             | websites:read (no)                                    | `websiteId` (id or tracking id of a website the user belongs to)                                                       | `[{websiteId, layout: OverviewLayout \| null}]` (`null` = default layout)                              |
| PUT (DG)    | `/account/overview-layout`                        | websites:read (no)                                    | `{websiteId, layout: {sections, cards: {section: ids[]}, hidden} \| null}` (ids `[a-z][a-z0-9-]*`; `null` resets)      | `[{websiteId, layout}]`; one membership row write; per user, any role                                 |
| POST        | `/websites`                                       | websites:write (no; tokens restricted to sites → 403) | `{domain, timezone, name?, currency?}`                                                                                | `[{websiteId, domain, trackingId}]`; 409 duplicate domain                                             |
| GET         | `/websites/:websiteId`                            | settings:read (yes)                                   | –                                                                                                                     | `[Website]`                                                                                           |
| PUT         | `/websites/:websiteId`                            | settings:write (yes)                                  | `WebsiteUpdate` (only changed fields; unknown fields → 400)                                                           | `[Website]`                                                                                           |
| DELETE      | `/websites/:websiteId`                            | websites:write                                        | –                                                                                                                     | Bearer → **403** (dashboard-only, as DataFast); session owner → soft delete, `[{message, websiteId}]` |
| GET         | `/websites/:websiteId/apikeys`                    | api-keys:read (yes)                                   | –                                                                                                                     | `WebsiteKey[]` (mobile keys hidden)                                                                   |
| POST        | `/websites/:websiteId/apikeys`                    | api-keys:write (yes)                                  | `{name?, includePii?, isMobile?}`                                                                                     | `[WebsiteKey & {key}]`; 400 over 10 keys                                                              |
| PUT         | `/websites/:websiteId/apikeys/:apiKeyId`          | api-keys:write                                        | –                                                                                                                     | `[WebsiteKey & {key}]` rolled; old secret dies                                                        |
| DELETE      | `/websites/:websiteId/apikeys/:apiKeyId`          | api-keys:write                                        | –                                                                                                                     | `[{deleted: true}]`                                                                                   |
| GET         | `/websites/:websiteId/team`                       | team:read (yes)                                       | –                                                                                                                     | `TeamMember[]` (owner first)                                                                          |
| POST        | `/websites/:websiteId/team`                       | team:write + owner (no)                               | `{email, role: viewer\|member}`                                                                                       | `[CreatedInvite]` incl. `inviteUrl`, `emailQueued` (DG; emailed by W6 when email is configured); 400 self, 409 member/pending                                |
| DELETE      | `/websites/:websiteId/team`                       | team:write + owner (no)                               | `{userId}`                                                                                                            | `[{message}]`; 400 self, 404                                                                          |
| PUT (DG)    | `/websites/:websiteId/team`                       | team:write + owner (no)                               | `{userId, role: owner\|member\|viewer}`                                                                               | `[{message, userId, role}]`; 400 would remove last owner                                              |
| GET (DG)    | `/websites/:websiteId/team/invites`               | team:read                                             | –                                                                                                                     | `PendingInvite[]`                                                                                     |
| DELETE (DG) | `/websites/:websiteId/team/invites/:invitationId` | team:write + owner                                    | –                                                                                                                     | `[{message}]`                                                                                         |

`Website` = DataFast's fields (`_id, domain, name, logo, trackingId, timezone, currency, kpi,
kpiColorScheme, revenueMetric, isCookieless, isAttackModeEnabled, includeRenewalRevenue,
allowedHostnames, isAllHostnamesAllowed, excludedIps, excludedPaths, excludedCountries,
excludedHostnames, sendWeeklyReports, sendViralTrafficAlerts, isPublicDashboardEnabled,
isPublicDataEnabled, createdAt`) plus DG `privacyMode (cookie|cookieless|consent), attributionModel,
botLevel (off|standard|strict; strict = attack mode), honorGpc, datafastCompat (also write DataFast's
cookies; turned on automatically when detected, `false` keeps it off), storeCustomerEmails, retentionDays
(30–36500|null), shareToken, updatedAt, role`. `isCookieless`/`isAttackModeEnabled` map onto
`privacyMode`/`botLevel` (the explicit DG field wins). `kpi: "revenue"` or `null` means revenue.
`excludedCountries` accepts names or codes and stores ISO codes. `isPublicDashboardEnabled: true`
mints a share token; `false` deletes it.

**`excludedUserAgents` (DG, W1, migration 0100):** `string[]` on `Website` (always returned) and
`WebsiteUpdate`: case-insensitive User-Agent substrings (3–200 chars, at most 50, duplicates
removed) stored in `sites.excluded_user_agents`; ingest drops matching hits before storage.

## 4. Ingest (W1)

| Method  | Path          | Notes                                                                                                                                                                                              |
| ------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST    | `/api/events` | DataFast body (plan §3.4), any content type, ≤ 8 KB; types `pageview, custom, identify, payment, external_link` and DG `engagement`. 200 `{}`; cookieless hits get `{visitorId, sessionId}` (DG adds `sessionId`). Malformed → 400, hostname not allowed → 403, unknown website → 404, > 8 KB → 413, rate limited → 429; bots and excluded hits → 200 `{}`. Write with one `db.batch()` in `waitUntil`. CORS: `Access-Control-Allow-Origin: *`. Details: `docs/tracking.md`. |
| OPTIONS | `/api/events` | CORS preflight (DataFast's script sends `application/json`).                                                                                                                                       |

## 5. Server-side events (W2, DF)

| Method | Path               | Perm           | Body / query                                                                                                    | Response                                                                          |
| ------ | ------------------ | -------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| POST   | `/api/v1/goals`    | goals:write    | `{datagoat_visitor_id\|visitorId, name, description?, metadata? (≤10 keys, key ^[a-z0-9_-]+$ ≤64, value ≤255)}` | `[{message, eventId}]`; 400, 403 suspended, 404 visitor has no pageviews          |
| DELETE | `/api/v1/goals`    | goals:write    | query `datagoat_visitor_id?`, `name?`, `startAt&endAt` (required when unfiltered)                               | `[{message, datafast_visitor_id?, goal_name?, timeRange?, deleted (DG)}]`; 400; 504 when more than 50,000 events matched (retry: the rest remains) |
| POST   | `/api/v1/identify` | identify:write | `{user_id ≤255, datagoat_visitor_id, ...profile}` (shallow merge; `name`, `image`/`avatar` and `email` also fill the visitor's profile columns; email stored only when the site stores customer emails, its hash always) | `{message, profileId?, action?: created\|updated\|unchanged}` (object, not array); cookieless sites: `{message}` only; 404 visitor has no pageviews |

Request bodies and queries take `datagoat_visitor_id`; DataFast's `datafast_visitor_id` is accepted as
an alias everywhere (`datagoat_session_id` / `datafast_session_id` likewise). Response field names are
DataFast's and did not change.

Server-side goals attach to the visitor's latest session (path = its exit page) and store `description` as the reserved property `$description` (hidden from goal properties). They do not change the session's bounce state. Deleting goals by visitor or without a name leaves payment-provider goals (`payment`, `free_trial`, `subscription_*`) alone; delete payments with `DELETE /api/v1/payments`.

## 6. Analytics `/api/v1/analytics` (W2 unless noted, `analytics:read`)

All take `websiteId` (non-`dg_`), `startAt`, `endAt`, `timezone`, `filter_*`. Breakdowns take
`fields`, `limit`, `offset`, sort by visitors desc, and return `pagination`.

| Method | Path                                                                                    | Extra params                                                                                                                                                                                                                                                                              | Response                                                                                                                                                  |
| ------ | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/overview` (DF)                                                                        | `fields`; DG `compare=previous` (needs a range)                                                                                                                                                                                                                                          | `[Overview]`; with compare: top-level `previous` (Overview) and `previousRange {startAt, endAt}`                                                          |
| GET    | `/timeseries` (DF)                                                                      | `fields` (required: name, visitors, new_visitors, returning_visitors, visitor_breakdown, pageviews, sessions, revenue, payments, conversion_rate; DG: bounce_rate, avg_session_duration, goals, refunds), `interval` (required: hour, day, week, month; DG: minute for ranges up to 6 h); default window 24 h / 30 d / 12 mo; same-day range → hour; `revenue` implies `payments` | `TimeseriesPoint[]` + top-level `fields, interval, timezone, currency, totals` (with `visitorBreakdown`, `revenueBreakdown`) + `pagination`               |
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
| GET    | `/heatmap` (DG)                                                                         | default range last 30 days                                                                                                                                                                                                                                                                | `HeatmapCell[]` (168 cells: ISO weekday 1-7 × hour 0-23, local time) + top-level `timezone, startAt, endAt`                                               |
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

W2 implementation notes (all DataFast-compatible additions):

- Timeseries without `fields` returns DataFast's fields only; the DG fields are opt-in. `compare=previous`
  adds top-level `previous {data, totals}` aligned with `data`. `interval=minute` over more than 6 h → 400.
- Long ranges: when there are no filters, the request timezone is the website's, the range is whole
  local days and the covered closed days hold at least `ROLLUP_MIN_SESSIONS` sessions (default 5000),
  breakdowns, pages, goals and timeseries read the daily rollups (plus raw tables after the rollup
  watermark). Visitor counts are then sums of daily unique visitors and the response carries top-level
  `approximate: true`. Ranges older than the website's `retentionDays` always use rollups (raw events
  are pruned). The overview stays exact (one pass over the range's sessions).
- Imported history (W6's Plausible import, `imported_daily`, completed imports only, days before the
  first native session only) is added to the overview, timeseries (day/week/month), referrers,
  channels, countries, devices, browsers, operating systems, pages, entry and exit pages when the
  request has no filters, uses the website timezone and covers whole days (or all time); such
  responses are `approximate`. Imports carry no revenue, goals or new/returning split. Not merged:
  regions (Plausible exports ISO 3166-2 codes), cities (GeoNames ids), hostnames (not exported) and
  campaigns (UTM fields are exported separately, not as combinations). Imported pages use the website
  domain as hostname.
- Revenue on breakdowns always comes from `payments` (exact), attributed by the website's model.
  Pages and goals attribute a visitor's payments in the range to every page viewed / goal completed.
- Breakdowns drop rows whose dimension is unknown (NULL), except referrers (`Direct / None`).
  Campaigns list only sessions with at least one UTM/ref/source/via parameter.
- `realtime/map`: recent goal events (type = goal name) and payments of the last 60 minutes; at most
  500 visitors. `realtime/replay`: at most 300 visitors per frame.
- Responses are cached with the Workers Cache API (custom domains only): a day for ranges that end
  before today, 60 s otherwise; `Cache-Control: no-cache` on the request skips the lookup; a website
  settings change starts a fresh cache. Responses carry `X-Cache: HIT|MISS`.

## 7. Visitors (W2, DF, `analytics:read`)

| Method | Path                          | Params                                                                                                                                                                                                                                                                                                                    | Response                                                                                                                               |
| ------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/v1/visitors`            | `limit` ≤250, `offset`, `startAt/endAt`, `visitedPage\|page`, `visitedPageContains\|pageContains`, `completedGoal\|goal`, `visitCount\|visit_count`, `country, region, city, browser, os, device, referrer, hostname, utm_*, ref, source, via`, `isCustomer\|hasRevenue`; DG `q` (search user id / name / email with PII) | `VisitorListRow[]` + `pagination.hasMore`; 400 unknown param, `completedGoal` with `isCustomer`, `didNotCompleteGoal`/`goalNot`; DG also accepts `filter_*` |
| GET    | `/api/v1/visitors/:visitorId` | –                                                                                                                                                                                                                                                                                                                         | `VisitorProfile` (object) incl. DG `sessions[]` (Google sessions add `searchKeywords[{query, probability}]` from Search Console, finisher), `payments[]`, `activityGrid[]`; 400 not a UUID v4 (cookieless hashes allowed for cookieless sites), 404 |

## 8. Website admin resources `/api/v1/admin/websites/:websiteId` (W2)

| Method | Path                         | Perm           | Body / query                                                                             | Response                                                |
| ------ | ---------------------------- | -------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| GET    | `/goals` (DF tracked goals)  | settings:read  | –                                                                                        | `TrackedGoal[]` (counts over the last 30 days; older or customized names listed with 0) |
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
| GET    | `/usage` (DG)                | settings:read  | –                                                                                        | `Usage` (`plan` from the optional `D1_PLAN` var: free/paid, else unknown with Free limits) |
| GET / POST | `/alerts` (DF)           | alerts:read / alerts:write | see §11 (W2 stores the rules; W6 evaluates and delivers)                     | `Alert[]` / `[Alert]`                                   |
| PUT / DELETE | `/alerts/:alertId` (DF) | alerts:write   | see §11                                                                                  | `[Alert]` / `[{message}]`                               |
| GET    | `/alerts/history` (DF)       | alerts:read    | `alertId?`, `limit` 1–100 (default 50)                                                   | `AlertHistoryEntry[]` + `counts`                        |

`FunnelStep`: `{name, type: pageview|goal, url? (pageview), urlMatchType?: equals|contains|starts_with|ends_with|not_equals|not_contains|wildcard, hostname?, goalName? (goal), goalCompletionType?: completed|not_completed}`; the server assigns `id`/`_id`.

## 9. Share links (W2)

| Method | Path                                    | Response                                                                                                                                                                                                                                                                                        |
| ------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/share/:token`                         | Dashboard HTML (via `env.ASSETS.fetch` of `/index.html`) when the token is valid, else 404; `X-Frame-Options: DENY`                                                                                                                                                                              |
| GET    | `/share/:token/widget` (finisher)       | The same shell for the embeddable widget page, framable by any site (`Content-Security-Policy: frame-ancestors *`, no `X-Frame-Options`); query `type=visitors\|revenue\|live\|chart`, `period=24h\|7d\|30d`, `theme`, `color` are read by the SPA                                              |
| GET    | `/api/share/:token`                     | `SharedWebsite`                                                                                                                                                                                                                                                                                 |
| GET    | `/api/share/:token/analytics/:endpoint` | Same shapes as `/api/v1/analytics/:endpoint` for `overview, timeseries, realtime, realtime/map, realtime/replay, pages, entry-pages, exit-pages, exit-clicks, referrers, channels, campaigns, countries, regions, cities, devices, browsers, operating-systems, hostnames, goals, heatmap`. No PII (profile names/emails nulled), no visitors, notes, metadata, goal properties or funnels; revenue fields (and recent payments) only when `isPublicDataEnabled`. Rate limited per client IP with `API_LIMITER` (429 DataFast body). Unknown endpoint or token → 404. |

## 10. Revenue (W3)

Implemented in `src/providers/` (guides: [`docs/revenue/`](../revenue/README.md)).

| Method | Path                                                    | Perm           | Body / query                                                                                                                                             | Response                                                                                                                                                         |
| ------ | ------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/v1/payments` (DF)                                 | payments:write | `CreatePaymentRequest` (≤ 16 KB)                                                                                                                         | **plain** `CreatePaymentResult {message, transaction_id?}`; duplicates 200 message-only; unknown visitor 200 message-only (stored unattributed); 400 plain `{error}` |
| DELETE | `/api/v1/payments` (DF)                                 | payments:write | `transaction_id\|tx_id` (ignores dates), else `datagoat_visitor_id\|visitorId` (+ optional range), else `startAt&endAt` (or `start&end`) required        | `[{message, transaction_id?, datafast_visitor_id?, timeRange?: {start, end}}]`; 404 `Transaction not found`; 400 no filter / bad visitor / incomplete or conflicting range |
| GET    | `/api/v1/payments` (DG)                                 | payments:read  | range, `filter_*` (on the attributed session), `attributed=true\|false`, `kind` (comma list), `provider`, `limit`, `offset`                              | `PaymentRow[]` + `pagination`; emails/names only with `includePii`                                                                                               |
| GET    | `/api/v1/analytics/revenue` (DG)                        | analytics:read | range (default last 30 days), `filter_*`, `model?`                                                                                                       | `RevenueSummary` (object), incl. DG `pathToPurchase {customers, averageDaysToPurchase, averageSessionsToPurchase, averagePageviewsToPurchase, topPaths[{channels[], customers, revenue}]}` (W4): visitors whose first payment is in the range (most recent 2000), channels of their sessions up to it with repeats collapsed (first touch + last 4), top 10 sequences |
| GET    | `/api/v1/analytics/revenue/sources` (DG)                | analytics:read | range, `filter_*`, `groupBy` (channel default, referrer, utm_*, ref, source, via, country, region, city, device, browser, os, entry_page, hostname), `model?` (first_touch\|last_touch\|last_non_direct, default the website's), `limit`, `offset` | `RevenueSourceRow[]` (incl. `Unattributed` row when unfiltered) + top-level `currency, groupBy, model` + `pagination`                                             |
| GET    | `/api/v1/analytics/revenue/path-to-purchase` (DG)       | analytics:read | range (first purchases in it), `filter_*`, `model?`                                                                                                      | `PathToPurchase` (object)                                                                                                                                        |
| GET    | `/api/v1/analytics/revenue/mrr` (DG, finisher)          | analytics:read | – (a snapshot: range and filters do not apply)                                                                                                           | `MrrSummary {currency, mrr, activeSubscriptions, byProvider[], revenueMetric, unconverted}`: active and past-due `provider_subscriptions` at the latest ECB rate |
| GET    | `/api/v1/admin/websites/:id/integrations` (DF)          | settings:read  | –                                                                                                                                                        | `[IntegrationsStatus]` (DG adds `dodo`, `creem`, `details[]` with `webhookUrl`, `webhookConfigured`, `webhookAutoCreated`)                                       |
| POST   | `…/integrations/stripe` (DF)                            | settings:write | `{stripeRak, webhookSecret?}` (`rk_live_` only; `rk_test_` with `ALLOW_TEST_PAYMENT_KEYS`)                                                                | `[IntegrationConnectResult]` = `{message, currency, webhookUrl, webhookConfigured}`; 400 names missing read permissions                                           |
| POST   | `…/integrations/lemonsqueezy` (DF)                      | settings:write | `{lemonsqueezyApiKey, lemonsqueezyStoreId, webhookSecret?}`                                                                                              | `[{message, currency, webhookUrl, webhookConfigured}]` (webhook created through the API when no secret is given)                                                  |
| POST   | `…/integrations/polar` (DF)                             | settings:write | `{polarAccessToken, polarOrgId, webhookSecret?, sandbox?}`                                                                                               | `[{message, webhookUrl, webhookConfigured}]` (no `currency`, as DataFast)                                                                                       |
| POST   | `…/integrations/paddle` (DF)                            | settings:write | `{paddleApiKey, webhookSecret?}` (`pdl_live_`; `pdl_sdbx_` with `ALLOW_TEST_PAYMENT_KEYS`)                                                                | `[{message, currency, webhookUrl, webhookConfigured}]`                                                                                                           |
| POST   | `…/integrations/dodo`, `…/creem` (DG)                   | settings:write | `{apiKey, webhookSecret?, testMode? (dodo)}`                                                                                                             | `[{message, currency, webhookUrl, webhookConfigured}]`                                                                                                           |
| POST   | `…/integrations/shopify` (DG)                           | settings:write | `{shopDomain (*.myshopify.com), webhookSecret, accessToken?}` (manual custom app; W8's app install calls `saveConnection()` instead)                      | `[{message, currency, webhookUrl, webhookConfigured}]`                                                                                                           |
| POST   | `…/integrations/woocommerce` (DG)                       | settings:write | `{storeUrl, webhookSecret, consumerKey?, consumerSecret?}` (manual; W8's plugin connect calls `saveConnection()`)                                         | `[{message, currency, webhookUrl, webhookConfigured}]`                                                                                                           |
| PATCH  | `…/integrations/<provider>` (DF for paddle)             | settings:write | optional `{webhookSecret}` (DG: replace the signing secret)                                                                                              | `[{message: "<Provider> payment re-sync queued"}]`; 400 `<Provider> is not connected to this website`                                                            |
| DELETE | `…/integrations/<provider>` (DF)                        | settings:write | –                                                                                                                                                        | `[{message: "<Provider> disconnected successfully"}]` (idempotent; revenue kept; auto-created webhooks removed)                                                   |
| POST   | `/webhooks/<provider>/:siteId`                          | signature      | provider payload (≤ 1 MB)                                                                                                                                | 200 `{received: true}` (+ `duplicate: true`); 401 bad signature; 400 no secret; 404 unknown site / not connected; 500 ingest failed (provider retries)            |

`POST` and `DELETE /api/v1/payments` take `datagoat_visitor_id` or its alias `datafast_visitor_id`
(responses keep `datafast_visitor_id`). Provider metadata (Stripe, Polar, Lemon Squeezy, Paddle,
Dodo, Creem) is read the same way: `datagoat_visitor_id` / `datagoat_session_id`, or DataFast's
`datafast_visitor_id` / `datafast_session_id`.

Connect validation failures are **400** with the provider's reason. Connect answers `currency` = the
website currency (DataFast does the same); the provider account currency is stored separately.
Server-side helpers other teams may call: `saveConnection()` (W8: Shopify app, WooCommerce plugin),
`processWebhook()` (W8: Shopify app webhooks), `paymentHintStatement()` / `hintFromExtraData()` /
`attributeByEmail()` (W1 ingest), all exported from `src/providers/index.ts`.

## 11. Growth (W6)

| Method | Path | Perm | Notes / response |
| --- | --- | --- | --- |
| POST | `/api/ai-crawls` (DF) | `dgbot_` if required | `{websiteId, domain, href, ai: {userAgent, ip?, statusCode?, source}}` ≤16 KB, or DG batch `{events: [...≤50]}` ≤64 KB → `{success: true, tracked, ignored}`; 404 unknown website, 400 foreign hostname/invalid, 401 token required, 413, 429 (`INGEST_SITE_LIMITER`, key `ai-crawls:<siteId>`) |
| GET | `/api/v1/admin/bot-traffic/usage` (DF) | analytics:read, session or all-sites `dgt_` (no `dg_`) | `[{usage {usage, dropped, packQuantity, allowance, remaining, percentUsed, periodStartAt, resetAt, isCounting}, websiteStats, billing: null, includedRequests, packRequests: null, packMonthlyPrice: null, canView, canPurchase: false}]`; counting only with `BOT_TRAFFIC_ALLOWANCE` |
| GET / PATCH | `/api/v1/admin/websites/:id/bot-traffic/settings` (DF) | settings:read / settings:write, owner, no `dg_` | `[{websiteId, domain, settings: BotTrafficSettings, crawlerCatalog}]`; PATCH ≤8 KB, strict: `verifiedOnly, requireAuthToken, disableCompanies, enableCompanies, disableCrawlerIds, enableCrawlerIds, excludedCrawlerIds` (not with incremental fields), `hiddenCrawlers, hideDashboardCard, groupBy, pageFilterIds` |
| GET / POST / PUT / DELETE | `/api/v1/admin/websites/:id/bot-traffic/token` (DF) | settings:read / write, owner, no `dg_` | `[BotTokenStatus]`; create/rotate include `requestAuthToken` once; POST with existing token → 409; PUT without → 404; DELETE turns `requireAuthToken` off |
| GET / PUT | `/api/v1/admin/websites/:id/bot-traffic/attack-mode` (DG) | settings:read / settings:write | `[AttackModeState]`; PUT `{enabled?, autoEnable?, multiplier? 2–100, minHits? ≥10, durationMinutes? 15–10080}` |
| GET / POST | `/api/v1/admin/websites/:id/alerts` (DF) | alerts:read / write | `Alert[]` / `[Alert]`; body `AlertCreateRequest {name 1–100, trigger: {goalName} \| {type: goal\|new_sale\|traffic_spike\|daily_digest\|weekly_digest, goalName?, multiplier?, minSessions?, includeRenewals?, includeFreeTrials?}, template?: {message 10–2000 (required for goal), subject?}, destination?: {type: email\|telegram\|webhook, email?, chatId?, botToken?, url?, rotateSecret?}, isEnabled?}`; max 25; email destinations → 400 when no email provider is configured; webhook create returns `destination.signingSecret` once |
| GET | `/api/v1/admin/websites/:id/alerts/channels` (DG) | alerts:read | `AlertChannels` (object) |
| GET / PUT / DELETE | `/api/v1/admin/websites/:id/alerts/:alertId` (DF; GET is DG) | alerts:read / alerts:write | `[Alert]` / `[Alert]` / `[{message}]` |
| GET | `/api/v1/admin/websites/:id/alerts/history` (DF) | alerts:read | `alertId?`, `limit` ≤100 (default 50) → `AlertHistoryEntry[]` + top-level `counts {sent, failed, total}` |
| POST | `/api/v1/admin/websites/:id/alerts/:alertId/test` (DG) | alerts:write | `[{message}]`; 502 with the provider error |
| POST | `/api/auth/password-resets` (DG, **W6**) | none (same-origin) | `{email}` → `{message}` (same answer for unknown emails; ≤1 email per account per 5 min); 503 without an email provider |
| GET | `/api/v1/mentions` (DF) | analytics:read | strict params `startAt/endAt` (default 30 d), `timezone`, `q` ≤200, `platform`, `limit` ≤1000, `offset`, `order` → `Mention[]` + `pagination` + `meta {totalMentions, sampled: false, mentionLimit: null, timezone, startAt, endAt}` |
| GET | `/api/v1/x/links` (DG) | analytics:read | range (default 30 d), `filter_*`, `limit`, `offset` → `XLinkRow[]` + `pagination` |
| GET | `/api/v1/github/commits` (DG) | analytics:read | range (default 30 d), `q` (case-insensitive message prefix such as `feat:`), `limit`, `offset` → `GithubCommit[]` + `pagination` |
| GET | `/api/v1/github/repos` (DG) | settings:read | live list `[{fullName, private, defaultBranch, pushedAt}]` (+ `error`) |
| GET | `/api/v1/search-console` (DG) | analytics:read | range (default 28 d), `groupBy=query\|page`, `filter_page`, `limit`, `offset` → `SearchConsoleRow[]` + `pagination` |
| GET | `/api/v1/search-console/overview` (DG) | analytics:read | range, `filter_page` → `SearchConsoleOverview` |
| GET | `/api/v1/search-console/status` (DG) | analytics:read | `SearchConsoleStatus` (live `properties` unless `properties=0`) |
| GET | `/api/v1/ads/campaigns` (DG) | analytics:read | range (default 30 d), `limit`, `offset` → `AdCampaignRow[]` + `pagination` |
| GET | `/api/v1/ads/summary` (DG) | analytics:read | range → `AdsSummary` |
| GET | `/api/v1/ads/accounts` (DG) | settings:read | live `MetaAdAccount[]` (+ `error`) |
| GET / PUT / DELETE | `/api/v1/admin/websites/:id/integrations/{github,google-search-console,meta-ads,x}` (DG) | settings:read / write | `GrowthIntegrationStatus` (object); PUT bodies `GithubIntegrationSettings`, `SearchConsoleIntegrationSettings`, `MetaAdsIntegrationSettings` (+ `campaignAccounts`), `XIntegrationSettings` (keywords 4–15 chars, ≤20; handles ≤20); tokens are write-only; DELETE removes the connection (synced data is kept) |
| GET | `/api/connect/{github,google-search-console,meta-ads,x}/start` (DG) | session, settings:write | `?websiteId=&returnTo=integrations\|search-console\|ads\|mentions` → 302 to provider OAuth (signed state + `dg_oauth` cookie, PKCE for Google and X); 503 when the client id/secret are not set |
| GET | `/api/connect/…/callback` (DG) | session + state cookie | stores encrypted credentials, 302 to `/app/:siteId/<returnTo>?connected=<slug>` (or `?error=…&integration=<slug>`) |
| POST | `/webhooks/github/:siteId` (DG) | `X-Hub-Signature-256` (per-site secret shown in the GitHub integration settings) | push events for the configured repo/branch → `github_commits`; `{ok, stored}` |
| GET / POST | `/api/v1/admin/websites/:id/imports` (DG) | settings:read / write | `ImportJob[]` / create `{source: "plausible", fileName?}` → `[ImportJob]` |
| GET / DELETE | `…/imports/:importId` (DG) | settings:read / write | `[ImportJob]`; DELETE removes the imported rows and marks the job `cancelled` |
| POST | `…/imports/:importId/rows` (DG) | settings:write | `{rows: [{day, dimension, value, visitors, visits, pageviews, bounces, durationSum (ms)}]}` ≤1000 rows; same keys are added; the dashboard parses Plausible exports in the browser → `[{accepted}]`; 409 when the job is closed |
| POST | `…/imports/:importId/complete` (DG) | settings:write | `[ImportJob]` |
| POST | `…/imports/:importId/file` (DG) | settings:write | body = Plausible export .zip (≤10 MB, ≤20,000 rows) parsed in the Worker → `[ImportJob]` + `tables`, `skipped` |

Imported data contract for the analytics layer: `src/growth/imports/read.ts` (`importCutoff`,
`importedDailyTotals`, `importedBreakdown`); see `docs/architecture/data-model.md`.

## 12. MCP and OAuth (W7)

| Method          | Path                                                                                                      | Notes                                                                                                                                                                                                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST            | `/mcp`, `/api/mcp`                                                                                        | Streamable HTTP, stateless, JSON responses (no SSE, no `Mcp-Session-Id`). Tools are DataFast's catalog without the vendor prefix (`analytics_overview`, `visitors_get`, `whoami`, …); `datafast_*` names are accepted as aliases in `tools/call`. Each tool calls the `/api/v1` handler in-process. |
| GET / DELETE    | `/mcp`, `/api/mcp`                                                                                        | **405** (stateless server). Unauthenticated requests on any method → **401** with `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource<path>"`.                                                                                                                  |
| GET             | `/.well-known/oauth-authorization-server[/mcp\|/api/mcp]`                                                 | RFC 8414 metadata (issuer = the request origin)                                                                                                                                                                                                                                               |
| GET             | `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp`, `…/api/mcp`         | RFC 9728 metadata; `resource` is `<origin>/mcp` (or `/api/mcp`)                                                                                                                                                                                                                                |
| POST            | `/oauth/register`                                                                                         | RFC 7591 JSON. Redirect URIs: https, http loopback, or a private-use scheme. Default method `client_secret_basic` (secret returned once); `none` for public clients. Registrations expire after 1 year. HTTPS `client_id` URLs (client metadata documents) need no registration.            |
| GET             | `/oauth/authorize`                                                                                        | Code + PKCE S256 only. Validates, then 302 to `/oauth/consent?request=<signed, 10 min>` and sets the `dg_oauth_consent` cookie (binds the request to the browser). Client/redirect errors → `/oauth/consent?error=…`; other errors → redirect URI with `error`, `state`, `iss`.               |
| GET             | `/oauth/consent`                                                                                          | The dashboard SPA (`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`)                                                                                                                                                                                                                  |
| GET             | `/oauth/consent/details?request=`                                                                         | `OAuthConsentDetails` (client, scopes with defaults, signed-in user and websites); 400 invalid, 410 expired                                                                                                                                                                                  |
| POST            | `/oauth/authorize`                                                                                        | JSON `OAuthDecisionRequest {request, approve, scopes[], websiteIds[]}` with the session cookie, same origin and the consent cookie → `OAuthDecisionResult {redirectTo}` (code or `access_denied`); 401 signed out, 403 other browser                                                          |
| POST            | `/oauth/token`                                                                                            | form-encoded (JSON accepted). `authorization_code` (+`code_verifier`, `redirect_uri`, `resource`) and `refresh_token` (rotating). Access 1 h (`dgo_…`), refresh 30 d (`dgr_…`), connection 90 d. Replayed code or refresh token revokes the connection.                                      |
| POST            | `/oauth/revoke`                                                                                           | RFC 7009; revoking a refresh token revokes the connection                                                                                                                                                                                                                                    |
| GET / DELETE    | `/api/v1/admin/oauth/connections[/:id]` (DG)                                                              | session or `dgt_` with api-keys:read/write → `OAuthConnection[]` / `[{message: "Access revoked"}]`; DELETE also revokes credentials minted through the connection                                                                                                                             |

Finisher: `resources/list` and `resources/read` serve the chart view for UI-capable clients
(`ui://datagoat/chart.html`, `text/html;profile=mcp-app`, and `ui://datagoat/chart.skybridge.html`,
`text/html+skybridge`); analytics read tools that it can draw carry `_meta.ui.resourceUri` and
`_meta["openai/outputTemplate"]` (`src/mcp/widgets.ts`). `initialize` advertises `resources`.

OAuth access tokens authenticate only at `/mcp` and `/api/mcp` (never `/api/v1`). OAuth scopes are
the permissions of §1.8 plus `account:read|write`, `access-tokens:read|write`, `visitors:read`,
`visitors:details` (PII), `bot-credentials:read|write` and `account-usage:read`; there is no
wildcard. Write tools return a dry-run preview unless `confirm: true`; OAuth writes also need an
`idempotencyKey` (8–128 chars, results kept 24 h in `idempotency_keys` under scope
`mcp:<kind>:<credentialId>`). MCP tool calls count against the credential's `/api/v1` rate limit
(one per underlying API call).

## 13. Ecosystem (W8)

| Method        | Path                                                                                         | Notes                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| POST          | `/api/v1/mobile/session` (DG)                                                                | `{email, password, deviceName?}` (login throttling as `/api/auth/login`) → `MobileSession` (object): a read-only `dgt_` token with `is_mobile = 1`, 365-day expiry, permissions `analytics:read, websites:read, settings:read, goals:read, payments:read, alerts:read`, no PII, plus `user` and `websites` like `Me`. At the 20-token cap the oldest mobile token is replaced; 400 if the cap is full of non-mobile tokens. 401 `Invalid email or password`, 429 throttled |
| DELETE        | `/api/v1/mobile/session` (DG)                                                                | mobile token only (403 otherwise) → `{message}`; revokes the token and its devices             |
| GET           | `/api/v1/mobile/devices` (DG)                                                                | any non-`dg_` credential → `MobileDevice[]` of the caller                                       |
| POST          | `/api/v1/mobile/devices` (DG)                                                                | mobile token only; `RegisterDeviceRequest {pushToken (Expo), platform: ios\|android, name?, notifySales?, notifyAlerts?, mutedSiteIds?}` upserts on `pushToken` (re-owned when another account signs in on the phone) → `[MobileDevice]`, **201** new / 200 update; max 20 devices per user |
| DELETE        | `/api/v1/mobile/devices/:deviceId` (DG)                                                      | own devices only → `[{deleted: true, id}]`; 404                                                 |
| POST          | `/api/apps/shopify/connect?websiteId=` (DG)                                                  | session or token with `settings:write`; `ShopifyConnectRequest {shop, clientId, clientSecret, grant?: client_credentials (default) \| authorization_code}`. Client credentials: mints a token, reads the shop, registers webhooks, installs the storefront ScriptTag → `[{status: "active", shop, shopName, currency, scriptTagInstalled, webhooks, warnings}]`; 400 when Shopify rejects. Authorization code: stores a `pending` connection → `[{status: "pending", shop, installUrl, redirectUrl}]` |
| GET           | `/api/apps/shopify/install?websiteId=` (DG)                                                  | `settings:write`; 302 to `https://<shop>/admin/oauth/authorize` with a signed 15-minute `state`; 400 without a saved connection |
| GET           | `/api/apps/shopify/callback`                                                                 | Shopify's redirect: verifies `hmac` (client secret) and `state`, exchanges `code` for an offline token, sets up the shop, 302 to `/app/:siteId/integrations?shopify=connected\|error` |
| POST          | `/api/apps/shopify/webhooks`                                                                 | `X-Shopify-Hmac-Sha256` (base64 HMAC of the raw body with the client secret), matched by `X-Shopify-Shop-Domain`. `app/uninstalled` → connection `disconnected`; `shop/redact` → connection deleted and Shopify payments' customer email/name nulled; `customers/redact` → those fields nulled for the listed orders and customer; `customers/data_request` → 200 |
| GET           | `/api/apps/shopify/pixel.js?websiteId=` (DG)                                                 | public; JavaScript for a Shopify custom pixel (goals only, see [docs/install/shopify.md](../install/shopify.md)) |
| GET           | `/apps/shopify.js?id=<trackingId>[&domain=][&goals=0]`                                       | static asset (no Worker): storefront loader installed as the ScriptTag                          |
| GET           | `/api/apps/woocommerce/connect?websiteId=&storeUrl=[&format=json]` (DG)                      | `settings:write`; 302 to `<store>/wc-auth/v1/authorize` (scope `read_write`, `user_id` = signed 30-minute state, `callback_url` = the POST below, `return_url` = `/app/:siteId/integrations?woocommerce=connected`); `format=json` → `[{authorizeUrl}]` |
| POST          | `/api/apps/woocommerce/connect`                                                              | WooCommerce's key delivery `{key_id, user_id, consumer_key, consumer_secret, key_permissions}`; 401 bad state → stores the connection, answers `{message}`, then (in `waitUntil`) reads the currency and creates `order.created`/`order.updated` webhooks |

### 13.1 Connections W8 creates for W3

`provider_connections` rows, credentials encrypted with `encryptJson(ENCRYPTION_KEY, …, "provider:<provider>:<siteId>")`
and `webhook_secret_enc` with `encryptString` and the same AAD.

| Provider      | `credentials` JSON                                                                                                                                         | `webhook_secret_enc`                                                  | Other columns                                                                                                            | Webhooks registered                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `shopify`     | `{shop, clientId, clientSecret, grant, accessToken, accessTokenExpiresAt (ms or null), scope}`. Client-credentials tokens expire (~24 h): mint a new one with `POST https://<shop>/admin/oauth/access_token` `grant_type=client_credentials` | the client secret (Shopify signs webhooks with it)                    | `account_id` = `<shop>.myshopify.com`, `account_name`, `currency`; `settings {grant, storefrontDomain, scriptTagId, webhookIds}`; `status` `pending` until OAuth completes | `orders/paid`, `refunds/create` → `/webhooks/shopify/:siteId` (W3); `app/uninstalled` → W8 |
| `woocommerce` | `{storeUrl, consumerKey, consumerSecret, keyId, permissions}`; REST base `<storeUrl>/wp-json/wc/v3/`, HTTP Basic auth                                       | random secret WooCommerce signs `X-WC-Webhook-Signature` with (null if webhook creation failed: poll instead) | `account_id` = store host, `currency`; `settings {webhookIds, visitorMetaKey: "_datagoat_visitor_id", connectedBy}`         | `order.created`, `order.updated` → `/webhooks/woocommerce/:siteId` (W3)                                 |

Visitor attribution for these orders:

- **Shopify**: the storefront loader copies the cookies into cart attributes `_datagoat_visitor_id`
  and `_datagoat_session_id` (older `_datafast_*` attributes are still read); Shopify copies them onto the order's `note_attributes`
  (`[{name, value}]`).
- **WooCommerce**: the WordPress plugin stores order meta `_datagoat_visitor_id` and
  `_datagoat_session_id` (from the `datagoat_*` cookies, or DataFast's `datafast_*`) at
  checkout, visible in the REST order's `meta_data`.

### 13.2 Proxied ingest (for W1)

The install guides in [docs/install/](../install/README.md) tell operators who proxy
`/js/script.js` and `/api/events` through their own server to forward the visitor's address as
`X-Forwarded-For` (appending) and `X-Real-IP`. A request reaching the Worker through such a proxy has
the proxy's address in `CF-Connecting-IP` and the proxy's location in `request.cf`. The guides
recommend the two setups that need no proxy code (same-zone Worker route, custom domain) because
Cloudflare then sees the visitor directly; for self-hosted proxies they state that country and city
reflect what the ingest can derive from those headers.

### 13.3 Mobile app events (for W1 and W2)

`@datagoat/react-native` posts the ordinary §4 body to `POST /api/events` (`text/plain`, one event
per request) with DataFast's mobile conventions:

- `href` = `datafast://<platform>/<Screen>` (e.g. `datafast://ios/HomeScreen`), `referrer` = null,
  `domain` = the website's domain. The ingest must accept the `datafast:` scheme for a website's
  own `domain` (no page hostname to check) and store the screen as the page, so the
  `contains datafast://` page filter and funnel steps work as in DataFast.
- `visitorId` (UUID v4), `sessionId` (`s` + UUID v4, 30-minute timeout), `visitorFirstSeenAt`,
  `visitorSessionNumber` as the web tracker sends them; `type` is `pageview`, `custom` or
  `identify`.
- `User-Agent`: `Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15
  (KHTML, like Gecko) Mobile/15E148 DataGoatReactNative/<version>` or
  `Mozilla/5.0 (Linux; Android 15; <model>) AppleWebKit/537.36 (KHTML, like Gecko) Mobile
  Safari/537.36 DataGoatReactNative/<version>`, so device/OS parsing and bot filtering treat it as a
  phone.
- Queued events are delivered late after offline periods; the body has no client timestamp.

Web-to-app (DataFast's documented behaviour): a website visitor and an app visitor that `identify`
with the same `user_id` are one person. Visitor profiles and journeys (W2) should show the sessions
of every visitor of the website that shares the profile's `user_id`.

