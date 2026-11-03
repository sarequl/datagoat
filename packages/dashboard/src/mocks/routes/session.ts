import type { IncomingMessage, ServerResponse } from 'node:http';
import { clearSessionCookie, hasSession, setSessionCookie } from '../cookies.ts';
import { MOCK_PASSWORD, MOCK_SESSION_TOKEN } from '../fixtures.ts';

type JsonBody = Record<string, unknown>;

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

function readBody(request: IncomingMessage): Promise<JsonBody> {
  return new Promise((resolve, reject) => {
    let data = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      data += chunk;
    });
    request.on('end', () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data) as JsonBody);
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    request.on('error', reject);
  });
}

export async function handleSession(
  method: string,
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (method === 'GET' && path === '/api/v1/session') {
    if (!hasSession(request)) {
      sendJson(response, 401, { error: { code: 401, message: 'Unauthenticated' } });
      return;
    }
    sendJson(response, 200, { data: { authenticated: true, scope: 'owner' } });
    return;
  }

  if (method === 'POST' && path === '/api/v1/session') {
    let body: JsonBody;
    try {
      body = await readBody(request);
    } catch {
      sendJson(response, 400, { error: { code: 400, message: 'Invalid JSON body' } });
      return;
    }
    if (body.password !== MOCK_PASSWORD) {
      sendJson(response, 401, { error: { code: 401, message: 'Incorrect password' } });
      return;
    }
    setSessionCookie(response, MOCK_SESSION_TOKEN);
    sendJson(response, 200, { data: { authenticated: true, scope: 'owner' } });
    return;
  }

  if (method === 'POST' && path === '/api/v1/session/logout') {
    clearSessionCookie(response);
    sendJson(response, 200, { data: { authenticated: false } });
    return;
  }

  sendJson(response, 404, {
    error: { code: 404, message: `Unknown session route ${method} ${path}` },
  });
}
