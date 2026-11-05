-- W1 (tracker & ingest): DataFast compatibility per website.
--
-- When on, the tracker also writes DataFast's `datafast_*` cookies next to `datagoat_*`, so
-- checkout code written for DataFast (reading `datafast_visitor_id`) keeps working. Ingest turns
-- it on the first time a browser reports an existing `datafast_visitor_id` cookie (one write per
-- website, ever); owners can switch it in Tracking settings. No index: read with the site row.
-- Values: 0 = not detected yet, 1 = on, 2 = turned off by the owner (never turned on again
-- automatically).
ALTER TABLE sites ADD COLUMN datafast_compat INTEGER NOT NULL DEFAULT 0;
