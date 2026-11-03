import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from './http.ts';
import { handleAnalytics } from './routes/analytics.ts';
import { handleSession } from './routes/session.ts';

export async function handleMockRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = (request.method ?? 'GET').toUpperCase();

  if (path === '/api/v1/health') {
    sendJson(response, 200, { data: { status: 'ok' } });
    return;
  }

  if (path === '/api/v1/session' || path === '/api/v1/session/logout') {
    await handleSession(method, path, request, response);
    return;
  }

  if (path === '/api/v1/analytics/metadata') {
    handleAnalytics(method, path, url, request, response);
    return;
  }

  if (path === '/api/v1/analytics/overview') {
    handleAnalytics(method, path, url, request, response);
    return;
  }

  if (path === '/api/v1/analytics/timeseries') {
    handleAnalytics(method, path, url, request, response);
    return;
  }

  response.statusCode = 404;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(
    JSON.stringify({
      error: { code: 404, message: `Mock route not implemented: ${method} ${path}` },
    }),
  );
}
