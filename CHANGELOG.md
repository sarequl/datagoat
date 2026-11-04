# Changelog

All notable changes to DataGoat are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

- Foundation: single-package Worker (Hono) with Static Assets, D1, KV login throttling, Rate Limiting bindings and one cron; Deploy-to-Cloudflare ready configuration.
- Complete D1 schema (migration 0001) for every planned feature, within the plan's write budget (3/5/6 rows per pageview path).
- First-run setup link, email + password sign-in with throttling, signed session cookies, password change and one-time reset links, owner/member/viewer roles and team invites.
- DataFast-compatible Account API: account, `dft_` access tokens, websites CRUD (deletion dashboard-only), `df_` website keys with roll, team; per-credential rate limiting with `X-RateLimit-*` headers.
- Shared libraries: response envelopes, validation, crypto (AES-GCM, HMAC, PBKDF2), DST-safe time ranges and D1-side bucketing, D1 batching and metering, site cache, `filter_*` compiler and metric definitions.
- Cron job multiplexer with per-job state, slot claims, query/subrequest budgets, error isolation and backoff; website purge and auth cleanup jobs.
- Dashboard shell: setup, login, invite, reset and add-website screens, site switcher, navigation for every planned page, light/dark theme, typed API client and an MSW mock API.
- Tracker build pipeline producing `script.js`, `script.cookieless.js` and `script.hash.js` (placeholder tracker), with size budgets.
- Test harness (workerd + local D1, write-budget meter, factories), Playwright e2e and CI.
