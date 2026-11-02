# DataGoat

Open-source, self-hostable web analytics. One script tag, one Cloudflare
Worker, one D1 database. Privacy-first by default: cookieless mode, optional
first-party cookies, server-side bot filtering, and no third-party requests at
runtime.

> **Status: pre-release.** DataGoat is under active development. The feature list
> below is the target scope from the design docs in [`design/`](design/), not a
> list of shipped, verified behaviour. See [`ROADMAP.md`](ROADMAP.md) for what
> is done and what is next.

## Why

Most web analytics either sends your visitors' data to a third party or is a
hosted product you cannot run yourself. DataGoat is meant to be the middle path:
run your own analytics on infrastructure you already pay for, keep the data in
your own D1 database, and keep the payload small enough that you can install it
with a single `<script>` tag.

This project is **inspired by** DataFast (datafa.st) and databull.app for
feature parity. It is **original code** — nothing is copied from either product,
and their source is not included here.

## Stack

| Layer | Choice |
| --- | --- |
| Ingestion + API | Cloudflare Worker |
| Storage | Cloudflare D1 (SQLite) |
| Dashboard | Static SPA served by the same Worker (React + TypeScript + Vite) |
| Tracking script | Plain ES2017 JavaScript, no dependencies |
| License | MIT |

## Scope

Grounded in the design docs, not invented here:

- Pageviews, sessions, visitors, and a realtime "live now" view.
- Traffic by source: channel, referrer, campaign, landing page, country, device,
  browser, operating system.
- Revenue attribution with last-non-direct, first-touch, and last-touch models.
- Goals and conversion funnels, including funnels that end at a payment.
- Server-side payments ingestion (manual, plus provider webhooks) and a
  payments API.
- Bot filtering at `off`, `standard`, and `strict` levels.
- Privacy modes: cookies, cookieless, and cookieless-until-consent.
- Read-only API keys for CLI and MCP consumers.

Out of scope for the first release: heatmaps, session replay, A/B testing,
surveys, error monitoring, and multi-tenant billing. See
[`design/worker.md`](design/worker.md) §13 and [`design/api.md`](design/api.md) §7.

## Install

Self-hosting instructions live in [`docs/INSTALL.md`](docs/INSTALL.md).

## Development

The Worker lives in [`packages/worker`](packages/worker). From the repository
root:

```sh
npm install                 # install all workspace dependencies
npm run build:data          # regenerate src/data/lists.ts from src/data/*.txt
npm run lint                # biome check
npm run typecheck           # tsc --noEmit
npm test                    # vitest (runs inside the Workers runtime)
npm run migrate:local       # apply packages/worker/migrations/*.sql to local D1
```

`wrangler.toml` is not committed. Copy `packages/worker/wrangler.example.toml`
to `wrangler.toml` and fill in real IDs before deploying.

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md). By participating you agree to the
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE). Copyright (c) 2026 DataGoat contributors.
