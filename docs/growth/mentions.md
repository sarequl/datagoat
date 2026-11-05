# X and Reddit mentions, X link attribution

## Mentions

The **Mentions** page lists posts on X and Reddit that mention your domain (always tracked) or the
keywords you add in its Settings tab (4–15 characters each, case insensitive, `@handle` and
`#hashtag` allowed; the same list is used for both networks). The `mentions.sync` job checks every
30 minutes, three websites per run, and stores only new posts. Read them with DataFast's API:
`GET /api/v1/mentions?startAt&endAt&q&platform&limit&offset&order` (`analytics:read`). DataGoat has
no plan tiers, so results are never sampled (`meta.sampled: false`).

- **X** uses the API v2 recent search (`url:"<domain>"`, the domain and your keywords). It needs an
  X API access level that includes search, which is paid: X bills pay-per-use credits for each post
  a search returns (check current prices in the X developer console). DataGoat asks only for posts
  newer than the last one it saw (`since_id`), up to 100 per run, every 30 minutes, so the bill
  follows how often you are mentioned. Get a bearer token from your app's **Keys and tokens** page
  at developer.x.com. Either set `X_BEARER_TOKEN` (app-only bearer token for the
  whole install), paste a bearer token in the Mentions settings, or connect with OAuth 2.0 by
  setting `X_CLIENT_ID` and `X_CLIENT_SECRET` and clicking "Connect with X" (scopes `tweet.read
  users.read offline.access`; tokens refresh automatically).
- **Reddit** needs a Reddit app: Reddit answers anonymous requests from servers, Cloudflare
  included, with a 403 block page. Create a "script" or "web" app at reddit.com/prefs/apps, request
  Data API access if Reddit asks for it, and set `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` as
  Worker secrets (app-only OAuth). Until then Reddit is skipped and the Mentions settings say so.

## X link attribution

Visitors from X arrive with a `t.co` referrer. While searching for mentions DataGoat records which
post each `t.co` link that points to your site belongs to. For links in profiles, add the handles
whose bio links to your site (your own or affiliates) under **Link-in-bio handles**; they are
checked once a day. `GET /api/v1/x/links` (and the "X link attribution" tab) then shows visitors,
revenue and payments per post or profile; visits whose `t.co` link was not found yet are grouped as
"Not matched". Revenue follows the website's attribution model.
