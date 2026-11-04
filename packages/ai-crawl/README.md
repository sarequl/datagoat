# @datagoat/ai-crawl

Server-side AI crawler tracking for [DataGoat](https://github.com/sarequl/datagoat), the
open-source analytics you host on Cloudflare. See when ChatGPT, Claude, Perplexity, Gemini and
other assistants fetch your pages to answer users, when search engines index them, and which
training crawlers collect them, including `robots.txt`, `llms.txt` and sitemaps.

The package runs in your backend, ignores static assets and human traffic cheaply, and posts a
small report to your DataGoat install. DataGoat classifies the crawler and verifies its IP
against the ranges the operators publish. The report format is the same as DataFast's
`@datafast/ai-crawl`, so you can switch by changing the import and adding `apiUrl`.

Tracking never slows down or breaks your site: reports run in `waitUntil` when the runtime has it,
time out after 1.5 s, and errors are swallowed. **Do not await the tracking calls.**

```sh
npm install @datagoat/ai-crawl
```

## Cloudflare Workers

```ts
import { withAICrawlerTracking } from "@datagoat/ai-crawl";

export default {
  fetch: withAICrawlerTracking(
    async (request, env, ctx) => fetch(request),
    { websiteId: "dfid_******", apiUrl: "https://analytics.example.com" },
  ),
};
```

The wrapper sees your response, so the status code is reported too.

## Cloudflare Pages (`functions/_middleware.ts`)

```ts
import { trackAICrawlerRequest } from "@datagoat/ai-crawl";

export async function onRequest(context) {
  trackAICrawlerRequest(context.request, context, {
    websiteId: "dfid_******",
    apiUrl: "https://analytics.example.com",
  });
  return context.next();
}
```

## Next.js (`proxy.ts`, formerly `middleware.ts`)

```ts
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { trackAICrawlerRequest } from "@datagoat/ai-crawl";

export function proxy(request: NextRequest, event: NextFetchEvent) {
  trackAICrawlerRequest(request, event, {
    websiteId: "dfid_******",
    apiUrl: "https://analytics.example.com",
  });
  return NextResponse.next();
}

export const config = {
  // Keep robots.txt, llms.txt and sitemaps reachable by the proxy.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
```

## Express

```ts
import express from "express";
import { createExpressAICrawlerMiddleware } from "@datagoat/ai-crawl";

const app = express();
app.use(createExpressAICrawlerMiddleware({ websiteId: "dfid_******", apiUrl: "https://analytics.example.com" }));
```

The middleware calls `next()` immediately and reports after the response has been sent.

## Hono or any Request/Response handler

```ts
import { trackAICrawlerResponse } from "@datagoat/ai-crawl";

app.use("*", async (c, next) => {
  await next();
  trackAICrawlerResponse(c.req.raw, c.res, c.executionCtx, { websiteId, apiUrl });
});
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `websiteId` | required | Your public tracking id (`data-website-id`). |
| `apiUrl` | required | Origin of your DataGoat install. |
| `authToken` | – | `dfbot_` token from the Bot traffic settings. Keep it server-side. |
| `publicOrigin` | – | Public origin to report when your runtime sees `localhost`/`0.0.0.0`. |
| `includeQuery` | `false` | Report the query string (may contain personal data). |
| `disableAnswerFetch`, `disableSearchCrawlers`, `disableTrainingCrawlers`, `disableOtherCrawlers` | `false` | Skip a category before sending. |
| `getIp` | header chain | Return the client IP yourself. By default `cf-connecting-ip`, then `x-vercel-forwarded-for`, `x-real-ip`, `x-forwarded-for` are used: only trust forwarding headers your own proxy sets. |
| `timeoutMs` | `1500` | Report timeout. |
| `fetch` | global fetch | Custom fetch. |
| `debug` | `false` | Log failures with `console.warn`. |

## Request authentication

Create a token in DataGoat (Bot traffic → settings → Request token), deploy it as `authToken`,
then enable "Reject unauthenticated requests". Rotating the token invalidates the old one at once;
deleting it turns enforcement off.

## Without Node.js

Any backend can `POST https://<your DataGoat>/api/ai-crawls` with
`{"websiteId", "domain", "href", "ai": {"userAgent", "ip", "statusCode", "source": "server_middleware"}}`
and an optional `Authorization: Bearer dfbot_…` header. See DataGoat's `docs/growth/bot-traffic.md`.

MIT licensed.
