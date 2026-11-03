import type { Env } from './env';

/**
 * Serves the built dashboard (`packages/dashboard/dist`) through the
 * `[assets]` binding. Wrangler's `single-page-application` fallback returns
 * `index.html` for unknown paths, so client-side routes resolve on reload and
 * `GET /` returns the SPA shell.
 */
export async function serveAssets(request: Request, env: Env): Promise<Response> {
  if (!env.ASSETS) {
    return new Response('Dashboard assets are not configured.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { Allow: 'GET, HEAD' },
    });
  }
  return env.ASSETS.fetch(request);
}
