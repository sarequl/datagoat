-- W2 (analytics API & query layer), migration 0200.
--
-- 1. rollup_state: per-site watermark of the rollup job (src/query/jobs/rollups.ts). Days up to and
--    including `through_day` (site-local, in `timezone`) are fully rolled up into daily_stats,
--    daily_pages, daily_dimensions and daily_goals. Queries read rollups only for those days and
--    only while `timezone` equals the site's timezone. One written row per site per day.
CREATE TABLE rollup_state (
  site_id TEXT PRIMARY KEY,
  timezone TEXT NOT NULL,
  first_day TEXT,                            -- first day with sessions (backfill start)
  through_day TEXT,                          -- last rolled-up closed day; NULL = nothing yet
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

-- 2. Events counted per day (usage page: events stored vs plan limits, without scanning events).
ALTER TABLE daily_stats ADD COLUMN events INTEGER NOT NULL DEFAULT 0;

-- 3. Non-pageview events (goals, outbound clicks, identify, payment goals) by type and time, and by
--    visitor. Pageviews are excluded by the partial-index predicate, so the pageview write budget
--    (3/5/6 rows) is unchanged; a goal or outbound click writes 2 more rows. They serve the goals
--    breakdown, goal filters, funnels, exit clicks, realtime events (by time) and visitor journeys,
--    server-side goal deletion and visitor profiles (by visitor) without scanning every pageview.
CREATE INDEX events_activity ON events (site_id, type, ts) WHERE type <> 'pageview';
CREATE INDEX events_visitor_activity ON events (site_id, visitor_id) WHERE type <> 'pageview';
