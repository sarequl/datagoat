import type { ServerResponse } from 'node:http';
import { funnelResults } from '../fixtures.ts';
import { sendJson } from '../http.ts';
import { resolveSiteScope } from './siteScope.ts';

export const FUNNEL_PREFIX = '/api/v1/analytics/funnel/';

export function handleFunnel(
  method: string,
  path: string,
  url: URL,
  response: ServerResponse,
): void {
  if (method !== 'GET') {
    sendJson(response, 405, { error: { code: 405, message: 'Method not allowed' } });
    return;
  }

  if (!resolveSiteScope(url, response)) return;

  const funnelId = decodeURIComponent(path.slice(FUNNEL_PREFIX.length));
  const data = funnelResults[funnelId];
  if (!data) {
    sendJson(response, 404, { error: { code: 404, message: `Unknown funnel: ${funnelId}` } });
    return;
  }

  // §2.7.3: startAt/endAt echo the resolved bounds; the mock echoes the request.
  sendJson(response, 200, {
    data: {
      ...data,
      timezone: url.searchParams.get('timezone') ?? data.timezone,
      startAt: url.searchParams.get('startAt'),
      endAt: url.searchParams.get('endAt'),
    },
  });
}
