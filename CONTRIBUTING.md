# Contributing to DataGoat

Thanks for helping. DataGoat is MIT licensed; by contributing you agree your work is released under
the same licence.

## Ground rules

- **Original code only.** DataGoat is compatible with DataFast's public wire format and API, built
  from its public documentation. Do not copy code, markup, styles or copy text from DataFast, and do
  not read or use anything from DataBull (its licence forbids reverse engineering).
- Dependencies must be MIT, Apache-2.0, BSD or ISC.
- The app must keep working on the Cloudflare Workers **Free plan**: no KV writes per request, one
  `db.batch()` per ingest event, few indexes (each costs a written row). The write-budget tests
  must keep passing.

## Getting started

See [docs/development.md](docs/development.md). In short: `npm ci`, copy `.dev.vars.example` to
`.dev.vars`, `npm run dev`.

## Making a change

1. Read [docs/CONTRACTS.md](docs/CONTRACTS.md) (where things live, how to add routes, jobs,
   migrations, pages and mocks) and [docs/api/contract.md](docs/api/contract.md).
2. Add tests for every behaviour: Worker tests in `test/worker/`, dashboard tests next to the
   dashboard code, e2e in `test/e2e/`.
3. Run `npm run check` (lint, typecheck, tests, build, size budgets, e2e). CI runs the same.
4. Database changes are new migration files; never edit a merged migration.
5. Add a line to `CHANGELOG.md` under **Unreleased** and document user-facing behaviour in `docs/`.
6. Keep commits small with messages that say what changed and why.

## Reporting security issues

Please report vulnerabilities privately to the maintainer instead of opening a public issue.
