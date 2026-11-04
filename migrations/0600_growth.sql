-- Growth (W6), migration 0600: alert channels and triggers, crawler IP verification, bot traffic
-- allowance accounting and automatic attack mode.
--
-- Write budget notes:
--   * None of these tables is on the per-pageview ingest path.
--   * crawler_ip_ranges holds one row per published IP-range source (about a dozen), rewritten
--     only when the published list changes.
--   * bot_usage is written at most once per isolate per minute while the allowance is exhausted.
--   * attack_mode / attack_mode_events are written only when attack mode switches on or off.

-- ---------------------------------------------------------------------------------------------
-- alerts: widen the trigger and channel CHECK constraints (SQLite cannot ALTER a CHECK, so the
-- table is rebuilt; it is owned by W6 and has no foreign keys pointing at it).
-- ---------------------------------------------------------------------------------------------

CREATE TABLE alerts_v2 (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  name TEXT NOT NULL,
  trigger_type TEXT NOT NULL DEFAULT 'goal'
    CHECK (trigger_type IN ('goal', 'new_sale', 'traffic_spike', 'daily_digest', 'weekly_digest')),
  "trigger" TEXT NOT NULL DEFAULT '{}',      -- JSON {goalName} / {multiplier, minSessions} / {includeRenewals, includeFreeTrials}
  channel TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'telegram', 'webhook')),
  destination TEXT NOT NULL DEFAULT '{}',    -- JSON {email} / {chatId} / {url}; secrets go in secret_enc
  secret_enc TEXT,                           -- Telegram bot token or webhook signing secret (AES-GCM)
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
INSERT INTO alerts_v2 (id, site_id, name, trigger_type, "trigger", channel, destination, secret_enc,
  template_subject, template_message, is_enabled, trigger_count, monthly_count, monthly_count_reset_at,
  daily_count, daily_count_reset_at, last_triggered_at, last_error, created_by, created_at, updated_at)
SELECT id, site_id, name, trigger_type, "trigger", channel, destination, secret_enc,
  template_subject, template_message, is_enabled, trigger_count, monthly_count, monthly_count_reset_at,
  daily_count, daily_count_reset_at, last_triggered_at, last_error, created_by, created_at, updated_at
FROM alerts;
DROP TABLE alerts;
ALTER TABLE alerts_v2 RENAME TO alerts;
CREATE INDEX alerts_site ON alerts (site_id);

-- Delivery log: which channel delivered it and a one-line summary for the history view.
ALTER TABLE alert_history ADD COLUMN channel TEXT;
ALTER TABLE alert_history ADD COLUMN trigger_type TEXT;
ALTER TABLE alert_history ADD COLUMN summary TEXT;

-- ---------------------------------------------------------------------------------------------
-- Bot traffic
-- ---------------------------------------------------------------------------------------------

-- Published crawler IP ranges (Google, Bing, OpenAI, Perplexity, Apple, ...), refreshed daily by
-- the `bots.ip-ranges` job. `prefixes` is a JSON string[] of CIDRs.
CREATE TABLE crawler_ip_ranges (
  source TEXT PRIMARY KEY,
  prefixes TEXT NOT NULL DEFAULT '[]',
  fetched_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_error TEXT
) WITHOUT ROWID;

-- Install-wide allowance accounting while BOT_TRAFFIC_ALLOWANCE is set: accepted and dropped
-- requests per period. Ingest counts in memory and flushes at most once a minute per isolate.
CREATE TABLE bot_usage (
  period TEXT PRIMARY KEY,                   -- 'YYYY-MM' (UTC calendar month)
  accepted INTEGER NOT NULL DEFAULT 0,
  dropped INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------------------------
-- Attack mode (automatic bot-filter escalation)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE attack_mode (
  site_id TEXT PRIMARY KEY,
  auto_enable INTEGER NOT NULL DEFAULT 0,    -- "Auto-enable on traffic spike"
  multiplier REAL NOT NULL DEFAULT 5,        -- spike = rate >= multiplier x trailing average
  min_hits INTEGER NOT NULL DEFAULT 100,     -- and at least this many hits in the window
  duration_minutes INTEGER NOT NULL DEFAULT 240,
  active_until INTEGER,                      -- set while automatic attack mode is on
  previous_level TEXT,                       -- sites.bot_level to restore afterwards
  activated_at INTEGER,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE attack_mode_events (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('auto', 'manual')),
  reason TEXT NOT NULL,                      -- 'bot_spike' | 'suspicious_traffic_spike' | 'manual'
  details TEXT NOT NULL DEFAULT '{}',        -- JSON: window, observed rate, baseline
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX attack_mode_events_site ON attack_mode_events (site_id, started_at);
