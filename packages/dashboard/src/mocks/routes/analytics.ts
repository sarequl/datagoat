import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Timeseries } from '../../api/types.ts';
import { metadata, overviewBase, overviewPrevious, sites, timeseriesPoint } from '../fixtures.ts';
import { sendJson } from '../http.ts';

const INTERVALS = ['hour', 'day', 'week', 'month'] as const;
type Interval = (typeof INTERVALS)[number];

const TIMESERIES_FIELDS = ['visitors', 'pageviews', 'sessions', 'revenue', 'payments'] as const;
type TimeseriesField = (typeof TIMESERIES_FIELDS)[number];

/** Canonical field order; requesting `revenue` also returns `payments`. */
function resolveFields(raw: string | null): TimeseriesField[] {
  const requested = (raw ?? TIMESERIES_FIELDS.join(','))
    .split(',')
    .map((field) => field.trim())
    .filter((field): field is TimeseriesField =>
      (TIMESERIES_FIELDS as readonly string[]).includes(field),
    );
  if (requested.includes('revenue') && !requested.includes('payments')) {
    requested.push('payments');
  }
  return TIMESERIES_FIELDS.filter((field) => requested.includes(field));
}

function parseDate(value: string | null, fallback: Date): Date {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function addInterval(date: Date, interval: Interval): Date {
  const next = new Date(date);
  switch (interval) {
    case 'hour':
      next.setUTCHours(next.getUTCHours() + 1);
      break;
    case 'day':
      next.setUTCDate(next.getUTCDate() + 1);
      break;
    case 'week':
      next.setUTCDate(next.getUTCDate() + 7);
      break;
    case 'month':
      next.setUTCMonth(next.getUTCMonth() + 1);
      break;
  }
  return next;
}

function generatePoints(start: Date, end: Date, interval: Interval) {
  const points = [];
  let cursor = new Date(start);
  let seed = 1;
  while (cursor.getTime() <= end.getTime()) {
    points.push(timeseriesPoint(cursor.toISOString(), seed));
    cursor = addInterval(cursor, interval);
    seed += 1;
  }
  return points;
}

function defaultStart(interval: Interval): Date {
  const now = new Date();
  const start = new Date(now);
  if (interval === 'hour') {
    start.setUTCHours(now.getUTCHours() - 23, 0, 0, 0);
  } else if (interval === 'day') {
    start.setUTCDate(now.getUTCDate() - 6);
  } else if (interval === 'week') {
    start.setUTCDate(now.getUTCDate() - 42);
  } else {
    start.setUTCMonth(now.getUTCMonth() - 6);
  }
  return start;
}

export function handleAnalytics(
  method: string,
  path: string,
  url: URL,
  _request: IncomingMessage,
  response: ServerResponse,
): void {
  if (method !== 'GET') {
    sendJson(response, 405, { error: { code: 405, message: 'Method not allowed' } });
    return;
  }

  if (path === '/api/v1/analytics/metadata') {
    const siteId = url.searchParams.get('siteId');
    const site = sites.find((item) => item.id === siteId);
    const data = site
      ? {
          ...metadata,
          siteId: site.id,
          name: site.name ?? site.domain,
          domain: site.domain,
          timezone: site.timezone,
          currency: site.currency,
        }
      : metadata;
    sendJson(response, 200, { data });
    return;
  }

  if (path === '/api/v1/analytics/overview') {
    const includePrevious = url.searchParams.get('compare') === 'previous';
    const data = includePrevious ? { ...overviewBase, previous: overviewPrevious } : overviewBase;
    sendJson(response, 200, { data });
    return;
  }

  if (path === '/api/v1/analytics/timeseries') {
    const rawInterval = url.searchParams.get('interval') ?? 'day';
    if (!INTERVALS.includes(rawInterval as Interval)) {
      sendJson(response, 400, {
        error: { code: 400, message: `Invalid interval: ${rawInterval}` },
      });
      return;
    }
    const interval = rawInterval as Interval;
    const start = parseDate(url.searchParams.get('startAt'), defaultStart(interval));
    const end = parseDate(url.searchParams.get('endAt'), new Date());
    if (start.getTime() > end.getTime()) {
      sendJson(response, 400, {
        error: { code: 400, message: 'startAt must be before endAt' },
      });
      return;
    }

    const fields = resolveFields(url.searchParams.get('fields'));
    const points = generatePoints(start, end, interval);
    const data: Timeseries = {
      interval,
      fields,
      timezone: url.searchParams.get('timezone') ?? 'UTC',
      currency: 'USD',
      points,
    };
    sendJson(response, 200, { data });
    return;
  }

  sendJson(response, 404, {
    error: { code: 404, message: `Unknown analytics route ${method} ${path}` },
  });
}
