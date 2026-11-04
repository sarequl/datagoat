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
- Dashboard shell: setup, login, invite, reset and add-website screens, site switcher, navigation for every planned page, dark-by-default theme with light and system modes using DataFast's colour palette (WCAG AA tested), typed API client and an MSW mock API.
- Tracker build pipeline producing `script.js`, `script.cookieless.js` and `script.hash.js` (placeholder tracker), with size budgets.
- The Worker bundles its D1 migrations and applies pending ones on first use, so setup works even when the deploy command skipped `wrangler d1 migrations apply`; schema failures answer 503 with the reason.
- `npm run smoke -- --url <deployment>` checks a deployed instance end to end over HTTP.
- Test harness (workerd + local D1, write-budget meter, factories), Playwright e2e and CI.
- Revenue attribution: Stripe (read-only restricted key, Events API polling, backfill, optional webhooks, Payment Links), Polar, Lemon Squeezy, Paddle Billing, Dodo Payments, Creem, Shopify and WooCommerce; DataFast's `POST`/`DELETE /api/v1/payments`; integrations connect/status/re-sync/disconnect; subscription lifecycle goals; ECB currency conversion; revenue by source, LTV by first channel, path to purchase and the payments list (docs/revenue/).
