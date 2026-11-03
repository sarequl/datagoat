import type { ServerResponse } from 'node:http';
import { goalRows } from '../fixtures.ts';
import { sendJson } from '../http.ts';

function parseLimit(raw: string | null): number {
  const value = Number.parseInt(raw ?? '100', 10);
  if (!Number.isFinite(value) || value < 1) return 100;
  return Math.min(value, 1000);
}

function parseOffset(raw: string | null): number {
  const value = Number.parseInt(raw ?? '0', 10);
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

export function handleGoals(
  method: string,
  _path: string,
  url: URL,
  response: ServerResponse,
): void {
  if (method !== 'GET') {
    sendJson(response, 405, { error: { code: 405, message: 'Method not allowed' } });
    return;
  }

  const order = url.searchParams.get('order') === 'asc' ? 'asc' : 'desc';
  const rows = [...goalRows].sort((a, b) =>
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
