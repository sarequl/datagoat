# Google Search Console

See which Google searches bring visitors, with clicks, impressions, CTR, average position and an
estimated revenue per keyword. Your website must be verified in Search Console and the Google
account you connect needs owner or full-user access to the property.

## Set up the Google OAuth client (once per install)

1. In Google Cloud Console create a project, enable the **Google Search Console API**, and configure
   the OAuth consent screen (scope `…/auth/webmasters.readonly`).
2. Create an OAuth client of type *Web application* with the redirect URI
   `https://<your DataGoat host>/api/connect/google-search-console/callback`.
3. `wrangler secret put GOOGLE_CLIENT_ID` and `wrangler secret put GOOGLE_CLIENT_SECRET`.

Then open **Search Console → Connect with Google**. DataGoat picks the Domain property
(`sc-domain:example.com`) or a URL-prefix property for the domain; change it in the property menu.
Refresh tokens are stored encrypted and access tokens refresh automatically.

## Sync

`gsc.sync` runs hourly. Once a day it refreshes the three most recent final days; it also backfills
two older days per run up to Search Console's 16 months. Each day stores the daily totals and the
top `GSC_ROWS_PER_DAY` (default 500) query × page rows, sorted by clicks. Search data appears with
Google's usual 2–3 day delay.

## Endpoints (DataGoat)

- `GET /api/v1/search-console?groupBy=query|page&filter_page=contains:/blog&startAt&endAt&limit&offset`
  → keywords or pages. `filter_page` (DataFast filter syntax) keeps keywords that brought traffic
  to matching pages.
- `GET /api/v1/search-console/overview` → totals, daily series and the previous period.
- `GET /api/v1/search-console/status` → connection, property, the properties the account can
  read, imported date range and backfill progress.

**Estimated revenue:** for each landing page, revenue per Organic Search session (payments
attributed to those sessions by the website's attribution model) times the clicks a keyword sent
to that page, summed over pages.
