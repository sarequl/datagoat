# CLI

`datagoat` is a command-line client for the DataGoat API: query analytics and manage websites,
goals, funnels, alerts, notes, keys, tokens and the team from a terminal, a script or an AI agent
that can run shell commands. It needs Node.js 20 or newer and has no runtime dependencies.

## Install

```sh
npx datagoat login          # run without installing
npm install -g datagoat     # or install the `datagoat` command
```

From a clone of this repository: `npm run build:cli`, then `node cli/bin/datagoat.mjs …`.

## Log in

```sh
datagoat login --url https://analytics.example.com
```

The CLI opens **Account → API tokens** in your browser (`--no-open` skips that); create an account
token (`dgt_…`) and paste it. It checks the token against the server and saves the URL and token in
`~/.config/datagoat/config.json` (mode 0600; `$XDG_CONFIG_HOME/datagoat/` or
`%APPDATA%\datagoat\` on Windows).

```sh
echo "$DATAGOAT_TOKEN" | datagoat login --url https://analytics.example.com   # CI: token on stdin
datagoat login --url https://analytics.example.com --token dgt_…              # visible in shell history
datagoat logout                                                               # forget the token
```

A website key (`dg_…`) works too. It is limited to one website, so commands need no `--site`, but
account commands (tokens, website creation, team changes) are refused.

## Configuration

Values come from, in order: command-line flags, environment variables, the config file.

| Setting | Flag | Environment | Config |
| --- | --- | --- | --- |
| Server | `--url` | `DATAGOAT_URL` | `url` |
| Token | `--token` | `DATAGOAT_TOKEN`, then `DATAGOAT_SITE_KEY` | `token` |
| Default website | `--site` (aliases `--website`, `--website-id`) | `DATAGOAT_SITE` | `site` |
| Config file path | | `DATAGOAT_CONFIG` | |

```sh
datagoat config show                 # active values and where each comes from
datagoat config set-site <websiteId> # default website (also: datagoat sites use <websiteId>)
datagoat config clear-site
datagoat config set-url <url>
datagoat config path
datagoat whoami
```

Without `--site` or a default, website commands ask you to pick one in a terminal and fail with a
hint in scripts.

## Global flags

| Flag | Meaning |
| --- | --- |
| `--json` | Compact JSON of the response data, for `jq` (default output is tables) |
| `--site <id>` | Website id (`_id`) or tracking id |
| `--url <url>` | DataGoat server |
| `--token <token>` | Token for this command only |
| `--verbose` | Print each request URL and status to stderr |
| `-y`, `--yes` | Skip confirmation prompts (required for destructive commands in scripts) |
| `-h`, `--help` | Help for any command: `datagoat analytics --help`, `datagoat help funnels` |
| `-V`, `--version` | CLI version |

Exit codes: `0` success, `1` API or network error, `2` usage error, `130` cancelled.

## Analytics

```sh
datagoat analytics overview --period last30d
datagoat analytics timeseries --interval day --fields visitors,revenue,payments --from 2026-01-01 --to 2026-01-31
datagoat analytics pages --filter page:contains=/docs --limit 25
datagoat analytics referrers --country "United States" --device mobile
datagoat analytics countries --goal signup --period last30d
datagoat analytics goal-properties --event signup --property plan
datagoat analytics realtime
datagoat --json analytics pages | jq '.[0]'
```

Reports: `overview`, `timeseries`, `realtime` (alias `live`), `realtime-map`, `metadata`, `pages`,
`entry-pages`, `exit-pages`, `exit-clicks`, `referrers`, `channels`, `campaigns`, `countries`,
`regions`, `cities`, `devices`, `browsers`, `os`, `hostnames`, `goals`, `goal-properties`,
`revenue`. Shortcuts: `datagoat stats` (overview), `datagoat breakdown <report>`, `datagoat live`.

Breakdown revenue is attributed revenue (which pages, sources and countries brought paying
visitors); overview and timeseries revenue is total revenue.

**Dates.** `--period today|yesterday|last24h|last7d|last30d|last90d|last12m|week|month|year|all`
is resolved in the website timezone. `--from`/`--to` take `YYYY-MM-DD` (whole days in the website
timezone, end inclusive) or an ISO instant with `Z` or an offset; a time without a zone is rejected
as ambiguous. `--timezone Europe/Paris` overrides the zone.

**Filters.** The dashboard's filters, repeatable and combinable:

```sh
-F key=value              # is (default)
-F key:operator=value     # operator before the =
-F key=operator:value     # or after it
-F country="United States,Canada"   # several values match any
```

Keys: `country`, `region`, `city`, `device`, `browser`, `os`, `referrer`, `page`, `entry_page`,
`hostname`, `goal`, `visit_count`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`,
`utm_content`, `ref`, `source`, `via`, `channel`. Operators: `is`, `is_not`, `contains`,
`does_not_contain` (text keys), `gte`, `lte` (`visit_count`). Each key also has a flag:
`--country`, `--entry-page`, `--utm-source`, … Repeating a key merges its values; mixing operators
for one key is an error.

## Visitors

```sh
datagoat visitors list --visited-page /pricing --period last30d
datagoat visitors list --visited-page-contains /docs --completed-goal signup
datagoat visitors list --utm-campaign launch --is-customer --period last30d
datagoat visitors list --search ada@example.com          # user id, name or email
datagoat visitors get <visitorId>                         # alias: datagoat visitor <id>
```

## Websites

```sh
datagoat sites list                     # aliases: websites, website, site
datagoat sites get [websiteId]
datagoat sites create --domain example.com --timezone Europe/Paris --name "My blog"
datagoat sites update [websiteId] --name "New name" --timezone UTC --cookieless true
datagoat sites update [websiteId] --excluded-ips "1.2.3.4,10.0.0.0/8" --set retentionDays=365
datagoat sites kpi [websiteId] --type goal --goal signup --color-scheme green
datagoat sites use <websiteId>          # make it the default
```

`--set key=value` sets any field of `PUT /api/v1/admin/websites/{id}` (values are parsed as JSON
when possible). Website deletion is dashboard-only; `sites delete` prints the server's answer.

## Website keys, account tokens, team

```sh
datagoat keys list                      # also: datagoat sites apikeys …
datagoat keys create --name "Prod" [--pii]
datagoat keys roll <apiKeyId>
datagoat keys delete <apiKeyId>

datagoat tokens list
datagoat tokens create --name "Read only" --permissions "analytics:read,websites:read" [--websites <id,id>] [--expires-days 90]
datagoat tokens delete <tokenId>

datagoat team list
datagoat team invite --email someone@example.com --role member
datagoat team role <userId> --role viewer
datagoat team remove <userId>
datagoat team invites
```

New secrets print once on stdout (the explanation goes to stderr), so
`datagoat keys create > key.txt` captures only the key. A token can never be broader than the one
you are using. Team changes need the owner role.

## Goals, funnels, alerts, notes

```sh
datagoat goals list
datagoat goals colors
datagoat goals customize signup_started --display-name "Signup started" --color "#8dcdff" --description "Opened the signup flow"
datagoat goals customize signup_started --clear-color
datagoat goals reset signup_started
datagoat goals track --visitor <visitorId> --name upgrade --meta plan=pro
datagoat goals delete-events --name test_goal --from 2026-01-01 --to 2026-01-31

datagoat funnels list
datagoat funnels view <funnelId> --period last30d --referrer Google
datagoat funnels create --name Checkout --steps '[{"name":"Pricing","type":"pageview","url":"/pricing"},{"name":"Purchase","type":"goal","goalName":"purchase"}]'
datagoat funnels update <funnelId> --name "New name" | --enable | --disable
datagoat funnels delete <funnelId>

datagoat alerts list
datagoat alerts create --name "New sale" --goal purchase --subject "New sale!" --email me@example.com
datagoat alerts create --name "Spike" --trigger '{"type":"traffic_spike"}' --message "Traffic is spiking" --telegram-chat 12345
datagoat alerts update <alertId> --disabled
datagoat alerts history [--alert <alertId>]
datagoat alerts test <alertId>
datagoat alerts delete <alertId>

datagoat notes list --period last30d --search launch
datagoat notes add --text "Launched the new pricing page" [--at 2026-11-04T09:00:00Z] [--key launch-pricing]
datagoat notes update <noteId> --text "…"
datagoat notes delete <noteId>
```

`funnels create` without `--steps` builds the steps interactively in a terminal.

## Payments and identify

```sh
datagoat payments list --period last30d [--attributed false] [--kind refund]     # alias: sales
datagoat payments create --amount 49.99 --currency USD --transaction-id ch_123 --visitor <visitorId> [--email …] [--renewal]
datagoat payments delete --transaction-id ch_123
datagoat identify --visitor <visitorId> --user-id u_42 --name "Ada" --prop plan=pro
```

`payments create` uses the DataFast-compatible Payments API and is idempotent on the transaction id.

## Shell completion

```sh
datagoat completion install            # detects bash, zsh or fish from $SHELL (or --shell)
datagoat completion uninstall
datagoat completion bash > /etc/bash_completion.d/datagoat   # or print the script yourself
```

`install` writes the script under `~/.config/datagoat/` and adds a marked block that sources it to
`~/.bashrc` (`~/.bash_profile` on macOS) or `~/.zshrc`; for fish it writes
`~/.config/fish/completions/datagoat.fish`. Restart the shell afterwards.

## Publishing (maintainers)

The package lives in `cli/` (npm name `datagoat`, bin `datagoat`). `npm run build:cli` bundles
`cli/src` with esbuild into `cli/dist/datagoat.mjs`; `npm publish` in `cli/` runs the build first
and ships `bin/` and `dist/` only. Tests: `npm run test:cli` (a mock HTTP server, plus a smoke test
of the built package).
