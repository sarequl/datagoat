# X and Reddit mentions, X link attribution

## Mentions

The **Mentions** page lists posts on X and Reddit that mention your domain (always tracked) or the
keywords you add in its Settings tab (4–15 characters each, case insensitive, `@handle` and
`#hashtag` allowed; the same list is used for both networks). The `mentions.sync` job checks every
30 minutes, three websites per run, and stores only new posts. Read them with DataFast's API:
`GET /api/v1/mentions?startAt&endAt&q&platform&limit&offset&order` (`analytics:read`). DataGoat has
no plan tiers, so results are never sampled (`meta.sampled: false`).

- **X** uses the API v2 recent search (`url:"<domain>"`, the domain and your keywords). It needs an
  X API access level that includes search. Either set `X_BEARER_TOKEN` (app-only bearer token for the
  whole install), paste a bearer token in the Mentions settings, or connect with OAuth 2.0 by
  setting `X_CLIENT_ID` and `X_CLIENT_SECRET` and clicking "Connect with X" (scopes `tweet.read
  users.read offline.access`; tokens refresh automatically).
- **Reddit** works without setup through the public search listing. For higher rate limits create a
  Reddit app and set `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` (app-only OAuth).

## X link attribution

Visitors from X arrive with a `t.co` referrer. While searching for mentions DataGoat records which
post each `t.co` link that points to your site belongs to. For links in profiles, add the handles
whose bio links to your site (your own or affiliates) under **Link-in-bio handles**; they are
checked once a day. `GET /api/v1/x/links` (and the "X link attribution" tab) then shows visitors,
revenue and payments per post or profile; visits whose `t.co` link was not found yet are grouped as
"Not matched". Revenue follows the website's attribution model.
