import type { ServerResponse } from 'node:http';
import type { BreakdownDimension } from '../../api/breakdown.ts';
import type { BreakdownRow } from '../../api/types.ts';
import { breakdownRows, sites } from '../fixtures.ts';
import { sendJson } from '../http.ts';
import { resolveSiteScope } from './siteScope.ts';

export const BREAKDOWN_DIMENSIONS: BreakdownDimension[] = [
  'pages',
  'referrers',
  'campaigns',
  'countries',
  'devices',
  'browsers',
];

export function isBreakdownPath(path: string): boolean {
  const dimension = path.replace(/^\/api\/v1\/analytics\//, '');
  return BREAKDOWN_DIMENSIONS.includes(dimension as BreakdownDimension);
}

function parseLimit(raw: string | null): number {
  const value = Number.parseInt(raw ?? '100', 10);
  if (!Number.isFinite(value) || value < 1) return 100;
  return Math.min(value, 100);
}

function parseOffset(raw: string | null): number {
  const value = Number.parseInt(raw ?? '0', 10);
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

export function handleSites(
  method: string,
  _path: string,
  url: URL,
  response: ServerResponse,
): void {
  if (method !== 'GET') {
    sendJson(response, 405, { error: { code: 405, message: 'Method not allowed' } });
    return;
  }

  const limit = parseLimit(url.searchParams.get('limit'));
  const offset = parseOffset(url.searchParams.get('offset'));
  const page = sites.slice(offset, offset + limit);
  sendJson(response, 200, {
    data: page,
    pagination: {
      limit,
      offset,
      total: sites.length,
      hasMore: offset + page.length < sites.length,
    },
  });
}

export function handleBreakdown(
  method: string,
  path: string,
  url: URL,
  response: ServerResponse,
): void {
  if (method !== 'GET') {
    sendJson(response, 405, { error: { code: 405, message: 'Method not allowed' } });
    return;
  }

  const dimension = path.split('/').pop() as BreakdownDimension;
  if (!BREAKDOWN_DIMENSIONS.includes(dimension)) {
    sendJson(response, 404, {
      error: { code: 404, message: `Unknown breakdown dimension: ${dimension}` },
    });
    return;
  }

  if (!resolveSiteScope(url, response)) return;

  const pathFilter = url.searchParams.get('path');
  let rows: BreakdownRow[] = breakdownRows(dimension);
  // The real API applies `path` to the page path; the mock only models that
  // filter for the pages dimension.
  if (dimension === 'pages' && pathFilter) {
    rows = rows.filter((row) => row.value.includes(pathFilter));
  }

  const order = url.searchParams.get('order') === 'asc' ? 'asc' : 'desc';
  rows = [...rows].sort((a, b) =>
    order === 'asc' ? a.visitors - b.visitors : b.visitors - a.visitors,
  );

  const limit = parseLimit(url.searchParams.get('limit'));
  const offset = parseOffset(url.searchParams.get('offset'));
  const page = rows.slice(offset, offset + limit);
  sendJson(response, 200, {
    data: page,
    pagination: {
      limit,
      offset,
      total: rows.length,
      hasMore: offset + page.length < rows.length,
    },
  });
}
