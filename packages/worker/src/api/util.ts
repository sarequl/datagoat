import type { Env, Website } from '../env';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', ...headers },
  });
}

/** §0 error envelope: `{"error": {"code", "message", "details"}}`. */
export function error(status: number, message: string, details?: unknown[]): Response {
  const body: { error: { code: number; message: string; details?: unknown[] } } = {
    error: { code: status, message },
  };
  if (details !== undefined) body.error.details = details;
  return json(body, status);
}

export function noContent(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

/**
 * §2.4: unknown or duplicate query parameters are rejected with 400. Returns an
 * error response, or null when the query string is acceptable.
 */
export function checkQueryParams(url: URL, allowed: string[]): Response | null {
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (seen.has(key)) return error(400, `Duplicate ${key} query parameter`);
    seen.add(key);
    if (!allowed.includes(key)) return error(400, `Unknown query parameter: ${key}`);
  }
  return null;
}

export interface Pagination {
  limit: number;
  offset: number;
  total: number;
  hasMore: boolean;
}

export function pagination(limit: number, offset: number, total: number): Pagination {
  return { limit, offset, total, hasMore: offset + limit < total };
}

export function parsePagination(url: URL): { limit: number; offset: number; error?: Response } {
  let limit = 100;
  let offset = 0;

  const limitRaw = url.searchParams.get('limit');
  if (limitRaw !== null) {
    const value = Number(limitRaw);
    if (!Number.isInteger(value) || value < 1 || value > 1000) {
      return { limit, offset, error: error(400, 'limit must be an integer between 1 and 1000') };
    }
    limit = value;
  }

  const offsetRaw = url.searchParams.get('offset');
  if (offsetRaw !== null) {
    const value = Number(offsetRaw);
    if (!Number.isInteger(value) || value < 0) {
      return { limit, offset, error: error(400, 'offset must be a non-negative integer') };
    }
    offset = value;
  }

  return { limit, offset };
}

export function parseOrder(url: URL): { order: 'asc' | 'desc'; error?: Response } {
  const raw = url.searchParams.get('order');
  if (raw === null || raw === 'desc') return { order: 'desc' };
  if (raw === 'asc') return { order: 'asc' };
  return { order: 'desc', error: error(400, 'order must be asc or desc') };
}

/** §1.4: cookie sessions pass `siteId`; missing -> 400, duplicate -> 400. */
export function readSiteParam(url: URL): { siteId?: string; error?: Response } {
  const values = url.searchParams.getAll('siteId');
  if (values.length > 1) return { error: error(400, 'Duplicate siteId query parameter') };
  const siteId = values[0];
  if (!siteId) return { error: error(400, 'siteId is required') };
  return { siteId };
}

/**
 * §1.4: a site is accessible when it exists and is owned by the caller. The
 * response is the same 404 whether the site is unknown or not owned, so
 * existence is not disclosed.
 */
export async function resolveOwnedSite(
  env: Env,
  userId: string,
  siteId: string,
): Promise<{ site?: Website; error?: Response }> {
  const site = await env.DB.prepare('SELECT * FROM websites WHERE id = ?')
    .bind(siteId)
    .first<Website>();
  if (!site || site.owner_user_id !== userId) return { error: error(404, 'Site not found') };
  return { site };
}

/** Parses a JSON object body; null means malformed or non-object JSON. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** ISO 8601 UTC timestamp ending in `Z` (§2.7 conventions). */
export function iso(ts: number): string {
  return new Date(ts * 1000).toISOString();
}
