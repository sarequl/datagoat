<div align="center">

# DataGoat

**Open-source, revenue-first web analytics that runs in your own Cloudflare account.**

See which channels, pages and campaigns bring paying customers, not just visitors.
One Worker, one D1 database, one script tag. MIT licensed.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sarequl/datagoat)

</div>

> **Status: pre-release.** Every feature below is built and covered by automated tests, and [`docs/PARITY.md`](docs/PARITY.md) tracks each DataFast feature in detail. Integrations with outside services (payment providers, email, X, Reddit, GitHub, Google, Meta, Expo push) are tested against mocked APIs only, so treat them as beta until you have verified them with your own accounts. Expect breaking changes until the first release.

## Why DataGoat

- **Revenue attribution is the point.** DataGoat joins a first-party visitor id to your payments, so every breakdown row shows visitors, revenue and payments together: which referrer, landing page, UTM campaign, country or device actually makes money.
- **Your data stays in your Cloudflare account.** No third-party analytics servers. You pick where it runs, and you can export or delete everything.
- **Cheap to run.** Most small sites fit Cloudflare's free plan. Larger ones need the $5/month Workers Paid plan, billed by Cloudflare, not by us.
- **Drop-in for DataFast users.** DataGoat accepts DataFast's tracking script attributes, `window.datafast()` calls and `datafast_visitor_id` payment metadata, so switching is a snippet swap.
- **No dashboard lock-outs.** There are no event quotas, so going viral never locks you out of your own analytics.
- **MIT, no licence keys, no activation limits.**

## Features

**Traffic analytics**

- Visitors (new and returning), sessions, pageviews, bounce rate, session duration, with previous-period comparison
- Breakdowns by channel, referrer, UTM campaign, `ref` / `source` / `via` parameters, page, entry and exit page, outbound clicks, hostname, country, region, city, device, browser and OS
- Automatic channel grouping: Organic Search, Paid Search, Organic Social, Paid Social, Email, Newsletter, Referral, Affiliate, AI assistants, Direct
- Advanced filters (is, is not, contains), combinable, plus saved segments
- Realtime view with a live map, 3D globe and 8-hour replay
- Visitor profiles with full journeys across sessions

**Revenue attribution**

- Stripe, Polar, Lemon Squeezy, Paddle, Dodo Payments, Creem, Shopify and WooCommerce
- Stripe connects with a read-only restricted key, with no webhook setup
- No-code payment links: Stripe Payment Links, Polar Checkout Links, Lemon Squeezy links
- Payments API for any other billing system
- Renewals, refunds, free trials and subscription lifecycle events
- First-touch, last-touch and last-non-direct attribution
- Lifetime value by first channel, revenue per visitor, conversion rate
- Purchase-likelihood prediction for live visitors

**Goals and funnels**

- Custom goals from JavaScript, HTML attributes, scroll depth or the server-side API
- Funnels of 2 to 8 pageview or goal steps, with revenue per step
- Identify signed-in users and merge their web and mobile activity

**Growth tools**

- Alerts for goals, new sales and traffic spikes, by email, Telegram or webhook
- Weekly email report
- AI crawler and bot traffic tracking
- X and Reddit mentions, and X link attribution
- GitHub commits and notes on your charts
- Google Search Console keywords
- Meta Ads spend and return on ad spend
- Import from Plausible

**For developers and AI agents**

- REST API with scoped keys
- CLI
- MCP server for Claude, ChatGPT and other AI tools, with OAuth
- npm SDK, React Native SDK, WordPress plugin, and guides for most frameworks and site builders

**Teams and sharing**

- Unlimited websites and team members, with owner, member and viewer roles
- Public dashboard links
- Mobile companion app

**Privacy**

- Three modes per site: first-party cookies, cookieless, or cookieless until consent
- Global Privacy Control support
- Server-side bot filtering
- IP, path, country and hostname exclusions

## How it works

```
Your site ── script tag ──► DataGoat Worker ──► D1 database
                                  ▲   │
Stripe, Polar, Paddle, … ─────────┘   └──► Dashboard, API, MCP
                     (payments matched to visitors)
```

The tracker sets a first-party visitor id. When a customer pays, your checkout passes that id in the payment metadata, or DataGoat matches the payment link or email. DataGoat then credits the revenue to the visit that brought the customer in.

## Quick start

### One-click deploy

1. Click **Deploy to Cloudflare** above. Cloudflare copies the repo to your GitHub account, creates the Worker, the D1 database and the other bindings, and asks for three secrets.
2. Open the setup link from the deploy output to create your owner account.
3. Add your website and paste the script tag into your site's `<head>`:

```html
<script defer data-website-id="YOUR_SITE_ID" data-domain="example.com"
        src="https://YOUR-DATAGOAT-DOMAIN/js/script.js"></script>
```

4. Connect a payment provider under **Settings → Revenue**.

### Manual deploy

You need Node.js 20.19 or newer and a Cloudflare account. The free plan works.

```bash
git clone https://github.com/sarequl/datagoat.git
```

```bash
cd datagoat && npm ci
```

```bash
npx wrangler login
```

```bash
npx wrangler d1 create datagoat
```

Put the printed `database_id` into `wrangler.jsonc`, then create the KV namespace used for login throttling and put its id there too:

```bash
npx wrangler kv namespace create LOGIN_THROTTLE
```

Set the three secrets listed in `.dev.vars.example`:

```bash
npx wrangler secret put SETUP_TOKEN
```

```bash
npx wrangler secret put SESSION_SECRET
```

```bash
npx wrangler secret put ENCRYPTION_KEY
```

Build, apply database migrations and deploy:

```bash
npm run deploy
```

Then open `https://YOUR-WORKER-URL/setup?token=YOUR_SETUP_TOKEN` to create your account.

### Use your own domain

Serve DataGoat from a subdomain such as `analytics.example.com`, or from a path on your main site if it is on Cloudflare. First-party hosting keeps ad blockers from dropping your data and lets visitor cookies last. See [`docs/`](docs/) for proxy guides.

## Switching from DataFast

1. Deploy DataGoat and add your site.
2. Replace DataFast's `src` with your DataGoat script URL, and its `data-website-id` with your DataGoat site id. Every other attribute keeps working.
3. Leave your checkout code alone: DataGoat reads `datafast_visitor_id` from Stripe, Polar and Lemon Squeezy metadata, and `window.datafast("goal")` calls still work.
4. Optionally import history from Plausible.

[`docs/PARITY.md`](docs/PARITY.md) lists every DataFast feature with its status in DataGoat
(done, done but untested against the real third-party service, partial, or not done and why), and
[`docs/switching-from-datafast.md`](docs/switching-from-datafast.md) walks through the move.

DataGoat is an independent project. It is not affiliated with or endorsed by DataFast.

## Privacy modes

| Mode                     | How visitors are recognised                                                                        | Best for                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Cookies (default)        | A first-party cookie on your domain, kept for one year                                             | Full revenue attribution, including purchases weeks after the first visit                    |
| Cookieless               | A hash of IP, browser and site with a random salt that rotates daily and is deleted after 48 hours | Sites that do not want to store anything in the browser; attribution only works within a day |
| Cookieless until consent | Cookieless until your consent banner calls `datagoat("consent", true)`                             | Sites with a consent banner                                                                  |

Whether a mode removes the need for a cookie banner depends on your jurisdiction and use. That is a legal decision for you, not a property of the software.

## Running costs

DataGoat runs on your Cloudflare account, and Cloudflare bills you directly.

| Traffic                                 | Plan               | Cost                              |
| --------------------------------------- | ------------------ | --------------------------------- |
| Up to roughly 20,000 pageviews a day    | Workers Free       | $0                                |
| Up to roughly 10 million events a month | Workers Paid       | $5/month                          |
| Beyond that                             | Workers Paid usage | About $5 per extra million events |

These figures are design targets based on Cloudflare's published limits. Check the usage page in your dashboard for real numbers.

## Development

```bash
npm ci
```

```bash
npm run dev
```

| Script                                    | What it does                                               |
| ----------------------------------------- | ---------------------------------------------------------- |
| `npm run dev`                             | Builds, applies local migrations and starts `wrangler dev` |
| `npm run dev:mock`                        | Runs the dashboard alone against a mock API                |
| `npm test`                                | Worker tests in the Workers runtime                        |
| `npm run test:tracker` / `test:dashboard` | Tracker and dashboard unit tests                           |
| `npm run e2e`                             | Playwright end-to-end tests                                |
| `npm run lint` / `typecheck`              | Biome and TypeScript                                       |
| `npm run check`                           | Everything above, plus build and size checks               |

Project layout:

| Path          | Contents                                                     |
| ------------- | ------------------------------------------------------------ |
| `src/`        | The Cloudflare Worker: ingest, API, payments, cron jobs, MCP |
| `tracker/`    | The tracking script                                          |
| `dashboard/`  | The React dashboard                                          |
| `migrations/` | D1 schema migrations                                         |
| `cli/`        | The `datagoat` CLI                                           |
| `packages/`   | SDKs, the WordPress plugin, middleware                       |
| `apps/mobile` | The mobile companion app                                     |
| `docs/`       | User and developer documentation                             |

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request.

## License

[MIT](LICENSE). The DataGoat name and logo are not covered by the licence: you may self-host and modify DataGoat freely, but please do not offer a hosted service under the DataGoat name.
