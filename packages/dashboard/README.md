# DataGoat dashboard

Static analytics dashboard SPA, served by the DataGoat Worker. Built against the
frozen `/api/v1` contract in [`design/api.md`](../../design/api.md) and the
architecture in [`design/dashboard.md`](../../design/dashboard.md).

## Stack

React 18 + TypeScript, Vite, React Router, TanStack Query, Chart.js v4,
`chartjs-adapter-date-fns`, `date-fns`, hand-written CSS tokens, native tables,
Vitest + Testing Library, and Playwright e2e.

## Development

From the repository root:

```sh
npm install
npm run dev:web        # Vite dev server on http://localhost:5173
npm run lint:web        # biome check
npm run typecheck:web   # tsc --noEmit
npm run test:web        # vitest
npm run build:web       # type-check + production build to dist/
npm run preview:web     # serve dist/ on http://localhost:4173
npm run e2e:web         # Playwright e2e against the mock API
```

## Mock API

The API is not built until milestone 4, so dev and preview run a typed mock of
`/api/v1` (see `src/mocks/`). The mock password defaults to `password`; override
it with `VITE_MOCK_PASSWORD`. The Worker serves the production build and the
real API, so the mock never runs there.

## Authentication

The SPA authenticates with the httpOnly `dg_session` cookie set by
`POST /api/v1/session`. JavaScript never holds a token. `GET /api/v1/session`
is the whoami check on load; a 401 sends the visitor to `/login`, which returns
them to the page they asked for.

## Milestones

- **M0** — shell, router, session auth, theme tokens, CI.
- **M1** — KPI grid, timeseries, period selector, deltas.
- **M2** — source tabs, chart + table, website switcher, filters.
- **M3** — funnels and goals.
- **M4** — live visitors.
- **M5** — settings, accessibility audit, perf budget, docs.
