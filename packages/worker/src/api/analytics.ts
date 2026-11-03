import type { Env, Website } from '../env';
import { hostOf } from '../util/ids';
import { isValidTimeZone, localParts, parseDateBound, zonedLocalMidnightToUtc } from '../util/time';
import { handleFunnelResult } from './funnels';
import { computeRevenue, convertCents, loadFxRates, loadVisitorRevenue } from './revenue';
import {
  checkQueryParams,
  error,
  iso,
  json,
  pagination,
  parseOrder,
  parsePagination,
  readSiteParam,
  resolveOwnedSite,
  round2,
  round4,
} from './util';

const UNKNOWN = '(unknown)';
const ALL_METRICS = ['visitors', 'pageviews', 'sessions', 'revenue', 'payments'] as const;
type Metric = (typeof ALL_METRICS)[number];
type Interval = 'hour' | 'day' | 'week' | 'month';

const OVERVIEW_KEYS = ['siteId', 'startAt', 'endAt', 'timezone', 'path', 'goal', 'compare'];
const TIMESERIES_KEYS = [
  'siteId',
  'startAt',
  'endAt',
  'timezone',
  'path',
  'goal',
  'interval',
  'fields',
];
const METADATA_KEYS = ['siteId'];
const BREAKDOWN_KEYS = [
  'siteId',
  'startAt',
  'endAt',
  'timezone',
  'path',
  'goal',
  'order',
  'limit',
  'offset',
];
const GOALS_KEYS = ['siteId', 'startAt', 'endAt', 'timezone', 'order', 'limit', 'offset'];
const FUNNEL_KEYS = ['siteId', 'startAt', 'endAt', 'timezone'];

const BREAKDOWN_GETTERS: Record<string, (row: BreakdownEvent) => string> = {
  pages: (row) => row.path || UNKNOWN,
  referrers: (row) => (row.referrer ? hostOf(row.referrer) || UNKNOWN : UNKNOWN),
  campaigns: (row) => row.utm_campaign || UNKNOWN,
  countries: (row) => row.country || UNKNOWN,
  regions: (row) => row.region || UNKNOWN,
  cities: (row) => row.city || UNKNOWN,
  browsers: (row) => row.browser || UNKNOWN,
  devices: (row) => row.device_type || UNKNOWN,
  'operating-systems': (row) => row.os || UNKNOWN,
  hostnames: (row) => row.hostname || UNKNOWN,
};

interface Range {
  start: number;
  end: number;
  startRaw: string | null;
  endRaw: string | null;
  timeZone: string;
}

interface BreakdownEvent {
  visitor_id: string;
  name: string;
  path: string | null;
  referrer: string | null;
  utm_campaign: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  device_type: string | null;
  os: string | null;
  browser: string | null;
  hostname: string | null;
  props: string | null;
}

function todayEnd(timeZone: string): number {
  const now = Math.floor(Date.now() / 1000);
  const parts = localParts(now, timeZone);
  return zonedLocalMidnightToUtc(parts.year, parts.month, parts.day + 1, timeZone) - 1;
}

function defaultStartForEnd(end: number, timeZone: string): number {
  const parts = localParts(end, timeZone);
  return zonedLocalMidnightToUtc(parts.year, parts.month, parts.day - 6, timeZone);
}

async function resolveRange(
  env: Env,
  userId: string,
  url: URL,
  allowed: string[],
): Promise<{ range?: Range; site?: Website; error?: Response }> {
  const queryError = checkQueryParams(url, allowed);
  if (queryError) return { error: queryError };

  const siteParam = readSiteParam(url);
  if (siteParam.error) return { error: siteParam.error };
  const { site, error: siteError } = await resolveOwnedSite(
    env,
    userId,
    siteParam.siteId as string,
  );
  if (siteError) return { error: siteError };

  const timeZone = url.searchParams.get('timezone') ?? site?.timezone ?? 'UTC';
  if (!isValidTimeZone(timeZone)) return { error: error(400, 'Invalid timezone') };

  const startRaw = url.searchParams.get('startAt');
  const endRaw = url.searchParams.get('endAt');

  let start: number;
  let end: number;
  if (startRaw !== null && endRaw !== null) {
    const parsedStart = parseDateBound(startRaw, timeZone, false);
    const parsedEnd = parseDateBound(endRaw, timeZone, true);
    if (parsedStart === null || parsedEnd === null) {
      return { error: error(400, 'Invalid date range') };
    }
    if (parsedStart > parsedEnd) {
      return { error: error(400, 'startAt must be before endAt') };
    }
    start = parsedStart;
    end = parsedEnd;
  } else if (startRaw !== null) {
    const parsedStart = parseDateBound(startRaw, timeZone, false);
    if (parsedStart === null) return { error: error(400, 'Invalid startAt') };
    end = todayEnd(timeZone);
    if (parsedStart > end) return { error: error(400, 'startAt must be before endAt') };
    start = parsedStart;
  } else if (endRaw !== null) {
    const parsedEnd = parseDateBound(endRaw, timeZone, true);
    if (parsedEnd === null) return { error: error(400, 'Invalid endAt') };
    start = defaultStartForEnd(parsedEnd, timeZone);
    end = parsedEnd;
  } else {
    end = todayEnd(timeZone);
    start = defaultStartForEnd(end, timeZone);
  }

  return { range: { start, end, startRaw, endRaw, timeZone }, site };
}

function previousRange(range: Range): { start: number; end: number } {
  const startOnly = range.startRaw && /^\d{4}-\d{2}-\d{2}$/.test(range.startRaw);
  const endOnly = range.endRaw && /^\d{4}-\d{2}-\d{2}$/.test(range.endRaw);
  if (startOnly && endOnly) {
    const start = parseDateBound(range.startRaw as string, range.timeZone, false) as number;
    const end = parseDateBound(range.endRaw as string, range.timeZone, false) as number;
    const lengthDays = Math.round((end - start) / 86400) + 1;
    const startParts = localParts(start, range.timeZone);
    const endParts = localParts(end, range.timeZone);
    const previousStart = zonedLocalMidnightToUtc(
      startParts.year,
      startParts.month,
      startParts.day - lengthDays,
      range.timeZone,
    );
    const previousEnd =
      zonedLocalMidnightToUtc(
        endParts.year,
        endParts.month,
        endParts.day - lengthDays + 1,
        range.timeZone,
      ) - 1;
    return { start: previousStart, end: previousEnd };
  }
  const length = range.end - range.start + 1;
  return { start: range.start - length, end: range.end - length };
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

interface OverviewMetrics {
  visitors: number;
  sessions: number;
  pageviews: number;
  bounceRate: number;
  avgSessionDuration: number;
  currency: string;
  revenue: number;
  payments: number;
  revenuePerVisitor: number;
  conversionRate: number;
}

/** `previous` is present only for `compare=previous` (§2.7.1). */
interface OverviewResponse extends OverviewMetrics {
  previous?: OverviewMetrics;
}

interface BreakdownResult {
  value: string;
  visitors: number;
  pageviews: number;
  revenue: number;
  payments: number;
  revenuePerVisitor: number;
  conversionRate?: number;
}

interface GoalResult {
  value: string;
  completions: number;
  visitors: number;
  pageviews: number;
  revenue: number;
  payments: number;
  revenuePerVisitor: number;
}

interface ExitClickResult {
  value: string;
  visitors: number;
  pageviews: number;
  revenue: number;
  payments: number;
  revenuePerVisitor: number;
  clicks: number;
}

async function computeOverview(
  env: Env,
  site: Website,
  start: number,
  end: number,
): Promise<OverviewMetrics> {
  const rows = await env.DB.prepare(
    `SELECT visitor_id, session_id, name, ts
     FROM events
     WHERE website_id = ? AND ts >= ? AND ts <= ? AND is_bot = 0`,
  )
    .bind(site.id, start, end)
    .all<{ visitor_id: string; session_id: string | null; name: string; ts: number }>();

  const visitors = new Set<string>();
  const sessions = new Set<string>();
  const sessionPageviews = new Map<string, number>();
  const sessionTimes = new Map<string, { min: number; max: number }>();
  let pageviews = 0;

  for (const row of rows.results) {
    visitors.add(row.visitor_id);
    if (row.name === 'pageview') pageviews += 1;
    if (!row.session_id) continue;
    sessions.add(row.session_id);
    sessionPageviews.set(
      row.session_id,
      (sessionPageviews.get(row.session_id) ?? 0) + (row.name === 'pageview' ? 1 : 0),
    );
    const times = sessionTimes.get(row.session_id);
    if (!times) sessionTimes.set(row.session_id, { min: row.ts, max: row.ts });
    else {
      times.min = Math.min(times.min, row.ts);
      times.max = Math.max(times.max, row.ts);
    }
  }

  const sessionCount = sessions.size;
  let bounces = 0;
  let durationSum = 0;
  for (const sessionId of sessions) {
    if ((sessionPageviews.get(sessionId) ?? 0) === 1) bounces += 1;
    const times = sessionTimes.get(sessionId);
    if (times) durationSum += Math.max(0, times.max - times.min);
  }

  const revenue = await computeRevenue(env, site, start, end);
  const visitorCount = visitors.size;

  return {
    visitors: visitorCount,
    sessions: sessionCount,
    pageviews,
    bounceRate: sessionCount > 0 ? round4(bounces / sessionCount) : 0,
    avgSessionDuration: sessionCount > 0 ? Math.round(durationSum / sessionCount) : 0,
    currency: site.currency,
    revenue: round2(revenue.revenue),
    payments: revenue.payments,
    revenuePerVisitor: visitorCount > 0 ? round2(revenue.revenue / visitorCount) : 0,
    conversionRate: visitorCount > 0 ? round4(revenue.payingVisitors / visitorCount) : 0,
  };
}

async function handleOverview(env: Env, url: URL, userId: string): Promise<Response> {
  const { range, site, error: rangeError } = await resolveRange(env, userId, url, OVERVIEW_KEYS);
  if (rangeError) return rangeError;

  const compare = url.searchParams.get('compare');
  if (compare !== null && compare !== 'previous') {
    return error(400, 'compare must be previous');
  }

  const data: OverviewResponse = await computeOverview(
    env,
    site as Website,
    range?.start as number,
    range?.end as number,
  );
  if (compare === 'previous') {
    const previous = previousRange(range as Range);
    data.previous = await computeOverview(env, site as Website, previous.start, previous.end);
  }
  return json({ data });
}

// ---------------------------------------------------------------------------
// Timeseries
// ---------------------------------------------------------------------------

function bucketStart(ts: number, interval: Interval, timeZone: string): number {
  if (interval === 'hour') return Math.floor(ts / 3600) * 3600;
  const parts = localParts(ts, timeZone);
  if (interval === 'day') {
    return zonedLocalMidnightToUtc(parts.year, parts.month, parts.day, timeZone);
  }
  if (interval === 'week') {
    const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
    const offset = (weekday + 6) % 7;
    return zonedLocalMidnightToUtc(parts.year, parts.month, parts.day - offset, timeZone);
  }
  return zonedLocalMidnightToUtc(parts.year, parts.month, 1, timeZone);
}

function buildBuckets(start: number, end: number, interval: Interval, timeZone: string): number[] {
  if (interval === 'hour') {
    const buckets: number[] = [];
    for (let t = Math.floor(start / 3600) * 3600; t <= end; t += 3600) buckets.push(t);
    return buckets;
  }

  const startParts = localParts(start, timeZone);
  let year = startParts.year;
  let month = startParts.month;
  let day = startParts.day;
  if (interval === 'week') {
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    day -= (weekday + 6) % 7;
  } else if (interval === 'month') {
    day = 1;
  }

  const buckets: number[] = [];
  for (let i = 0; i < 1001; i++) {
    const bucket = zonedLocalMidnightToUtc(year, month, day, timeZone);
    if (bucket > end) break;
    buckets.push(bucket);
    if (interval === 'day') {
      day += 1;
    } else if (interval === 'week') {
      day += 7;
    } else {
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
  }
  return Array.from(new Set(buckets));
}

function resolveFields(raw: string | null): { fields: Metric[]; error?: Response } {
  if (raw === null || raw.trim() === '') return { fields: [...ALL_METRICS] };
  const requested = raw
    .split(',')
    .map((field) => field.trim())
    .filter((field) => field.length > 0);
  for (const field of requested) {
    if (!(ALL_METRICS as readonly string[]).includes(field)) {
      return { fields: [], error: error(400, `Unknown metric: ${field}`) };
    }
  }
  if (requested.includes('revenue') && !requested.includes('payments')) {
    requested.push('payments');
  }
  return { fields: ALL_METRICS.filter((field) => requested.includes(field)) };
}

async function handleTimeseries(env: Env, url: URL, userId: string): Promise<Response> {
  const { range, site, error: rangeError } = await resolveRange(env, userId, url, TIMESERIES_KEYS);
  if (rangeError) return rangeError;

  const intervalRaw = url.searchParams.get('interval');
  if (!intervalRaw) return error(400, 'interval is required');
  if (!['hour', 'day', 'week', 'month'].includes(intervalRaw)) {
    return error(400, `Invalid interval: ${intervalRaw}`);
  }
  const interval = intervalRaw as Interval;

  const { fields, error: fieldsError } = resolveFields(url.searchParams.get('fields'));
  if (fieldsError) return fieldsError;

  const { start, end, timeZone } = range as Range;
  const buckets = buildBuckets(start, end, interval, timeZone);
  if (buckets.length > 1000) {
    return error(400, 'narrow the range or use a larger interval');
  }

  const eventRows = await env.DB.prepare(
    `SELECT ts, visitor_id, session_id, name
     FROM events
     WHERE website_id = ? AND ts >= ? AND ts <= ? AND is_bot = 0`,
  )
    .bind((site as Website).id, start, end)
    .all<{ ts: number; visitor_id: string; session_id: string | null; name: string }>();

  const paymentRows = await env.DB.prepare(
    `SELECT occurred_at, currency,
            COALESCE(amount_minor, amount_cents) - refunded_minor - disputed_minor AS net
     FROM payments
     WHERE website_id = ? AND occurred_at >= ? AND occurred_at <= ? AND attributed = 1`,
  )
    .bind((site as Website).id, start, end)
    .all<{ occurred_at: number; currency: string; net: number }>();

  const rates = await loadFxRates(env);
  const indexByBucket = new Map<number, number>();
  buckets.forEach((bucket, index) => {
    indexByBucket.set(bucket, index);
  });

  interface BucketAgg {
    visitors: Set<string>;
    pageviews: number;
    sessions: Set<string>;
    revenueCents: number;
    payments: number;
  }
  const aggs: BucketAgg[] = buckets.map(() => ({
    visitors: new Set(),
    pageviews: 0,
    sessions: new Set(),
    revenueCents: 0,
    payments: 0,
  }));

  for (const row of eventRows.results) {
    const index = indexByBucket.get(bucketStart(row.ts, interval, timeZone));
    if (index === undefined) continue;
    const agg = aggs[index];
    agg.visitors.add(row.visitor_id);
    if (row.name === 'pageview') agg.pageviews += 1;
    if (row.session_id) agg.sessions.add(row.session_id);
  }

  for (const row of paymentRows.results) {
    const index = indexByBucket.get(bucketStart(row.occurred_at, interval, timeZone));
    if (index === undefined) continue;
    const agg = aggs[index];
    agg.revenueCents += convertCents(
      row.net,
      row.currency,
      (site as Website).currency,
      row.occurred_at,
      rates,
    );
    agg.payments += 1;
  }

  const points = aggs.map((agg, index) => {
    const point: Record<string, unknown> = { timestamp: iso(buckets[index]) };
    for (const field of fields) {
      if (field === 'visitors') point.visitors = agg.visitors.size;
      else if (field === 'pageviews') point.pageviews = agg.pageviews;
      else if (field === 'sessions') point.sessions = agg.sessions.size;
      else if (field === 'revenue') point.revenue = round2(agg.revenueCents / 100);
      else if (field === 'payments') point.payments = agg.payments;
    }
    return point;
  });

  return json({
    data: {
      interval,
      fields,
      timezone: timeZone,
      currency: (site as Website).currency,
      points,
    },
  });
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

async function handleMetadata(env: Env, url: URL, userId: string): Promise<Response> {
  const queryError = checkQueryParams(url, METADATA_KEYS);
  if (queryError) return queryError;
  const siteParam = readSiteParam(url);
  if (siteParam.error) return siteParam.error;
  const { site, error: siteError } = await resolveOwnedSite(
    env,
    userId,
    siteParam.siteId as string,
  );
  if (siteError) return siteError;

  return json({
    data: {
      siteId: (site as Website).id,
      domain: (site as Website).domain,
      name: (site as Website).name ? (site as Website).name : (site as Website).domain,
      timezone: (site as Website).timezone,
      currency: (site as Website).currency,
      // No KPI column exists yet (M5 settings UI); the contract allows null.
      kpi: null,
    },
  });
}

// ---------------------------------------------------------------------------
// Breakdowns
// ---------------------------------------------------------------------------

async function handleBreakdown(
  env: Env,
  url: URL,
  userId: string,
  dimension: string,
): Promise<Response> {
  const { range, site, error: rangeError } = await resolveRange(env, userId, url, BREAKDOWN_KEYS);
  if (rangeError) return rangeError;

  const { order, error: orderError } = parseOrder(url);
  if (orderError) return orderError;
  const { limit, offset, error: pageError } = parsePagination(url);
  if (pageError) return pageError;

  const pathFilter = url.searchParams.get('path');
  const goalFilter = url.searchParams.get('goal');
  const siteId = (site as Website).id;
  const { start, end } = range as Range;

  // Breakdowns are pageview-scoped: goal/custom events are reported by
  // `/analytics/goals` and must not create page or referrer rows.
  let sql = `SELECT visitor_id, name, path, referrer, utm_campaign, country, region, city,
                    device_type, os, browser, hostname, props
             FROM events
             WHERE website_id = ? AND ts >= ? AND ts <= ? AND is_bot = 0 AND name = 'pageview'`;
  const binds: unknown[] = [siteId, start, end];
  if (pathFilter) {
    sql += ' AND path LIKE ?';
    binds.push(`%${pathFilter}%`);
  }

  const rows = await env.DB.prepare(sql)
    .bind(...binds)
    .all<BreakdownEvent>();
  const getter = BREAKDOWN_GETTERS[dimension];
  if (!getter) return error(404, 'Not found');

  interface RowAgg {
    visitors: Set<string>;
    pageviews: number;
  }
  const byValue = new Map<string, RowAgg>();

  for (const row of rows.results) {
    const value = getter(row);
    let agg = byValue.get(value);
    if (!agg) {
      agg = { visitors: new Set(), pageviews: 0 };
      byValue.set(value, agg);
    }
    agg.visitors.add(row.visitor_id);
    agg.pageviews += 1;
  }

  // Goal completion is overlaid from the goal event stream, independent of
  // the pageview-scoped dimension grouping.
  const goalVisitors = goalFilter ? new Set<string>() : null;
  if (goalFilter) {
    const goalRows = await env.DB.prepare(
      `SELECT DISTINCT visitor_id FROM events
       WHERE website_id = ? AND ts >= ? AND ts <= ? AND is_bot = 0 AND name = ?`,
    )
      .bind(siteId, start, end, goalFilter)
      .all<{ visitor_id: string }>();
    for (const row of goalRows.results) goalVisitors?.add(row.visitor_id);
  }

  const visitorRevenue = await loadVisitorRevenue(env, site as Website, start, end);

  const result: BreakdownResult[] = Array.from(byValue.entries()).map(([value, agg]) => {
    let revenueCents = 0;
    let payments = 0;
    for (const visitor of agg.visitors) {
      const entry = visitorRevenue.get(visitor);
      if (entry) {
        revenueCents += entry.revenueCents;
        payments += entry.payments;
      }
    }
    const visitors = agg.visitors.size;
    const row: BreakdownResult = {
      value,
      visitors,
      pageviews: agg.pageviews,
      revenue: round2(revenueCents / 100),
      payments,
      revenuePerVisitor: visitors > 0 ? round2(revenueCents / 100 / visitors) : 0,
    };
    if (goalVisitors) {
      let goalCount = 0;
      for (const visitor of agg.visitors) {
        if (goalVisitors.has(visitor)) goalCount += 1;
      }
      row.conversionRate = visitors > 0 ? round4(goalCount / visitors) : 0;
    }
    return row;
  });

  result.sort((a, b) => {
    const diff = order === 'asc' ? a.visitors - b.visitors : b.visitors - a.visitors;
    return diff !== 0 ? diff : String(a.value).localeCompare(String(b.value));
  });

  const total = result.length;
  return json({
    data: result.slice(offset, offset + limit),
    pagination: pagination(limit, offset, total),
  });
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

async function handleGoals(env: Env, url: URL, userId: string): Promise<Response> {
  const { range, site, error: rangeError } = await resolveRange(env, userId, url, GOALS_KEYS);
  if (rangeError) return rangeError;

  const { order, error: orderError } = parseOrder(url);
  if (orderError) return orderError;
  const { limit, offset, error: pageError } = parsePagination(url);
  if (pageError) return pageError;

  const { start, end } = range as Range;
  const rows = await env.DB.prepare(
    `SELECT visitor_id, name
     FROM events
     WHERE website_id = ? AND ts >= ? AND ts <= ? AND is_bot = 0 AND name != 'pageview'`,
  )
    .bind((site as Website).id, start, end)
    .all<{ visitor_id: string; name: string }>();

  interface GoalAgg {
    visitors: Set<string>;
    completions: number;
  }
  const byName = new Map<string, GoalAgg>();
  for (const row of rows.results) {
    let agg = byName.get(row.name);
    if (!agg) {
      agg = { visitors: new Set(), completions: 0 };
      byName.set(row.name, agg);
    }
    agg.visitors.add(row.visitor_id);
    agg.completions += 1;
  }

  const visitorRevenue = await loadVisitorRevenue(env, site as Website, start, end);
  const result: GoalResult[] = Array.from(byName.entries()).map(([value, agg]) => {
    let revenueCents = 0;
    let payments = 0;
    for (const visitor of agg.visitors) {
      const entry = visitorRevenue.get(visitor);
      if (entry) {
        revenueCents += entry.revenueCents;
        payments += entry.payments;
      }
    }
    const visitors = agg.visitors.size;
    return {
      value,
      completions: agg.completions,
      visitors,
      pageviews: 0,
      revenue: round2(revenueCents / 100),
      payments,
      revenuePerVisitor: visitors > 0 ? round2(revenueCents / 100 / visitors) : 0,
    };
  });

  result.sort((a, b) => {
    const diff = order === 'asc' ? a.visitors - b.visitors : b.visitors - a.visitors;
    return diff !== 0 ? diff : String(a.value).localeCompare(String(b.value));
  });

  const total = result.length;
  return json({
    data: result.slice(offset, offset + limit),
    pagination: pagination(limit, offset, total),
  });
}

// ---------------------------------------------------------------------------
// Exit clicks
// ---------------------------------------------------------------------------

async function handleExitClicks(env: Env, url: URL, userId: string): Promise<Response> {
  const { range, site, error: rangeError } = await resolveRange(env, userId, url, BREAKDOWN_KEYS);
  if (rangeError) return rangeError;

  const { order, error: orderError } = parseOrder(url);
  if (orderError) return orderError;
  const { limit, offset, error: pageError } = parsePagination(url);
  if (pageError) return pageError;

  const { start, end } = range as Range;
  const rows = await env.DB.prepare(
    `SELECT visitor_id, json_extract(props, '$.url') AS url
     FROM events
     WHERE website_id = ? AND ts >= ? AND ts <= ? AND is_bot = 0
       AND name = 'exit_click' AND json_extract(props, '$.url') IS NOT NULL`,
  )
    .bind((site as Website).id, start, end)
    .all<{ visitor_id: string; url: string }>();

  interface ClickAgg {
    visitors: Set<string>;
    clicks: number;
  }
  const byUrl = new Map<string, ClickAgg>();
  for (const row of rows.results) {
    let agg = byUrl.get(row.url);
    if (!agg) {
      agg = { visitors: new Set(), clicks: 0 };
      byUrl.set(row.url, agg);
    }
    agg.visitors.add(row.visitor_id);
    agg.clicks += 1;
  }

  const visitorRevenue = await loadVisitorRevenue(env, site as Website, start, end);
  const result: ExitClickResult[] = Array.from(byUrl.entries()).map(([value, agg]) => {
    let revenueCents = 0;
    let payments = 0;
    for (const visitor of agg.visitors) {
      const entry = visitorRevenue.get(visitor);
      if (entry) {
        revenueCents += entry.revenueCents;
        payments += entry.payments;
      }
    }
    const visitors = agg.visitors.size;
    return {
      value,
      visitors,
      pageviews: 0,
      revenue: round2(revenueCents / 100),
      payments,
      revenuePerVisitor: visitors > 0 ? round2(revenueCents / 100 / visitors) : 0,
      clicks: agg.clicks,
    };
  });

  result.sort((a, b) => {
    const diff = order === 'asc' ? a.visitors - b.visitors : b.visitors - a.visitors;
    return diff !== 0 ? diff : String(a.value).localeCompare(String(b.value));
  });

  const total = result.length;
  return json({
    data: result.slice(offset, offset + limit),
    pagination: pagination(limit, offset, total),
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const BREAKDOWN_PATH =
  /^\/api\/v1\/analytics\/(pages|referrers|campaigns|countries|regions|cities|browsers|devices|operating-systems|hostnames)$/;
const FUNNEL_PATH = /^\/api\/v1\/analytics\/funnel\/([^/]+)$/;

export async function handleAnalytics(
  _request: Request,
  env: Env,
  url: URL,
  method: string,
  userId: string,
): Promise<Response | null> {
  const path = url.pathname;

  if (path === '/api/v1/analytics/overview') {
    if (method !== 'GET') return error(405, 'Method not allowed');
    return handleOverview(env, url, userId);
  }
  if (path === '/api/v1/analytics/timeseries') {
    if (method !== 'GET') return error(405, 'Method not allowed');
    return handleTimeseries(env, url, userId);
  }
  if (path === '/api/v1/analytics/metadata') {
    if (method !== 'GET') return error(405, 'Method not allowed');
    return handleMetadata(env, url, userId);
  }
  if (path === '/api/v1/analytics/goals') {
    if (method !== 'GET') return error(405, 'Method not allowed');
    return handleGoals(env, url, userId);
  }
  if (path === '/api/v1/analytics/exit-clicks') {
    if (method !== 'GET') return error(405, 'Method not allowed');
    return handleExitClicks(env, url, userId);
  }

  const breakdown = BREAKDOWN_PATH.exec(path);
  if (breakdown) {
    if (method !== 'GET') return error(405, 'Method not allowed');
    return handleBreakdown(env, url, userId, breakdown[1]);
  }

  const funnel = FUNNEL_PATH.exec(path);
  if (funnel) {
    if (method !== 'GET') return error(405, 'Method not allowed');
    const { range, site, error: rangeError } = await resolveRange(env, userId, url, FUNNEL_KEYS);
    if (rangeError) return rangeError;
    return handleFunnelResult(env, site as Website, decodeURIComponent(funnel[1]), range as Range);
  }

  return null;
}
