import type { IncomingMessage, ServerResponse } from 'node:http';

const COOKIE_NAME = 'dg_session';
const COOKIE_ATTRIBUTES = 'HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200';

export function parseCookies(request: IncomingMessage): Record<string, string> {
  const header = request.headers.cookie;
  if (!header) return {};

  const cookies: Record<string, string> = {};
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

export function hasSession(request: IncomingMessage): boolean {
  return Boolean(parseCookies(request)[COOKIE_NAME]);
}

export function setSessionCookie(response: ServerResponse, value: string): void {
  response.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(value)}; ${COOKIE_ATTRIBUTES}`,
  );
}

export function clearSessionCookie(response: ServerResponse): void {
  response.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
  );
}
