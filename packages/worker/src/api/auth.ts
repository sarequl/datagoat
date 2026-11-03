import type { Env } from '../env';
import { fromHex, toHex } from '../util/crypto';
import { parseCookies, serializeCookie, ulid } from '../util/ids';
import { error, json, readJsonBody } from './util';

const encoder = new TextEncoder();

export const SESSION_COOKIE = 'dg_session';
export const SESSION_TTL_S = 12 * 3600;
const PBKDF2_ITERATIONS = 210_000;
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_S = 15 * 60;
const OWNER_EMAIL = 'owner@localhost';

// ---------------------------------------------------------------------------
// Password hashing (PBKDF2-SHA256; Workers have no Argon2/bcrypt)
// ---------------------------------------------------------------------------

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  );
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${toHex(salt)}$${toHex(bits)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
  const iterations = Number(parts[1]);
  const salt = fromHex(parts[2]);
  const expected = fromHex(parts[3]);
  if (!Number.isInteger(iterations) || iterations < 1 || !salt || !expected) return false;

  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  const actual = new Uint8Array(bits);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// HS256 session JWT
// ---------------------------------------------------------------------------

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return new Uint8Array(signature);
}

export async function signSession(env: Env, userId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = base64UrlEncode(
    encoder.encode(JSON.stringify({ sub: userId, exp: now + SESSION_TTL_S, iat: now })),
  );
  const signature = base64UrlEncode(await hmacSha256(env.SESSION_SECRET, `${header}.${payload}`));
  return `${header}.${payload}.${signature}`;
}

export async function verifySession(env: Env, token: string): Promise<string | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  if (!header || !payload || !signature) return null;

  const expected = base64UrlEncode(await hmacSha256(env.SESSION_SECRET, `${header}.${payload}`));
  const expectedBytes = base64UrlDecode(expected);
  const actualBytes = base64UrlDecode(signature);
  if (expectedBytes.length !== actualBytes.length) return null;
  let diff = 0;
  for (let i = 0; i < expectedBytes.length; i++) {
    diff |= expectedBytes[i] ^ actualBytes[i];
  }
  if (diff !== 0) return null;

  try {
    const decoded = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as {
      sub?: unknown;
      exp?: unknown;
    };
    if (typeof decoded.sub !== 'string' || typeof decoded.exp !== 'number') return null;
    if (decoded.exp < Math.floor(Date.now() / 1000)) return null;
    return decoded.sub;
  } catch {
    return null;
  }
}

/** §2.5: the cookie or `Authorization: Bearer` both carry the session JWT. */
export function sessionTokenFromRequest(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match) return match[1].trim();
  }
  const cookies = parseCookies(request.headers.get('cookie'));
  return cookies[SESSION_COOKIE] ?? null;
}

export async function requireOwner(
  request: Request,
  env: Env,
): Promise<{ userId?: string; error?: Response }> {
  const token = sessionTokenFromRequest(request);
  if (!token) return { error: error(401, 'Unauthenticated') };
  const userId = await verifySession(env, token);
  if (!userId) return { error: error(401, 'Unauthenticated') };
  return { userId };
}

function sessionCookie(token: string): string {
  return serializeCookie(SESSION_COOKIE, token, {
    maxAge: SESSION_TTL_S,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
  });
}

function clientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ??
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ??
    '127.0.0.1'
  );
}

async function loginRateLimit(env: Env, ip: string): Promise<{ key: string; allowed: boolean }> {
  const window = Math.floor(Math.floor(Date.now() / 1000) / LOGIN_WINDOW_S);
  const key = `login_rl:${ip}:${window}`;
  const raw = await env.KV.get(key);
  const count = raw ? Number(raw) : 0;
  if (Number.isFinite(count) && count >= LOGIN_MAX_ATTEMPTS) {
    return { key, allowed: false };
  }
  await env.KV.put(key, String(count + 1), { expirationTtl: LOGIN_WINDOW_S * 2 });
  return { key, allowed: true };
}

interface UserRow {
  id: string;
  password_hash: string;
}

async function findOwner(env: Env): Promise<UserRow | null> {
  const owner = await env.DB.prepare(
    'SELECT id, password_hash FROM users WHERE is_owner = 1 ORDER BY created_at ASC LIMIT 1',
  ).first<UserRow>();
  if (owner) return owner;
  return env.DB.prepare(
    'SELECT id, password_hash FROM users ORDER BY created_at ASC LIMIT 1',
  ).first<UserRow>();
}

async function issueSession(env: Env, userId: string): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(now, userId).run();
  const token = await signSession(env, userId);
  return json({ data: { authenticated: true, scope: 'owner' } }, 200, {
    'Set-Cookie': sessionCookie(token),
  });
}

/**
 * Session routes (§2.5 / §2.7.10). Returns null when the path is not a session
 * route so the API router can continue.
 */
export async function handleSession(
  request: Request,
  env: Env,
  url: URL,
  method: string,
): Promise<Response | null> {
  const path = url.pathname;

  if (path === '/api/v1/session' && method === 'GET') {
    const owner = await requireOwner(request, env);
    if (owner.error) return owner.error;
    return json({ data: { authenticated: true, scope: 'owner' } });
  }

  if (path === '/api/v1/session/logout' && method === 'POST') {
    return json({ data: { authenticated: false } }, 200, {
      'Set-Cookie': serializeCookie(SESSION_COOKIE, '', { maxAge: 0, path: '/' }),
    });
  }

  if (path === '/api/v1/session' && method === 'POST') {
    const limit = await loginRateLimit(env, clientIp(request));
    if (!limit.allowed) {
      return error(429, 'Too many login attempts', [{ retryAfterSeconds: LOGIN_WINDOW_S }]);
    }

    const body = await readJsonBody(request);
    if (body === null) return error(400, 'Invalid JSON body');
    const password = typeof body.password === 'string' ? body.password : '';

    const userCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{
      n: number;
    }>();

    // First boot: create the owner from the submitted password, then log in.
    if ((userCount?.n ?? 0) === 0) {
      if (!password) return error(401, 'Incorrect password');
      const id = ulid();
      const nowSeconds = Math.floor(Date.now() / 1000);
      await env.DB.prepare(
        'INSERT INTO users (id, email, password_hash, is_owner, created_at) VALUES (?, ?, ?, 1, ?)',
      )
        .bind(id, OWNER_EMAIL, await hashPassword(password), nowSeconds)
        .run();
      // v0 is single-account: the first owner inherits pre-existing sites.
      await env.DB.prepare('UPDATE websites SET owner_user_id = ? WHERE owner_user_id IS NULL')
        .bind(id)
        .run();
      await env.KV.delete(limit.key);
      return issueSession(env, id);
    }

    const user = await findOwner(env);
    if (!user || !password || !(await verifyPassword(password, user.password_hash))) {
      return error(401, 'Incorrect password');
    }
    await env.KV.delete(limit.key);
    return issueSession(env, user.id);
  }

  return null;
}
