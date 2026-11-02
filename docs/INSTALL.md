# Installing DataGoat

DataGoat runs as a single Cloudflare Worker backed by a single D1 database. This
guide walks through a self-hosted deployment on Cloudflare's free or paid plan.

> The package layout is being finalised in [`../ROADMAP.md`](../ROADMAP.md). If
> the directory names below do not match the repository, use the equivalent path
> in your checkout and open an issue so we can fix the docs.

## Prerequisites

- A Cloudflare account with Workers and D1 enabled.
- Node.js LTS and a package manager (`npm`, `pnpm`, or `bun`).
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) installed and
  authenticated (`wrangler login`).

## 1. Get the code

```bash
git clone https://github.com/sarequl/datagoat.git
cd datagoat
npm install
```

## 2. Configure the Worker

Copy the example config and adjust it for your account:

```bash
cp wrangler.example.toml wrangler.toml
```

Set at least:

- `name` — the Worker's hostname, e.g. `datagoat-<you>`.
- `account_id` — your Cloudflare account id.
- The D1 binding that the Worker reads and writes.

## 3. Create the database and apply the schema

```bash
wrangler d1 create datagoat-prod
wrangler d1 execute datagoat-prod --remote --file=migrations/0001_init.sql
```

Record the `database_id` that `d1 create` prints and put it in `wrangler.toml`.

## 4. Set secrets

```bash
echo "<a long random string>" | wrangler secret put SESSION_SECRET
echo "<another long random string>" | wrangler secret put COOKIELESS_SALT
```

`SESSION_SECRET` signs the dashboard session cookie. `COOKIELESS_SALT` is the
key used to derive visitor ids when a site runs in cookieless mode. Rotate it to
reset all cookieless ids.

## 5. Deploy

```bash
npm run deploy
```

The Worker serves both `/api/v1/*` and the static dashboard from one origin.

## 6. Create your first site

The dashboard is served at the Worker root. Open it, sign in with the admin
password you set at first boot, and create a site to get:

- a **site token** for the tracking script, and
- a **read-only API key** for the CLI and MCP.

## 7. Install the tracking script

Paste this before the closing `</body>` tag of every page:

```html
<script src="https://<your-worker-host>/t.js" data-site="<SITE_TOKEN>" defer></script>
```

For SPAs, cookieless mode, subdomain tracking, and custom events, see
[`design/script.md`](../design/script.md) §10 for the full set of install
snippets.

## 8. Verify

- Load a page and confirm a `POST /t` (or `GET /p.gif`) request reaches the
  Worker with a `204`.
- Open the dashboard and confirm the pageview appears.
- Run the read API once with your key:

```bash
curl -H "Authorization: Bearer <READ_KEY>" \
  "https://<your-worker-host>/api/v1/analytics/overview"
```

## Updating

Pull the latest release, re-run migrations if any are new, and deploy:

```bash
git pull
npm install
wrangler d1 execute datagoat-prod --remote --file=migrations/<new>.sql
npm run deploy
```

## Troubleshooting

- **Events rejected with `host_not_allowed`** — add the page's host to the
  site's allowed hosts in the dashboard.
- **No data in the dashboard** — confirm the site token matches the script tag
  and that the Worker is deployed to the host in the tag.
- **Cookieless visitors reset daily** — that is expected; the id is derived
  from a daily salt.
