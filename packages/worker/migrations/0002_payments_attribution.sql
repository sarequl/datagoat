-- DataGoat Milestone 2 — revenue attribution schema.
--
-- Source: design/attribution.md §5, §6, §9. This migration is strictly
-- additive: 0001_init.sql is untouched. `payments` and `webhook_events`
-- already exist there; this file adds the attribution columns and the new
-- identity/FX tables.
--
-- All amounts are INTEGER minor units (cents/paise) in the currency the
-- customer paid in. All timestamps are INTEGER unix seconds. JSON is stored
-- as TEXT and parsed in the Worker.

-- ---------------------------------------------------------------------------
-- customers — identity bridge (attribution.md §1.4)
-- ---------------------------------------------------------------------------
-- Resolution is many-to-one: one email can map to several visitor_ids over
-- time (shared laptops, cookie clears). `customers` keeps the most recent
-- mapping as the active row; `customer_links` keeps the full history so LTV
-- can be re-computed under a different merge policy (§9.2).

CREATE TABLE customers (
  id                   TEXT PRIMARY KEY,
  website_id           TEXT NOT NULL,
  email                TEXT,
  visitor_id           TEXT,
  provider             TEXT NOT NULL,
  provider_customer_id TEXT,
  first_seen_at        INTEGER NOT NULL,
  last_seen_at         INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_customers_email    ON customers (website_id, email);
CREATE UNIQUE INDEX idx_customers_provider ON customers (website_id, provider, provider_customer_id);
CREATE INDEX        idx_customers_visitor  ON customers (website_id, visitor_id);

CREATE TABLE customer_links (
  id                   TEXT PRIMARY KEY,
  website_id           TEXT NOT NULL,
  email                TEXT,
  visitor_id           TEXT,
  provider             TEXT NOT NULL,
  provider_customer_id TEXT,
  linked_at            INTEGER NOT NULL
);
CREATE INDEX idx_customer_links_email    ON customer_links (website_id, email, linked_at);
CREATE INDEX idx_customer_links_visitor  ON customer_links (website_id, visitor_id, linked_at);

-- ---------------------------------------------------------------------------
-- payments — attribution columns (attribution.md §5.1)
-- ---------------------------------------------------------------------------
-- Legacy Milestone 1 columns are kept and written where they overlap, so the
-- M1 schema stays valid:
--   amount_cents     = amount_minor
--   customer_id      = provider_customer_id
--   credited_channel = the channel of websites.attribution_model
-- The three *_touch_* / *_non_direct_* sets are the authoritative credit
-- snapshot; `credited_*` is the legacy single-model view.

ALTER TABLE payments ADD COLUMN provider_customer_id      TEXT;
ALTER TABLE payments ADD COLUMN provider_subscription_id TEXT;
ALTER TABLE payments ADD COLUMN provider_subscription_ids TEXT;
ALTER TABLE payments ADD COLUMN email                    TEXT;
ALTER TABLE payments ADD COLUMN join_method              TEXT;
ALTER TABLE payments ADD COLUMN join_confidence          REAL;
ALTER TABLE payments ADD COLUMN gross_minor              INTEGER;
ALTER TABLE payments ADD COLUMN tax_minor                INTEGER;
ALTER TABLE payments ADD COLUMN discount_minor           INTEGER;
ALTER TABLE payments ADD COLUMN amount_minor             INTEGER;
ALTER TABLE payments ADD COLUMN amount_usd_minor         INTEGER;
ALTER TABLE payments ADD COLUMN refunded_minor           INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN disputed_minor           INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN disputed_at              INTEGER;
ALTER TABLE payments ADD COLUMN kind                     TEXT;
ALTER TABLE payments ADD COLUMN product_name             TEXT;
ALTER TABLE payments ADD COLUMN plan_id                  TEXT;
ALTER TABLE payments ADD COLUMN attribution_window_days  INTEGER;
ALTER TABLE payments ADD COLUMN attributed               INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN first_touch_channel      TEXT;
ALTER TABLE payments ADD COLUMN first_touch_source       TEXT;
ALTER TABLE payments ADD COLUMN first_touch_medium       TEXT;
ALTER TABLE payments ADD COLUMN first_touch_campaign     TEXT;
ALTER TABLE payments ADD COLUMN first_touch_at           INTEGER;
ALTER TABLE payments ADD COLUMN last_touch_channel       TEXT;
ALTER TABLE payments ADD COLUMN last_touch_source        TEXT;
ALTER TABLE payments ADD COLUMN last_touch_medium        TEXT;
ALTER TABLE payments ADD COLUMN last_touch_campaign      TEXT;
ALTER TABLE payments ADD COLUMN last_touch_at            INTEGER;
ALTER TABLE payments ADD COLUMN last_non_direct_channel  TEXT;
ALTER TABLE payments ADD COLUMN last_non_direct_source   TEXT;
ALTER TABLE payments ADD COLUMN last_non_direct_medium   TEXT;
ALTER TABLE payments ADD COLUMN last_non_direct_campaign TEXT;
ALTER TABLE payments ADD COLUMN last_non_direct_at       INTEGER;
ALTER TABLE payments ADD COLUMN last_non_direct_fallback INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN touch_count              INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN primary_model            TEXT;
ALTER TABLE payments ADD COLUMN updated_at               INTEGER;
ALTER TABLE payments ADD COLUMN reattributed_at          INTEGER;

CREATE INDEX idx_payments_email        ON payments (website_id, email);
CREATE INDEX idx_payments_customer     ON payments (website_id, provider_customer_id);
CREATE INDEX idx_payments_first_touch  ON payments (website_id, first_touch_channel, occurred_at);
CREATE INDEX idx_payments_last_touch   ON payments (website_id, last_touch_channel, occurred_at);
CREATE INDEX idx_payments_lnd          ON payments (website_id, last_non_direct_channel, occurred_at);

-- ---------------------------------------------------------------------------
-- visitors — attribution fields (attribution.md §5.3)
-- ---------------------------------------------------------------------------
-- worker.md's `visitors` already carries first_channel / first_channel_name /
-- first_referrer / first_utm_* / ltv_cents / is_buyer / first_purchase_at.
-- This adds the first-touch anchor and the denormalised revenue cache that
-- §9.1 requires to be recomputed from `payments` on refund / re-attribution.

ALTER TABLE visitors ADD COLUMN first_touch_at INTEGER;
ALTER TABLE visitors ADD COLUMN payment_count  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE visitors ADD COLUMN revenue_minor  INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- fx_rates — cross-currency rollup (attribution.md §5.5)
-- ---------------------------------------------------------------------------
-- Filled by a daily job. If a rate is missing, `payments.amount_usd_minor`
-- stays null and that payment is excluded from USD LTV with a visible
-- "missing FX" counter.

CREATE TABLE fx_rates (
  date     TEXT NOT NULL,
  currency TEXT NOT NULL,
  usd_rate REAL NOT NULL,
  PRIMARY KEY (date, currency)
);

-- ---------------------------------------------------------------------------
-- attribution_events — read alias over `events` (attribution.md §5.2)
-- ---------------------------------------------------------------------------
-- §5.2 says attribution_events is the attribution subset of worker.md's
-- `events` table and must not be a second table. This view exposes the spec's
-- names (occurred_at, source/medium/campaign, page_path) over `events`.
-- Queries may read either name; the view keeps the spec's vocabulary stable.

CREATE VIEW attribution_events AS
SELECT
  website_id,
  event_id,
  visitor_id,
  session_id,
  ts           AS occurred_at,
  channel,
  utm_source   AS source,
  utm_medium   AS medium,
  utm_campaign AS campaign,
  utm_content  AS content,
  utm_term     AS term,
  referrer,
  path         AS page_path,
  query,
  is_bot,
  consent,
  created_at   AS received_at
FROM events;
