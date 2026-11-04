# Import from Plausible

Keep your history when moving from Plausible.

1. In Plausible open the site's settings → **Imports & Exports** → **Export data** (not the export
   button on the chart) and download the .zip from the email.
2. In DataGoat open **Import**, choose the file and click **Start import**.

The file is parsed in your browser and uploaded in chunks of 1,000 rows, which keeps each request
small enough for the Free plan. Imported: daily visitors, visits, pageviews, bounces and visit
duration; sources (shown as referrers), UTM source/medium/campaign/term/content; pages, entry and
exit pages; countries and regions (cities are kept as Plausible's GeoNames ids); devices, browsers
and operating systems. Custom events and goals are not imported: set up goals again.

Imported days are used for the period **before** your first DataGoat-tracked visit, so a period
covered by both is never counted twice. Removing an import deletes its data.

## API

- `POST /api/v1/admin/websites/:id/imports {"source": "plausible", "fileName"}` → job
- `POST …/imports/:importId/rows {"rows": [{day, dimension, value, visitors, visits, pageviews,
  bounces, durationSum}]}` (≤ 1000 rows, `durationSum` in milliseconds, `dimension: ""` with
  `value: ""` for daily totals) → `[{accepted}]`; rows with the same key are added up
- `POST …/imports/:importId/complete`, `GET …/imports[/:importId]`, `DELETE …/imports/:importId`
- `POST …/imports/:importId/file` with the .zip as the body parses it on the server (≤ 10 MB and
  20,000 rows; larger exports must use the dashboard, since parsing costs Worker CPU).

The parser (`src/growth/imports/plausible.ts`, ZIP reader in `zip.ts`) uses only Web APIs
(`DecompressionStream`, `TextDecoder`), so the same code runs in the Worker and the browser.
Each imported row is one row written in D1.
