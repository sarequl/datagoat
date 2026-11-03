# DataGoat API, CLI, MCP & Integrations — proposed surface (v0 design)

Status: proposal. No repo, no app code. Owner: API & Integrations Engineer.
Stack target: Cloudflare Worker (API + ingestion) + D1 (storage) + static dashboard.
Reference for feature parity: DataFast public docs (datafa.st/docs), read 2026-11-02.
This is original design; nothing here is copied code.

## 0. Decisions

| Decision | Choice |
| --- | --- |
| Base URL | `/api/v1/` |
| Transport | HTTPS JSON only, `Authorization: Bearer <token>` |
| Token types | `dg_read_` site read-only key, `dg_ingest_` site event key, `dgt_` account token |
| Site selection | `dg_*` key infers the site; `dgt_` tokens and cookie sessions pass `siteId` (§1.4) |
| Success envelope | `{"data": <endpoint payload>}`; lists also carry `pagination` |
| Error envelope | `{"error": {"code": <http status>, "message": <string>, "details": [<optional>]}}` |
| Versioning | URL path (`/api/v1/`). Breaking changes ship as `/api/v2/` |
| Auth timing | Every request resolves token → account + site scope + permission before handler |
| Writes in v0 | Only via `dg_ingest_` (events) and `dgt_` (account admin). `dg_read_` is strictly read-only |
| Rate limiting | Per-token token-bucket in D1/KV; headers `X-RateLimit-Limit/Remaining/Reset` |
| SPA session | `POST /api/v1/session` sets an httpOnly `dg_session` HS256 JWT; middleware accepts cookie OR Bearer |

Why three token types instead of one (DataFast uses a single `df_` key for both reads and writes):
a read-only key can be given to an agent/dashboard without risk of it mutating data, and an ingest key
never needs read privileges. This is a deliberate, small deviation, not a copy.

## 1. Auth model

### 1.1 Token types

| Token | Prefix | Scope | Best for |
| --- | --- | --- | --- |
| Site read-only key | `dg_read_` | One site, read | Dashboards, agents, scripts, MCP read tools |
| Site ingest key | `dg_ingest_` | One site, write events | Server-side goals, payments, identify |
| Account token | `dgt_` | One account, optionally site-allowlisted | CLI sessions, MCP write tools, account automation |

- A `dg_*` key resolves the site from the key itself; `siteId` is not applicable to it.
- An `dgt_` token **or a cookie session** calling a site-scoped endpoint must pass `siteId` as a query
  parameter; see §1.4 for resolution and validation.
- Admin subroutes embed the site in the path: `/api/v1/admin/sites/{siteId}/funnels`.

### 1.2 Permissions (for `dgt_`; `dg_*` keys are fixed-scope)

| Permission | Allows |
| --- | --- |
| `analytics:read` | analytics, breakdowns, visitors, realtime, mentions, goals list, funnels read |
| `metadata:read` | site metadata, settings read |
| `events:write` | goals, payments, identify |
| `notes:read` / `notes:write` | manual chart notes |
| `funnels:read` / `funnels:write` | funnels |
| `alerts:read` / `alerts:write` | alerts |
| `keys:read` / `keys:write` | site read/ingest keys |
| `tokens:read` / `tokens:write` | account tokens |
| `sites:read` / `sites:write` | list/create/update sites |
| `team:read` / `team:write` | members (write = owner only) |
| `gsc:read` / `gsc:write` | Search Console status, keywords, connect/disconnect |
| `social:read` / `social:write` | mentions + keyword config |
| `*` | everything (owner) |

Recommended agent permission sets (documented in the README, not enforced by default):

- Read-only agent: `analytics:read,metadata:read,sites:read,funnels:read,alerts:read,notes:read,gsc:read,social:read`
- Growth agent: add `funnels:write,alerts:write,notes:write`

### 1.3 Token storage (Worker Engineer owns the schema; this is the contract)

- Store only `sha256(token)` in D1 (`api_tokens` table). Raw value returned once at create/roll.
- Columns: `id`, `account_id`, `site_id` (nullable for `dgt_`), `kind` (`read|ingest|account`),
  `token_hash`, `name`, `permissions` (JSON array), `site_allowlist` (JSON array, nullable),
  `last_used_at`, `created_at`, `revoked_at`.
- On login/token create, the raw token is shown once and never retrievable again.
- `keys:write` allows roll (old hash stops working immediately) and revoke.

### 1.4 Site resolution

Site-scoped endpoints (`/api/v1/analytics/*`, `/visitors*`, `/mentions`, `/gsc/*`, and the §2.2 ingest
endpoints) resolve the site from the credential and a `siteId` query parameter when applicable:

| Credential | `siteId` query param | Rule |
| --- | --- | --- |
| `dg_read_` / `dg_ingest_` key | not applicable | site is embedded in the key; passing `siteId` is a 400 |
| `dgt_` token | required | validated against the account's sites |
| cookie session (`dg_session`) | required | validated against the owner's sites |

- `siteId` selects the site context only; permissions still come from the credential.
- Cookie sessions use the same rule as `dgt_` (API-owner ruling, 2026-11-03, at the Dashboard Engineer's
  request): the SPA sends the selected site as `siteId` on every site-scoped call. This avoids server-side
  "active site" state and keeps one rule for both auth modes; the WebsiteSwitcher gets the value from
  `GET /api/v1/admin/sites`.
- Missing `siteId` on a `dgt_` or cookie call to a site-scoped endpoint → 400 with message
  `siteId is required`.
- A `siteId` that does not exist or is not owned by the caller → 404, the same response as any inaccessible
  resource; existence is not disclosed.
- Duplicate `siteId` parameters → 400, consistent with §2.4.
- Admin subroutes carry the site in the path instead (`/api/v1/admin/sites/{siteId}/...`, §2.3) and do not
  accept a `siteId` query param. `GET /api/v1/admin/sites` is not site-scoped and needs none.
- Bootstrap order for the SPA: wait for `/admin/sites` before firing site-scoped requests. An early call
  without `siteId` is a 400, not a default to an arbitrary site.
- `siteId` is not a secret and may appear in URLs and logs.

## 2. REST API surface

All endpoints return the §0 envelopes. Every list endpoint supports `limit` (default 100, max 1000),
`offset`, and returns `pagination: {limit, offset, total, hasMore}`.

### 2.1 Site endpoints (site resolution in §1.4)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/analytics/overview` | Totals for a range; exact shape in §2.7.1. `compare=previous` adds a `previous` block mirroring the same fields for the preceding equal-length range (site tz) |
| GET | `/api/v1/analytics/timeseries` | Metrics bucketed by `interval` (`hour|day|week|month`); `fields` selects metrics. Shape in §2.7.2 |
| GET | `/api/v1/analytics/realtime` | Active visitor count for the last 10 min. Shape in §2.7.4 |
| GET | `/api/v1/analytics/realtime/map` | Active visitors last 10 min with geo/device fields, plus recent payments. Shape in §2.7.5 |
| GET | `/api/v1/analytics/metadata` | Site domain, timezone, currency, name, #1 KPI. Shape in §2.7.6 |
| GET | `/api/v1/analytics/pages` | Top pages by visitors, with revenue |
| GET | `/api/v1/analytics/referrers` | Traffic sources |
| GET | `/api/v1/analytics/countries` / `regions` / `cities` | Geography |
| GET | `/api/v1/analytics/browsers` / `devices` / `operating-systems` | Device |
| GET | `/api/v1/analytics/campaigns` | UTM campaign breakdown |
| GET | `/api/v1/analytics/goals` | Goal name, completions, visitors and revenue per goal. Shape in §2.7.9 |
| GET | `/api/v1/analytics/hostnames` | Multi-domain breakdown |
| GET | `/api/v1/analytics/exit-clicks` | External destinations by unique visitors and clicks |
| GET | `/api/v1/analytics/funnel/{funnelId}` | Step-by-step drop-off and conversion. Steps are ordered predicates evaluated within one session; predicate set in §2.6, result shape in §2.7.3 |
| GET | `/api/v1/visitors` | Search by page, goal, country, device, browser, `utm_campaign`, `isCustomer` |
| GET | `/api/v1/visitors/{visitorId}` | Identity, profile, activity, goals, payments, prediction |
| GET | `/api/v1/mentions` | X/Reddit mentions (see §6) |
| GET | `/api/v1/gsc/keywords` | Search Console keywords (see §5) |
| GET | `/api/v1/gsc/overview` | GSC totals + revenue estimate |
| GET | `/api/v1/gsc/status` | Connection state |

Common query params: `startAt`, `endAt` (inclusive `YYYY-MM-DD` or ISO; a date-only bound covers the whole
local day in the site tz), `timezone` (IANA, default site tz), `path` filter (e.g. `/blog`), `fields`,
`interval`, `order` (`asc|desc`). `siteId` is required by `dgt_` and cookie-session calls on these
endpoints and validated per §1.4.

### 2.1.1 Breakdown response shape (all `/analytics/*` breakdowns)

Every breakdown row carries the dimension value plus the same metric set, so the dashboard renders one
table shape for all dimensions:

```json
{
  "data": [
    {"value": "/pricing", "visitors": 1204, "pageviews": 2680, "revenue": 5310.0, "payments": 42, "revenuePerVisitor": 4.41, "conversionRate": 0.0349}
  ],
  "pagination": {"limit": 100, "offset": 0, "total": 1, "hasMore": false}
}
```

- `revenue` is **attributed** revenue (Attribution Engineer's model), not booked revenue; label it as an
  estimate in the UI.
- `revenuePerVisitor = revenue / visitors`; when `visitors = 0` return `0`, never `null`/`NaN`.
- `payments` is a count. `conversionRate` is returned only when the request includes a `goal=<name>` filter;
  it is goal-completing unique visitors in the row ÷ row visitors, `0` when `visitors = 0`. Without a goal
  filter the key is absent.
- Applies to `pages`, `referrers`, `campaigns`, `countries`, `regions`, `cities`, `browsers`, `devices`,
  `operating-systems`, and `hostnames`. `goals` adds `completions` and omits `conversionRate`;
  `exit-clicks` adds `clicks`. See §2.7.7 for the exact per-endpoint rows.

### 2.2 Ingest endpoints (`dg_ingest_`, or `dgt_` with `events:write`)

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/v1/goals` | Record a custom goal event for a visitor |
| POST | `/api/v1/payments` | Record a payment (amount, currency, provider, order id) |
| POST | `/api/v1/identity` | Identify a visitor (`userId` + metadata) |
| DELETE | `/api/v1/goals/events` | Bulk-delete goal events (dangerous; see §7) |

Event field contract is owned by the Script & SDK Engineer. The API only validates and stores it; it does
not invent field names. The ingestion Worker (Worker Engineer) owns the actual event tables.

### 2.3 Admin endpoints (`dgt_`, or `dg_read_` for the read-only subset)

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/admin/sites` | `sites:read` |
| GET | `/api/v1/admin/sites/{siteId}` | `sites:read` |
| POST | `/api/v1/admin/sites` | `sites:write` |
| PATCH | `/api/v1/admin/sites/{siteId}` | `sites:write` |
| GET | `/api/v1/admin/sites/{siteId}/keys` | `keys:read` |
| POST | `/api/v1/admin/sites/{siteId}/keys` | `keys:write` |
| POST | `/api/v1/admin/sites/{siteId}/keys/{keyId}/roll` | `keys:write` |
| DELETE | `/api/v1/admin/sites/{siteId}/keys/{keyId}` | `keys:write` |
| GET | `/api/v1/admin/tokens` | `tokens:read` |
| POST | `/api/v1/admin/tokens` | `tokens:write` |
| DELETE | `/api/v1/admin/tokens/{tokenId}` | `tokens:write` |
| GET/POST/PATCH/DELETE | `/api/v1/admin/sites/{siteId}/funnels[...]` | `funnels:read|write` |
| GET/POST/PATCH/DELETE | `/api/v1/admin/sites/{siteId}/alerts[...]` | `alerts:read|write` |
| GET | `/api/v1/admin/sites/{siteId}/alerts/{id}/history` | `alerts:read` |
| GET/POST/PATCH/DELETE | `/api/v1/admin/sites/{siteId}/notes[...]` | `notes:read|write` |
| GET/POST/DELETE | `/api/v1/admin/sites/{siteId}/team[...]` | `team:read|write` |
| GET | `/api/v1/admin/account` | any `dgt_` |

Read shape for the site list: §2.7.8.

Notes are always path-scoped by site. Mention reads infer site from a `dg_*` key; `dgt_` and cookie
sessions must pass `siteId` (§1.4).

### 2.4 Errors

| Code | Meaning |
| --- | --- |
| 400 | missing/invalid fields, bad date range, bad enum, invalid id |
| 401 | missing/invalid token, wrong prefix, expired/revoked |
| 403 | missing permission, token cannot access the site, owner-only action |
| 404 | resource not found or not accessible |
| 409 | duplicate (e.g. token name, funnel name) or idempotency key reused with different input |
| 429 | rate limited (see headers) |
| 500 | unexpected |

Unknown or duplicate query parameters are rejected with 400 (matches the strictness of the reference docs).

### 2.5 Session (SPA auth)

Bearer tokens stay for CLI, MCP, and external callers. The browser SPA authenticates with a cookie so no
token lives in JS.

| Method | Path | Body | Effect |
| --- | --- | --- | --- |
| POST | `/api/v1/session` | `{ "password": "<admin password>" }` | Verify PBKDF2 hash; set `dg_session` |
| POST | `/api/v1/session/logout` | — | Clear `dg_session` |
| GET | `/api/v1/session` | — | Whoami: `{ "authenticated": true, "scope": "owner" }` or 401 |

Cookie attributes: `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200` (12 h). Value is an HS256 JWT
`{ sub, exp, iat }` signed with `SESSION_SECRET` (Worker env). The middleware accepts **either** the cookie
**or** `Authorization: Bearer`. A cookie session maps to **account-owner** scope (it can call admin CRUD:
funnels, keys, tokens, team, settings). `dg_*` keys are never accepted as the SPA session. Login is
rate-limited (10 attempts / 15 min / IP). PBKDF2-SHA256 is used because Workers have no Argon2/bcrypt in the
standard runtime; ≥210k iterations. The admin password is set at first boot and stored as its hash in D1
(Worker Engineer owns that table).

Cookie-authenticated calls resolve the site exactly like `dgt_`: a required `siteId` query param on every
site-scoped endpoint (§1.4). The SPA's WebsiteSwitcher supplies it; `/admin/sites` needs no `siteId`.

### 2.6 Funnel step predicates (Worker contract)

A funnel is an ordered list of steps. Each step is a predicate; a visitor "enters" a step if the predicate
matches any event in their session. Steps are evaluated **in order within one session**, and an optional
`maxGapSeconds` (default none) caps the time between consecutive steps.

| Predicate | Params | Matches |
| --- | --- | --- |
| page equals | `path` | a pageview whose path is exactly `path` |
| page contains | `pathContains` | a pageview whose path contains the substring |
| goal | `goal` | a goal event with that name |
| country | `country` | visitor country code |
| referrer | `referrer` | referrer host (or `referrerContains`) |
| device | `device` | `desktop|mobile|tablet` |
| hostname | `host` | multi-domain hostname |
| UTM | `utmSource`, `utmCampaign` | matching UTM value |
| isCustomer | `isCustomer` | visitor customer status |
| scroll depth | `scrollPercent` | only if scroll events exist; otherwise the step is dropped with a warning |

- Step count: 2–8.
- A funnel may end on a goal or a payment step; a payment step uses predicate `goal = "payment"` plus the
  amount from the payment event, so `FunnelChart` can show revenue per step.
- `POST /api/v1/admin/sites/{siteId}/funnels` validates the predicate set and rejects unknown predicates
  with 400.

### 2.7 Pinned response shapes

This section is normative for `/api/v1`: it fixes the JSON the dashboard, CLI, and MCP tools code against.
The names are camelCase and deliberately differ from the reference product's snake_case; this is original
design, not copied shape.

Conventions used below:

- Envelopes are §0. Success is `{"data": ...}` plus `pagination` where stated; errors are
  `{"error": {"code", "message", "details"}}`.
- Counts are integers. Timestamps are ISO 8601 UTC strings ending in `Z`. Date bounds are `YYYY-MM-DD`.
- Money is a decimal number in the site currency's **major unit** (e.g. `5310.5` = $5,310.50), rounded to
  2 dp. Storage is minor units; the API converts.
- Rates are fractions in `[0, 1]` rounded to 4 dp, never percentages. (`revenuePerVisitor` is money, not a
  rate.)
- A field marked *nullable* is always present as `null`, never omitted.

#### 2.7.1 Overview — `GET /api/v1/analytics/overview`

```json
{
  "data": {
    "visitors": 12840,
    "sessions": 15320,
    "pageviews": 41280,
    "bounceRate": 0.421,
    "avgSessionDuration": 184,
    "currency": "USD",
    "revenue": 5310.5,
    "payments": 42,
    "revenuePerVisitor": 0.4134,
    "conversionRate": 0.0333
  }
}
```

`data` is an object, not an array.

| Field | Type | Definition |
| --- | --- | --- |
| `visitors` | int | Unique visitors in range |
| `sessions` | int | Sessions in range |
| `pageviews` | int | Pageviews in range |
| `bounceRate` | fraction | Single-pageview sessions ÷ sessions; `0` when `sessions = 0` |
| `avgSessionDuration` | int | Mean session length in seconds, rounded to nearest second |
| `currency` | string | ISO 4217 code for money fields (added in this revision) |
| `revenue` | money | Attributed revenue (estimate), not booked revenue |
| `payments` | int | Payment events attributed in range |
| `revenuePerVisitor` | money | `revenue ÷ visitors`; `0` when `visitors = 0` |
| `conversionRate` | fraction | Paying unique visitors ÷ visitors (revenue-based conversion); `0` when `visitors = 0` |

`compare=previous` adds `data.previous` with exactly the same fields (including `currency`) for the
immediately preceding equal-length range in the site timezone. Without the parameter the key is absent.

#### 2.7.2 Timeseries — `GET /api/v1/analytics/timeseries`

`interval` is required. `fields` is optional and selects a subset of
`visitors,pageviews,sessions,revenue,payments` (default all five). Requesting `revenue` also returns
`payments`. An unknown metric is a 400.

```json
{
  "data": {
    "interval": "day",
    "fields": ["visitors", "pageviews", "sessions", "revenue", "payments"],
    "timezone": "UTC",
    "currency": "USD",
    "points": [
      {"timestamp": "2026-11-01T00:00:00Z", "visitors": 320, "pageviews": 704, "sessions": 272, "revenue": 0, "payments": 0}
    ]
  }
}
```

- Rows are under `points` (not `data[]`), matching the dashboard's typed mock.
- `fields` echoes the effective metrics in canonical order `visitors,pageviews,sessions,revenue,payments`;
  each point carries only those metrics (plus `payments` when `revenue` was requested).
- `point.timestamp` is the bucket start as a UTC instant. `hour` buckets start at the top of the hour;
  `day`/`week`/`month` buckets start at local midnight in `timezone` (weeks Monday, months day 1), converted
  to UTC.
- Every bucket in the inclusive range is returned and zero-filled when empty.
- No `pagination`: one response covers the whole range. Ranges wider than 1000 buckets are rejected with
  400 (`narrow the range or use a larger interval`).
- Same-day ranges do not change the requested interval.

#### 2.7.3 Funnel results — `GET /api/v1/analytics/funnel/{funnelId}`

```json
{
  "data": {
    "id": "fun_1",
    "name": "Checkout",
    "steps": [
      {"step": 1, "name": "View pricing", "visitors": 1204, "conversionRate": 1, "dropoffRate": 0, "revenue": 0, "payments": 0},
      {"step": 2, "name": "Start checkout", "visitors": 310, "conversionRate": 0.2574, "dropoffRate": 0.7426, "revenue": 0, "payments": 0},
      {"step": 3, "name": "Payment", "visitors": 42, "conversionRate": 0.0349, "dropoffRate": 0.8645, "revenue": 5310.5, "payments": 42}
    ],
    "totalVisitors": 1204,
    "totalConversionRate": 0.0349,
    "revenue": 5310.5,
    "payments": 42,
    "revenuePerVisitor": 4.4111,
    "timezone": "UTC",
    "startAt": "2026-11-01",
    "endAt": "2026-11-03",
    "lastUpdated": "2026-11-03T08:00:00Z"
  }
}
```

- `steps` preserve funnel order; `step` is 1-based.
- Step `visitors` = unique visitors who reached that step in order, within one session, honouring the
  funnel's `maxGapSeconds`.
- Step `conversionRate = step.visitors ÷ steps[0].visitors` (first step `1`).
- Step `dropoffRate = 1 − step.visitors ÷ previousStep.visitors` (first step `0`).
- Step `revenue`/`payments` = attributed revenue/payment count from visitors who reached that step.
- `totalVisitors` = first-step visitors; `totalConversionRate` = last ÷ first; `revenue`/`payments` =
  final-step totals; `revenuePerVisitor = revenue ÷ totalVisitors` (`0` when `0`).
- `startAt`/`endAt` echo the resolved bounds (`null` for all-time); `lastUpdated` is generation time.
- Inactive or unknown funnels return 404.

#### 2.7.4 Realtime — `GET /api/v1/analytics/realtime`

```json
{ "data": { "online": 128, "windowMinutes": 10, "timestamp": "2026-11-03T08:00:00Z" } }
```

- `online` = unique visitors with any event in the last `windowMinutes` minutes. The field is named
  `online` (not `visitors`) so it cannot be confused with the map endpoint's `visitors` array.
- `windowMinutes` is `10` in v0 and is echoed so clients do not hard-code the window.
- `timestamp` is the response time. Date-range and filter parameters are ignored; unknown parameters
  return 400.
- Resolved 2026-11-03: worker.md now uses the same 10-minute window (PR #7), so `windowMinutes` is the
  single source of truth for both docs.

#### 2.7.5 Realtime map — `GET /api/v1/analytics/realtime/map`

```json
{
  "data": {
    "count": 2,
    "windowMinutes": 10,
    "timestamp": "2026-11-03T08:00:00Z",
    "visitors": [
      {
        "visitorId": "9f2c1e0ab74d4f3c8e5a6b7c8d9e0f11",
        "page": "/pricing",
        "referrer": "Google",
        "countryCode": "FR",
        "region": "Île-de-France",
        "city": "Paris",
        "latitude": 48.8566,
        "longitude": 2.3522,
        "device": "desktop",
        "browser": "Chrome",
        "os": "Mac OS",
        "sessionStartTime": "2026-11-03T07:55:00Z",
        "lastSeenAt": "2026-11-03T08:00:00Z",
        "visitCount": 2,
        "isCustomer": false
      }
    ],
    "recentPayments": [
      {"visitorId": "9f2c1e0ab74d4f3c8e5a6b7c8d9e0f11", "amount": 49.0, "currency": "USD", "at": "2026-11-03T07:58:00Z", "isRenewal": false}
    ]
  }
}
```

- `count` = `visitors.length`, same window as §2.7.4.
- `visitors` are active in the window, newest `lastSeenAt` first. Nullable: `page`, `referrer`,
  `countryCode`, `region`, `city`, `latitude`, `longitude`. `page` is the current path, not a full URL.
  Coordinates are coarse city-level values from `request.cf`, never precise locations.
- `device` ∈ `desktop|mobile|tablet`; `browser`/`os` are display names; `visitCount` is the all-time
  session count; `isCustomer` reports whether payment data exists for the visitor.
- `recentPayments` lists payments in the window, newest first, maximum 20:
  `{visitorId, amount, currency, at, isRenewal}`. Payments are not repeated inside visitor rows.
- No `pagination`. No customer names or emails: use `/visitors/{visitorId}` for identity.

#### 2.7.6 Metadata — `GET /api/v1/analytics/metadata`

```json
{
  "data": {
    "siteId": "site_1",
    "domain": "example.com",
    "name": "Example",
    "timezone": "UTC",
    "currency": "USD",
    "kpi": "revenue"
  }
}
```

- `kpi` is the site's #1 KPI as a scalar (nullable), not an array. Allowed values: `visitors`,
  `sessions`, `pageviews`, `bounceRate`, `avgSessionDuration`, `revenue`, `payments`,
  `revenuePerVisitor`, `conversionRate`; `null` when unset.
- This corrects the dashboard mock's `kpis: string[]` to scalar `kpi`.

#### 2.7.7 Breakdown rows

Base row (confirmed from §2.1.1):

```json
{"value": "/pricing", "visitors": 1204, "pageviews": 2680, "revenue": 5310.0, "payments": 42, "revenuePerVisitor": 4.41, "conversionRate": 0.0349}
```

| Endpoint | Row shape |
| --- | --- |
| `pages`, `referrers`, `campaigns`, `countries`, `regions`, `cities`, `browsers`, `devices`, `operating-systems`, `hostnames` | base |
| `goals` | base + `completions` (int, event count), no `conversionRate` |
| `exit-clicks` | base + `clicks` (int) |

- `value` is the dimension value: path, referrer host, country code, device type, goal name, or external
  destination URL.
- `completions` counts goal events, so one visitor can contribute more than once.

#### 2.7.8 Sites list — `GET /api/v1/admin/sites`

```json
{
  "data": [
    {"id": "site_1", "name": "Example", "domain": "example.com", "timezone": "UTC", "currency": "USD", "createdAt": "2026-01-01T00:00:00Z"}
  ],
  "pagination": {"limit": 100, "offset": 0, "total": 1, "hasMore": false}
}
```

- `name` is nullable. `id` is the `siteId` used by `dgt_` calls and admin paths.
- No `role` in v0 (single account, owner-only session).

#### 2.7.9 Goals list — `GET /api/v1/analytics/goals`

```json
{
  "data": [
    {"value": "signup", "completions": 482, "visitors": 391, "pageviews": 0, "revenue": 0, "payments": 0, "revenuePerVisitor": 0}
  ],
  "pagination": {"limit": 100, "offset": 0, "total": 1, "hasMore": false}
}
```

- Base row + `completions`. `value` is the goal name; `visitors` is unique visitors who completed it.
- Sorted by `visitors` descending by default; `order=asc` reverses.
- Payment-related goals can appear here too.

#### 2.7.10 Session endpoints

Confirms §2.5 with exact bodies:

| Method | Path | Request | Success body |
| --- | --- | --- | --- |
| POST | `/api/v1/session` | `{"password": "<admin password>"}` | `{"data": {"authenticated": true, "scope": "owner"}}` |
| POST | `/api/v1/session/logout` | — | `{"data": {"authenticated": false}}` |
| GET | `/api/v1/session` | — | `{"data": {"authenticated": true, "scope": "owner"}}`; 401 error envelope when unauthenticated |

- Cookie `dg_session`: `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200`, HS256 JWT `{sub, exp, iat}`,
  12 h, signed with `SESSION_SECRET`.
- Wrong password → 401 `{"error": {"code": 401, "message": "Incorrect password"}}`; malformed JSON body
  → 400.
- Owner scope. `dg_*` keys are never accepted as the SPA session; the middleware accepts the cookie or
  `Authorization: Bearer`.

## 3. CLI

Binary: `datagoat` (single Node/Bun script, no framework). It is a thin wrapper over §2.

### 3.1 Auth & config

- `datagoat login [--token <t>]` — interactive, or pipe: `echo $TOKEN | datagoat login`.
- Token/config stored at `~/.config/datagoat/config.json` (mode 0600).
- `datagoat logout`.
- `datagoat whoami` — token kind, permissions, accessible sites.

Env overrides: `DATAGOAT_TOKEN`, `DATAGOAT_SITE`, `DATAGOAT_API_BASE` (default `https://<your-worker>/api/v1`).

### 3.2 Global flags

| Flag | Description |
| --- | --- |
| `--json` | Compact JSON (default: pretty-printed, piped to a pager when interactive) |
| `--site <id>` | Override the site for `dgt_` calls |
| `--start` / `--end` | Date range shorthand |
| `--verbose` | Print request URL + status to stderr |
| `--format <table|json|csv>` | Output shape (default table when TTY, json otherwise) |

### 3.3 Commands

```
datagoat analytics overview [--start --end --path]
datagoat analytics timeseries [--fields visitors,pageviews,revenue --interval day]
datagoat analytics realtime
datagoat analytics realtime-map
datagoat analytics metadata
datagoat analytics pages|referrers|countries|regions|cities|browsers|devices|operating-systems|campaigns|goals|hostnames|exit-clicks
datagoat analytics funnel <funnelId>
datagoat visitors list [--visitedPage --completedGoal --country --device --utm_campaign --isCustomer]
datagoat visitors get <visitorId>
datagoat mentions list [--platform x|reddit --q --start --end]
datagoat goals track [--name --visitorId --properties <json>]
datagoat goals list
datagoat payments track [--amount --currency --provider --orderId --visitorId]
datagoat identity identify [--userId --metadata <json>]
datagoat sites list|get|create|update
datagoat keys list|create|roll|revoke --site <id>
datagoat tokens list|create|revoke
datagoat funnels list|create|update|delete
datagoat alerts list|create|update|delete|history
datagoat notes list|create|update|delete
datagoat gsc status|keywords|overview|connect|disconnect|backfill
datagoat config set|get
```

- All commands support `--json`; output is valid JSON on stdout and diagnostics on stderr.
- Example: `datagoat --json sites list | jq '.data[].domain'`.
- Interactive prompts appear only when a required id is omitted and stdin is a TTY.

## 4. MCP server

One MCP server, `datagoat-mcp` (npm `@datagoat/mcp`), usable with Claude Code, Cursor, Codex.
Tools are prefixed `datagoat_` and mirror §2 1:1 (same fields, same validation, same permissions).

### 4.1 Transport & auth

- `stdio` transport for local clients; optional HTTP transport for hosted/team use.
- Auth: a `dgt_` token via env `DATAGOAT_MCP_TOKEN`, or OAuth (deferred to v1).
- Read-only tools work with `dg_read_` too; `dg_read_` cannot call write tools.

### 4.2 Safety pattern

Tools that are irreversible or credential-issuing are marked `confirm` below. Without `confirm: true`
they return a dry-run preview and change nothing. Every write accepts an optional `idempotencyKey`
so agent retries do not double-apply.

### 4.3 Tool catalog (v0)

| Group | Tools |
| --- | --- |
| Analytics | `datagoat_analytics_overview`, `_timeseries`, `_realtime`, `_realtime_map`, `_metadata`, `_pages`, `_referrers`, `_countries`, `_regions`, `_cities`, `_browsers`, `_devices`, `_operating_systems`, `_campaigns`, `_goals`, `_hostnames`, `_exit_clicks`, `_funnel` |
| Visitors | `datagoat_visitors_search`, `datagoat_visitors_get` |
| Mentions | `datagoat_mentions_list`, `datagoat_mentions_stats` |
| Goals | `datagoat_goals_track`, `datagoat_goals_list`, `datagoat_goals_delete_events` ⚠ confirm |
| Payments | `datagoat_payments_track`, `datagoat_payments_list` |
| Identity | `datagoat_identity_identify` |
| Sites | `datagoat_sites_list`, `datagoat_sites_get`, `datagoat_sites_create`, `datagoat_sites_update` |
| Keys | `datagoat_keys_list`, `datagoat_keys_create` ⚠ confirm, `datagoat_keys_roll` ⚠ confirm, `datagoat_keys_revoke` ⚠ confirm |
| Tokens | `datagoat_tokens_list`, `datagoat_tokens_create` ⚠ confirm, `datagoat_tokens_revoke` ⚠ confirm |
| Funnels | `datagoat_funnels_list`, `datagoat_funnels_create`, `datagoat_funnels_update`, `datagoat_funnels_delete` ⚠ confirm |
| Alerts | `datagoat_alerts_list`, `datagoat_alerts_create`, `datagoat_alerts_update`, `datagoat_alerts_delete` ⚠ confirm, `datagoat_alerts_history` |
| Notes | `datagoat_notes_list`, `datagoat_notes_create`, `datagoat_notes_update`, `datagoat_notes_delete` ⚠ confirm |
| Team | `datagoat_team_list`, `datagoat_team_invite`, `datagoat_team_remove` ⚠ confirm (owner only) |
| GSC | `datagoat_gsc_status`, `datagoat_gsc_keywords`, `datagoat_gsc_overview`, `datagoat_gsc_connect`, `datagoat_gsc_disconnect` ⚠ confirm, `datagoat_gsc_backfill` |
| Social | `datagoat_social_keywords_list`, `datagoat_social_keywords_update` |
| Account | `datagoat_account_get`, `datagoat_account_update` |

### 4.4 Suggested agent prompts (documented, not enforced)

- "Who mentioned my brand in the last 30 days?" → `datagoat_mentions_list`.
- "Add a note that we launched the new landing page today." → `datagoat_notes_create` with `idempotencyKey`.

## 5. Google Search Console integration

### 5.1 Connection

- OAuth 2.0, offline access. Scope: `https://www.googleapis.com/auth/webmasters.readonly`.
- Flow: `GET /api/v1/gsc/connect?siteId=...` → 302 to Google → `GET /api/v1/gsc/callback` stores tokens.
- Tokens live in D1 (`gsc_connections`: `site_id`, `property_url`, `access_token_enc`, `refresh_token_enc`,
  `expires_at`, `created_at`). Encryption is a Worker Engineer concern (AES-GCM with an env key); the API
  never logs tokens. A connection can be removed with `gsc:write` (`/api/v1/gsc/disconnect`).
- Requires the property verified in Search Console and owner/full user permission.

### 5.2 Backfill & storage

- A scheduled Worker job calls the Search Analytics Query API:
  `siteUrl`, `startDate`, `endDate`, `dimensions=[date, query, page]`, `rowLimit` 25000.
- Storage table `gsc_daily` (`site_id`, `date`, `query`, `page`, `impressions`, `clicks`, `ctr`, `position`),
  keyed by `(site_id, date, query, page)` so re-runs upsert. GSC data typically lags 24–48h.
- `datagoat gsc backfill` triggers a manual re-sync for a date range (idempotent).

### 5.3 Read API

| Endpoint | Returns |
| --- | --- |
| `GET /api/v1/gsc/status` | connected, property, last sync, last error |
| `GET /api/v1/gsc/overview` | clicks, impressions, CTR, avg position, revenue estimate for a range |
| `GET /api/v1/gsc/keywords` | per-keyword clicks/impressions/CTR/position/revenue estimate; `path` filter supported |
| `GET /api/v1/gsc/pages` | per-page aggregate |

- `path` filtering limits keywords to pages under that path, matching the dashboard behaviour in the reference.
- Revenue estimate is produced by joining GSC page traffic with revenue-by-page from the attribution model
  (owned by the Attribution Engineer). It is always returned under an `estimatedRevenue` field and labelled as
  an estimate in docs and MCP descriptions. We do not claim it equals booked revenue.

### 5.4 Rate/cost note

Search Analytics Query is quota-limited (daily quota per project). We cache results and backfill incrementally.
Exact quota numbers are set in the Google Cloud project, not in this doc.

## 6. X / Reddit social mentions integration

### 6.1 Collection

A scheduled Worker (`social_collector`) polls for each connected site's keyword list and stores rows in
`mentions` (`id`, `site_id`, `platform`, `timestamp`, `text`, `url`, `author_name`, `author_username`,
`author_image`, `engagement` JSON, `media` JSON, `is_retweet`, `subreddit`).

| Platform | Source | Notes |
| --- | --- | --- |
| X | X API v2 filtered/recent search | Requires a paid access tier for search; a keyword list is configured per site |
| Reddit | public search JSON (`/search.json?q=...`) with a descriptive User-Agent | Rate-limited per IP; poll conservatively |

- Default keywords: the site domain and configured brand terms.
- `social:write` manages the keyword list; `social:read` (or `analytics:read`) reads results.
- This is the highest-uncertainty part of the surface. **Assumption to confirm:** whether the project will pay
  for X search access or fall back to a third-party mention provider. If neither is available, `mentions` ships
  as an empty, documented table with the collector stubbed.

### 6.2 Read API

`GET /api/v1/mentions` — params: `startAt`, `endAt`, `timezone`, `q` (case-insensitive, matches text/author/url/
subreddit, ≤200 chars), `platform` (`x|reddit`), `limit` (1–1000, default 100), `offset`, `order` (`asc|desc`).
Returns `data[]` (id, platform, timestamp UTC, text, url, author, engagement, media, isRetweet, subreddit)
plus `pagination` and `meta` (resolved timezone, UTC bounds, total).

## 7. Explicit non-goals (v0)

- No paid plans, billing, or per-plan caps. Open source, self-hosted: one account, many sites.
- No card payments through the API/MCP. (No payment credentials flow at all in v0.)
- No write endpoints on `dg_read_`. No account creation via API (self-hosted single-tenant setup).
- No deletion of sites via API (destructive; keep in the dashboard for now).
- `goals/events` bulk delete is gated behind `confirm` and is the only destructive ingest op.
- OAuth for MCP is deferred to v1 (token auth covers v0).

## 8. Coordination (who owns what)

| Area | Owner | Interface needed from me |
| --- | --- | --- |
| Event schema (goal/payment/identify fields) | Script & SDK Engineer | validate + store; document field contract |
| D1 tables, token hashing, encryption | Worker Engineer | §1.3 token table + §5.2 `gsc_daily` |
| Revenue-by-page attribution model | Attribution Engineer | §5.3 `estimatedRevenue` join |
| Dashboard field needs | Dashboard Engineer | §2.1 + §2.7 pinned response shapes |
| Ingestion Worker + cron | Worker Engineer | endpoints above |
| SPA session auth | Dashboard Engineer | §2.5 endpoints; admin password hash table |

## 9. Open questions for the team

1. Confirm the three-token model vs a single site key (trade-off: safety vs parity).
2. Confirm whether to pay for X search access, use a third-party provider, or ship mentions as a stub.
3. Confirm D1 capacity expectations for `gsc_daily` retention (e.g. keep 24 months, then aggregate).
4. ~~Confirm whether `dgt_` account tokens are needed for a self-hosted single-tenant install.~~ **Resolved
   2026-11-02 with Dashboard Engineer:** the SPA uses the `dg_session` cookie (§2.5); `dgt_` tokens remain for
   CLI, MCP, and external/CI use only.
5. Confirm the MCP `confirm`/dry-run pattern is acceptable vs always-execute for write tools.
6. ~~Realtime window: §2.7.4 pins 10 minutes, but worker.md §9/§10 defines "live now" as 5 minutes. The
   Worker Engineer must confirm one number before implementing `/analytics/realtime[/map]`.~~ **Resolved
   2026-11-03:** worker.md was updated to the 10-minute window (PR #7), matching §2.7.4.

## 10. Sources (read 2026-11-02)

- https://datafa.st/docs/api — surfaces, envelopes, base URL, error codes
- https://datafa.st/docs/api/authentication — token types, permissions
- https://datafa.st/docs/api/website/analytics — analytics endpoints and params
- https://datafa.st/docs/api/website/visitors — visitors endpoints
- https://datafa.st/docs/api/website/mentions/list — mentions params and response
- https://datafa.st/docs/mcp-tools — MCP tool catalog and safety pattern
- https://datafa.st/docs/cli-introduction — CLI flags, env vars, config location
- https://datafa.st/docs/google-search-console — GSC connection and revenue estimate behaviour
