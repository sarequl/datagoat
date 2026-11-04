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
