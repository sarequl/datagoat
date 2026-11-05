# Installing the tracking script

After first-run setup, or after **Add website** in the website switcher, the dashboard opens
**Settings > Installation** for the new website. The same page is always available from the
settings tabs. It has four steps.

1. **Website details.** Domain, timezone and currency. The timezone decides where a reporting day
   starts; revenue from every provider is converted to the currency.
2. **Add the tracking script.** Copy the snippet for your platform: HTML, Next.js, React, Vue / Nuxt,
   WordPress, Webflow, Framer, Shopify, Google Tag Manager, or "Switch from DataFast".
3. **Verify the installation.** The page checks for visitors every 5 seconds and turns green when
   the first event arrives. Open your site in another tab to send one.
4. **Connect revenue.** Links to each payment provider on the Integrations page.

## The snippet

```html
<script
  defer
  data-website-id="dgid_…"
  data-domain="example.com"
  data-api-url="https://<your DataGoat host>/api/events"
  src="https://<your DataGoat host>/js/script.js"
></script>
```

It uses DataFast's attributes. DataGoat always sets `data-api-url`, so events reach the Worker
whichever host serves the script.

- **Cookieless websites** load `script.cookieless.js`. The snippet follows the privacy mode set under
  **Tracking & privacy**. If you change the mode, replace the tag on your site.
- **Hash routing** (`example.com/#/pricing`): tick "Hash-based routing" under Script options to load
  `script.hash.js`.
- **Localhost**: "Track localhost while developing" adds `data-allow-localhost="true"`. Remove it
  in production.
- **Other domains**: hostnames listed under Tracking & privacy > Allowed hostnames are added as
  `data-allowed-hostnames`, so visitor IDs carry across them.
- **Consent mode**: add the queue stub before the tag, then call `window.datagoat("consent", true)`
  after the visitor accepts, or `false` if they decline. The page shows both snippets.

### Switching from DataFast

Keep your tag and change four things: `src` (to this instance's `/js/script.js`), `data-website-id`
(to the new ID), a new `data-api-url`, and add `data-compat="datafast"`. With that attribute the
tracker also writes the `datafast_visitor_id` cookie, so `window.datafast(...)` calls,
`data-fast-goal` attributes and checkout code that reads `datafast_*` cookies keep working. New
sites use DataGoat's own names (`datagoat_visitor_id`, `window.datagoat(...)`). Server code that uses
DataFast's API needs this instance's `/api/v1` base URL and a DataGoat API key.

## First-party script domain

Ad blockers often block analytics hosts. Because DataGoat runs on your Cloudflare account, you
can serve it from a subdomain of your own site with no proxy code:

1. In the Cloudflare dashboard open **Workers & Pages**, pick the DataGoat Worker, then **Settings >
   Domains & Routes > Add > Custom domain**.
2. Enter a neutral subdomain such as `a.example.com`. Avoid names like `analytics` or `tracking`.
   The domain's DNS must be on Cloudflare; the certificate is issued automatically.
3. On the Installation page open **Script options**, set **Script host** to
   `https://a.example.com` and copy the new tag. The browser remembers this choice per website.

If the site's DNS is not on Cloudflare, proxy `/js/script.js` and `/api/events` through your own
server to the Worker, then set Script host to your site's origin.

## When nothing shows up

- `data-domain` and `data-website-id` must match the values in the snippet.
- Visits from localhost are ignored unless `data-allow-localhost="true"` is set.
- Ad blockers, and browsers where `localStorage.datagoat_ignore` is set, send nothing.
- A Content-Security-Policy must allow the DataGoat host in `script-src` and `connect-src`.
- Hostnames other than the domain and its subdomains must be in Allowed hostnames.
- Check that your IP, country or page is not listed under Exclusions.

## Excluding your own visits

Open your site, open the browser console and run `localStorage.datagoat_ignore = 'true'`. Run
`delete localStorage.datagoat_ignore` to be counted again (DataFast's `datafast_ignore` is also
respected). Do this for each browser and subdomain.
To exclude an office or VPN, add its IP addresses under **Exclusions**. "Add my current IP" reads
your public IP from Cloudflare's `/cdn-cgi/trace` on the dashboard's own host.
