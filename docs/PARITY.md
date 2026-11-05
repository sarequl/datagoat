# DataFast parity

This is an audit of DataGoat against every DataFast feature we could find: the 230 DataFast docs
pages, the 60 changelog entries and the feature sections of the research report. Each row was
checked in the merged code, not in the docs: by reading the implementation, by the test suites
(Worker, dashboard, tracker, CLI, ecosystem, Playwright), and by running the real Worker with the
demo data (`npm run seed:demo`), where a script opened every dashboard page and called every
DataFast API endpoint with a website key and an account token. Every page and endpoint answered without
an error.

**Status**

- **Done**: built and tested.
- **Done (untested against the real service)**: built against the provider's documented API and
  tested with mocked HTTP only. No credentials exist in this project, so the first real connection
  is the real test.
- **Partial**: works, but something DataFast has is missing (stated in the row).
- **Not done**: missing, with the reason.

Last audit: November 2026, branch `finisher`.

## Summary

| Area | Done | Done (untested against the real service) | Partial | Not done |
| --- | --- | --- | --- | --- |
| Tracking | 34 | 0 | 0 | 0 |
| Dashboard | 52 | 0 | 2 | 0 |
| Revenue | 15 | 10 | 1 | 0 |
| Goals and funnels | 16 | 0 | 0 | 0 |
| API | 22 | 0 | 0 | 1 |
| MCP and CLI | 13 | 1 | 0 | 0 |
| Growth | 17 | 8 | 0 | 0 |
| Team and sharing | 11 | 0 | 0 | 0 |
| Privacy | 10 | 0 | 0 | 1 |
| Install and ecosystem | 13 | 3 | 0 | 0 |
| Mobile | 5 | 1 | 1 | 2 |
| **Total** | **208** | **23** | **4** | **4** |

Rows marked "finisher" were added or fixed in this audit.

## Tracking

| DataFast feature | Status | Where | Notes |
| --- | --- | --- | --- |
| One `<script defer data-website-id data-domain src=/js/script.js>` install | Done | `tracker/src/tracker.ts`, `public/js/script.js` | ~5 KB gzip (`tracker/size-budget.json`) |
| Tracking ids; old `dfid_` ids keep working | Done | `src/lib/ids.ts` (`newTrackingId`), `src/lib/site-cache.ts` | new ids are `dgid_` + 16 base62 characters; the collector accepts any opaque id, so existing and imported `dfid_` ids need no tag change |
| `data-allowed-hostnames` cross-domain tracking with `_df_vid` `_df_sid` `_df_vfs` `_df_vsn` link handoff | Done | `tracker/src/tracker.ts` | DataGoat writes `_dg_*` and reads both; parameters stripped with `history.replaceState` |
| Subdomain tracking (cookie on `.data-domain`) | Done | `tracker/src/tracker.ts` | |
| `data-api-url` (relative or absolute) | Done | `tracker/src/tracker.ts` | |
| `data-allow-localhost`, `data-allow-file-protocol` | Done | `tracker/src/tracker.ts` | |
| `data-debug`, `data-disable-console` | Done | `tracker/src/tracker.ts` | |
| `data-disable-payments` (fix duplicate payments) | Done | `tracker/src/tracker.ts` | |
| Cookies `datafast_visitor_id` (1 year), `datafast_session_id` (30 min), first-seen and session count | Done | `tracker/src/tracker.ts`, `docs/tracking.md` | DataGoat writes `datagoat_*` cookies and reads `datafast_*` too, so DataFast visitors keep their ids; `data-compat="datafast"` also writes the `datafast_*` cookies |
| SPA navigation (`pushState`/`popstate`, 100 ms debounce) and 60 s same-URL throttle | Done | `tracker/src/tracker.ts` (`pageview`) | throttle state in sessionStorage |
| Hash routing build `script.hash.js` | Done | `tracker/build.mjs` | |
| Cookieless build `script.cookieless.js` with a daily rotating salt | Done | `src/ingest/salts.ts`, `src/ingest/identity.ts` | salts are random per day and deleted after two days |
| Goals `window.datafast("name", {…})`, name rules, ≤ 10 parameters | Done | `tracker/src/validate.ts`, `src/ingest/events.ts` | `window.datafast` is an alias of `window.datagoat`; parameter names up to 64 characters (DataFast's docs; its script stops at 32) |
| Queue snippet: goals before the script loads | Done | `tracker/src/tracker.ts` | `window.datagoat` alias |
| `data-fast-goal` and `data-fast-goal-*` (click, form) | Done | `tracker/src/tracker.ts` | Enter and Space too |
| `data-fast-scroll`, `-threshold`, `-delay`, `-*` | Done | `tracker/src/tracker.ts` | |
| `identify` with shallow-merged profile | Done | `src/ingest/events.ts` | |
| Outbound link clicks (`external_link` `{url, text}`) | Done | `tracker/src/tracker.ts`, `/api/v1/analytics/exit-clicks` | |
| Success-page payments: Stripe `?session_id=cs_…`, Polar `?checkout_id=`, Lemon Squeezy `?order_id=` | Done | `tracker/src/tracker.ts`, `src/providers/hints.ts` | end-to-end test `test/worker/cross-team/payment-attribution.test.ts` (finisher); Paddle `?transaction_id=` added |
| `datafast("payment", {email})` fallback | Done | `src/ingest/events.ts`, `attributeByEmail()` | cross-team test (finisher) |
| Ad click ids (`gclid`, `fbclid`, `msclkid`, `ttclid`, …) | Done | `tracker/src/tracker.ts`, `src/ingest/body.ts`, `src/ingest/channels.ts` | |
| UTM, `ref`, `source`, `via` parsed server-side | Done | `src/ingest/enrich.ts` | |
| Channel grouping (Organic/Paid Search, Organic/Paid Social, AI, Email, Newsletter, Affiliate, Referral, Direct…) | Done | `src/ingest/channels.ts` | |
| Client and server bot filtering | Done | `tracker/src/tracker.ts`, `src/ingest/bots.ts` | counted per reason in `bot_daily` |
| Location from the request (country, region, city, coordinates) | Done | `src/ingest/geo.ts` | Cloudflare's `request.cf`, no third-party lookup |
| Device, browser, OS from the user agent | Done | `src/ingest/ua.ts` | Mobile Safari merged into Safari in breakdowns |
| Exclude IPs (and CIDRs) | Done | `src/ingest/exclusions.ts`, Settings → Exclusions | "Add my current IP" button |
| Exclude paths with `*` wildcards | Done | `src/ingest/exclusions.ts` | |
| Exclude countries | Done | `src/ingest/exclusions.ts` | names or codes |
| Exclude hostnames | Done | `src/ingest/exclusions.ts` | |
| Exclude your own visits (`localStorage.datafast_ignore`) | Done | `tracker/src/tracker.ts` | DataGoat's key is `datagoat_ignore`; both are respected; console commands shown in Settings |
| DataFast's own unmodified script can send to DataGoat | Done | `test/fixtures/datafast/captured.ts`, `test/worker/ingest/protocol.test.ts` | captured request bodies |
| Content-Security-Policy guidance | Done | `docs/tracking.md#content-security-policy` | |
| npm package (`datafast` → `@datagoat/sdk`) for browser, React, Next.js and server | Done | `packages/sdk` | |

## Dashboard

| DataFast feature | Status | Where | Notes |
| --- | --- | --- | --- |
| All-websites dashboard with last 24 hours / 7 days / 30 days | Done | `dashboard/src/pages/account/WebsitesPage.tsx` | finisher: visitors, revenue, live visitors and a trend per website |
| Reorder websites (drag and drop) | Done | `PUT /api/v1/admin/account/website-order`, migration `0900` | finisher: drag or Move buttons; saved per user, used by the switcher |
| KPI row: visitors (new / returning), revenue, conversion rate, revenue per visitor, bounce rate, session time | Done | `dashboard/src/analytics/components/KpiRow.tsx` | plus payments, sessions, pageviews |
| "Visitors now" tile opening the live map (`M`) | Done | `KpiRow.tsx`, `OverviewDashboard.tsx` | |
| Main chart: visitors line and revenue bars | Done | `dashboard/src/analytics/components/MainChart.tsx` | |
| Granularity hourly / daily / weekly / monthly | Done | `MainChart.tsx`, `/api/v1/analytics/timeseries` | |
| Previous period comparison (dashed line, faded bars, previous values under KPIs) | Done | `OverviewDashboard.tsx`, `compare=previous` | |
| Metric trend charts (conversion rate, revenue/visitor, bounce rate, session time) | Done | `MainChart.tsx` | |
| New vs returning visitors chart | Done | `MainChart.tsx` | |
| Pageviews chart and pageviews heatmap | Done | `dashboard/src/analytics/components/ActivityHeatmap.tsx`, `/api/v1/analytics/heatmap` | |
| Refunds greyed out on revenue bars | Done | `MainChart.tsx`, timeseries field `refunds` | finisher |
| MRR as the headline revenue metric | Done | `GET /api/v1/analytics/revenue/mrr`, `KpiRow.tsx` | finisher: `revenueMetric: "mrr"` now changes the overview |
| Notes pinned to the chart | Done | `MainChart.tsx`, `/api/v1/admin/websites/:id/notes` | |
| Click a point to drill down into that day/week/month | Done | `MainChart.tsx` | |
| Sticky tooltips (click to keep a point's numbers, for screenshots) | Done | `MainChart.tsx` | finisher: the numbers stay next to the point's actions |
| GitHub commits and 𝕏 mentions on the chart | Done | `OverviewDashboard.tsx` | |
| Filter commits by type (`feat:`, `fix:`) | Done | `OverviewDashboard.tsx`, `/api/v1/github/commits?q=` | finisher |
| Period selector: today, yesterday, last 24 h, 7 d, 30 d, more periods (3 / 6 / 12 months …), custom range | Done | `dashboard/src/analytics/components/PeriodSelector.tsx` | |
| "Now" period (last 30 minutes, refreshes every minute) | Done | `PeriodSelector.tsx`, `interval=minute` | |
| Pin favourite periods per website | Partial | `PeriodSelector.tsx` | pins are kept per website **in this browser** (localStorage), so they do not follow you to another device or browser |
| Date hopping arrows | Done | `PeriodSelector.tsx` | |
| Keyboard shortcuts T, Y, D, W, 3, N, M | Done | `dashboard/src/analytics/lib/period.ts` | finisher: D and 3 now mean last 24 hours and last 30 days as in DataFast |
| Refresh button | Done | `OverviewDashboard.tsx` | |
| Source card: channel, referrer, UTM campaign (source, medium, campaign, term, content), `ref`/`source`/`via` | Done | `dashboard/src/analytics/cards.tsx` | |
| Channel pie chart with drill-down into its sources | Done | `BreakdownCard.tsx` (`ShareDonut`) | finisher: donut, and a click switches to the channel's referrers |
| Keyword tab (Google Search Console) with revenue estimates in the Source card | Done | `cards.tsx` (`keywordTab`), `/api/v1/search-console` | finisher; narrowed by a page filter |
| Campaign-level ad spend in the Source card and ROAS in the main dashboard | Done | `cards.tsx` (`adsTab`), `KpiRow.tsx`, `/api/v1/ads/*` | finisher |
| Pages card: page, entry page (with revenue), exit links | Done | `cards.tsx` | plus exit page and hostname |
| Location card: map, country, region, city | Done | `cards.tsx`, `WorldMap.tsx` | |
| System card: browser, OS, device | Done | `cards.tsx` | |
| Every row shows visitors, revenue and payments; click to filter | Done | `BreakdownCard.tsx` | |
| Details: full list with search and sort by name / revenue / traffic | Done | `BreakdownCard.tsx` | finisher: sorting |
| Advanced filters: is / is not / contains / does not contain, combined | Done | `dashboard/src/analytics/components/FilterBar.tsx`, `src/lib/filters.ts` | |
| Channel filter | Done | `FilterBar.tsx`, `filter_channel` | |
| Visit count filter (at least / at most / is / is not) | Done | `filter_visit_count` | |
| Goal filter | Done | `filter_goal` | |
| Segments (saved filter sets) | Done | `/api/v1/admin/websites/:id/segments`, `FilterBar.tsx` | saved server-side per website |
| #1 KPI (revenue or a goal) across breakdowns | Done | `KpiRow.tsx`, `BreakdownCard.tsx` | |
| KPI colour schemes | Done | Settings → General, `dashboard/src/analytics/lib/colors.ts` | |
| Real-time map: 3D globe and 2D map | Done | `dashboard/src/pages/analytics/RealtimePage.tsx`, `Globe.tsx`, `WorldMap.tsx` | |
| Map styles Outdoors, Dark, Light, Satellite | Partial | `dashboard/src/analytics/lib/mapStyles.ts` | the maps are drawn locally from Natural Earth shapes, so "Satellite" is a colour style, not imagery (no third-party map tiles by design) |
| Globe replay (last 8 hours, 15-minute steps) | Done | `RealtimePage.tsx`, `/api/v1/analytics/realtime/replay` | |
| Globe filters (country, device, browser) | Done | `RealtimePage.tsx` | |
| Event log; click an event to highlight the visitor, click a visitor to filter events | Done | `RealtimePage.tsx` | |
| Visitor details on the map (device, browser, location, page, session, visit count), top referrers, avatars | Done | `RealtimePage.tsx` | |
| Light mode, full screen, auto-rotation | Done | `RealtimePage.tsx` | |
| Purchase-likelihood colours and expected value (after 1,000 visitors and 10 attributed payments) | Done | `src/query/jobs/predictions.ts`, `src/query/prediction.ts` | |
| Visitor profile: journey from first visit to purchase, identity, prediction | Done | `dashboard/src/pages/analytics/VisitorProfilePage.tsx`, `/api/v1/visitors/:id` | |
| Journey shows each day's referrer | Done | `VisitorProfilePage.tsx` | |
| Keyword probability in journeys for Google visitors | Done | `src/query/visitors.ts` (`googleKeywords`) | finisher: Search Console queries for the landing page, by share of clicks |
| GitHub-style visitor activity grid | Done | `VisitorProfilePage.tsx` | |
| Web-to-app journeys (same `user_id` on web and app) | Done | `src/query/visitors.ts` | |
| Website nicknames, account rename | Done | Settings → General, `PUT /api/v1/admin/account` | |
| Phone-sized dashboard | Done | Playwright 390 px tests | every page fits without horizontal scrolling |

## Revenue

| DataFast feature | Status | Where | Notes |
| --- | --- | --- | --- |
| Stripe: connect with a restricted key (secret, publishable and test keys rejected) | Done (untested against the real service) | `src/providers/adapters/stripe.ts`, `POST …/integrations/stripe` | |
| Stripe: Checkout metadata `datafast_visitor_id` / `datafast_session_id` | Done (untested against the real service) | `stripe.ts`, `src/providers/attribution.ts` | `datagoat_visitor_id` / `datagoat_session_id` are the documented names |
| Stripe: PaymentIntent API metadata | Done (untested against the real service) | `stripe.ts` | |
| Stripe: Payment Links via the success page | Done (untested against the real service) | `src/providers/jobs.ts` (`providers.resolve-hints`) | resolution tested end to end with a mocked Stripe API (finisher) |
| Stripe: backfill, renewals (invoices), refunds and disputes, events polling with optional webhooks | Done (untested against the real service) | `stripe.ts`, `providers.sync` | |
| Lemon Squeezy: API key + store, auto-created webhook, checkout custom data, Payment Links `?order_id=` | Done (untested against the real service) | `src/providers/adapters/lemonsqueezy.ts` | |
| Polar: access token + org, checkout metadata, Checkout Links `?checkout_id=` | Done (untested against the real service) | `src/providers/adapters/polar.ts` | sandbox too |
| Paddle: API key, checkout `customData`, overlay checkout, re-sync, key expiry | Done (untested against the real service) | `src/providers/adapters/paddle.ts` | |
| Dodo Payments | Done (untested against the real service) | `src/providers/adapters/dodo.ts` | native adapter; the Payments API route DataFast documents works too |
| Shopify orders and refunds | Done (untested against the real service) | `src/providers/adapters/shopify.ts`, `src/ecosystem/shopify.ts` | |
| Easytool (also an install guide) | Partial | `docs/install/easytool.md` | Easytool's built-in integration posts only to DataFast; with DataGoat, send sales to the Payments API from an Easytool webhook or automation tool |
| Email matching (`payment {email}` or identify, either order) | Done | `src/providers/hints.ts`, `src/providers/engine.ts` | cross-team test (finisher) |
| `POST /api/v1/payments` (payments, renewals, refunds, free trials, idempotent `transaction_id`) | Done | `src/providers/payments-api.ts` | |
| `DELETE /api/v1/payments` by transaction, visitor or range | Done | `payments-api.ts` | |
| Payment-provider goals `payment`, `free_trial` and the subscription lifecycle set | Done | `src/providers/lifecycle.ts` | |
| Renewal revenue, "Include renewal revenue" toggle | Done | `src/lib/metrics.ts`, Settings → Attribution & revenue | |
| Refunds view | Done | Revenue page, chart (finisher) | |
| Website currency (any ISO currency) with conversion | Done | `src/lib/money.ts`, `src/providers/fx.ts` | ECB daily rates (fetch tested with a mocked ECB feed) |
| Integrations status, re-sync and disconnect API | Done | `src/providers/integrations-api.ts` | |
| Revenue on every breakdown row, attributed by session | Done | `src/query/breakdowns.ts`, `src/lib/metrics.ts` | |
| Revenue per channel/page/country in the dashboard | Done | `RevenuePage.tsx` | |
| Current MRR | Done | `GET /api/v1/analytics/revenue/mrr` | finisher; active and past-due subscriptions at the latest rate |
| "Unattributed" revenue bucket | Done | `/api/v1/analytics/revenue/sources` | |
| Duplicate payment protection (link + server attribution) | Done | `src/providers/engine.ts` (unique provider txn), `data-disable-payments` | |
| Revenue prediction | Done | see Dashboard | |
| Re-upload a key to refresh old renewals | Done | PATCH `…/integrations/<provider>` (re-sync) | |

## Goals and funnels

| DataFast feature | Status | Where | Notes |
| --- | --- | --- | --- |
| Client goals (JS, HTML attributes, scroll) | Done | see Tracking | |
| Server-side goals `POST /api/v1/goals` (404 without pageviews) | Done | `src/api/v1/ingest-api/index.ts` | |
| Delete goals `DELETE /api/v1/goals` | Done | `ingest-api/index.ts` | |
| Goal parameters in journeys | Done | `VisitorProfilePage.tsx` | |
| Goal custom properties breakdown (API and dashboard) | Done | `/api/v1/analytics/goals/properties`, `GoalsPage.tsx` | |
| Goals over time, colours, display names, hide noisy goals, descriptions | Done | `GoalsPage.tsx`, `…/goals/customizations` | |
| Goal quick actions: journeys, create funnel, filter, set as KPI | Done | `GoalsPage.tsx` | |
| Tracked goals list | Done | `GET …/websites/:id/goals` | |
| Goal completion rate (share of unique visitors) | Done | `/api/v1/analytics/goals` (`conversion_rate`) | |
| Journey tab: visitors who completed a goal | Done | Visitors page `completedGoal` | |
| Funnels of 2–8 steps, page visits or goals | Done | `FunnelBuilder.tsx`, `src/api/v1/admin/funnels.ts` | |
| Reorder funnel steps | Done | `FunnelBuilder.tsx` | Move up/down buttons instead of drag (keyboard accessible) |
| Wildcard funnel paths (`/blog/*`) | Done | `src/query/funnels.ts` | plus equals / contains / starts / ends / not |
| Funnel results: conversion, drop-off, revenue per step; hover details | Done | `FunnelDetailPage.tsx`, `FunnelChart.tsx` | the per-step numbers are shown inline rather than in pinned tooltips |
| Funnel results API `/api/v1/analytics/funnels/:id` | Done | `src/query/funnels.ts` | |
| Funnels and goals from the CLI and MCP | Done | `cli/src/commands/resources.ts`, `src/mcp/tools/resources.ts` | |

## API

Every DataFast endpoint was called on the running Worker with demo data and answered as documented
(a scripted probe of 81 requests; every status was the documented one).

| DataFast feature | Status | Where | Notes |
| --- | --- | --- | --- |
| `df_` website keys and `dft_` account tokens with DataFast's permission names | Done | `src/auth/credentials.ts`, `shared/permissions.ts` | new keys are `dg_` / `dgt_`; `df_` / `dft_` keys keep working |
| 60 requests per minute with `X-RateLimit-*` headers | Done | `src/auth/rate-limit.ts` | Workers Rate Limiting binding (no KV writes) |
| Account: retrieve / update | Done | `src/api/v1/account/tokens.ts` | |
| Access tokens: list / create / delete | Done | `tokens.ts` | |
| Websites: list / create / retrieve / update / delete (dashboard only) | Done | `src/api/v1/account/websites.ts` | |
| Website keys: list / create / roll / delete | Done | `websites.ts` | |
| Team: list / invite / remove | Done | `websites.ts` | |
| Alerts: list / create / update / delete / history | Done | `src/growth/alerts/routes.ts` | |
| Funnels: list / create / update / delete | Done | `src/api/v1/admin/funnels.ts` | |
| Goal customizations: list / update / delete; tracked goals | Done | `src/api/v1/admin/goals.ts` | |
| Notes: list / create / update / delete | Done | `src/api/v1/admin/notes.ts` | |
| Integrations: status; Stripe / Lemon Squeezy / Polar / Paddle connect; disconnect (incl. Shopify, WooCommerce); Paddle re-sync | Done | `src/providers/integrations-api.ts` | |
| Analytics: overview, timeseries, metadata, realtime, realtime map, funnel results | Done | `src/api/v1/analytics/handlers.ts` | |
| Breakdowns: pages, referrers, countries, regions, cities, devices, browsers, operating systems, campaigns, exit clicks, hostnames | Done | `src/query/breakdowns.ts` | |
| Goals analyze and goal properties | Done | `src/query/event-breakdowns.ts` | |
| Identify | Done | `src/api/v1/ingest-api/index.ts` | |
| Visitors: list / retrieve | Done | `src/api/v1/visitors/index.ts`, `src/query/visitors.ts` | |
| Payments: create / delete | Done | `src/providers/payments-api.ts` | |
| Mentions list | Done | `src/growth/mentions/routes.ts` | |
| Bot traffic: summary, pages, settings, token, usage | Done | `src/growth/bots/routes.ts` | |
| API playground | Done | `dashboard/src/pages/settings/ApiPlaygroundPage.tsx` | finisher: send any analytics GET with the session, copy the curl |
| llms.txt and Markdown docs | Done | `static/llms.txt`, `docs/` | finisher: `/llms.txt` |
| "Apps built on the API" (DataFast's demo apps) | Not done | – | these are DataFast's own showcase apps, not a product feature; the API they use is compatible |

## MCP and CLI

| DataFast feature | Status | Where | Notes |
| --- | --- | --- | --- |
| Streamable HTTP MCP server at `/api/mcp` | Done | `src/mcp/server.ts` | also `/mcp` |
| DataFast's tool catalog (63 tools; `datafast_*` names accepted) | Done | `src/mcp/tools/` | 72 tools on the running Worker |
| Confirmation for data-changing tools | Done | `src/mcp/executor.ts` | dry run unless `confirm: true`, idempotency keys |
| Website deletion and payment connections stay dashboard-only | Done | `src/mcp/tools/resources.ts` | |
| OAuth for MCP clients (Claude, ChatGPT, Cursor, Codex) | Done | `src/mcp/oauth/` | |
| Connected apps: list and revoke | Done | `/api/v1/admin/oauth/connections`, Account page | |
| ChatGPT app with interactive traffic, revenue, breakdown, funnel and realtime map widgets | Done (untested against the real service) | `src/mcp/widgets.ts` | finisher: MCP Apps and OpenAI Apps SDK resources; drawing tested in a browser, not inside ChatGPT |
| CLI login with a token, `whoami`, `config`, `--json` | Done | `cli/src/commands/account.ts` | npm package `datagoat` |
| CLI analytics with dashboard filters and periods | Done | `cli/src/commands/analytics.ts` | |
| CLI visitors list / get | Done | `cli/src/commands/resources.ts` | |
| CLI websites, KPI, API keys, team | Done | `cli/src/commands/sites.ts` | |
| CLI tokens, alerts, goals | Done | `cli/src/commands/` | |
| CLI funnels (list, create, update, delete, view with conversion and revenue) | Done | `cli/src/commands/resources.ts` | |
| CLI shell completion (bash, zsh, fish) | Done | `cli/src/commands/completion.ts` | |

## Growth

| DataFast feature | Status | Where | Notes |
| --- | --- | --- | --- |
| Email alerts for goals, payments and free trials with visitor details in the message | Done (untested against the real service) | `src/growth/alerts/`, `src/growth/delivery/email.ts` | Resend or Postmark; delivery tested with mocked providers |
| Up to 25 alerts per website, alert history | Done | `src/growth/alerts/routes.ts` | |
| Weekly email report (Monday) | Done (untested against the real service) | `src/growth/alerts/digest.ts` | |
| "Insight to grow your startup" in the weekly report | Done | `insightsFor()` in `digest.ts` | finisher |
| Viral traffic alerts | Done | `src/growth/alerts/spike.ts` | |
| Attack mode with auto-enable on traffic spikes | Done | `src/growth/attack/attack-mode.ts` | |
| 𝕏 mentions on the chart | Done (untested against the real service) | `src/growth/mentions/` | X API v2 search |
| Reddit mentions | Done (untested against the real service) | `src/growth/mentions/providers.ts` | |
| 𝕏 link attribution (tweets instead of `t.co`) | Done (untested against the real service) | `x_links`, `/api/v1/x/links` | |
| Mentions API and MCP | Done | `/api/v1/mentions`, `mentions_list` | |
| GitHub commits on the chart | Done (untested against the real service) | `src/growth/commits/github.ts` | finisher: the Integrations card now connects with a repository and an optional token, shows the push webhook secret |
| Google Search Console: keywords, clicks, impressions, CTR, position, estimated revenue | Done (untested against the real service) | `src/growth/gsc/` | |
| Search Console property selected automatically | Done | `autoSelectProperty()` | |
| Keyword filtering by page | Done | `filter_page` | |
| Meta Ads: spend, campaigns, ROAS | Done (untested against the real service) | `src/growth/meta/` | finisher: a pasted system-user token works without Facebook OAuth |
| Bot traffic: server-side tracking (`@ai-crawl` middleware and direct `POST /api/ai-crawls`) | Done | `packages/ai-crawl`, `src/growth/bots/ingest.ts` | |
| Bot categories (AI answers, indexing, training) and verification confidence | Done | `src/growth/bots/catalog.ts`, `ip-ranges.ts` | published IP ranges refreshed daily |
| Bot traffic by page, wildcard page search (`/blog/*`) | Done | `BotTrafficPage.tsx`, `/api/v1/analytics/bot-traffic/pages` | |
| Discovery files (`robots.txt`, `llms.txt`, sitemaps) kept visible | Done | `packages/ai-crawl` | |
| Bot settings (verified only, companies, crawlers, hidden card) | Done | `src/growth/bots/settings.ts` | |
| Optional request-authentication token | Done | `…/bot-traffic/token` | |
| Accepted-request allowance and usage card | Done | `src/growth/bots/usage.ts` | counted only when `BOT_TRAFFIC_ALLOWANCE` is set; there is no billing |
| Bot traffic in the API and MCP | Done | `bot_traffic_*` tools | |
| Crawler directory | Done | Bot traffic settings (`crawlerCatalog`) | shown in the dashboard, not as a public marketing page |
| Plausible import | Done | `src/growth/imports/` | CSV zip parsed in the browser or the Worker |

## Team and sharing

| DataFast feature | Status | Where | Notes |
| --- | --- | --- | --- |
| Invite team members by email | Done | `TeamPage.tsx`, `POST …/team` | the invite link is always shown; emailed when email is configured |
| Roles: viewer, member (all but team and deletion), owner | Done | `shared/permissions.ts` | matches DataFast's role matrix |
| Remove members | Done | `DELETE …/team` | |
| Public dashboard URL | Done | `/share/:token`, `SharedDashboardPage.tsx` | |
| Public dashboard with the real-time visitor map | Done | `SharedDashboardPage.tsx` | finisher: Live map view without names or journeys |
| Public revenue on or off | Done | Share page | |
| Widgets (embed your numbers anywhere; size, colours, theme) | Done | `dashboard/src/pages/public/WidgetPage.tsx`, `/share/:token/widget` | finisher: visitors, revenue, visitors online, chart |
| Forgot password | Done | `/forgot-password`, `POST /api/auth/password-resets` | finisher; needs an email provider, otherwise `npm run reset-password` |
| Sign out | Done | top bar | |
| Account page | Done | `AccountPage.tsx` | |
| Connected AI apps on the account page | Done | `AccountPage.tsx` | |

## Privacy

| DataFast feature | Status | Where | Notes |
| --- | --- | --- | --- |
| Cookieless mode (no visitor cookies, daily rotating hash) | Done | `src/ingest/identity.ts`, `salts.ts` | |
| Cookieless limits (journeys unavailable) | Done | `TrackingSettingsPage.tsx` explains them | |
| GDPR guidance | Done | `docs/tracking.md` | |
| No IP addresses stored | Done | `src/ingest/` | IPs are only used for exclusions, geo (Cloudflare) and the cookieless hash |
| Customer names and emails only for keys with PII access | Done | `includePii` on keys and tokens | |
| Exclusions (IPs, paths, countries, hostnames, own visits) | Done | see Tracking | |
| Data stays in the operator's account | Done | Cloudflare D1 in your account | DataFast's DPA lists US subprocessors |
| Reduce usage by excluding traffic | Done | Settings → Exclusions, Usage page | |
| Data deletion with the website | Done | `sites.purge` job | |
| Delete payments / goals via API | Done | see API | |
| "Pause tracking at limit" | Not done | – | not applicable: DataGoat has no event quota or billing; the Usage page shows Cloudflare's limits instead |

## Install and ecosystem

| DataFast feature | Status | Where | Notes |
| --- | --- | --- | --- |
| Install guides (Astro, Bolt, Bubble, Django, Framer, Ghost, GTM, Kajabi, Laravel, Lovable, Next.js, Podia, React Router, Replit, Squarespace, Vercel v0, Vue, Webflow, Wix) | Done | `docs/install/` | one guide per DataFast page |
| Attribution guides for AI site builders (Bolt, Ghost, Kajabi, Lovable, Podia, Replit, v0) | Done | `docs/install/<builder>.md` | |
| Proxy guides (Astro, Caddy, DigitalOcean, Express, FastAPI, Firebase, Flask, Laravel, Next.js, Nginx, PHP, Vue) | Done | `docs/install/proxy-*.md` | plus Vercel, Netlify, Django |
| Managed proxy (first-party subdomain) | Done | `docs/install/custom-domain.md`, `cloudflare-route.md` | your own Worker on your own domain, no CNAME service needed |
| Onboarding with live install verification | Done | `InstallPage.tsx` | |
| npm package | Done | `packages/sdk` | |
| React Native SDK (provider, hooks, Expo) | Done | `packages/react-native` | |
| Web-to-app funnels | Done | `docs/install/web-to-app.md` | |
| WordPress plugin | Done (untested against the real service) | `packages/wordpress` | `php -l` and behaviour tests with the PHP CLI (`npm run test:ecosystem`), not a live WordPress |
| WooCommerce connect and order revenue | Done (untested against the real service) | `src/ecosystem/woocommerce.ts` | |
| Shopify app: tracking without a script tag, `add_to_cart` / `initiate_checkout` / `payment` goals, order revenue | Done (untested against the real service) | `src/ecosystem/shopify.ts`, `shopify-pixel.ts` | |
| Google Tag Manager | Done | `docs/install/google-tag-manager.md` | |
| Switching from DataFast | Done | `docs/switching-from-datafast.md` | |
| Server-side crawler middleware | Done | `packages/ai-crawl` | |
| CSP fix guide | Done | `docs/tracking.md` | |
| Plausible import | Done | see Growth | |

## Mobile

| DataFast feature | Status | Where | Notes |
| --- | --- | --- | --- |
| iOS and Android app with all dashboard metrics (visitors, revenue, sources, geography, devices, goals, pages) | Done | `apps/mobile` | Expo app; logic unit-tested, not run on a device here |
| Website list | Done | `apps/mobile/app/sites.tsx` | |
| Period picker and chart | Done | `apps/mobile/app/site/[id].tsx` | |
| Live visitors | Done | `apps/mobile` | |
| Push notifications for sales and alerts | Done (untested against the real service) | `src/ecosystem/push.ts` | Expo push API mocked |
| Sign in with email and a 6-digit code | Partial | `POST /api/v1/mobile/session` | signs in with email and password: many installs have no email provider |
| No API key needed to sign in | Done | mobile session token | |
| Real-time 3D map in the app | Not done | – | needs a native map/WebGL view and device testing; out of scope without native tooling |
| iOS home-screen widgets | Not done | `apps/mobile/src/lib/widget.ts` | the app stores the widget data; the native WidgetKit extension needs Xcode |

## Not done, and why

1. **Apps built on the API**: DataFast's own showcase apps, not a product feature; the API is compatible.
2. **Pause tracking at limit**: not applicable without an event quota or billing.
3. **Real-time 3D map in the mobile app**: needs native map or WebGL modules and device testing.
4. **iOS home-screen widgets**: the native WidgetKit extension cannot be built or tested without Xcode;
   the app already writes the widget data.

Partial rows that stay partial: pinned periods are per browser; "Satellite" is a colour style
because maps are drawn locally; Easytool's integration is operated by Easytool for DataFast only;
mobile sign-in uses a password instead of an emailed code.

## DataGoat-only extras

- Runs entirely in your Cloudflare account (Workers + D1) within the Free plan's limits; MIT licence.
- Three attribution models (first touch, last touch, last non-direct) and revenue by any source
  (`/api/v1/analytics/revenue/sources`), lifetime value by first channel and path to purchase.
- More payment providers: Creem, WooCommerce through the REST API, Shopify through a custom app.
- Consent mode (`data-require-consent`), Global Privacy Control, user-agent exclusions,
  configurable data retention, an engagement beacon (active time, scroll depth), `sendBeacon`
  delivery and `SameSite`/`Secure` cookies.
- Alerts by Telegram and signed webhooks, daily digests, mobile push, a test send.
- Entry-page, exit-page, hostname and channel breakdowns in the API; minute buckets; a pageview
  heatmap; previous-period compare on the API; Cache API caching for closed ranges.
- Team role changes and pending invites; sign out everywhere.
- A usage page against Cloudflare's limits; first-run setup link; demo data (`npm run seed:demo`).
- `ref`/`source`/`via` campaign dimensions, segments shared by the team, 390 px layouts and WCAG AA
  contrast in both themes.
