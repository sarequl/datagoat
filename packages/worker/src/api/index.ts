import type { Env } from '../env';
import { handleAnalytics } from './analytics';
import { handleSession, requireOwner } from './auth';
import { handleAdminFunnels } from './funnels';
import { handleAdminSites } from './sites';
import { error } from './util';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

/**
 * Routes `/api/v1/*`. The router owns auth: session routes are public, every
 * other `/api/v1` route requires a valid session.
 */
export async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const method = request.method;
  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const path = url.pathname;

  const session = await handleSession(request, env, url, method);
  if (session) return session;

  const owner = await requireOwner(request, env);
  if (owner.error) return owner.error;
  const userId = owner.userId as string;

  if (path === '/api/v1/admin/sites') {
    return handleAdminSites(request, env, url, method);
  }

  const siteMatch = /^\/api\/v1\/admin\/sites\/([^/]+)$/.exec(path);
  if (siteMatch) {
    return handleAdminSites(request, env, url, method, decodeURIComponent(siteMatch[1]));
  }

  const funnelsMatch = /^\/api\/v1\/admin\/sites\/([^/]+)\/funnels(?:\/([^/]+))?$/.exec(path);
  if (funnelsMatch) {
    return handleAdminFunnels(
      request,
      env,
      url,
      method,
      decodeURIComponent(funnelsMatch[1]),
      funnelsMatch[2] ? decodeURIComponent(funnelsMatch[2]) : undefined,
    );
  }

  if (path.startsWith('/api/v1/analytics/')) {
    const analytics = await handleAnalytics(request, env, url, method, userId);
    if (analytics) return analytics;
    return error(404, 'Not found');
  }

  return error(404, 'Not found');
}
