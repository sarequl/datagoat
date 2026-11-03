-- DataGoat Milestone 3 — funnel definition storage.
--
-- Source: design/api.md §2.8.1 / §2.8.7 and design/worker.md §3.8.
--
-- §2.8.7 freezes the wire shape: each step is a predicate discriminator plus
-- flattened params, and the gap cap is funnel-level. 0001 modelled steps as
-- `goal_slug` + `window_hours`, which cannot represent the §2.6 predicate set,
-- so `funnel_steps` is rebuilt with `type` + `params` (JSON) + `name`.
--
-- Also adds `events.hostname` so the `/analytics/hostnames` breakdown can
-- report the multi-domain hostname (the beacon sends the full page URL `u`,
-- but 0001 stored only the path).

-- ---------------------------------------------------------------------------
-- funnels — definition metadata
-- ---------------------------------------------------------------------------

ALTER TABLE funnels ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE funnels ADD COLUMN max_gap_seconds INTEGER;
ALTER TABLE funnels ADD COLUMN updated_at INTEGER;
ALTER TABLE funnels ADD COLUMN deleted_at INTEGER;

CREATE INDEX idx_funnels_site_active ON funnels (website_id, deleted_at, created_at);

-- ---------------------------------------------------------------------------
-- funnel_steps — predicate + flattened params (§2.8.1)
-- ---------------------------------------------------------------------------

DROP TABLE funnel_steps;

CREATE TABLE funnel_steps (
  id         TEXT PRIMARY KEY,
  funnel_id  TEXT NOT NULL,
  position   INTEGER NOT NULL,
  type       TEXT NOT NULL,
  params     TEXT NOT NULL,
  name       TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_funnel_steps ON funnel_steps (funnel_id, position);

-- ---------------------------------------------------------------------------
-- events — hostname for the multi-domain breakdown
-- ---------------------------------------------------------------------------

ALTER TABLE events ADD COLUMN hostname TEXT;
CREATE INDEX idx_events_site_hostname ON events (website_id, hostname);
