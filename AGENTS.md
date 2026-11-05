# AGENTS.md

Guidance for AI coding agents working in this repository. Humans: see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## What DataGoat is

Open-source, revenue-first web analytics that runs in the operator's own Cloudflare account: one Worker, one D1 database, static assets for the dashboard and tracker, and a cron. It is drop-in compatible with DataFast's tracking script, cookies (with `data-compat="datafast"`), `window.datafast()` API and payment metadata; DataGoat's own names are the defaults. [`docs/PARITY.md`](docs/PARITY.md) tracks every DataFast feature.

## Read before changing code

| Document | What it tells you |
| --- | --- |
| [`docs/CONTRACTS.md`](docs/CONTRACTS.md) | Module ownership, shared registration points, how to add a route, job, migration or page, migration number ranges, Free-plan rules, checks |
| [`docs/api/contract.md`](docs/api/contract.md) | Every HTTP endpoint, its auth, parameters and response shape |
| [`docs/architecture/data-model.md`](docs/architecture/data-model.md) | Every D1 table and index, and which module writes it |
| [`docs/architecture/jobs.md`](docs/architecture/jobs.md) | Cron jobs and their schedules |
| [`docs/development.md`](docs/development.md) | Local setup and demo data |

If you change a contract, update the document in the same commit.

## Layout

| Path | Contents |
| --- | --- |
| `src/` | The Worker (Hono): `ingest/`, `query/`, `api/v1/`, `providers/` (payments), `growth/`, `mcp/`, `ecosystem/`, `auth/`, `setup/`, `lib/`, `jobs/` |
| `tracker/` | The tracking script, built into `public/js/script*.js` |
| `dashboard/` | The React dashboard (Vite, TanStack Router and Query, Tailwind), with an MSW mock API in `dashboard/src/mocks/` |
| `shared/api-types.ts` | Request and response types shared by the Worker, dashboard and CLI |
| `migrations/` | D1 migrations, applied by Wrangler and by the Worker itself on first use |
| `static/` | Files copied into `public/` at build time: headers, favicons, brand assets |
| `cli/`, `packages/`, `apps/mobile` | CLI, SDKs and plugins, mobile app |
| `test/` | Worker tests (`test/worker/`) and Playwright tests (`test/e2e/`) |

## Commands

```bash
npm ci
```

```bash
npm run check
```

`check` runs lint, typecheck, every unit suite, the build, size budgets and end-to-end tests. A change is done only when it passes. Other useful commands: `npm test` (Worker), `npm run test:dashboard`, `npm run test:tracker`, `npm run dev`, `npm run dev:mock` (dashboard against the mock API), `npm run seed:demo` (realistic local data), `npm run gen:migrations` (after adding a migration).

When several Playwright runs share a machine, set `E2E_MOCK_PORT` and `E2E_WORKER_PORT` to unused ports.

## Rules

1. **Original code only.** Use DataFast's public docs to understand behaviour and wire formats. Never copy DataFast's source, markup, styles or copy. Never read or use code from DataBull (databull.app): its licence forbids it.
2. **Cloudflare Free-plan budget is a hard constraint.**
   - No KV writes on per-event or per-request paths. KV is for login throttling only.
   - D1 bills one written row per table row plus one per index touched. Add an index only when a real query needs it, and check the query plan.
   - At most 50 D1 queries per Worker invocation; batch writes with `db.batch()`.
   - Cron jobs write only rows that changed and do the work in SQL.
   - The write-budget and read-budget tests encode these limits. If a change alters a budget, update the test and explain why in the commit.
3. **Migrations:** never edit a migration that has shipped. Add a new file in your area's number range, then run `npm run gen:migrations`.
4. **Compatibility:** keep DataFast's tracker attributes, the `window.datafast()` alias, reading of `datafast_*` cookies and `datafast_visitor_id` metadata, the `data-compat="datafast"` mode, legacy key prefixes (`df_`, `dft_`, `dfbot_`) and API field names working. DataGoat's own names (`datagoat_*`, `window.datagoat()`, `dg_`/`dgt_`/`dgbot_`, `dgid_`) are the defaults.
5. **Tests:** every behaviour change needs a test. Dashboard pages need a component test and, for flows, a Playwright test against the mock API. Test outside services with mocked `fetch`; never call real third-party APIs in tests.
6. **Secrets:** never commit secrets or real credentials. `.dev.vars.example` holds placeholders only.
7. **Commits:** small and coherent, with a message that says what changed and why. Do not add `Co-Authored-By` or other AI attribution trailers to commit messages.
