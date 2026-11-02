import type { Env } from './env';
import { SESSION_GAP_S } from './env';
import { dayBucket, hourBucket } from './util/time';

/** Recompute derived tables for the last 24 hours on every tick. */
const ROLLUP_WINDOW_S = 24 * 3600;

interface EventRow {
  id: string;
  session_id: string | null;
  visitor_id: string | null;
  name: string;
  ts: number;
  path: string | null;
  referrer: string | null;
  channel: string | null;
  channel_name: string | null;
  direct_type: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  device_type: string | null;
  os: string | null;
  browser: string | null;
  language: string | null;
  is_bot: number;
}

interface SessionAgg {
  id: string;
  visitor_id: string;
  started_at: number;
  ended_at: number;
  pageviews: number;
  events: number;
  entry_path: string | null;
  exit_path: string | null;
  referrer: string | null;
  channel: string | null;
  channel_name: string | null;
  direct_type: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  device_type: string | null;
  os: string | null;
  browser: string | null;
  language: string | null;
  is_new_visitor: number;
}

interface AggCell {
  visitors: Set<string>;
  pageviews: number;
  sessions: Set<string>;
}

interface DayAgg {
  total: AggCell;
  dims: Map<string, Map<string, AggCell>>;
}

function newCell(): AggCell {
  return { visitors: new Set(), pageviews: 0, sessions: new Set() };
}

/**
 * Cron rollup (design/worker.md §9). Ingest writes only `events`; this handler
 * rebuilds `sessions`, `visitors`, and `daily_aggregates` for a rolling window.
 *
 * The recompute-and-replace strategy is idempotent, so a retried tick cannot
 * double-count. It trades unbounded historical scans for predictable cost; the
 * window is one day, which is plenty for late-arriving beacons and replayed
 * events.
 */
export async function rollup(
  env: Env,
  now = Math.floor(Date.now() / 1000),
): Promise<{ websites: number; events: number }> {
  const sites = await env.DB.prepare('SELECT id, timezone, retention_days FROM websites').all<{
    id: string;
    timezone: string;
    retention_days: number;
  }>();

  let total = 0;
  for (const site of sites.results) {
    total += await recomputeSite(
      env,
      site.id,
      site.timezone || 'UTC',
      site.retention_days ?? 365,
      now,
    );
  }
  return { websites: sites.results.length, events: total };
}

async function recomputeSite(
  env: Env,
  websiteId: string,
  timeZone: string,
  retentionDays: number,
  now: number,
): Promise<number> {
  const windowStart = now - ROLLUP_WINDOW_S;
  const lookback = windowStart - SESSION_GAP_S;

  const result = await env.DB.prepare(
    `SELECT id, session_id, visitor_id, name, ts, path, referrer, channel, channel_name,
            direct_type, utm_source, utm_medium, utm_campaign, country, region, city,
            device_type, os, browser, language, is_bot
     FROM events
     WHERE website_id = ? AND ts >= ?
     ORDER BY visitor_id, ts, id`,
  )
    .bind(websiteId, lookback)
    .all<EventRow>();

  const events = result.results;
  const human = events.filter((event) => !event.is_bot && event.visitor_id);

  await rollupSessions(env, websiteId, human, lookback, now);
  await rollupVisitors(env, websiteId, windowStart, now);
  await rollupAggregates(env, websiteId, timeZone, human, now);
  await markNewFlags(env, websiteId);
  await applyRetention(env, websiteId, timeZone, retentionDays, now);

  return events.length;
}

async function rollupSessions(
  env: Env,
  websiteId: string,
  events: EventRow[],
  lookback: number,
  now: number,
): Promise<void> {
  // Drop sessions that overlap the recompute window so an upsert cannot duplicate.
  await env.DB.prepare(
    `DELETE FROM sessions
     WHERE website_id = ? AND (started_at >= ? OR ended_at >= ? OR ended_at IS NULL)`,
  )
    .bind(websiteId, lookback, lookback)
    .run();

  // Visitors with a session entirely before the window already existed, so their
  // next session is a return visit rather than a new one.
  const prior = await env.DB.prepare(
    'SELECT DISTINCT visitor_id FROM sessions WHERE website_id = ? AND started_at < ?',
  )
    .bind(websiteId, lookback)
    .all<{ visitor_id: string }>();
  const priorVisitors = new Set(prior.results.map((row) => row.visitor_id));

  const sessions: SessionAgg[] = [];
  let current: SessionAgg | null = null;
  let currentVisitor: string | null = null;

  for (const event of events) {
    const visitorId = event.visitor_id as string;
    if (currentVisitor !== visitorId) {
      current = null;
      currentVisitor = visitorId;
    }

    const gap = current ? event.ts - current.ended_at : Number.POSITIVE_INFINITY;
    const startsNew =
      !current ||
      (event.session_id !== null && event.session_id !== current.id) ||
      (event.session_id === null && gap > SESSION_GAP_S);

    if (startsNew) {
      current = {
        id: event.session_id ?? `sess_${event.id}`,
        visitor_id: visitorId,
        started_at: event.ts,
        ended_at: event.ts,
        pageviews: 0,
        events: 0,
        entry_path: event.path,
        exit_path: event.path,
        referrer: event.referrer,
        channel: event.channel,
        channel_name: event.channel_name,
        direct_type: event.direct_type,
        utm_source: event.utm_source,
        utm_medium: event.utm_medium,
        utm_campaign: event.utm_campaign,
        country: event.country,
        region: event.region,
        city: event.city,
        device_type: event.device_type,
        os: event.os,
        browser: event.browser,
        language: event.language,
        is_new_visitor: priorVisitors.has(visitorId) ? 0 : 1,
      };
      sessions.push(current);
    } else if (current === null) {
      // Unreachable: `startsNew` is true whenever `current` is null.
      continue;
    }

    current.ended_at = event.ts;
    current.events += 1;
    if (event.name === 'pageview') current.pageviews += 1;
    current.exit_path = event.path;
  }

  for (const session of sessions) {
    await env.DB.prepare(
      `INSERT INTO sessions (
         id, website_id, visitor_id, started_at, ended_at, duration_s, pageviews, events,
         entry_path, exit_path, referrer, channel, channel_name, direct_type,
         utm_source, utm_medium, utm_campaign, first_source, country, region, city,
         device_type, os, browser, language, is_bot, converted, revenue_cents,
         is_new_visitor, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         ended_at = excluded.ended_at,
         duration_s = excluded.duration_s,
         pageviews = excluded.pageviews,
         events = excluded.events,
         exit_path = excluded.exit_path,
         updated_at = excluded.updated_at`,
    )
      .bind(
        session.id,
        websiteId,
        session.visitor_id,
        session.started_at,
        session.ended_at,
        Math.max(0, session.ended_at - session.started_at),
        session.pageviews,
        session.events,
        session.entry_path,
        session.exit_path,
        session.referrer,
        session.channel,
        session.channel_name,
        session.direct_type,
        session.utm_source,
        session.utm_medium,
        session.utm_campaign,
        session.channel,
        session.country,
        session.region,
        session.city,
        session.device_type,
        session.os,
        session.browser,
        session.language,
        session.is_new_visitor,
        now,
        now,
      )
      .run();
  }
}

async function rollupVisitors(
  env: Env,
  websiteId: string,
  windowStart: number,
  now: number,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO visitors (
       website_id, visitor_id, first_seen, last_seen, sessions, pageviews,
       first_channel, first_channel_name, first_referrer, first_utm_source, first_utm_medium,
       first_utm_campaign, first_landing_path, first_country, first_device_type,
       is_bot, updated_at
     )
     SELECT
       ? AS website_id,
       e.visitor_id,
       MIN(e.ts) AS first_seen,
       MAX(e.ts) AS last_seen,
       COUNT(DISTINCT e.session_id) AS sessions,
       SUM(CASE WHEN e.name = 'pageview' THEN 1 ELSE 0 END) AS pageviews,
       (SELECT f.channel FROM events f
         WHERE f.website_id = e.website_id AND f.visitor_id = e.visitor_id
         ORDER BY f.ts ASC, f.id ASC LIMIT 1) AS first_channel,
       (SELECT f.channel_name FROM events f
         WHERE f.website_id = e.website_id AND f.visitor_id = e.visitor_id
         ORDER BY f.ts ASC, f.id ASC LIMIT 1) AS first_channel_name,
       (SELECT f.referrer FROM events f
         WHERE f.website_id = e.website_id AND f.visitor_id = e.visitor_id
         ORDER BY f.ts ASC, f.id ASC LIMIT 1) AS first_referrer,
       (SELECT f.utm_source FROM events f
         WHERE f.website_id = e.website_id AND f.visitor_id = e.visitor_id
         ORDER BY f.ts ASC, f.id ASC LIMIT 1) AS first_utm_source,
       (SELECT f.utm_medium FROM events f
         WHERE f.website_id = e.website_id AND f.visitor_id = e.visitor_id
         ORDER BY f.ts ASC, f.id ASC LIMIT 1) AS first_utm_medium,
       (SELECT f.utm_campaign FROM events f
         WHERE f.website_id = e.website_id AND f.visitor_id = e.visitor_id
         ORDER BY f.ts ASC, f.id ASC LIMIT 1) AS first_utm_campaign,
       (SELECT f.path FROM events f
         WHERE f.website_id = e.website_id AND f.visitor_id = e.visitor_id
         ORDER BY f.ts ASC, f.id ASC LIMIT 1) AS first_landing_path,
       (SELECT f.country FROM events f
         WHERE f.website_id = e.website_id AND f.visitor_id = e.visitor_id
         ORDER BY f.ts ASC, f.id ASC LIMIT 1) AS first_country,
       (SELECT f.device_type FROM events f
         WHERE f.website_id = e.website_id AND f.visitor_id = e.visitor_id
         ORDER BY f.ts ASC, f.id ASC LIMIT 1) AS first_device_type,
       0 AS is_bot,
       ? AS updated_at
     FROM events e
     WHERE e.website_id = ? AND e.is_bot = 0
       AND e.visitor_id IN (
         SELECT DISTINCT visitor_id FROM events WHERE website_id = ? AND ts >= ?
       )
     GROUP BY e.visitor_id
     ON CONFLICT (website_id, visitor_id) DO UPDATE SET
       last_seen = excluded.last_seen,
       sessions = excluded.sessions,
       pageviews = excluded.pageviews,
       is_bot = excluded.is_bot,
       updated_at = excluded.updated_at`,
  )
    .bind(websiteId, now, websiteId, websiteId, windowStart)
    .run();
}

async function rollupAggregates(
  env: Env,
  websiteId: string,
  timeZone: string,
  events: EventRow[],
  now: number,
): Promise<void> {
  const byDay = new Map<string, DayAgg>();
  const days: string[] = [];

  const dimGetters: Array<[string, (event: EventRow) => string | null]> = [
    ['channel', (event) => event.channel],
    ['channel_name', (event) => event.channel_name],
    ['referrer', (event) => event.referrer],
    ['path', (event) => event.path],
    ['device_type', (event) => event.device_type],
    ['country', (event) => event.country],
    ['hour', (event) => hourBucket(event.ts, timeZone)],
  ];

  function dayAgg(day: string): DayAgg {
    let entry = byDay.get(day);
    if (!entry) {
      entry = { total: newCell(), dims: new Map() };
      byDay.set(day, entry);
      days.push(day);
    }
    return entry;
  }

  function cell(
    container: { total: AggCell; dims: Map<string, Map<string, AggCell>> },
    dimKey: string,
    dimValue: string,
  ): AggCell {
    if (dimKey === '') return container.total;
    let dim = container.dims.get(dimKey);
    if (!dim) {
      dim = new Map();
      container.dims.set(dimKey, dim);
    }
    let cell = dim.get(dimValue);
    if (!cell) {
      cell = newCell();
      dim.set(dimValue, cell);
    }
    return cell;
  }

  function record(container: DayAgg, dimKey: string, dimValue: string, event: EventRow): void {
    const target = cell(container, dimKey, dimValue);
    target.visitors.add(event.visitor_id as string);
    if (event.name === 'pageview') target.pageviews += 1;
    if (event.session_id) target.sessions.add(event.session_id);
  }

  for (const event of events) {
    const day = dayBucket(event.ts, timeZone);
    const agg = dayAgg(day);
    record(agg, '', '', event);
    for (const [dimKey, get] of dimGetters) {
      record(agg, dimKey, get(event) || '(unknown)', event);
    }
  }

  if (days.length === 0) return;

  const placeholders = days.map(() => '?').join(', ');
  await env.DB.prepare(
    `DELETE FROM daily_aggregates WHERE website_id = ? AND day IN (${placeholders})`,
  )
    .bind(websiteId, ...days)
    .run();

  const insert = env.DB.prepare(
    `INSERT INTO daily_aggregates (website_id, day, kind, dim_key, dim_value, value, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const statements: D1PreparedStatement[] = [];
  for (const day of days) {
    const agg = byDay.get(day);
    if (!agg) continue;
    const cells: Array<[string, string, AggCell]> = [['', '', agg.total]];
    for (const [dimKey, values] of agg.dims) {
      for (const [dimValue, cell] of values) cells.push([dimKey, dimValue, cell]);
    }
    for (const [dimKey, dimValue, cell] of cells) {
      statements.push(
        insert.bind(websiteId, day, 'visitors', dimKey, dimValue, cell.visitors.size, now),
      );
      statements.push(
        insert.bind(websiteId, day, 'pageviews', dimKey, dimValue, cell.pageviews, now),
      );
      statements.push(
        insert.bind(websiteId, day, 'sessions', dimKey, dimValue, cell.sessions.size, now),
      );
    }
  }

  await env.DB.batch(statements);
}

async function markNewFlags(env: Env, websiteId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE events SET is_new_visitor = 1
     WHERE website_id = ? AND id IN (
       SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (PARTITION BY visitor_id ORDER BY ts ASC, id ASC) AS rn
         FROM events WHERE website_id = ?
       ) WHERE rn = 1
     )`,
  )
    .bind(websiteId, websiteId)
    .run();

  await env.DB.prepare(
    `UPDATE events SET is_new_session = 1
     WHERE website_id = ? AND id IN (
       SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (PARTITION BY website_id, session_id ORDER BY ts ASC, id ASC) AS rn
         FROM events WHERE website_id = ? AND session_id IS NOT NULL
       ) WHERE rn = 1
     )`,
  )
    .bind(websiteId, websiteId)
    .run();
}

async function applyRetention(
  env: Env,
  websiteId: string,
  timeZone: string,
  retentionDays: number,
  now: number,
): Promise<void> {
  const cutoff = now - retentionDays * 86400;
  const cutoffDay = dayBucket(cutoff, timeZone);

  await env.DB.prepare('DELETE FROM events WHERE website_id = ? AND ts < ?')
    .bind(websiteId, cutoff)
    .run();
  await env.DB.prepare('DELETE FROM daily_aggregates WHERE website_id = ? AND day < ?')
    .bind(websiteId, cutoffDay)
    .run();
  await env.DB.prepare(
    'DELETE FROM sessions WHERE website_id = ? AND ended_at IS NOT NULL AND ended_at < ?',
  )
    .bind(websiteId, cutoff)
    .run();
}
