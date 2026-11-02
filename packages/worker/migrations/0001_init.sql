-- DataGoat initial schema (Milestone 1).
--
-- Source: design/worker.md §3, plus design/attribution.md §5.4 (`webhook_events`).
-- All timestamps are INTEGER unix seconds unless noted. JSON is stored as TEXT and
-- parsed in the Worker. No FOREIGN KEY constraints: D1 does not enforce them by
-- default and referential integrity is checked in application code.

-- ---------------------------------------------------------------------------
-- Tenancy and auth
-- ---------------------------------------------------------------------------

CREATE TABLE websites (
  id                TEXT PRIMARY KEY,
  site_token        TEXT NOT NULL,
  name              TEXT NOT NULL,
  domain            TEXT NOT NULL,
  timezone          TEXT NOT NULL DEFAULT 'UTC',
  currency          TEXT NOT NULL DEFAULT 'USD',
  owner_user_id     TEXT,
  privacy_mode      TEXT NOT NULL DEFAULT 'cookies',
  allow_cookieless  INTEGER NOT NULL DEFAULT 1,
  allowed_hosts     TEXT NOT NULL DEFAULT '[]',
  excluded_ips      TEXT NOT NULL DEFAULT '[]',
  excluded_paths    TEXT NOT NULL DEFAULT '[]',
  excluded_ua       TEXT NOT NULL DEFAULT '[]',
  hash_paths        INTEGER NOT NULL DEFAULT 0,
  attribution_model TEXT NOT NULL DEFAULT 'last_non_direct',
  retention_days    INTEGER NOT NULL DEFAULT 365,
  bot_filter_level  TEXT NOT NULL DEFAULT 'standard',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_websites_domain ON websites (domain);
CREATE UNIQUE INDEX idx_websites_token ON websites (site_token);

CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  display_name   TEXT,
  is_owner       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  last_login_at  INTEGER
);
CREATE UNIQUE INDEX idx_users_email ON users (email);

-- Token table frozen by ROADMAP decision D6: one table, kind = read|ingest|account.
-- Prefixes: dg_read_ / dg_ingest_ / dgt_. Contract source: design/api.md §1.3.
CREATE TABLE api_tokens (
  id             TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL,
  site_id        TEXT,
  kind           TEXT NOT NULL,
  token_hash     TEXT NOT NULL,
  name           TEXT NOT NULL,
  permissions    TEXT NOT NULL DEFAULT '[]',
  site_allowlist TEXT,
  rate_limit     INTEGER NOT NULL DEFAULT 60,
  last_used_at   INTEGER,
  created_at     INTEGER NOT NULL,
  revoked_at     INTEGER
);
CREATE UNIQUE INDEX idx_api_tokens_hash ON api_tokens (token_hash);
CREATE INDEX idx_api_tokens_site ON api_tokens (site_id);
CREATE INDEX idx_api_tokens_account ON api_tokens (account_id);

-- ---------------------------------------------------------------------------
-- Event stream
-- ---------------------------------------------------------------------------

CREATE TABLE events (
  id             TEXT PRIMARY KEY,
  website_id     TEXT NOT NULL,
  event_id       TEXT NOT NULL,
  session_id     TEXT,
  visitor_id     TEXT,
  name           TEXT NOT NULL,
  ts             INTEGER NOT NULL,
  path           TEXT NOT NULL,
  query          TEXT,
  referrer       TEXT,
  channel        TEXT,
  channel_name   TEXT,
  direct_type    TEXT,
  utm_source     TEXT,
  utm_medium     TEXT,
  utm_campaign   TEXT,
  utm_term       TEXT,
  utm_content    TEXT,
  country        TEXT,
  region         TEXT,
  city         TEXT,
  colo           TEXT,
  device_type    TEXT,
  os             TEXT,
  browser        TEXT,
  viewport_w     INTEGER,
  viewport_h     INTEGER,
  screen_width   INTEGER,
  screen_height  INTEGER,
  dpr            REAL,
  language       TEXT,
  tz             TEXT,
  is_bot         INTEGER NOT NULL DEFAULT 0,
  bot_score      INTEGER,
  bot_reason     TEXT,
  group_id       TEXT,
  is_new_visitor INTEGER,
  is_new_session INTEGER,
  consent        INTEGER,
  props          TEXT,
  created_at     INTEGER NOT NULL,
  UNIQUE (website_id, event_id)
);
CREATE INDEX idx_events_site_ts       ON events (website_id, ts);
CREATE INDEX idx_events_site_session  ON events (website_id, session_id, ts);
CREATE INDEX idx_events_site_visitor  ON events (website_id, visitor_id, ts);
CREATE INDEX idx_events_site_name_ts  ON events (website_id, name, ts);
CREATE INDEX idx_events_bot           ON events (website_id, is_bot, ts);

-- ---------------------------------------------------------------------------
-- Derived tables (written by the cron rollup, never by the ingest path)
-- ---------------------------------------------------------------------------

CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,
  website_id      TEXT NOT NULL,
  visitor_id      TEXT,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  duration_s      INTEGER NOT NULL DEFAULT 0,
  pageviews       INTEGER NOT NULL DEFAULT 0,
  events          INTEGER NOT NULL DEFAULT 0,
  entry_path      TEXT,
  exit_path       TEXT,
  referrer        TEXT,
  channel         TEXT,
  channel_name    TEXT,
  direct_type     TEXT,
  utm_source      TEXT,
  utm_medium      TEXT,
  utm_campaign    TEXT,
  first_source    TEXT,
  country         TEXT,
  region          TEXT,
  city            TEXT,
  device_type     TEXT,
  os              TEXT,
  browser         TEXT,
  language        TEXT,
  is_bot          INTEGER NOT NULL DEFAULT 0,
  converted       INTEGER NOT NULL DEFAULT 0,
  revenue_cents   INTEGER NOT NULL DEFAULT 0,
  is_new_visitor  INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_sessions_site_start ON sessions (website_id, started_at);
CREATE INDEX idx_sessions_site_visitor ON sessions (website_id, visitor_id, started_at);
CREATE INDEX idx_sessions_live ON sessions (website_id, ended_at);

CREATE TABLE visitors (
  website_id        TEXT NOT NULL,
  visitor_id        TEXT NOT NULL,
  group_id          TEXT,
  first_seen        INTEGER NOT NULL,
  last_seen         INTEGER NOT NULL,
  first_channel     TEXT,
  first_channel_name TEXT,
  first_referrer    TEXT,
  first_utm_source  TEXT,
  first_utm_medium  TEXT,
  first_utm_campaign TEXT,
  first_landing_path TEXT,
  first_country     TEXT,
  first_device_type TEXT,
  sessions          INTEGER NOT NULL DEFAULT 0,
  pageviews         INTEGER NOT NULL DEFAULT 0,
  identified_user   TEXT,
  is_bot            INTEGER NOT NULL DEFAULT 0,
  is_buyer          INTEGER NOT NULL DEFAULT 0,
  first_purchase_at INTEGER,
  last_purchase_at  INTEGER,
  days_to_purchase  INTEGER,
  visits_to_purchase INTEGER,
  ltv_cents         INTEGER NOT NULL DEFAULT 0,
  currency          TEXT NOT NULL DEFAULT 'USD',
  consent           INTEGER,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (website_id, visitor_id)
);

-- ---------------------------------------------------------------------------
-- Goals and funnels
-- ---------------------------------------------------------------------------

CREATE TABLE goals (
  id            TEXT PRIMARY KEY,
  website_id    TEXT NOT NULL,
  slug          TEXT NOT NULL,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'event',
  config        TEXT,
  is_funnel_end INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_goals_site_slug ON goals (website_id, slug);

CREATE TABLE funnels (
  id          TEXT PRIMARY KEY,
  website_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE funnel_steps (
  id           TEXT PRIMARY KEY,
  funnel_id    TEXT NOT NULL,
  position     INTEGER NOT NULL,
  goal_slug    TEXT NOT NULL,
  window_hours INTEGER NOT NULL DEFAULT 168,
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_funnel_steps ON funnel_steps (funnel_id, position);

-- ---------------------------------------------------------------------------
-- Revenue (Milestone 2 writes these; tables are created now so 0001 is stable)
-- ---------------------------------------------------------------------------

CREATE TABLE payments (
  id                  TEXT PRIMARY KEY,
  website_id          TEXT NOT NULL,
  provider            TEXT NOT NULL,
  provider_payment_id TEXT NOT NULL,
  provider_event_id   TEXT,
  customer_id         TEXT,
  visitor_id          TEXT,
  session_id          TEXT,
  amount_cents        INTEGER NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'USD',
  status              TEXT NOT NULL,
  product_id          TEXT,
  attribution_model   TEXT NOT NULL,
  credited_channel    TEXT,
  credited_channel_name TEXT,
  credited_referrer   TEXT,
  credited_landing_path TEXT,
  is_first_purchase   INTEGER NOT NULL DEFAULT 0,
  raw                 TEXT,
  occurred_at         INTEGER NOT NULL,
  created_at          INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_payments_provider ON payments (website_id, provider, provider_payment_id);
CREATE INDEX idx_payments_site_occurred ON payments (website_id, occurred_at);
CREATE INDEX idx_payments_visitor ON payments (website_id, visitor_id, occurred_at);

CREATE TABLE payment_integrations (
  id               TEXT PRIMARY KEY,
  website_id       TEXT NOT NULL,
  provider         TEXT NOT NULL,
  account_id       TEXT,
  webhook_secret   TEXT,
  last_imported_at INTEGER,
  enabled          INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL,
  UNIQUE (website_id, provider)
);

-- Webhook idempotency ledger (design/attribution.md §5.4).
CREATE TABLE webhook_events (
  website_id  TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  provider    TEXT NOT NULL,
  type        TEXT,
  received_at INTEGER NOT NULL,
  status      TEXT NOT NULL,
  payment_id  TEXT,
  PRIMARY KEY (website_id, event_id)
);

-- ---------------------------------------------------------------------------
-- Materialized reads and alerts
-- ---------------------------------------------------------------------------

CREATE TABLE daily_aggregates (
  website_id TEXT NOT NULL,
  day        TEXT NOT NULL,
  kind       TEXT NOT NULL,
  dim_key    TEXT NOT NULL,
  dim_value  TEXT NOT NULL,
  value      INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (website_id, day, kind, dim_key, dim_value)
);
CREATE INDEX idx_agg_lookup ON daily_aggregates (website_id, day, kind);

CREATE TABLE notes (
  id          TEXT PRIMARY KEY,
  website_id  TEXT NOT NULL,
  day         TEXT NOT NULL,
  body        TEXT NOT NULL,
  author_id   TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE alert_rules (
  id          TEXT PRIMARY KEY,
  website_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,
  channel     TEXT,
  config      TEXT,
  created_at  INTEGER NOT NULL
);
