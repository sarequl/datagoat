-- W1 (tracker & ingest), migration 0100.
--
-- 1. Engagement beacon (`data-track-engagement="true"` on the DataGoat tracker): active time and
--    the deepest scroll of the session, written by one UPDATE of the session row when a page is
--    hidden. Neither column is indexed, so the beacon costs exactly 1 written row.
-- 2. User-agent exclusions: case-insensitive substrings or `*` globs matched against the
--    User-Agent header at ingest; matching hits are dropped like IP/path/country exclusions.

ALTER TABLE sessions ADD COLUMN engaged_ms INTEGER;   -- summed active time (ms), NULL = no beacon
ALTER TABLE sessions ADD COLUMN max_scroll INTEGER;   -- deepest scroll seen, percent 0-100

ALTER TABLE sites ADD COLUMN excluded_user_agents TEXT NOT NULL DEFAULT '[]'; -- JSON string[]
