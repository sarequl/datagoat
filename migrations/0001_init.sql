-- DataGoat schema, migration 0001 (foundation, F0).
--
-- Conventions (docs/architecture/data-model.md has the full reference):
--   * Every timestamp is INTEGER epoch milliseconds (UTC). Calendar days are TEXT 'YYYY-MM-DD'
--     in the site's timezone unless a column says otherwise.
--   * Money is INTEGER minor units (cents) with its ISO 4217 currency next to it.
--   * JSON is stored as TEXT. Booleans are INTEGER 0/1.
--   * Ids are TEXT: 24-hex ObjectId-like ids (src/lib/ids.ts) unless the column says otherwise.
--   * Analytics tables are keyed by site_id first and are WITHOUT ROWID where the primary key is
--     the access path.
--   * Write budget (plan §7): D1 bills one written row per table row plus one per index entry
--     touched. Indexes exist only where a real query needs them; the hot ingest path writes about
--     4 rows per pageview. test/worker/schema-write-budget.test.ts guards this.
--   * Feature teams add tables/columns only in their own migration ranges (docs/CONTRACTS.md).

-- ---------------------------------------------------------------------------------------------
-- Instance
-- ---------------------------------------------------------------------------------------------

-- Key/value settings for the whole install (setup completion, public base URL, email sender).
CREATE TABLE instance_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------------------------
-- Sites (websites) and their settings
-- ---------------------------------------------------------------------------------------------

CREATE TABLE sites (
  id TEXT PRIMARY KEY,                       -- `_id` / `websiteId` in the API
  public_id TEXT NOT NULL UNIQUE,            -- `trackingId`, the script's data-website-id
  domain TEXT NOT NULL,
  name TEXT,
  logo TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  currency TEXT NOT NULL DEFAULT 'USD',      -- reporting currency (ISO 4217)
  privacy_mode TEXT NOT NULL DEFAULT 'cookie'
    CHECK (privacy_mode IN ('cookie', 'cookieless', 'consent')),
  attribution_model TEXT NOT NULL DEFAULT 'first_touch'
    CHECK (attribution_model IN ('first_touch', 'last_touch', 'last_non_direct')),
  bot_level TEXT NOT NULL DEFAULT 'standard'
    CHECK (bot_level IN ('off', 'standard', 'strict')), -- 'strict' == DataFast attack mode
  honor_gpc INTEGER NOT NULL DEFAULT 1,      -- Sec-GPC: 1 hits are processed cookieless
  allowed_hostnames TEXT NOT NULL DEFAULT '[]',   -- JSON string[]
  all_hostnames_allowed INTEGER NOT NULL DEFAULT 0,
  excluded_ips TEXT NOT NULL DEFAULT '[]',        -- JSON string[]: IPs and CIDRs
  excluded_paths TEXT NOT NULL DEFAULT '[]',      -- JSON string[]: exact paths and `/x/*` globs
  excluded_countries TEXT NOT NULL DEFAULT '[]',  -- JSON string[]: ISO 3166-1 alpha-2 codes
  excluded_hostnames TEXT NOT NULL DEFAULT '[]',  -- JSON string[]: exact hostnames
  kpi TEXT,                                  -- #1 KPI: a goal name, or NULL for revenue
  kpi_color_scheme TEXT,
  revenue_metric TEXT NOT NULL DEFAULT 'revenue',
  include_renewal_revenue INTEGER NOT NULL DEFAULT 1,
  store_customer_emails INTEGER NOT NULL DEFAULT 1,
  retention_days INTEGER,                    -- prune `events` older than N days; NULL keeps all
  send_weekly_reports INTEGER NOT NULL DEFAULT 0,
  send_viral_traffic_alerts INTEGER NOT NULL DEFAULT 0,
  share_token TEXT UNIQUE,                   -- public dashboard link token; NULL = disabled
  public_data_enabled INTEGER NOT NULL DEFAULT 0, -- isPublicDataEnabled (widgets)
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER                         -- soft delete; the purge job removes data in chunks
);

-- ---------------------------------------------------------------------------------------------
-- Users, roles, sessions, invites
-- ---------------------------------------------------------------------------------------------

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,                -- stored lowercase
  password_hash TEXT NOT NULL,               -- pbkdf2_sha256$<iterations>$<salt>$<hash>
  name TEXT,
  image TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  password_changed_at INTEGER NOT NULL
);

CREATE TABLE memberships (
  site_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member', 'viewer')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, user_id)
) WITHOUT ROWID;
CREATE INDEX memberships_user ON memberships (user_id);

-- Dashboard sessions. The cookie carries a random token plus an HMAC; only its SHA-256 is stored.
CREATE TABLE auth_sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT,
  ip_country TEXT
) WITHOUT ROWID;
CREATE INDEX auth_sessions_user ON auth_sessions (user_id);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  email TEXT NOT NULL,                       -- lowercase
  role TEXT NOT NULL CHECK (role IN ('member', 'viewer')),
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  revoked_at INTEGER
);
CREATE UNIQUE INDEX invites_pending ON invites (site_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- One-time password reset links, created by `npm run reset-password` (no email needed).
CREATE TABLE password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------------------------
-- API credentials: df_ website keys and dft_ account tokens (hashed)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('df', 'dft')),
  site_id TEXT,                              -- df_: the one website; dft_: NULL
  user_id TEXT NOT NULL,                     -- creator/owner
  name TEXT,
  key_hash TEXT NOT NULL UNIQUE,             -- SHA-256 hex of the full secret
  key_prefix TEXT NOT NULL,                  -- first 8 characters, e.g. df_ab123
  display_key TEXT NOT NULL,                 -- masked, e.g. df_ab...xyz9
  permissions TEXT NOT NULL DEFAULT '["*"]', -- JSON Grant[]
  website_ids TEXT NOT NULL DEFAULT '[]',    -- dft_: JSON string[]; [] = every accessible site
  include_pii INTEGER NOT NULL DEFAULT 0,    -- may read customer names/emails
  is_mobile INTEGER NOT NULL DEFAULT 0,      -- created for the mobile app; hidden from lists
  oauth_connection_id TEXT,                  -- minted through an MCP OAuth connection (W7)
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,                      -- updated lazily (at most every 10 minutes)
  usage_count INTEGER NOT NULL DEFAULT 0,    -- approximate; flushed with last_used_at
  revoked_at INTEGER
);
CREATE INDEX api_keys_site ON api_keys (site_id) WHERE site_id IS NOT NULL;
CREATE INDEX api_keys_user ON api_keys (user_id);

-- ---------------------------------------------------------------------------------------------
-- MCP OAuth 2.1 server (W7)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,                       -- client_id (or the metadata document URL)
  secret_hash TEXT,                          -- confidential clients only
  name TEXT,
  redirect_uris TEXT NOT NULL,               -- JSON string[]
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
  grant_types TEXT NOT NULL DEFAULT '["authorization_code","refresh_token"]',
  metadata_url TEXT,
  metadata TEXT,                             -- JSON registration metadata
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);

-- An approved consent: user + client + scopes + websites.
CREATE TABLE oauth_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scopes TEXT NOT NULL,                      -- JSON string[]
  site_ids TEXT NOT NULL,                    -- JSON string[]
  resource TEXT NOT NULL,                    -- exact MCP resource URL
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX oauth_connections_user ON oauth_connections (user_id);

CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  resource TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
) WITHOUT ROWID;

CREATE TABLE oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  connection_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  rotated_at INTEGER,                        -- refresh tokens: when it was exchanged
  revoked_at INTEGER
) WITHOUT ROWID;
CREATE INDEX oauth_tokens_connection ON oauth_tokens (connection_id);

-- Replay protection for retried writes (MCP write tools, notes idempotencyKey, ...).
CREATE TABLE idempotency_keys (
  scope TEXT NOT NULL,                       -- e.g. 'mcp:<connectionId>', 'notes:<siteId>:<userId>'
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER,
  response TEXT,                             -- JSON; never contains newly issued secrets
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------------------------
-- Raw analytics: visitors, sessions, events (W1 writes, W2 reads)
-- ---------------------------------------------------------------------------------------------

-- Written once per visitor, plus on identify/payment email. Last-seen and session counts derive
-- from `sessions` so pageviews never write here.
CREATE TABLE visitors (
  site_id TEXT NOT NULL,
  id TEXT NOT NULL,                          -- datafast_visitor_id (UUID v4) or cookieless hash
  first_seen_at INTEGER NOT NULL,            -- server time of the first event
  client_first_seen_at INTEGER,              -- visitorFirstSeenAt from the cookie
  first_session_id TEXT NOT NULL,
  user_id TEXT,                              -- identify() user_id
  name TEXT,                                 -- identify() name
  image TEXT,                                -- identify() image
  profile TEXT,                              -- JSON: other identify() fields, shallow-merged
  identified_at INTEGER,
  email TEXT,                                -- only when the site stores customer emails
  email_hash TEXT,                           -- SHA-256 of lowercase email, for payment matching
  PRIMARY KEY (site_id, id)
) WITHOUT ROWID;
CREATE INDEX visitors_user ON visitors (site_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX visitors_email ON visitors (site_id, email_hash) WHERE email_hash IS NOT NULL;

-- Session dimensions come from the first pageview and are never overwritten. Most breakdowns
-- read only this table.
CREATE TABLE sessions (
  site_id TEXT NOT NULL,
  id TEXT NOT NULL,                          -- datafast_session_id ('s' + UUID) or server id
  visitor_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  session_number INTEGER,                    -- visitorSessionNumber; NULL when cookieless
  cookieless INTEGER NOT NULL DEFAULT 0,
  hostname TEXT,                             -- entry hostname
  entry_path TEXT NOT NULL,
  exit_path TEXT,
  pageviews INTEGER NOT NULL DEFAULT 0,
  interactions INTEGER NOT NULL DEFAULT 0,   -- goals and outbound clicks (bounce = total <= 1)
  referrer TEXT,                             -- full referrer URL (external only)
  referrer_domain TEXT,                      -- e.g. 'news.ycombinator.com'; NULL = direct
  channel TEXT NOT NULL,                     -- plan §8.1, e.g. 'Organic Search', 'Direct'
  source TEXT,                               -- display name: 'Google', 'Hacker News', ref value
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_term TEXT,
  utm_content TEXT,
  ref TEXT,                                  -- ?ref=
  source_param TEXT,                         -- ?source=  (filter_source, campaigns.source)
  via TEXT,                                  -- ?via=  (affiliate)
  ad_click_ids TEXT,                         -- JSON {gclid, fbclid, ...}
  country TEXT,                              -- ISO 3166-1 alpha-2
  region TEXT,
  city TEXT,
  lat REAL,
  lon REAL,
  device TEXT,                               -- 'desktop' | 'mobile' | 'tablet'
  browser TEXT,
  browser_version TEXT,
  os TEXT,
  os_version TEXT,
  device_vendor TEXT,
  device_model TEXT,
  language TEXT,
  timezone TEXT,                             -- browser timezone
  screen_width INTEGER,
  screen_height INTEGER,
  viewport_width INTEGER,
  viewport_height INTEGER,
  PRIMARY KEY (site_id, id)
) WITHOUT ROWID;
CREATE INDEX sessions_time ON sessions (site_id, started_at);
CREATE INDEX sessions_visitor ON sessions (site_id, visitor_id, started_at);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  site_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  type TEXT NOT NULL,                        -- pageview | custom | identify | payment | external_link
  hostname TEXT,
  path TEXT,                                 -- includes '#hash' for the hash build
  name TEXT,                                 -- goal name (custom), provider (payment)
  props TEXT                                 -- JSON: goal params, {url,text}, payment refs
);
CREATE INDEX events_time ON events (site_id, ts);

-- ---------------------------------------------------------------------------------------------
-- Revenue (W3)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE payments (
  site_id TEXT NOT NULL,
  id TEXT NOT NULL,
  provider TEXT NOT NULL,                    -- stripe | polar | lemonsqueezy | paddle | dodo | creem | shopify | woocommerce | api
  provider_txn_id TEXT NOT NULL,             -- idempotency key (transaction_id for the API)
  provider_customer_id TEXT,
  provider_event_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('payment', 'renewal', 'refund', 'free_trial')),
  amount_minor INTEGER NOT NULL,             -- original amount; refunds negative
  currency TEXT NOT NULL,                    -- original currency
  reporting_minor INTEGER NOT NULL,          -- converted to the site currency at ingest
  reporting_currency TEXT NOT NULL,
  fx_rate REAL,
  visitor_id TEXT,
  first_session_id TEXT,                     -- first_touch attribution
  last_session_id TEXT,                      -- last_touch attribution
  last_non_direct_session_id TEXT,           -- last_non_direct attribution
  attributed_via TEXT NOT NULL
    CHECK (attributed_via IN ('metadata', 'link', 'customer', 'email', 'api', 'none')),
  customer_email TEXT,                       -- only when the site stores customer emails
  customer_name TEXT,
  email_hash TEXT,
  refund_of TEXT,                            -- provider_txn_id of the refunded payment
  lifecycle_goal TEXT,                       -- e.g. subscription_started
  metadata TEXT,                             -- JSON
  source TEXT NOT NULL DEFAULT 'api'
    CHECK (source IN ('webhook', 'poll', 'backfill', 'api', 'hint', 'import')),
  occurred_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, id),
  UNIQUE (site_id, provider, provider_txn_id)
) WITHOUT ROWID;
CREATE INDEX payments_time ON payments (site_id, occurred_at);
CREATE INDEX payments_visitor ON payments (site_id, visitor_id) WHERE visitor_id IS NOT NULL;
CREATE INDEX payments_unattributed_email ON payments (site_id, email_hash)
  WHERE visitor_id IS NULL AND email_hash IS NOT NULL;

CREATE TABLE provider_connections (
  site_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  credentials_enc TEXT NOT NULL,             -- AES-GCM JSON, aad 'provider:<provider>:<site_id>'
  webhook_secret_enc TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'error', 'disconnected', 'pending')),
  account_id TEXT,                           -- provider account/org/store id
  account_name TEXT,
  currency TEXT,
  settings TEXT NOT NULL DEFAULT '{}',       -- JSON, provider specific
  key_expires_at INTEGER,
  last_synced_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, provider)
) WITHOUT ROWID;

-- Polling/backfill cursors per provider stream (e.g. 'events', 'backfill:charges').
CREATE TABLE provider_sync_state (
  site_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  stream TEXT NOT NULL,
  cursor TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  last_run_at INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, provider, stream)
) WITHOUT ROWID;

-- Provider customer -> visitor, so renewals attribute without metadata.
CREATE TABLE provider_customers (
  site_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, provider, customer_id)
) WITHOUT ROWID;

-- Success-page references reported by the tracker (?session_id=cs_..., ?checkout_id=, ?order_id=).
CREATE TABLE payment_hints (
  site_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  ref TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  resolved_at INTEGER,
  last_error TEXT,
  PRIMARY KEY (site_id, provider, ref)
) WITHOUT ROWID;
CREATE INDEX payment_hints_pending ON payment_hints (created_at) WHERE resolved_at IS NULL;

-- Webhook delivery dedupe (provider event ids). Pruned after 30 days.
CREATE TABLE webhook_events (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (provider, event_id)
) WITHOUT ROWID;

-- Daily reference rates (ECB), expressed as units of `currency` per 1 USD.
CREATE TABLE fx_rates (
  day TEXT NOT NULL,                         -- UTC date
  currency TEXT NOT NULL,
  per_usd REAL NOT NULL,
  PRIMARY KEY (day, currency)
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------------------------
-- Product configuration (W2 unless noted)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE funnels (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  steps TEXT NOT NULL,                       -- JSON FunnelStep[] (docs/api/contract.md)
  is_active INTEGER NOT NULL DEFAULT 1,      -- DELETE soft-deletes (DataFast behaviour)
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX funnels_site ON funnels (site_id);
CREATE UNIQUE INDEX funnels_active_name ON funnels (site_id, name) WHERE is_active = 1;

CREATE TABLE goal_customizations (
  site_id TEXT NOT NULL,
  name TEXT NOT NULL,                        -- raw goal name
  display_name TEXT,
  color TEXT,
  description TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, name)
) WITHOUT ROWID;

CREATE TABLE segments (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  name TEXT NOT NULL,
  filters TEXT NOT NULL,                     -- JSON {"filter_country": "is:US", ...}
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX segments_site ON segments (site_id);

-- Manual chart notes (DataFast notes API).
CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  text TEXT NOT NULL,
  author_id TEXT,
  idempotency_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX notes_site_time ON notes (site_id, ts);
CREATE UNIQUE INDEX notes_idempotency ON notes (site_id, author_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Conversion-likelihood model per site, rebuilt daily (realtime map, visitor profile).
CREATE TABLE prediction_models (
  site_id TEXT PRIMARY KEY,
  model TEXT NOT NULL,                       -- JSON: per-dimension conversion rates and values
  baseline_conversion_rate REAL NOT NULL,
  baseline_average_value REAL NOT NULL,
  sample_visitors INTEGER NOT NULL,
  trained_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------------------------
-- Alerts, digests and outbound delivery (W6)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE alerts (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  name TEXT NOT NULL,
  trigger_type TEXT NOT NULL DEFAULT 'goal'
    CHECK (trigger_type IN ('goal', 'new_sale', 'traffic_spike', 'weekly_digest')),
  trigger TEXT NOT NULL DEFAULT '{}',        -- JSON {goalName} / {multiplier} / {}
  channel TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'telegram')),
  destination TEXT NOT NULL DEFAULT '{}',    -- JSON {email} / {chatId}; secrets go in secret_enc
  secret_enc TEXT,                           -- e.g. Telegram bot token (AES-GCM)
  template_subject TEXT,
  template_message TEXT,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  trigger_count INTEGER NOT NULL DEFAULT 0,
  monthly_count INTEGER NOT NULL DEFAULT 0,
  monthly_count_reset_at INTEGER,
  daily_count INTEGER NOT NULL DEFAULT 0,
  daily_count_reset_at INTEGER,
  last_triggered_at INTEGER,
  last_error TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX alerts_site ON alerts (site_id);

CREATE TABLE alert_history (
  id INTEGER PRIMARY KEY,
  site_id TEXT NOT NULL,
  alert_id TEXT NOT NULL,
  alert_name TEXT NOT NULL,
  goal_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  error TEXT,
  visitor_id TEXT,
  triggered_at INTEGER NOT NULL
);
CREATE INDEX alert_history_site_time ON alert_history (site_id, triggered_at);

-- Outbound deliveries with retries: emails, Telegram messages, invite links, digests.
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY,
  site_id TEXT,
  kind TEXT NOT NULL,                        -- 'email' | 'telegram' | ...
  payload TEXT NOT NULL,                     -- JSON
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  dedupe_key TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX outbox_pending ON outbox (next_attempt_at) WHERE status = 'pending';

-- ---------------------------------------------------------------------------------------------
-- Cookieless identity (W1)
-- ---------------------------------------------------------------------------------------------

-- Random daily salts for HMAC(site|ip|ua). Today's and yesterday's are kept, older deleted.
CREATE TABLE cookieless_salts (
  day TEXT PRIMARY KEY,                      -- UTC date the salt is valid for
  salt TEXT NOT NULL,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------------------------
-- Rollups (W2). Recomputed by cron with INSERT ... SELECT ... ON CONFLICT DO UPDATE ... WHERE
-- (changed), for closed days only; ranges that include today read raw tables for today.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE daily_stats (
  site_id TEXT NOT NULL,
  day TEXT NOT NULL,                         -- site-local date
  visitors INTEGER NOT NULL DEFAULT 0,
  new_visitors INTEGER NOT NULL DEFAULT 0,
  returning_visitors INTEGER NOT NULL DEFAULT 0,
  sessions INTEGER NOT NULL DEFAULT 0,
  pageviews INTEGER NOT NULL DEFAULT 0,
  bounces INTEGER NOT NULL DEFAULT 0,
  duration_sum INTEGER NOT NULL DEFAULT 0,   -- ms
  revenue_minor INTEGER NOT NULL DEFAULT 0,  -- site currency, all payments
  new_revenue_minor INTEGER NOT NULL DEFAULT 0,
  renewal_revenue_minor INTEGER NOT NULL DEFAULT 0,
  refund_minor INTEGER NOT NULL DEFAULT 0,
  payments INTEGER NOT NULL DEFAULT 0,
  paying_visitors INTEGER NOT NULL DEFAULT 0,
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, day)
) WITHOUT ROWID;

CREATE TABLE daily_pages (
  site_id TEXT NOT NULL,
  day TEXT NOT NULL,
  hostname TEXT NOT NULL,
  path TEXT NOT NULL,
  pageviews INTEGER NOT NULL DEFAULT 0,
  visitors INTEGER NOT NULL DEFAULT 0,       -- daily uniques; sums over days are labelled as such
  entries INTEGER NOT NULL DEFAULT 0,
  exits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, day, hostname, path)
) WITHOUT ROWID;

-- Generic session-dimension rollup: dimension in ('channel','referrer','country','region','city',
-- 'device','browser','os','hostname','entry_page','utm_source', ... 'via').
CREATE TABLE daily_dimensions (
  site_id TEXT NOT NULL,
  day TEXT NOT NULL,
  dimension TEXT NOT NULL,
  value TEXT NOT NULL,                       -- '' for NULL
  visitors INTEGER NOT NULL DEFAULT 0,
  sessions INTEGER NOT NULL DEFAULT 0,
  pageviews INTEGER NOT NULL DEFAULT 0,
  bounces INTEGER NOT NULL DEFAULT 0,
  duration_sum INTEGER NOT NULL DEFAULT 0,
  revenue_minor INTEGER NOT NULL DEFAULT 0,
  payments INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, day, dimension, value)
) WITHOUT ROWID;

CREATE TABLE daily_goals (
  site_id TEXT NOT NULL,
  day TEXT NOT NULL,
  name TEXT NOT NULL,
  completions INTEGER NOT NULL DEFAULT 0,
  visitors INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, day, name)
) WITHOUT ROWID;

-- Human-ingest hits dropped as bots, by reason ('ua', 'headless', 'automation', 'strict'). W1.
CREATE TABLE bot_daily (
  site_id TEXT NOT NULL,
  day TEXT NOT NULL,                         -- UTC date
  reason TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, day, reason)
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------------------------
-- AI crawler / bot traffic product (W6)
-- ---------------------------------------------------------------------------------------------

-- One upsert per accepted crawler request (1 written row, no secondary index).
CREATE TABLE bot_traffic (
  site_id TEXT NOT NULL,
  hour INTEGER NOT NULL,                     -- UTC hour start, epoch ms
  crawler_id TEXT NOT NULL,                  -- 'OpenAI::ChatGPT-User::answer_fetch'
  hostname TEXT NOT NULL,
  path TEXT NOT NULL,
  status_code INTEGER NOT NULL DEFAULT 0,    -- 0 = unknown
  verified INTEGER NOT NULL DEFAULT 0,       -- 1 = IP verified
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, hour, crawler_id, hostname, path, status_code, verified)
) WITHOUT ROWID;

CREATE TABLE bot_settings (
  site_id TEXT PRIMARY KEY,
  settings TEXT NOT NULL DEFAULT '{}',       -- JSON BotTrafficSettings (docs/api/contract.md)
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

-- dfbot_ request-authentication tokens (hashed), one per site.
CREATE TABLE bot_tokens (
  site_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  display_token TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------------------------
-- Growth integrations (W6): GitHub, Google Search Console, Meta Ads, X/Reddit, imports
-- ---------------------------------------------------------------------------------------------

-- OAuth/API connections for non-payment integrations. kind in ('github','gsc','meta_ads','x').
CREATE TABLE integration_connections (
  site_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  credentials_enc TEXT,                      -- AES-GCM JSON, aad 'integration:<kind>:<site_id>'
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'error', 'disconnected', 'pending')),
  settings TEXT NOT NULL DEFAULT '{}',       -- JSON: repo, property, ad accounts, keywords, handles
  cursor TEXT,
  last_synced_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, kind)
) WITHOUT ROWID;

CREATE TABLE mentions (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('x', 'reddit')),
  external_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  text TEXT NOT NULL,
  url TEXT NOT NULL,
  author_name TEXT,
  author_username TEXT,
  author_image TEXT,
  engagement TEXT NOT NULL DEFAULT '{}',     -- JSON {likes,replies,reposts,quotes} | {score,comments}
  media TEXT,                                -- JSON (x)
  is_retweet INTEGER NOT NULL DEFAULT 0,
  subreddit TEXT,
  relevant INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE (site_id, platform, external_id)
);
CREATE INDEX mentions_site_time ON mentions (site_id, ts);

-- X link attribution: t.co short links seen as referrers, resolved to the tweet that posted them.
CREATE TABLE x_links (
  site_id TEXT NOT NULL,
  tco_url TEXT NOT NULL,
  tweet_id TEXT,
  tweet_url TEXT,
  author_username TEXT,
  text TEXT,
  posted_at INTEGER,
  resolved_at INTEGER,
  PRIMARY KEY (site_id, tco_url)
) WITHOUT ROWID;

CREATE TABLE github_commits (
  site_id TEXT NOT NULL,
  sha TEXT NOT NULL,
  repo TEXT NOT NULL,
  branch TEXT,
  message TEXT NOT NULL,
  author_name TEXT,
  author_login TEXT,
  author_avatar TEXT,
  additions INTEGER,
  deletions INTEGER,
  url TEXT,
  committed_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, sha)
) WITHOUT ROWID;
CREATE INDEX github_commits_site_time ON github_commits (site_id, committed_at);

CREATE TABLE gsc_daily (
  site_id TEXT NOT NULL,
  day TEXT NOT NULL,                         -- Search Console date (PT)
  query TEXT NOT NULL,
  page TEXT NOT NULL,
  clicks INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  position REAL,                             -- average position
  PRIMARY KEY (site_id, day, query, page)
) WITHOUT ROWID;

CREATE TABLE ad_spend_daily (
  site_id TEXT NOT NULL,
  platform TEXT NOT NULL,                    -- 'meta'
  account_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  day TEXT NOT NULL,                         -- ad account date
  campaign_name TEXT,
  currency TEXT NOT NULL,
  spend_minor INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  reach INTEGER NOT NULL DEFAULT 0,
  purchase_value_minor INTEGER,
  PRIMARY KEY (site_id, platform, account_id, campaign_id, day)
) WITHOUT ROWID;

CREATE TABLE imports (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'plausible' CHECK (source IN ('plausible', 'datafast')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  file_name TEXT,
  range_start TEXT,                          -- first imported day
  range_end TEXT,
  rows_total INTEGER,
  rows_imported INTEGER NOT NULL DEFAULT 0,
  cursor TEXT,
  error TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX imports_site ON imports (site_id);

-- Imported aggregates. dimension '' with value '' holds daily totals.
CREATE TABLE imported_daily (
  site_id TEXT NOT NULL,
  import_id TEXT NOT NULL,
  day TEXT NOT NULL,
  dimension TEXT NOT NULL,                   -- '', 'page', 'entry_page', 'referrer', 'country', ...
  value TEXT NOT NULL,
  visitors INTEGER NOT NULL DEFAULT 0,
  visits INTEGER NOT NULL DEFAULT 0,
  pageviews INTEGER NOT NULL DEFAULT 0,
  bounces INTEGER NOT NULL DEFAULT 0,
  duration_sum INTEGER NOT NULL DEFAULT 0,   -- ms
  PRIMARY KEY (site_id, day, dimension, value, import_id)
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------------------------
-- Cron multiplexer state (src/jobs/scheduler.ts)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE job_state (
  name TEXT PRIMARY KEY,
  last_run_at INTEGER,                       -- start of the last run
  last_slot INTEGER,                         -- schedule slot (epoch ms) the last run covered
  last_success_at INTEGER,
  last_error TEXT,
  last_duration_ms INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  state TEXT,                                -- JSON owned by the job (cursors)
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
