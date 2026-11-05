# Growth features

Everything here is optional: a feature whose provider is not configured says so in its page and
status endpoint, and costs nothing. All secrets are Worker secrets (`wrangler secret put NAME`, or
`.dev.vars` locally); the Deploy button does not ask for them.

| Feature | Page | Setup | Doc |
| --- | --- | --- | --- |
| Alerts, digests, weekly email report, invite and reset emails | Alerts | Email provider (optional), Telegram bot (optional) | [alerts.md](alerts.md) |
| Attack mode | Bot traffic | none | [alerts.md](alerts.md#attack-mode) |
| AI crawler bot traffic | Bot traffic | `@datagoat/ai-crawl` in your site's backend | [bot-traffic.md](bot-traffic.md) |
| X and Reddit mentions, X link attribution | Mentions | X API token (paid, per post read); Reddit app credentials | [mentions.md](mentions.md) |
| GitHub commit markers | Integrations | GitHub token or OAuth app, push webhook | [github.md](github.md) |
| Google Search Console | Search Console | Google OAuth client | [search-console.md](search-console.md) |
| Meta Ads spend and ROAS | Ads & ROAS | Meta app or system-user token | [meta-ads.md](meta-ads.md) |
| Plausible import | Import | none | [plausible-import.md](plausible-import.md) |

## OAuth redirect URIs

Register `https://<your DataGoat host>/api/connect/<provider>/callback` with each provider, where
`<provider>` is `github`, `google-search-console`, `meta-ads` or `x`.

## Free plan budget

All sync jobs run inside the one-minute cron and respect its limits (40 D1 queries and 40
subrequests per run). They write only rows that changed, and an idle install writes nothing.
Indicative daily writes: Search Console up to `GSC_ROWS_PER_DAY` (500) rows per site and day of
history, Meta Ads one row per campaign and day, mentions three rows per new mention, bot traffic
one row per accepted crawler request.
