import type { ServerResponse } from 'node:http';
import type { Site } from '../../api/types.ts';
import { sites } from '../fixtures.ts';
import { sendJson } from '../http.ts';

/**
 * Site-scoped routes require one owned `siteId` query param for cookie
 * sessions: missing -> 400, unknown/not-owned -> 404, duplicate -> 400.
 * `dg_*` keys infer the site and admin subroutes stay path-scoped, so this
 * helper only applies to the `/analytics/*` routes the SPA calls.
 */
export function resolveSiteScope(url: URL, response: ServerResponse): Site | null {
  const values = url.searchParams.getAll('siteId');
  if (values.length > 1) {
    sendJson(response, 400, {
      error: { code: 400, message: 'Duplicate siteId query parameter' },
    });
    return null;
  }

  const siteId = values[0];
  if (!siteId) {
    sendJson(response, 400, { error: { code: 400, message: 'siteId is required' } });
    return null;
  }

  const site = sites.find((item) => item.id === siteId);
  if (!site) {
    sendJson(response, 404, { error: { code: 404, message: `Site not found: ${siteId}` } });
    return null;
  }

  return site;
}
