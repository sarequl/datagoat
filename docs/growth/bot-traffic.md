# Bot traffic (AI crawlers)

See when AI assistants fetch your pages to answer users, when search engines index them, and which
crawlers collect them for training, including `robots.txt`, `llms.txt`, `llms-full.txt`, sitemaps and
Markdown files. Crawlers rarely run JavaScript, so this is reported from your server, not the
tracking script.

## Install

Use [`@datagoat/ai-crawl`](../../packages/ai-crawl/README.md) in the backend of the website you
track (Cloudflare Workers or Pages, Next.js `proxy.ts`/`middleware.ts`, Express, Hono, any Fetch
handler):

```ts
import { withAICrawlerTracking } from "@datagoat/ai-crawl";

export default {
  fetch: withAICrawlerTracking(handler, {
    websiteId: "dfid_…",                     // the site's tracking id
    apiUrl: "https://analytics.example.com", // your DataGoat
  }),
};
```

Or POST from any backend (DataFast's format, ≤ 16 KB):

```http
POST /api/ai-crawls
Content-Type: application/json
Authorization: Bearer dfbot_…   (optional)

{"websiteId": "dfid_…", "domain": "example.com", "href": "https://example.com/docs",
 "ai": {"userAgent": "<full User-Agent>", "ip": "203.0.113.10", "statusCode": 200, "source": "server_middleware"}}
```

DataGoat also accepts `{"events": [ …up to 50… ]}` (≤ 64 KB) to send several requests at once. The
answer is `{"success": true, "tracked": n, "ignored": m}`; requests that are not crawlers are
ignored, an unknown website is 404, a hostname that does not belong to the website is 400, and the
per-website rate limit (600 requests/minute, shared Rate Limiting binding) answers 429.

## Classification and verification

DataGoat classifies the user agent on the server from its own catalog
(`src/growth/bots/catalog.ts`, each entry citing the operator's documentation) into **AI answers**
(`answer_fetch`: ChatGPT-User, Claude-User, Perplexity-User, …), **Indexing** (`search_index`:
Googlebot, bingbot, OAI-SearchBot, PerplexityBot, …), **Training** (`training`: GPTBot, ClaudeBot,
CCBot, Bytespider, Applebot, GoogleOther, Google-CloudVertexBot, meta-externalagent, …) and
**Other** (`ai_crawler`). Fields such as `provider` or `category` in the body are ignored.

Where the operator publishes IP ranges (OpenAI, Google, Bing, Perplexity, Apple, DuckDuckGo, Common
Crawl), the `bots.ip-ranges` job downloads them daily and requests from inside them are **IP
verified**; others are **user agent only**. "Accept only IP-verified crawlers" drops the rest.

Forward the crawler's real IP: on Workers `cf-connecting-ip` is set by Cloudflare. Behind your own
proxy, only use forwarding headers that proxy sets.

## Settings, token and API

The Bot traffic page and DataFast's API (`/api/v1/analytics/bot-traffic`, `/bot-traffic/pages`,
`/api/v1/admin/bot-traffic/usage`, `/api/v1/admin/websites/:id/bot-traffic/{settings,token}`) offer:

- turning companies or single agents off (skipped before storage), verified-only, display options;
- a `dfbot_` request token: create it, deploy it as `authToken`, then turn on "Reject
  unauthenticated requests". Rotation kills the old token immediately; deleting it turns
  enforcement off. Settings and tokens are owner-only and not available to `df_` keys.

## Allowance and cost

Each accepted request is one row written in D1 (an upsert per hour, crawler, page, status and
verification). Self-hosted installs have no allowance by default (`isCounting: false`). To cap
bot traffic, for example to protect the Free plan's 100,000 rows written per day, set
`BOT_TRAFFIC_ALLOWANCE` to the accepted requests per UTC month; when it is used up only bot traffic
ingestion pauses until the next month, and `usage.dropped` counts what was skipped. Counting is
flushed at most once a minute per isolate, so the cap is approximate by a minute of traffic.
