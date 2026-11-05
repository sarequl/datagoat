# Website settings, team, keys and integrations

Everything here is in the dashboard under the **Website** group of the sidebar, plus **Account** at
the bottom. Owners can change everything. Members can change everything except the team and
deleting the website. Viewers see the same pages read-only.

## Settings

| Tab                   | What you can change                                                                                                                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settings (general)    | Name, domain, timezone, currency, logo URL; **#1 KPI** (revenue, or a goal such as `signup`, with a colour scheme; confirmed in a dialog); weekly email report and traffic-spike email; the tracking snippet, website ID and API website ID |
| Installation          | The onboarding guide: details, platform snippets, live verification, revenue connection ([install.md](install.md))                                                                                                                       |
| Tracking & privacy    | Privacy mode (cookies, cookieless, consent), Global Privacy Control, bot filtering (off, standard, strict = attack mode), allowed hostnames (or any hostname), first-party script domain                                                   |
| Exclusions            | IP addresses and CIDR ranges ("Add my current IP"), pages (`/admin` exact, `/admin/*` everything below), countries, exact hostnames, excluding your own browser                                                                          |
| Attribution & revenue | Attribution model (first touch, last touch, last non-direct touch), include renewal revenue, headline metric (revenue or MRR), store customer names and emails                                                                           |
| Delete website        | Owners only. Type the domain to confirm. Data is removed in the background.                                                                                                                                                               |

Excluded traffic is dropped before it is stored. Never exclude checkout or thank-you pages, or
revenue can no longer be attributed. Whether a privacy mode removes the need for a consent banner
is a legal question for you, not a guarantee.

User-agent exclusions are proposed in the API contract but not implemented by the server yet;
the Exclusions tab shows them only once the server reports the field.

## Team

Owners invite by email with the **viewer** or **member** role. DataGoat does not need an email
provider for this: the page shows a one-time invite link (valid 7 days) to send yourself. Owners can
change roles (including making someone an owner), remove members and revoke pending invites. A
website always keeps at least one owner. Removing a member also stops the `df_` keys they created.

## API keys

- **Website keys (`df_`)**: one website, every website permission, at most 10. Optionally include
  customer names and emails (PII). Roll replaces the secret at once; revoke deletes the key.
- **Account tokens (`dft_`)**: yours, across websites. Choose read-only, full access or custom
  permissions (DataFast's names), all or selected websites, PII, and an expiry. Pass `websiteId`
  on every call. Use them for the CLI, MCP clients and agents.

Secrets are shown once and stored hashed. Members and owners can manage website keys; viewers can
only see them.

## Integrations

### Revenue

| Provider      | What you paste                                    | Notes                                                                                                                                     |
| ------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Stripe        | Restricted key `rk_…`                             | Read access to Charges, Checkout Sessions, Customers, Events, Invoices, Payment Intents, Subscriptions. `sk_` and `pk_` keys are refused. |
| Lemon Squeezy | API key and store ID                              | Pass `checkout[custom][datafast_visitor_id]`.                                                                                             |
| Polar         | Organization access token and organization ID     | Read scopes for orders, subscriptions, customers, checkouts.                                                                              |
| Paddle        | API key `pdl_live_…`                              | The key's expiry date is shown.                                                                                                           |
| Dodo, Creem   | API key, optional webhook signing secret          | The page shows the webhook URL `https://<host>/webhooks/<provider>/<websiteId>`.                                                          |
| Shopify       | Your `*.myshopify.com` domain                     | Opens the DataGoat Shopify app install; the app must be configured for your instance (Shopify app client ID and secret).                 |
| WooCommerce   | Nothing here                                      | Install the DataGoat WordPress plugin and enter this instance's URL, the website ID and a website key.                                   |

Credentials are checked with the provider, then stored encrypted (AES-GCM with `ENCRYPTION_KEY`).
Each connected provider shows its account, last sync, whether past payments are still importing and
the last error, with **Re-sync** and **Disconnect**.

### Growth

Google Search Console, GitHub, X and Reddit mentions, and Meta Ads can connect through the
provider's OAuth flow (`/api/connect/<integration>/start`) once the operator has registered an OAuth
app with the provider and set its client ID and secret on the Worker. Without that, the card says
which variables are missing instead of offering a Connect button, and GitHub and Meta Ads still
connect with a pasted token:

- Search Console: the property (`sc-domain:example.com` or a URL prefix). OAuth only.
- GitHub: the repository as `owner/name` and an optional branch. A public repository needs nothing
  else; for a private one paste a fine-grained token (*Contents: read*, *Metadata: read*). Once saved,
  the card shows the push webhook URL (`/webhooks/github/<websiteId>`) and its signing secret.
- X and Reddit: keywords (4 to 15 characters, shared by both searches) and link-in-bio handles. Your
  domain is always searched.
- Meta Ads: ad account IDs and campaign IDs (and, without OAuth, a system-user access token with
  `ads_read`), plus the recommended UTM template for your ads.

## Share link

Turn on a public, read-only dashboard at `/share/<token>`. Copy or open the link, create a new link
(the old one stops working), or turn sharing off. Revenue is hidden unless you switch on "Show
revenue". Visitor profiles, customer details, notes and settings are never shown. The public page
has an **Overview** and a **Live map** view (the real-time globe or map, the live visitor list and
event log, without names or journeys; payments only with "Show revenue").

### Widgets

While sharing is on, the **Widgets** card generates an `<iframe>` you can paste into any page:
*Visitors* or *Revenue* for the last 24 hours, 7 or 30 days with a trend line, *Visitors online
now*, or a *Visitors chart*, in a dark or light theme, with your colour and size. The widget is
served at `/share/<token>/widget?type=&period=&theme=&color=` (the only DataGoat page other sites
may frame) and reads the public share API, so creating a new share link or turning sharing off
stops every widget. Revenue widgets show a dash unless revenue is shared. Each widget view costs a
few Worker requests and D1 reads (cached for 60 seconds on a custom domain), so keep that in mind on
very busy pages.

## Usage & data

DataGoat runs in your Cloudflare account, so the page compares this website's last 24 hours with
Cloudflare's limits: estimated D1 rows written against the daily allowance (100,000 on Free), tracked
events against the Free plan's 100,000 Worker requests per day, and the D1 database size against
its cap (500 MB on Free, 10 GB on Paid). It warns at 70% of the database size.

**Data retention** deletes raw events older than N days (30 to 36500, or keep forever) in the daily
clean-up. Sessions, visitors and payments are kept, so attribution survives. Shortening retention
asks for confirmation.

## Account

Change your name and password (other sessions are signed out), **Sign out everywhere** (every
browser session, including this one; API keys keep working), see your websites and roles, and revoke
AI apps connected through MCP sign-in.
