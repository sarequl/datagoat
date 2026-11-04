# Development

Requirements: Node 20.19+ (22 recommended). Everything runs locally; no Cloudflare account needed.

```sh
npm ci
cp .dev.vars.example .dev.vars        # then put real random values in it
npm run dev                           # build, migrate the local D1, wrangler dev on :8787
```

Open `http://localhost:8787/setup?token=<SETUP_TOKEN from .dev.vars>`.

Dashboard work:

- `npm run dev:dashboard`: Vite on :5173 with hot reload, proxying `/api` to `wrangler dev`.
- `npm run dev:mock`: Vite with the MSW mock API, no Worker needed. Sign in with
  `demo@datagoat.dev` / `demo-password`. `?mock-signed-in=1` skips sign-in; `?mock-setup=1` shows the
  setup screen (token `mock-setup-token`).

Checks: `npm run check` runs lint, typecheck, Worker/tracker/dashboard tests, build, size budgets
and Playwright. See [CONTRACTS.md](CONTRACTS.md) §7 for each script and the test helpers.

Regenerate binding types after changing `wrangler.jsonc`: `npm run cf-typegen`.

## Demo data

Fill your local database with a realistic demo website, for development, screenshots and demos:

```bash
npm run db:migrate:local && npm run seed:demo
```

It creates `demo.datagoat.dev` with about 90 days of traffic, including a Hacker News launch spike, goals, outbound clicks, Stripe, Polar and Lemon Squeezy payments with renewals and refunds, identified customers, a few live visitors, a funnel and chart notes. It writes raw data only, so every number in the dashboard comes from the real query code. Sign in as `demo@datagoat.dev` with password `demo-password`; every existing local user also gets access to the demo site.

Options: `--days 30`, `--daily 80` (visitors per day), `--seed 7` (a different but reproducible dataset), `--domain`, `--email`, `--password`, and `--out demo.sql` to write the SQL without applying it. Running it again replaces only the demo site. It only ever writes to the local database.
