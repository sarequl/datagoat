# Deploying DataGoat

DataGoat is one Worker, one D1 database, one KV namespace (login throttling only), three Rate
Limiting bindings and one cron trigger, all declared in [`wrangler.jsonc`](../wrangler.jsonc).

## Deploy to Cloudflare button

The button copies the repository into your GitHub account and builds it with Workers Builds:

1. **Resources.** Cloudflare provisions the D1 database (`DB`) and the KV namespace
   (`LOGIN_THROTTLE`) and writes their ids into your copy's `wrangler.jsonc`, replacing the
   placeholder ids. Rate Limiting bindings need no provisioning.
2. **Secrets.** You are prompted for the values in [`.dev.vars.example`](../.dev.vars.example):
   - `SETUP_TOKEN`: any long random string (`openssl rand -hex 24`), used once.
   - `SESSION_SECRET`: at least 32 random characters (`openssl rand -hex 32`).
   - `ENCRYPTION_KEY`: at least 32 random characters. Never change it later: stored provider
     credentials would no longer decrypt.
     Setup refuses to run while any of them is missing, shorter than required, or still the example
     placeholder (`GET /api/setup` lists the problems).
3. **Build command:** `npm run build` (dashboard + tracker into `public/`).
4. **Deploy command:** `npm run deploy` = build, `wrangler d1 migrations apply DB --remote`, then
   `wrangler deploy`. Migrations reference the **binding** name, so a renamed database still works,
   and they run non-interactively in CI.
5. Open `https://<your-worker>/setup?token=<SETUP_TOKEN>` to create the first owner and website, then
   copy the tracking snippet.

## Manual deploy

```sh
npm ci
npx wrangler login
npx wrangler d1 create datagoat          # paste the database_id into wrangler.jsonc
npx wrangler kv namespace create LOGIN_THROTTLE   # paste the id into wrangler.jsonc
npx wrangler secret put SETUP_TOKEN
npx wrangler secret put SESSION_SECRET
npx wrangler secret put ENCRYPTION_KEY
npm run deploy
```

Then open `/setup?token=…` as above. Later deploys are `npm run deploy` (migrations first, then the
Worker). Keeping a deployed copy up to date is described in [updating.md](updating.md).

## Collector placement

Serve the Worker on a subdomain of your site (`a.example.com`) or a route on your own zone for
first-party cookies; `*.workers.dev` works but is blocked more often by ad blockers. Static assets
(`/js/*`, dashboard) never invoke the Worker, so the script keeps loading even if a Free account hits
its daily request limit.

## Free-plan notes

- PBKDF2 uses **50,000** iterations by default (`PASSWORD_ITERATIONS` in `wrangler.jsonc`). The
  Workers runtime allows up to 100,000, which measured about 16 ms per hash in local workerd, above
  the Free plan's 10 ms CPU limit per request; 50,000 is about 8 ms. On Workers Paid, set it to
  `"100000"`. Existing hashes are re-hashed with the configured count at the next login. Trade-off:
  fewer iterations make offline guessing of a leaked hash cheaper, so use long passwords.
- The cron runs every minute. Idle jobs write almost nothing (see [architecture/jobs.md](architecture/jobs.md)).
- Deleting a website removes its rows gradually (1000 rows per hour by default,
  `PURGE_ROWS_PER_RUN`), because deletes count against the 100,000 daily row writes.

## Password reset without email

```sh
npm run reset-password -- you@example.com https://analytics.example.com          # remote D1
npm run reset-password -- you@example.com http://localhost:8787 --local          # local dev
```

It inserts a one-hour, single-use token with `wrangler d1 execute` and prints the link.
