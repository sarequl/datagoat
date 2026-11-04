# Meta Ads ROAS

Combine Facebook and Instagram ad spend with the revenue DataGoat attributes to each campaign.

## Connect

Either:

- **OAuth:** create a Meta app (Business type) with Facebook Login and the Marketing API, request
  `ads_read`, add the redirect URI `https://<host>/api/connect/meta-ads/callback`, set `META_APP_ID`
  and `META_APP_SECRET`, then click **Connect Meta Ads**. DataGoat exchanges the login for a
  long-lived (about 60 days) token; reconnect when the page reports it expired.
- **System user token:** in Business Manager create a system user with `ads_read` on your ad
  accounts and paste its token on the Ads page (`PUT …/integrations/meta-ads {"accessToken"}`).
  These tokens do not expire.

With `META_APP_SECRET` set every Graph API call carries `appsecret_proof`. Then choose the
campaigns to track on the Ads page (`GET /api/v1/ads/accounts` lists accounts and campaigns).

## Tag your ads

Add URL parameters to every ad, for example
`utm_source=meta&utm_medium=paid-social&utm_campaign={{campaign.id}}&utm_content={{ad.id}}`.
A visit counts for a campaign when `utm_campaign` equals its id or name (any case) or contains its
name, and the visit looks like Meta traffic (utm_source meta/facebook/fb/instagram/ig, a paid
social utm_medium, the Paid Social channel or an `fbclid`). Exact matches win; each visit counts
once.

## Data

`meta.sync` runs hourly: the first runs backfill 90 days in 30-day windows, then it refreshes the
last three days. `GET /api/v1/ads/campaigns` returns spend, impressions, clicks, visitors, payments,
revenue, ROAS and Meta's own purchase value per campaign; `GET /api/v1/ads/summary` returns the
totals used for the ROAS KPI. Spend in another currency is converted with the latest ECB rate
stored by the revenue module (`currencyConverted: false` when no rate is available yet).
DataGoat counts only revenue it can attribute, so numbers differ from Ads Manager's modelled
conversions.
