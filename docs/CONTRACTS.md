# Team contracts

How eight teams build DataGoat in parallel without colliding. Read this with
[`docs/api/contract.md`](api/contract.md) (HTTP API), [`docs/architecture/data-model.md`](architecture/data-model.md)
(tables) and the plan. If you must change a contract, change the document in the same commit and
say so in your report.

## 1. Ownership

| Team | Area                        | Code it owns                                                                                                                                                                                                                                                                    | Dashboard pages                                                                                                         | Migrations |
| ---- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------- |
| F0   | Foundation                  | `src/lib/`, `src/auth/`, `src/setup/`, `src/api/v1/account/`, `src/jobs/{registry,scheduler,maintenance}.ts`, `src/app.ts`, `src/routes.ts`, `shared/`, test harness, build scripts, dashboard shell (router, layout, API client, mocks infrastructure, auth screens, new-site) | `auth/*`, `account/NewSitePage`                                                                                         | 0001       |
| W1   | Tracker & ingest            | `tracker/`, `src/ingest/` (`/api/events`, channels, UA, geo, bots, identity, cookieless salts, consent)                                                                                                                                                                         | –                                                                                                                       | 0100–0199  |
| W2   | Analytics API & query layer | `src/query/`, `src/api/v1/{analytics,visitors,ingest-api,admin,public}/` (rollups, retention, predictions, funnels, goals, notes, segments, share links, usage, alert rules CRUD + history; W6 evaluates and delivers alerts and owns the test send)                                                                                                                 | –                                                                                                                       | 0200–0299  |
| W3   | Revenue                     | `src/providers/` (adapters, `/api/v1/payments`, webhooks, integrations, revenue analytics, FX, sync, hint resolution)                                                                                                                                                           | –                                                                                                                       | 0300–0399  |
| W4   | Dashboard: analytics        | `dashboard/src/pages/analytics/*`, `pages/public/*`, their components and hooks (`dashboard/src/analytics/`)                                                                                                                                                                                               | overview, realtime (map, globe, replay), visitors, visitor profile, goals, funnels, revenue, shared dashboard           | none       |
| W5   | Dashboard: settings & admin | `dashboard/src/pages/settings/*` (incl. `settings/InstallPage` onboarding), `pages/account/{AccountPage,NewSitePage}`, `mocks/handlers/settings.ts`                                                                                                                                                                                                                 | settings (general, installation / onboarding, tracking, exclusions, attribution, danger), add website, team, API keys, integrations, share link, usage, account | none       |
| W6   | Growth                      | `src/growth/` (alerts, digest, outbox, attack mode, bot traffic, mentions, X attribution, GitHub, Search Console, Meta Ads, Plausible import, `POST /api/auth/password-resets`), `packages/ai-crawl` (assigned to W6 by the coordinator), `dashboard/src/pages/growth/*`                                                                                                                        | bot traffic, mentions, Search Console, ads, alerts, import                                                              | 0600–0699  |
| W7   | Agents                      | `src/mcp/` (MCP server, OAuth), `cli/`, `dashboard/src/pages/oauth/*`                                                                                                                                                                                                           | OAuth consent                                                                                                           | 0700–0799  |
| W8   | Ecosystem                   | `packages/*` (browser SDK, React Native SDK, WordPress plugin, ai-crawl middleware), `apps/mobile`, `src/ecosystem/` (mobile session/devices, Shopify app, WooCommerce connect)                                                                                                 | –                                                                                                                       | 0800–0899  |

The authoritative route ownership list is the header of [`src/routes.ts`](../src/routes.ts) and the
tables in the API contract. Writes per table are listed in the data-model doc.

## 2. Shared registration points

Edit these minimally and additively (one line), so merges stay trivial.

| What                    | Where                                                                                                           | How                                                                                                                                                                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| HTTP routes             | your area's router (`src/<area>/index.ts`)                                                                      | Replace a `stubRoutes(...)` line with a real handler on the same router, using the **absolute** path. Never add `/:param` catch-alls under a shared prefix (`/webhooks/*`, `/api/v1/admin/websites/:id/integrations/*`, `/api/v1/analytics/*`): other teams own sibling paths. |
| A new router            | `src/routes.ts`                                                                                                 | One `app.route("/", yourRoutes)` line in your block.                                                                                                                                                                                                                           |
| Middleware for a prefix | `src/routes.ts`                                                                                                 | Only F0. `/api/v1/*` already runs `sameOriginGuard → authenticate → apiRateLimit`.                                                                                                                                                                                             |
| Cron jobs               | your area's `*Jobs` array (`ingestJobs`, `queryJobs`, `providerJobs`, `growthJobs`, `mcpJobs`, `ecosystemJobs`) | Append a `JobDefinition`. `src/jobs/index.ts` already includes every area.                                                                                                                                                                                                     |
| Bearer formats          | `registerBearerResolver(prefix, fn)` in `src/auth/credentials.ts`                                               | Call it from your module (W7 MCP OAuth).                                                                                                                                                                                                                                       |
| Migrations              | `migrations/NNNN_<what>.sql` in your range                                                                      | See §4.                                                                                                                                                                                                                                                                        |
| Dashboard page          | `dashboard/src/pages/<area>/<Page>.tsx`                                                                         | Replace the placeholder file's content. New page: one entry in `dashboard/src/nav.ts` + the file.                                                                                                                                                                              |
| Mock API                | `dashboard/src/mocks/handlers/{auth,analytics,growth}.ts`, fixtures in `mocks/fixtures/`                        | Add/adjust handlers for your endpoints. Fixtures are typed with `shared/api-types.ts`.                                                                                                                                                                                         |
| API types               | `shared/api-types.ts`                                                                                           | Add types for new endpoints next to their section; keep `docs/api/contract.md` in sync.                                                                                                                                                                                        |
| Permissions             | `shared/permissions.ts`                                                                                         | F0 only. Reuse DataFast permission names.                                                                                                                                                                                                                                      |
| Outbound email/Telegram/webhook | `enqueueStatement()` in `src/growth/delivery/outbox.ts` | Add the statement to your batch with a unique `dedupeKey`; W6's `outbox.deliver` job sends it with retries (email only when a provider is configured: `emailConfigured(env)`). |

## 3. How to add things

**A route.** In your router: `router.get("/api/v1/analytics/overview", requireSiteAccess("analytics:read"), async (c) => { const { site } = getAccess(c); ... return success(c, [row]); })`. Validate with `parseQuery`/`parseJsonBody`/`parsePagination`/`parseFields` (`src/lib/validate.ts`), throw `ApiError` for errors, filter with `parseFilters` + `compileFilters`, compute metrics with `src/lib/metrics.ts`, resolve ranges with `parseRange`. Delete the stub line. Add Worker tests (`test/worker/<area>/…`) using `api()` and the factories.

**A job.** `{ name: "area.job", schedule: { every: "minute" | "minutes" | "hour" | "day" | "week", … }, run: async (ctx) => { … } }`. Use `ctx.db` (budgeted), `ctx.now` (scheduled time), `ctx.state`/`ctx.setState()` for cursors, `ctx.fetch` for subrequests. Do work in SQL; write only changed rows (`ON CONFLICT DO UPDATE … WHERE` changed). Minute jobs must tolerate overlapping runs; hourly and slower jobs run once per slot. Test with `runScheduled([job], env, ctx, at)`.

**A migration.** Next free number in your range, e.g. `migrations/0101_ingest_x.sql`, then `npm run gen:migrations` and commit `src/db/migrations.generated.ts` (the Worker bundles and self-applies migrations; `npm run lint` fails when the bundle is stale). Never edit another team's migration (or 0001). Each new index on `events`, `sessions` or `visitors` changes the write budget: update `test/worker/schema-write-budget.test.ts` and justify it in the PR. Document new tables/columns in `docs/architecture/data-model.md` (your rows only). New site-scoped tables need a `site_id` column; the website purge job finds them automatically.

**A dashboard page.** Implement the default export in your page file; fetch with TanStack Query and `api`/`apiGet` from `dashboard/src/api/client.ts`; use the tokens in `styles.css` (`bg-surface`, `bg-surface-2`, `text-muted`, `border-line`, `bg-primary`/`text-primary-fg` for buttons, `text-primary-text` for primary-coloured text, `text-error-text`/`text-success-text` for status text, `text-visitors`/`text-revenue` series, chart colours `chart-1..4`; contrast is tested by `dashboard/src/test/contrast.test.ts`) and the primitives in `components/ui`. Read `websiteId` from `useParams({ strict: false })`. Pages are lazy chunks; keep heavy libraries (maps, globe) inside your page so the initial bundle stays under 150 KB gzip.

**A mock.** Add an MSW handler next to the others with a typed fixture. Run `npm run dev:mock` and sign in with `demo@datagoat.dev` / `demo-password` (`?mock-signed-in=1` skips login, `?mock-setup=1` shows setup with token `mock-setup-token`).

## 4. Migration ranges

| Range     | Team                   |
| --------- | ---------------------- |
| 0001–0099 | F0                     |
| 0100–0199 | W1                     |
| 0200–0299 | W2                     |
| 0300–0399 | W3                     |
| –         | W4, W5 (no migrations) |
| 0600–0699 | W6                     |
| 0700–0799 | W7                     |
| 0800–0899 | W8                     |

Wrangler applies migrations in filename order, so ranges also fix the order across teams.

## 5. Naming conventions

- Files: kebab-case for modules (`site-cache.ts`), PascalCase for React components/pages.
- Job names: `<area>.<job>` lowercase (`ingest.rotate-salts`).
- SQL: snake_case tables and columns; timestamps `*_at` in epoch ms; days `day` as `YYYY-MM-DD`; money `*_minor` integers; JSON in TEXT; booleans 0/1.
- API JSON: DataFast's field names where DataFast has the endpoint (often snake_case metrics and camelCase resources); camelCase for DataGoat-only resources.
- Ids: `newId()` (24 hex) for rows, `newTrackingId()` for sites, `randomToken()` for secrets. Secrets are stored hashed (`sha256Hex`) or encrypted (`encryptString` with an AAD such as `provider:<provider>:<siteId>`).
- Logs: `log.info("area.event", {fields})`; never log secrets, raw keys, IPs or emails.

## 6. Free-plan rules (hard constraints)

- No KV writes on any per-event or per-request path (KV is only for login throttling).
- One `db.batch()` per ingest event; under 50 queries per invocation (a batch counts once).
- Every index costs a written row per insert. Add one only for a real query, and update the write-budget test.
- Bound parameters ≤ 100 per statement (`chunkForParams`, `selectInChunks`, `MAX_FILTER_PARAMS`).
- Cron: 10 ms CPU; do aggregation in SQL; write only changed rows; respect `ctx.remainingQueries()`.
- Cache sites with `siteCache`; credentials and memberships are cached per isolate for 30 s.

## 7. Checks

| Command                  | What                                                                       |
| ------------------------ | -------------------------------------------------------------------------- |
| `npm run lint`           | Biome (format + lint) over the repo                                        |
| `npm run typecheck`      | `tsc` for the Worker+tests, dashboard, tracker and Node tooling            |
| `npm test`               | Worker tests in workerd with a migrated local D1 (`vitest.config.ts`)      |
| `npm run test:tracker`   | Tracker unit tests (happy-dom)                                             |
| `npm run test:dashboard` | Dashboard tests (happy-dom, Testing Library, MSW)                          |
| `npm run test:cli`       | CLI tests (Node, mock HTTP server, built-package smoke test)               |
| `npm run build`          | Dashboard + tracker into `public/` (`npm run build:cli` bundles the CLI)   |
| `npm run size`           | Tracker and dashboard initial-JS gzip budgets (`tracker/size-budget.json`) |
| `npm run e2e` | Playwright: mock dashboard + real Worker on `wrangler dev` started from an empty, unmigrated D1 (setup, sign-out, sign-in through the UI, then `npm run smoke` against it) |
| `npm run smoke -- --url <deployment>` | HTTP smoke test of any deployed instance ([deploy.md](deploy.md)) |
| `npm run check`          | All of the above, in that order (CI runs this)                             |

Worker test helpers: `resetDb()`, `meterEnv()` (write-budget meter: `m.d1.rowsWritten`, `m.d1.rowsRead`, `m.d1.queries`, `m.kv.writes`), factories (`createUser`, `createSite`, `addMember`, `createApiKey`, `sessionCookie`, `createSession`, `createEvent`, `createPayment`) and `api(path, {token | cookie, body, method})`.
